// Symbol 署名付きメッセージ: 文章（UTF-8 のバイト列）に、アカウントの秘密鍵で署名する。署名と公開鍵があれば、
// だれでも「この公開鍵の持ち主が、この文章に署名した」ことを確かめられる。NEM の署名付きメッセージ
// （lib/nem/signedMessage.ts）と同じ考え方で、違いは署名方式だけ（NEM は Ed25519 / Keccak-512、Symbol は
// Ed25519 / SHA-512）。トランザクションではないので、ブロックチェーンには何も送らない。
//
// このファイルは SDK を使わない（形式の検査と、共有用 JSON の組み立て・読み取りだけ）。署名と検証そのものは
// lib/symbol/crypto.ts の signData / verifySignature。
//
// 共有用のテキスト（QR にもできる）は KASANE の封筒に入れた JSON:
//   { "kasane": 1, "kind": "symbol_signed_message", "data": { "message": "...", "publicKey": "<64 hex>", "signature": "<128 hex>" } }
// 他のツールが出す `{"message","publicKey","signature"}` だけの JSON も読める。
//
// NEM との取り違えを防ぐ: NEM の署名付きメッセージ（KASANE の封筒 `nem_signed_message`、NanoWallet 形式の
// `{"message","signer","signature"}`）を貼られたときは、読めないと言うだけでなく「NEM のものです」と教えられるよう
// detectOtherChainSignedMessage で見分ける。同じ秘密鍵でも NEM と Symbol では公開鍵が違う（署名方式が違う）ので、
// NEM の署名を Symbol の検証に通しても必ず合わない。
export const SYMBOL_SIGNED_MESSAGE_KIND = 'symbol_signed_message';
const NEM_SIGNED_MESSAGE_KIND = 'nem_signed_message';
const KASANE_QR_VERSION = 1;

/** 署名の対象はメッセージの UTF-8 バイト列（改行・空白も 1 文字ずつ含む）。 */
export function symbolMessageBytes(message: string): Uint8Array {
  return new TextEncoder().encode(message);
}

/** 署名できる長さの上限（バイト）。QR にもテキストにも収まる現実的な大きさ（NEM と同じ）。 */
export const SYMBOL_SIGNED_MESSAGE_MAX_BYTES = 4096;

export const isSymbolPublicKeyHex = (s: string) => /^[0-9a-fA-F]{64}$/.test(s.trim());
export const isSymbolSignatureHex = (s: string) => /^[0-9a-fA-F]{128}$/.test(s.trim());

export interface SymbolSignedMessage {
  message: string;
  publicKey: string; // upper-case hex
  signature: string; // upper-case hex
  /** 読み込んだ元の形式（読み込み時だけ付く）。 */
  from?: 'kasane' | 'plain';
}

export function buildSymbolSignedMessage(m: SymbolSignedMessage): string {
  if (!isSymbolPublicKeyHex(m.publicKey) || !isSymbolSignatureHex(m.signature)) throw new Error('symbol signed message: bad key or signature');
  return JSON.stringify({
    kasane: KASANE_QR_VERSION,
    kind: SYMBOL_SIGNED_MESSAGE_KIND,
    data: { message: m.message, publicKey: m.publicKey.trim().toUpperCase(), signature: m.signature.trim().toUpperCase() },
  });
}

function parseObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const json: unknown = JSON.parse(t);
    return json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * KASANE の封筒、または `{"message","publicKey","signature"}`。どちらでもなければ null。
 * NEM の封筒・NanoWallet 形式（`signer` があって `publicKey` がない）は読まない（detectOtherChainSignedMessage で見分ける）。
 */
export function parseSymbolSignedMessage(text: string): SymbolSignedMessage | null {
  let d = parseObject(text);
  if (d === null) return null;
  let from: SymbolSignedMessage['from'] = 'plain';
  if (d.kasane !== undefined) {
    if (d.kasane !== KASANE_QR_VERSION || d.kind !== SYMBOL_SIGNED_MESSAGE_KIND || d.data === null || typeof d.data !== 'object') return null;
    d = d.data as Record<string, unknown>;
    from = 'kasane';
  }
  if (typeof d.message !== 'string' || typeof d.publicKey !== 'string' || typeof d.signature !== 'string') return null;
  if (!isSymbolPublicKeyHex(d.publicKey) || !isSymbolSignatureHex(d.signature)) return null;
  return { message: d.message, publicKey: d.publicKey.trim().toUpperCase(), signature: d.signature.trim().toUpperCase(), from };
}

/**
 * 貼られたテキストが、NEM の署名付きメッセージ（KASANE の封筒、または NanoWallet 形式）なら 'nem'。そうでなければ null。
 * Symbol の検証画面が「読めません」の代わりに「NEM のものです」と案内するために使う。
 */
export function detectOtherChainSignedMessage(text: string): 'nem' | null {
  const d = parseObject(text);
  if (d === null) return null;
  if (d.kasane !== undefined) return d.kind === NEM_SIGNED_MESSAGE_KIND ? 'nem' : null;
  // NanoWallet: { message(16進), signer, signature }。`publicKey` を持つ JSON は Symbol 側で読むのでここには来ない。
  if (d.publicKey === undefined && typeof d.signer === 'string' && typeof d.message === 'string' && typeof d.signature === 'string') return 'nem';
  return null;
}
