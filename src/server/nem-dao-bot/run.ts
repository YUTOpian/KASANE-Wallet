// NEM 版 DAO「特典の交換」の自動引き渡しボット（サーバー専用）。
//
//   KASANE_NEM_DAO_BOT=1 npm run nem-dao-bot
//
// サーバーで KASANE Wallet を動かすとき、同じサーバーでこのプロセスを別に起動したときだけ働く。
// ブラウザのウォレット（src/）はこのファイルを読み込まない（ビルドにも入らない）ので、起動しなければ従来どおり、
// 会員の交換申請は管理者が手動で渡す。
//
// 働き: DAO アカウント宛てに届いた交換申請を見て、`verify.ts` の条件をすべて満たすものだけ、DAO の名前で特典を送る
// （ボットは DAO の連署者。`fulfilExchange` と同じ「マルチシグ経由のモザイク送金」を、ボットの鍵で始める）。
// それ以外（管理者の設定変更・配布・ネームスペースなど）には、何があっても触れない（そのための経路がコードに無い）。
//
// 設定（環境変数。鍵はこのサーバーの中だけに置く）:
//   KASANE_NEM_DAO_BOT=1                 これが 1 のときだけ動く（無ければ何もせず終了）
//   KASANE_NEM_DAO_BOT_KEY_FILE=/path    ボット用アカウントの秘密鍵（64 桁の 16 進、NEM ウォレットの書き方）を 1 行で書いたファイル（推奨。権限は 600）
//   KASANE_NEM_DAO_BOT_KEY=...           ファイルの代わりに、鍵そのものを環境変数で渡す
//   KASANE_NEM_DAO_BOT_DAO=<公開鍵>[,…] 見張る DAO の ID（公開鍵）。カンマ区切りで複数可
//   KASANE_NEM_DAO_BOT_NODE=https://…    NIS1 ノード（https。同じ機械・社内ネットワークなら http も可）
//   KASANE_NEM_DAO_BOT_NETWORK=mainnet   mainnet | testnet（既定 mainnet）
//   KASANE_NEM_DAO_BOT_MAX_QTY=10        1 回の申請の個数の上限（省略すると制限なし）
//   KASANE_NEM_DAO_BOT_MAX_AGE_HOURS=24  この時間より古い申請は渡さない（既定 24。0 で制限なし）
//   KASANE_NEM_DAO_BOT_POLL_SEC=30       見に行く間隔（秒。既定 30、最小 10）
//   KASANE_NEM_DAO_BOT_MAX_PER_TICK=10   1 回の見回りで渡す申請の数の上限（既定 10）
//   KASANE_NEM_DAO_BOT_DRY_RUN=1         判定だけして、何も送らない（動作確認用）
import { readFileSync } from 'node:fs';
import { isAllowedNodeUrl } from '../../lib/nodePolicy';
import { nemAddressFromPublicKey, nemKeyPairFromPrivateKey, normalizeNemAddress } from '../../lib/nem/crypto';
import { buildFulfilMessage, daoNamespaceOf, isGovernanceMosaicId, parseDaoDescription, parseExchangeMessage, parseFulfilMessage, selectDaoItems } from '../../lib/nem/daoCore';
import type { CreatedMosaicRow, DaoItemRow } from '../../lib/nem/daoCore';
import { toDaoMove } from '../../lib/nem/daoMoves';
import type { DaoMove, RawMove } from '../../lib/nem/daoMoves';
import { nemMosaicTransferFee, signNemMultisigWrapped } from '../../lib/nem/tx';
import type { NemMosaicFeeInfo } from '../../lib/nem/tx';
import { verifyNemExchange } from './verify';

const log = (msg: string) => console.log(`${new Date().toISOString()} [nem-dao-bot] ${msg}`);
const die = (msg: string): never => { console.error(`[nem-dao-bot] ${msg}`); process.exit(1); };

