// SSS Extension で署名する、署名関数（tx.ts の signXxx）共通の包み。
// 署名関数は秘密鍵を受け取って同期で署名するので、秘密鍵に空文字を渡し、その中の「署名する」だけを差し替える（tx.ts の withSigningOverride）。
//   1回目: 署名するバイト列と署名前のトランザクションを取り出す（署名はゼロ）。
//   SSS に署名を頼み、返った署名がこちらの内容に対するものかを検算する（sss.ts の signWithSss）。
//   2回目: 同じ関数をもう一度呼び、その署名を付ける。1回目と署名以外が1バイトでも違えば、送らない。
// そのため、`run` の中で時刻や乱数を使ってはいけない（パラメータは呼ぶ前に確定させておく）。
import { SssError, signWithSss } from '../sss';
import { signWithLedger } from '../ledger/session';
import { verifySignature } from './crypto';
import { withSigningOverride } from './tx';

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

// Symbol のトランザクション: サイズ(4) + 予約(4) + 署名(64) + …。署名より前と後ろ（署名以外）が同じかを比べる。
const SIGNATURE_START = 8;
const SIGNATURE_END = 72;
function sameExceptSignature(a: string, b: string): boolean {
  return a.length === b.length
    && a.slice(0, SIGNATURE_START * 2) === b.slice(0, SIGNATURE_START * 2)
    && a.slice(SIGNATURE_END * 2).toUpperCase() === b.slice(SIGNATURE_END * 2).toUpperCase();
}

/** 署名を外（SSS / Ledger）に頼む共通の流れ。`sign` は署名するバイト列と署名前のトランザクションを受け取り、64バイトの署名を返す。 */
export async function signViaExternal<T extends { payload: string }>(
  sign: (signingPayload: Uint8Array, serializedTx: Uint8Array) => Promise<Uint8Array>,
  run: () => T,
): Promise<T> {
  const captured: { bytes: Uint8Array | null } = { bytes: null };
  const first = withSigningOverride({
    sign: (data) => { captured.bytes = Uint8Array.from(data); return { bytes: new Uint8Array(64) }; },
  }, run);
  if (captured.bytes === null) throw new SssError('bad_response', 'signing_not_requested');
  const signature = await sign(captured.bytes, hexToBytes(first.payload));
  const second = withSigningOverride({ sign: () => ({ bytes: signature }) }, run);
  if (!sameExceptSignature(first.payload, second.payload)) throw new SssError('signature_mismatch', 'payload_changed');
  return second;
}

export function signViaSss<T extends { payload: string }>(
  who: { publicKey: string; networkByte: number },
  run: () => T,
): Promise<T> {
  return signViaExternal(
    (signingPayload, serializedTx) => signWithSss({ expectedPublicKey: who.publicKey, networkByte: who.networkByte, serializedTx, signingPayload }),
    run,
  );
}

/** Ledger（Symbol アプリ）で署名する。`index` はデバイスのアカウント番号。 */
export function signViaLedger<T extends { payload: string }>(
  who: { publicKey: string; networkByte: number; index: number },
  run: () => T,
): Promise<T> {
  return signViaExternal(
    (signingPayload) => signWithLedger('symbol', who.index, who.publicKey, who.networkByte, signingPayload, verifySignature),
    run,
  );
}

/** 秘密鍵をこの端末に持たない署名者（SSS Extension / Ledger）。 */
export type KeylessSigner = { kind: 'sss' } | { kind: 'ledger'; index: number };

/** 秘密鍵があればそれで、`keyless` ならその署名者（SSS / Ledger）で署名する。 */
export async function signWithAny<T extends { payload: string }>(
  privateKey: string,
  keyless: KeylessSigner | undefined,
  publicKey: string,
  networkByte: number,
  run: () => T,
): Promise<T> {
  if (keyless?.kind === 'sss') return signViaSss({ publicKey, networkByte }, run);
  if (keyless?.kind === 'ledger') return signViaLedger({ publicKey, networkByte, index: keyless.index }, run);
  return signMaybeSss(privateKey, publicKey, networkByte, run);
}

/** 秘密鍵があればそれで、空文字（SSS Extension のアカウント）なら SSS で署名する。 */
export async function signMaybeSss<T extends { payload: string }>(
  privateKey: string,
  publicKey: string,
  networkByte: number,
  run: () => T,
): Promise<T> {
  return privateKey === '' ? signViaSss({ publicKey, networkByte }, run) : run();
}
