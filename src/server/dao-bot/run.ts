// DAO「ポイント交換」の自動連署ボット（サーバー専用）。
//
//   KASANE_DAO_BOT=1 npm run dao-bot
//
// サーバーで KASANE Wallet を動かすとき、同じサーバーでこのプロセスを別に起動したときだけ働く。
// ブラウザのウォレット（src/）はこのファイルを読み込まない（ビルドにも入らない）ので、起動しなければ従来どおり、
// 会員の交換申請は管理者が手動で連署して成立する。
//
// 働き: DAO 宛の署名待ち（bonded）を見て、`verify.ts` の条件をすべて満たす「ポイント交換の申請」だけに連署する。
// それ以外（管理者の設定変更・配布・回収など）には、何があっても連署しない。
//
// 設定（環境変数。鍵はこのサーバーの中だけに置く）:
//   KASANE_DAO_BOT=1                 これが 1 のときだけ動く（無ければ何もせず終了）
//   KASANE_DAO_BOT_KEY_FILE=/path    ボット用アカウントの秘密鍵（64 桁の 16 進）を 1 行で書いたファイル（推奨。権限は 600）
//   KASANE_DAO_BOT_KEY=...           ファイルの代わりに、鍵そのものを環境変数で渡す
//   KASANE_DAO_BOT_DAO=<公開鍵>[,…] 見張る DAO の ID（公開鍵）。カンマ区切りで複数可
//   KASANE_DAO_BOT_NODE=https://…    ノード（https。同じ機械・社内ネットワークなら http も可）
//   KASANE_DAO_BOT_NETWORK=mainnet   mainnet | testnet（既定 mainnet）
//   KASANE_DAO_BOT_MAX_QTY=10        1 回の申請の数量の上限（省略すると制限なし）
//   KASANE_DAO_BOT_POLL_SEC=15       見に行く間隔（秒。既定 15、最小 5）
//   KASANE_DAO_BOT_DRY_RUN=1         判定だけして、連署は送らない（動作確認用）
import { readFileSync } from 'node:fs';
import { PrivateKey } from 'symbol-sdk';
import { Address, KeyPair } from 'symbol-sdk/symbol';
import { addressFromPublicKey, bytesToHex } from '../../lib/symbol/crypto';
import { isAllowedNodeUrl } from '../../lib/nodePolicy';
import type { RestPartialAggregate } from '../../lib/symbol/partialPayload';
import { EXCHANGE_KEYS, verifyExchangeRequest } from './verify';
import type { BotContext, ExchangeTerms } from './verify';

const log = (msg: string) => console.log(`${new Date().toISOString()} [dao-bot] ${msg}`);
const die = (msg: string): never => { console.error(`[dao-bot] ${msg}`); process.exit(1); };

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const hex16 = (key: bigint) => key.toString(16).toUpperCase().padStart(16, '0');

interface Config {
  keyPair: KeyPair;
  daoKeys: string[];
  node: string;
  networkByte: number;
  maxQuantity: bigint | null;
  pollMs: number;
  dryRun: boolean;
}