interface Config {
  privateKey: string;
  publicKey: string;
  daoKeys: string[];
  node: string;
  networkByte: number;
  maxQuantity: bigint | null;
  maxAgeMs: number | null;
  pollMs: number;
  maxPerTick: number;
  dryRun: boolean;
}

/** 設定を読む。有効にされていないとき（KASANE_NEM_DAO_BOT が 1 でないとき）は null。 */
export function loadConfig(env: NodeJS.ProcessEnv): Config | null {
  if (env.KASANE_NEM_DAO_BOT !== '1') return null;
  // ブラウザ（ウォレットの画面）では動かさない。鍵をページに持ち込まないため。
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') die('サーバー（Node.js）でだけ動かせます。');
  const keyText = (env.KASANE_NEM_DAO_BOT_KEY_FILE ? readFileSync(env.KASANE_NEM_DAO_BOT_KEY_FILE, 'utf8') : env.KASANE_NEM_DAO_BOT_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyText)) die('KASANE_NEM_DAO_BOT_KEY_FILE（または KASANE_NEM_DAO_BOT_KEY）に、秘密鍵（64 桁の 16 進）を指定してください。');
  const daoKeys = (env.KASANE_NEM_DAO_BOT_DAO ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (daoKeys.length === 0 || daoKeys.some((k) => !/^[0-9A-F]{64}$/.test(k))) die('KASANE_NEM_DAO_BOT_DAO に、DAO の ID（公開鍵・64 桁の 16 進）を指定してください。');
  const node = (env.KASANE_NEM_DAO_BOT_NODE ?? '').trim().replace(/\/+$/, '');
  if (!node || !isAllowedNodeUrl(node)) die('KASANE_NEM_DAO_BOT_NODE に、ノードの URL（https://…）を指定してください。');
  const network = env.KASANE_NEM_DAO_BOT_NETWORK ?? 'mainnet';
  if (network !== 'mainnet' && network !== 'testnet') die('KASANE_NEM_DAO_BOT_NETWORK は mainnet か testnet です。');
  const max = env.KASANE_NEM_DAO_BOT_MAX_QTY?.trim();
  if (max && !/^[1-9][0-9]*$/.test(max)) die('KASANE_NEM_DAO_BOT_MAX_QTY は 1 以上の整数です。');
  const age = Number(env.KASANE_NEM_DAO_BOT_MAX_AGE_HOURS ?? '24');
  if (!Number.isFinite(age) || age < 0) die('KASANE_NEM_DAO_BOT_MAX_AGE_HOURS は 0 以上の数です。');
  const poll = Number(env.KASANE_NEM_DAO_BOT_POLL_SEC ?? '30');
  const perTick = Number(env.KASANE_NEM_DAO_BOT_MAX_PER_TICK ?? '10');
  const key = nemKeyPairFromPrivateKey(keyText);
  return {
    privateKey: key.privateKey,
    publicKey: key.publicKey,
    daoKeys,
    node,
    networkByte: network === 'testnet' ? 0x98 : 0x68,
    maxQuantity: max ? BigInt(max) : null,
    maxAgeMs: age === 0 ? null : age * 3_600_000,
    pollMs: Math.max(10, Number.isFinite(poll) ? poll : 30) * 1000,
    maxPerTick: Math.max(1, Number.isFinite(perTick) ? Math.floor(perTick) : 10),
    dryRun: env.KASANE_NEM_DAO_BOT_DRY_RUN === '1',
  };
}

interface RawDefinition {
  id?: { namespaceId: string; name: string };
  description?: string;
  properties?: Array<{ name: string; value: string }>;
  levy?: Record<string, unknown> | null;
}
interface RawDefinitionEntry extends RawDefinition { meta?: { id?: number }; mosaic?: RawDefinition }

