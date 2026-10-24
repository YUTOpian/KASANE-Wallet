// Ledger の Symbol アプリ / NEM アプリとのやり取り（公開鍵の取得・署名）。
//
// 形式は公式の実装に合わせてあります（根拠: Symbol Desktop Wallet 1.2.0 の `Ledger.ts`、NEM Wallet の `hw-app-nem.js`）。
//   公開鍵の取得: データ = [パスの本数][4バイト大端 × 本数][ネットワーク種別(1バイト)]
//     Symbol 応答 = [32][公開鍵]（アドレスは返らない）
//     NEM    応答 = [40][アドレス(ASCII)][32][公開鍵]
//   署名: 最初のAPDUのデータ = パス部分 ＋ 署名対象の先頭、以降は署名対象の続き。
//     P1 の 0x80 = このあとに続きがある、0x01 = 先頭ではない（続きの分）。
//   P2: 曲線 Ed25519(0x80)。Symbol も NEM も同じ。
// ★実機では未確認です（docs/FEATURES.md の Ledger 参照）。動かなかったときは、このファイルの PROTOCOL と下の2つの関数だけを直せば済みます。
import { LedgerError, buildApdu, chunkPayload, classifyStatus, serializePath, splitStatus, statusHex } from './framing';
import type { LedgerTransport } from './transport';

export const PROTOCOL = {
  CLA: 0xe0,
  INS_GET_PUBLIC_KEY: 0x02,
  INS_SIGN: 0x04,
  P1_NO_CONFIRM: 0x00,
  P1_CONFIRM: 0x01,
  // 署名の分割送信: 続きがある(0x80) / 先頭ではない(0x01)
  P1_MORE_FOLLOWS: 0x80,
  P1_CONTINUATION: 0x01,
  // 曲線 Ed25519。Symbol アプリも NEM アプリも 0x80（公式の実装どおり）。
  P2_ED25519: 0x80,
} as const;

/** BIP44 のコインタイプ: Symbol メインネット 4343 / NEM メインネット 43 / どちらもテストネットは 1。 */
function coinType(chain: 'symbol' | 'nem', networkByte: number): number {
  if (networkByte !== 0x68) return 1; // テストネット
  return chain === 'symbol' ? 4343 : 43;
}

export function ledgerPath(chain: 'symbol' | 'nem', index: number, networkByte: number): string {
  return `m/44'/${coinType(chain, networkByte)}'/${index}'/0'/0'`;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function send(t: LedgerTransport, apdu: Uint8Array): Promise<Uint8Array> {
  const { data, sw } = splitStatus(await t.exchange(apdu));
  const kind = classifyStatus(sw);
  if (kind) throw new LedgerError(kind, statusHex(sw));
  return data;
}

export interface LedgerAccount {
  publicKey: string; // 64文字の16進（大文字）
  address: string;   // 公開鍵から計算したアドレス（ハイフンなし）
}

/** 公開鍵取得の APDU のデータ部: パス ＋ ネットワーク種別 1 バイト。 */
export function accountRequestData(path: string, networkByte: number): Uint8Array {
  const p = serializePath(path);
  const out = new Uint8Array(p.length + 1);
  out.set(p, 0);
  out[p.length] = networkByte & 0xff;
  return out;
}

/**
 * 公開鍵を取得する。`display` を true にすると、デバイスの画面にアドレスを出して確認を求める。
 * `addressFromPublicKey` は呼び出し側から渡す（Symbol と NEM でアドレスの作り方が違うため）。
 * Symbol アプリはアドレスを返さないので、アドレスは公開鍵から計算する。
 * NEM アプリはアドレスも返すので、計算した値と一致しなければ受け付けない。
 */
export async function getLedgerAccount(
  t: LedgerTransport,
  chain: 'symbol' | 'nem',
  index: number,
  networkByte: number,
  addressFromPublicKey: (publicKeyHex: string, networkByte: number) => string,
  display = false,
): Promise<LedgerAccount> {
  const path = ledgerPath(chain, index, networkByte);
  const res = await send(t, buildApdu(PROTOCOL.CLA, PROTOCOL.INS_GET_PUBLIC_KEY, display ? PROTOCOL.P1_CONFIRM : PROTOCOL.P1_NO_CONFIRM, PROTOCOL.P2_ED25519, accountRequestData(path, networkByte)));
  let publicKey: string;
  let deviceAddress: string | null = null;
  if (chain === 'symbol') {
    // [32][公開鍵]
    if (res.length < 33 || res[0] !== 32) throw new LedgerError('bad_response', 'public_key');
    publicKey = hex(res.slice(1, 33));
  } else {
    // [40][アドレス][32][公開鍵]
    if (res.length < 1 || res[0] !== 40 || res.length < 1 + 40 + 1 + 32 || res[41] !== 32) throw new LedgerError('bad_response', 'public_key');
    deviceAddress = new TextDecoder().decode(res.slice(1, 41)).replace(/-/g, '').toUpperCase();
    publicKey = hex(res.slice(42, 74));
  }
  const address = addressFromPublicKey(publicKey, networkByte).replace(/-/g, '').toUpperCase();
  if (deviceAddress !== null && deviceAddress !== address) throw new LedgerError('bad_response', 'address_mismatch');
  return { publicKey, address };
}

/** 署名の分割送信の P1: 続きがあれば 0x80、先頭でなければ 0x01。 */
export function signP1(chunkIndex: number, chunkCount: number): number {
  return (chunkIndex < chunkCount - 1 ? PROTOCOL.P1_MORE_FOLLOWS : 0) | (chunkIndex > 0 ? PROTOCOL.P1_CONTINUATION : 0);
}

/**
 * 署名する。`payload` は、アプリが署名する対象のバイト列そのもの:
 *   Symbol … ジェネレーションハッシュ(32) ＋ トランザクションの 108 バイト目以降
 *   NEM    … シリアライズしたトランザクション全体
 * 返り値は署名（64バイト）。
 */
export async function ledgerSign(
  t: LedgerTransport,
  chain: 'symbol' | 'nem',
  index: number,
  networkByte: number,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const path = serializePath(ledgerPath(chain, index, networkByte));
  const chunks = chunkPayload(path, payload);
  let last: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < chunks.length; i += 1) {
    last = await send(t, buildApdu(PROTOCOL.CLA, PROTOCOL.INS_SIGN, signP1(i, chunks.length), PROTOCOL.P2_ED25519, chunks[i]));
  }
  if (last.length < 64) throw new LedgerError('bad_response', 'signature');
  return last.slice(0, 64);
}