/** 設定を読む。有効にされていないとき（KASANE_DAO_BOT が 1 でないとき）は null。 */
export function loadConfig(env: NodeJS.ProcessEnv): Config | null {
  if (env.KASANE_DAO_BOT !== '1') return null;
  // ブラウザ（ウォレットの画面）では動かさない。鍵をページに持ち込まないため。
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') die('サーバー（Node.js）でだけ動かせます。');
  const keyText = (env.KASANE_DAO_BOT_KEY_FILE ? readFileSync(env.KASANE_DAO_BOT_KEY_FILE, 'utf8') : env.KASANE_DAO_BOT_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyText)) die('KASANE_DAO_BOT_KEY_FILE（または KASANE_DAO_BOT_KEY）に、秘密鍵（64 桁の 16 進）を指定してください。');
  const daoKeys = (env.KASANE_DAO_BOT_DAO ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (daoKeys.length === 0 || daoKeys.some((k) => !/^[0-9A-F]{64}$/.test(k))) die('KASANE_DAO_BOT_DAO に、DAO の ID（公開鍵・64 桁の 16 進）を指定してください。');
  const node = (env.KASANE_DAO_BOT_NODE ?? '').trim().replace(/\/+$/, '');
  if (!node || !isAllowedNodeUrl(node)) die('KASANE_DAO_BOT_NODE に、ノードの URL（https://…）を指定してください。');
  const network = env.KASANE_DAO_BOT_NETWORK ?? 'mainnet';
  if (network !== 'mainnet' && network !== 'testnet') die('KASANE_DAO_BOT_NETWORK は mainnet か testnet です。');
  const max = env.KASANE_DAO_BOT_MAX_QTY?.trim();
  if (max && !/^[1-9][0-9]*$/.test(max)) die('KASANE_DAO_BOT_MAX_QTY は 1 以上の整数です。');
  const poll = Number(env.KASANE_DAO_BOT_POLL_SEC ?? '15');
  return {
    keyPair: new KeyPair(new PrivateKey(keyText)),
    daoKeys,
    node,
    networkByte: network === 'testnet' ? 0x98 : 0x68,
    maxQuantity: max ? BigInt(max) : null,
    pollMs: Math.max(5, Number.isFinite(poll) ? poll : 15) * 1000,
    dryRun: env.KASANE_DAO_BOT_DRY_RUN === '1',
  };
}

class Rest {
  constructor(private readonly base: string) {}
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`GET ${path} → ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  }
  async putCosignature(body: { parentHash: string; signature: string; signerPublicKey: string; version: string }): Promise<void> {
    const res = await fetch(`${this.base}/transactions/cosignature`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`PUT /transactions/cosignature → ${res.status}`);
  }
}

interface MetaRow { metadataEntry: { value: string } }

function contextFor(cfg: Config, rest: Rest, daoPublicKey: string): BotContext {
  const daoAddress = addressFromPublicKey(daoPublicKey, cfg.networkByte);
  /** DAO 自身が付けたメタデータだけを読む（sourceAddress = DAO）。管理者が自分の名前で付けたものは対象外。 */
  const meta = async (mosaicId: string, key: bigint): Promise<string | null> => {
    const res = await rest.get<{ data: MetaRow[] }>(`/metadata?targetId=${mosaicId}&metadataType=1&sourceAddress=${daoAddress}&scopedMetadataKey=${hex16(key)}`);
    return res.data.length > 0 ? new TextDecoder().decode(hexToBytes(res.data[0].metadataEntry.value)) : null;
  };
  return {
    networkByte: cfg.networkByte,
    daoPublicKey,
    maxQuantity: cfg.maxQuantity,
    async exchangeTerms(rewardMosaicId: string): Promise<ExchangeTerms | null> {
      if (!/^[0-9A-F]{16}$/.test(rewardMosaicId)) return null;
      if ((await meta(rewardMosaicId, EXCHANGE_KEYS.exchangeable)) !== 'true') return null;
      const pointMosaicId = (await meta(rewardMosaicId, EXCHANGE_KEYS.pointMosaicId))?.trim().toUpperCase();
      const costText = (await meta(rewardMosaicId, EXCHANGE_KEYS.exchangeCost))?.trim();
      if (!pointMosaicId || !/^[0-9A-F]{16}$/.test(pointMosaicId) || !costText || !/^[1-9][0-9]*$/.test(costText)) return null;
      return { pointMosaicId, cost: BigInt(costText) };
    },
    async balance(address: string, mosaicId: string): Promise<bigint> {
      try {
        const res = await rest.get<{ account: { mosaics?: Array<{ id: string; amount: string }> } }>(`/accounts/${address}`);
        const row = (res.account.mosaics ?? []).find((m) => m.id.toUpperCase() === mosaicId.toUpperCase());
        return row ? BigInt(row.amount) : 0n;
      } catch (e) {
        if ((e as { status?: number }).status === 404) return 0n;
        throw e;
      }
    },
  };
}

/** 起動時の確認: ボットが DAO の連署者に入っているか。入っていなければ連署しても無効なので、止める。 */
async function checkCosigner(cfg: Config, rest: Rest, daoPublicKey: string): Promise<void> {
  const daoAddress = addressFromPublicKey(daoPublicKey, cfg.networkByte);
  const botPublicKey = cfg.keyPair.publicKey.toString().toUpperCase();
  const botAddress = addressFromPublicKey(botPublicKey, cfg.networkByte);
  const res = await rest.get<{ multisig: { minApproval: number; cosignatoryAddresses?: string[] } }>(`/account/${daoAddress}/multisig`);
  const botHex = bytesToHex(new Address(botAddress).bytes).toUpperCase();
  const cosigners = (res.multisig.cosignatoryAddresses ?? []).map((a) => a.toUpperCase());
  if (!cosigners.includes(botHex)) die(`ボット（${botAddress}）は DAO ${daoPublicKey} の連署者ではありません。DAO 設定で、このアドレスを管理者に追加してください。`);
  log(`DAO ${daoPublicKey}: 連署者として登録済み（承認数 ${res.multisig.minApproval}）。${res.multisig.minApproval > 1 ? 'ボット 1 人では成立しないため、ほかの管理者の連署も要ります。' : ''}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  if (!cfg) {
    log('無効です（KASANE_DAO_BOT=1 のときだけ動きます）。交換申請は、従来どおり管理者が連署します。');
    return;
  }
  const rest = new Rest(cfg.node);
  const botPublicKey = cfg.keyPair.publicKey.toString().toUpperCase();
  log(`起動: ボット ${addressFromPublicKey(botPublicKey, cfg.networkByte)} / DAO ${cfg.daoKeys.length} 件 / ${cfg.dryRun ? '判定のみ（DRY RUN）' : '連署あり'}`);
  for (const dao of cfg.daoKeys) await checkCosigner(cfg, rest, dao);