class Nis {
  private readonly base: string;
  constructor(base: string) { this.base = base; }
  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`GET ${path.split('?')[0]} → ${res.status}`), { status: res.status });
    return (await res.json()) as T;
  }
  async announce(payload: string): Promise<{ hash: string }> {
    const res = await fetch(`${this.base}/transaction/announce`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`POST /transaction/announce → ${res.status}`);
    const body = (await res.json()) as { code?: number; message?: string; transactionHash?: { data?: string } };
    // code 1 = SUCCESS。それ以外は取り込まれない（残高不足・期限切れなど）。
    if (body.code !== 1) throw new Error(`announce 失敗: code ${body.code} ${body.message ?? ''}`);
    return { hash: body.transactionHash?.data ?? '' };
  }
}

const upper = (s: string | undefined) => (s ?? '').toUpperCase();
const prop = (d: RawDefinition, name: string) => d.properties?.find((p) => p.name === name)?.value;

async function accountInfo(nis: Nis, address: string) {
  const res = await nis.get<{ account?: { balance?: number; publicKey?: string; multisigInfo?: { minCosignatories?: number } }; meta?: { cosignatories?: Array<{ address?: string; publicKey?: string }> } }>(`/account/get?address=${address}`);
  return {
    balance: BigInt(res.account?.balance ?? 0),
    minCosignatories: res.account?.multisigInfo?.minCosignatories ?? 0,
    cosigners: (res.meta?.cosignatories ?? []).map((a) => ({ address: normalizeNemAddress(a.address ?? ''), publicKey: upper(a.publicKey) })),
  };
}

async function createdMosaics(nis: Nis, address: string): Promise<CreatedMosaicRow[]> {
  const res = await nis.get<{ data?: RawDefinitionEntry[] }>(`/account/mosaic/definition/page?address=${address}&pageSize=100`);
  const rows: CreatedMosaicRow[] = [];
  for (const e of res.data ?? []) {
    const d = e.mosaic ?? e;
    if (!d.id) continue;
    rows.push({ id: `${d.id.namespaceId}:${d.id.name}`, description: d.description ?? '', transferable: prop(d, 'transferable') !== 'false' });
  }
  return rows;
}

async function owned(nis: Nis, address: string): Promise<Map<string, bigint>> {
  const res = await nis.get<{ data?: Array<{ quantity: number | string; mosaicId: { namespaceId: string; name: string } }> }>(`/account/mosaic/owned?address=${address}`);
  return new Map((res.data ?? []).map((m) => [`${m.mosaicId.namespaceId}:${m.mosaicId.name}`.toLowerCase(), BigInt(m.quantity)]));
}

/** 送金を新しい順に読む（確定したもの）。 */
async function moves(nis: Nis, cfg: Config, address: string, direction: 'incoming' | 'outgoing', pages: number): Promise<DaoMove[]> {
  const out: DaoMove[] = [];
  let lastId: number | undefined;
  for (let i = 0; i < pages; i += 1) {
    const page = await nis.get<{ data?: RawMove[] }>(`/account/transfers/${direction}?address=${address}&pageSize=25${lastId !== undefined ? `&id=${lastId}` : ''}`);
    const entries = page.data ?? [];
    for (const e of entries) {
      const m = toDaoMove(e, cfg.networkByte);
      if (m) out.push(m);
    }
    const next = entries[entries.length - 1]?.meta?.id;
    if (entries.length < 25 || next === undefined || next === lastId) break;
    lastId = next;
  }
  return out;
}

/** まだ確定していない取引（連署待ちを含む）の中の送金。 */
async function pendingMoves(nis: Nis, cfg: Config, address: string): Promise<DaoMove[]> {
  const res = await nis.get<{ data?: RawMove[] }>(`/account/unconfirmedTransactions?address=${address}`);
  return (res.data ?? []).flatMap((e) => { const m = toDaoMove(e, cfg.networkByte); return m ? [m] : []; });
}

/** 手数料の計算に要る、モザイクの発行量と可分性（取れなければ null。推測しない）。レヴィ付きも null（ボットは扱わない）。 */
async function feeInfo(nis: Nis, id: string): Promise<NemMosaicFeeInfo | null> {
  const ns = id.slice(0, id.lastIndexOf(':'));
  let lastId: number | undefined;
  let best: { def: RawDefinition; metaId: number } | null = null;
  for (let page = 0; page < 20; page += 1) {
    const res = await nis.get<{ data?: RawDefinitionEntry[] }>(`/namespace/mosaic/definition/page?namespace=${encodeURIComponent(ns)}&pageSize=100${lastId !== undefined ? `&id=${lastId}` : ''}`);
    const entries = res.data ?? [];
    for (const e of entries) {
      const d = e.mosaic ?? e;
      if (!d.id || `${d.id.namespaceId}:${d.id.name}`.toLowerCase() !== id) continue;
      const metaId = e.meta?.id ?? 0;
      if (!best || metaId >= best.metaId) best = { def: d, metaId };
    }
    const next = entries[entries.length - 1]?.meta?.id;
    if (entries.length < 100 || next === undefined) break;
    lastId = next;
  }
  if (!best || (best.def.levy && Object.keys(best.def.levy).length > 0)) return null;
  const initial = prop(best.def, 'initialSupply');
  if (initial === undefined || !/^\d+$/.test(initial)) return null;
  // 手数料は発行量が小さいほど高くなる。現在の発行量と定義の発行量の小さいほうで見積もる（多めに払う側。足りないよりよい）。
  let supply = BigInt(initial);
  try {
    const now = await nis.get<{ supply?: number | string }>(`/mosaic/supply?mosaicId=${encodeURIComponent(id)}`);
    if (now.supply !== undefined && /^\d+$/.test(String(now.supply)) && BigInt(now.supply) < supply) supply = BigInt(now.supply);
  } catch { /* 定義の値で見積もる */ }
  return { supply, divisibility: Number(prop(best.def, 'divisibility') ?? 0) };
}