  // 結論が出たものは覚えておく（同じものを何度も調べない）。一覧から消えたら忘れる。
  const settled = new Set<string>();
  const tick = async (): Promise<void> => {
    for (const dao of cfg.daoKeys) {
      const ctx = contextFor(cfg, rest, dao);
      const daoAddress = addressFromPublicKey(dao, cfg.networkByte);
      const list = await rest.get<{ data: Array<{ meta: { hash: string } }> }>(`/transactions/partial?address=${daoAddress}&order=desc&pageSize=50`);
      const live = new Set(list.data.map((d) => d.meta.hash.toUpperCase()));
      for (const h of settled) if (!live.has(h)) settled.delete(h);
      for (const hash of live) {
        if (settled.has(hash)) continue;
        try {
          const detail = await rest.get<RestPartialAggregate & { transaction: { cosignatures?: Array<{ signerPublicKey: string }> } }>(`/transactions/partial/${hash}`);
          if ((detail.transaction.cosignatures ?? []).some((c) => c.signerPublicKey.toUpperCase() === botPublicKey)) { settled.add(hash); continue; }
          const verdict = await verifyExchangeRequest(detail, hash, ctx);
          if (!verdict.ok) {
            if (!verdict.retry) settled.add(hash);
            // 交換の形でないもの（管理者の操作）は、いつものことなので静かに。
            if (verdict.reason !== 'not_exchange_shape') log(`連署しない ${hash.slice(0, 12)}…: ${verdict.reason}${verdict.retry ? '（あとでもう一度確認）' : ''}`);
            continue;
          }
          if (cfg.dryRun) {
            log(`[DRY RUN] 連署してよい申請 ${hash.slice(0, 12)}…: ${verdict.member} が ${verdict.rewardMosaicId} を ${verdict.quantity} 個（ポイント ${verdict.points}）`);
          } else {
            await rest.putCosignature({ parentHash: hash, signature: bytesToHex(cfg.keyPair.sign(hexToBytes(hash)).bytes).toUpperCase(), signerPublicKey: botPublicKey, version: '0' });
            log(`連署した ${hash.slice(0, 12)}…: ${verdict.member} が ${verdict.rewardMosaicId} を ${verdict.quantity} 個（ポイント ${verdict.points}）`);
          }
          settled.add(hash);
        } catch (e) {
          log(`確認に失敗 ${hash.slice(0, 12)}…（次の回にやり直し）: ${(e as Error).message}`);
        }
      }
    }
  };

  for (;;) {
    try { await tick(); } catch (e) { log(`ノードに繋がりません（次の回にやり直し）: ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

void main();