/** 起動時の確認: ボットが DAO の連署者に入っているか。入っていなければ送っても無効なので、止める。 */
async function checkCosigner(cfg: Config, nis: Nis, daoAddress: string, daoKey: string): Promise<void> {
  const info = await accountInfo(nis, daoAddress);
  const botAddress = nemAddressFromPublicKey(cfg.publicKey, cfg.networkByte);
  if (!info.cosigners.some((c) => c.publicKey === cfg.publicKey)) die(`ボット（${botAddress}）は DAO ${daoKey} の連署者ではありません。DAO 設定で、このアドレスを管理者に追加してください。`);
  const approval = info.minCosignatories === 0 ? info.cosigners.length : info.minCosignatories;
  log(`DAO ${daoKey}: 連署者として登録済み（承認 ${approval} 人）。${approval > 1 ? 'ボット 1 人では確定しないため、渡す取引には、ほかの管理者の連署も要ります（「マルチシグ」の画面で連署）。' : ''}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  if (!cfg) {
    log('無効です（KASANE_NEM_DAO_BOT=1 のときだけ動きます）。交換申請は、従来どおり管理者が手動で渡します。');
    return;
  }
  const nis = new Nis(cfg.node);
  const botAddress = nemAddressFromPublicKey(cfg.publicKey, cfg.networkByte);
  log(`起動: ボット ${botAddress} / DAO ${cfg.daoKeys.length} 件 / ${cfg.dryRun ? '判定のみ（DRY RUN）' : '引き渡しあり'}`);
  for (const key of cfg.daoKeys) await checkCosigner(cfg, nis, nemAddressFromPublicKey(key, cfg.networkByte), key);

  // 結論が出た申請は覚えておく（同じものを何度も調べない）。在庫・手数料の不足だけは、次の回に見直す。
  const settled = new Set<string>();
  const tick = async (): Promise<void> => {
    for (const daoKey of cfg.daoKeys) {
      const daoAddress = nemAddressFromPublicKey(daoKey, cfg.networkByte);
      const created = await createdMosaics(nis, daoAddress);
      const gov = created.find((m) => isGovernanceMosaicId(m.id) && parseDaoDescription(m.description) !== null);
      if (!gov) { log(`DAO ${daoKey}: ガバナンストークンが見つかりません（DAO ではない？）`); continue; }
      const items: DaoItemRow[] = selectDaoItems(created, daoKey, daoAddress, daoNamespaceOf(gov.id));
      if (!items.some((i) => i.kind === 'reward')) continue;

      const info = await accountInfo(nis, daoAddress);
      const [incoming, ...others] = await Promise.all([
        moves(nis, cfg, daoAddress, 'incoming', 3),
        // 返事（DAO の名前で出た送金）は、DAO と各管理者（ボット自身を含む）の履歴、と保留中の取引から探す。
        ...[daoAddress, ...info.cosigners.map((c) => c.address)].flatMap((a) => [moves(nis, cfg, a, 'outgoing', 3).catch(() => [] as DaoMove[]), pendingMoves(nis, cfg, a).catch(() => [] as DaoMove[])]),
      ]);
      const fulfilled = new Set(others.flat().filter((m) => m.from === daoAddress).map((m) => parseFulfilMessage(m.message)).filter((h): h is string => h !== null));
      const stock = await owned(nis, daoAddress);
      let xem = info.balance;
      let done = 0;

      for (const move of incoming) {
        if (done >= cfg.maxPerTick) break;
        if (settled.has(move.hash)) continue;
        const parsed = parseExchangeMessage(move.message);
        if (!parsed) continue;
        const verdict = verifyNemExchange({
          move, daoAddress, items, fulfilled, maxQuantity: cfg.maxQuantity, maxAgeMs: cfg.maxAgeMs, nowMs: Date.now(),
          rewardStock: stock.get(parsed.reward) ?? 0n, daoXem: xem,
        });
        if (!verdict.ok) {
          if (!verdict.retry) settled.add(move.hash);
          if (verdict.reason !== 'already_fulfilled' && verdict.reason !== 'too_old') log(`渡さない ${move.hash.slice(0, 12)}…: ${verdict.reason}${verdict.retry ? '（あとでもう一度確認）' : ''}`);
          continue;
        }
        try {
          const mosaics = [{ id: verdict.rewardId, quantity: verdict.quantity }];
          const message = buildFulfilMessage(verdict.hash);
          const fee = await (async () => {
            const infoRow = await feeInfo(nis, verdict.rewardId);
            if (!infoRow) throw new Error('mosaic_info_unavailable（特典の定義が読めない、またはレヴィ付き）');
            return nemMosaicTransferFee(cfg.networkByte, mosaics, { [verdict.rewardId]: infoRow }, message);
          })();
          if (cfg.dryRun) {
            log(`[DRY RUN] 渡してよい申請 ${verdict.hash.slice(0, 12)}…: ${verdict.member} へ ${verdict.rewardId} を ${verdict.quantity} 個（ポイント ${verdict.paid}、手数料 ${fee}）`);
          } else {
            const payload = signNemMultisigWrapped(cfg.privateKey, cfg.publicKey, cfg.networkByte, daoKey, { kind: 'mosaicTransfer', recipient: verdict.member, mosaics, message, fee });
            const sent = await nis.announce(payload);
            log(`渡した ${verdict.hash.slice(0, 12)}…: ${verdict.member} へ ${verdict.rewardId} を ${verdict.quantity} 個（送信 ${sent.hash.slice(0, 12)}…）`);
          }
          // 同じ見回りの中の次の申請に、この分を引いた在庫・XEM で判定する。
          stock.set(verdict.rewardId, (stock.get(verdict.rewardId) ?? 0n) - verdict.quantity);
          xem -= fee;
          fulfilled.add(verdict.hash);
          settled.add(verdict.hash);
          done += 1;
        } catch (e) {
          log(`渡せませんでした ${move.hash.slice(0, 12)}…（次の回にやり直し）: ${(e as Error).message}`);
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
