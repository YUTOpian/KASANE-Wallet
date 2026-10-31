// NEM 署名付きメッセージ: 文章（UTF-8 のバイト列）に、アカウントの秘密鍵で署名する。署名と公開鍵があれば、
// だれでも「この公開鍵の持ち主が、この文章に署名した」ことを確かめられる。NanoWallet の署名付きメッセージと同じ
// 考え方（Ed25519 / Keccak-512）。トランザクションではないので、ブロックチェーンには何も送らない。
//
// このファイルは SDK を使わない（形式の検査と、共有用 JSON の組み立て・読み取りだけ）。署名と検証そのものは
// lib/nem/crypto.ts の signNemData / verifyNemSignature。
//
// 共有用のテキスト（QR にもできる）は KASANE の封筒に入れた JSON:
//   { "kasane": 1, "kind": "nem_signed_message", "data": { "message": "...", "publicKey": "<64 hex>", "signature": "<128 hex>" } }
// 他のツールが出す `{"message","publicKey","signature"}` だけの JSON も読める。
//
// NanoWallet（NEM Wallet）との互換:
//   NanoWallet の形式は { "message": "<16進>", "signer": "<公開鍵>", "signature": "<署名>" }。message は署名したバイト列そのものを
//   16 進にしたもの。こちらも読める（16 進を文章に戻す）し、同じ形式でも出せる（buildNanoWalletSignedMessage）。
//   署名の中身（Ed25519 / Keccak-512 でバイト列に署名）は同じ。違いは、絵文字などサロゲートペアの文字を NanoWallet が
//   UTF-16 の 1 単位ずつ 3 バイトに符号化する点（正しい UTF-8 では 4 バイト）。検証では両方の符号化を試す。
export const NEM_SIGNED_MESSAGE_KIND = 'nem_signed_message';
const KASANE_QR_VERSION = 1;

/** 署名の対象はメッセージの UTF-8 バイト列（改行・空白も 1 文字ずつ含む）。 */
export function nemMessageBytes(message: string): Uint8Array {
  return new TextEncoder().encode(message);
}

/**
 * NanoWallet（nem-sdk の utf8ToHex）と同じ符号化。UTF-16 の 1 単位ずつ UTF-8 風に符号化するので、
 * 絵文字などサロゲートペアの文字は 4 バイトではなく 3 バイト + 3 バイトになる。BMP の文字（日本語・英数字・記号）は
 * 正しい UTF-8 と同じ。
 */
export function nemNanoMessageBytes(message: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < message.length; i++) {
    const c = message.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;

export const isHexBytes = (s: string) => HEX_BYTES.test(s.trim());

export function nemHexToBytes(hex: string): Uint8Array {
  return Uint8Array.from((hex.trim().match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
}

export function nemBytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 16 進のバイト列を文章に戻す。正しい UTF-8 と、NanoWallet 式（サロゲートが 3 バイト + 3 バイト）の両方を読む。
 * 文章として読めないバイト列は null。
 */
export function nemHexToText(hex: string): string | null {
  if (!isHexBytes(hex)) return null;
  const b = nemHexToBytes(hex);
  const cont = (i: number) => i < b.length && (b[i] & 0xc0) === 0x80;
  const units: number[] = [];
  for (let i = 0; i < b.length;) {
    const c = b[i];
    if (c < 0x80) { units.push(c); i += 1; }
    else if ((c & 0xe0) === 0xc0 && cont(i + 1)) { units.push(((c & 0x1f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else if ((c & 0xf0) === 0xe0 && cont(i + 1) && cont(i + 2)) { units.push(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)); i += 3; }
    else if ((c & 0xf8) === 0xf0 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) return null;
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    } else return null;
  }
  let text = '';
  for (let i = 0; i < units.length; i += 8192) text += String.fromCharCode(...units.slice(i, i + 8192));
  return text;
}

/** 署名できる長さの上限（バイト）。QR にもテキストにも収まる現実的な大きさ。 */
export const NEM_SIGNED_MESSAGE_MAX_BYTES = 4096;

export const isNemPublicKeyHex = (s: string) => /^[0-9a-fA-F]{64}$/.test(s.trim());
export const isNemSignatureHex = (s: string) => /^[0-9a-fA-F]{128}$/.test(s.trim());

export interface NemSignedMessage {
  message: string;
  publicKey: string; // upper-case hex
  signature: string; // upper-case hex
  /** 読み込んだ元の形式（読み込み時だけ付く）。 */
  from?: 'kasane' | 'plain' | 'nanowallet';
}

export function buildNemSignedMessage(m: NemSignedMessage): string {
  if (!isNemPublicKeyHex(m.publicKey) || !isNemSignatureHex(m.signature)) throw new Error('nem signed message: bad key or signature');
  return JSON.stringify({
    kasane: KASANE_QR_VERSION,
    kind: NEM_SIGNED_MESSAGE_KIND,
    data: { message: m.message, publicKey: m.publicKey.trim().toUpperCase(), signature: m.signature.trim().toUpperCase() },
  });
}

/**
 * NanoWallet と同じ形式の共有 JSON: { message: <署名したバイト列の16進>, signer: <公開鍵>, signature: <署名> }。
 * bytes は署名したバイト列（KASANE なら UTF-8、NanoWallet 式なら nemNanoMessageBytes）。これを 16 進にして message に入れるので、
 * NanoWallet 側は署名をそのまま検証できる。
 */
export function buildNanoWalletSignedMessage(m: { publicKey: string; signature: string }, bytes: Uint8Array): string {
  if (!isNemPublicKeyHex(m.publicKey) || !isNemSignatureHex(m.signature)) throw new Error('nem signed message: bad key or signature');
  return JSON.stringify({ message: nemBytesToHex(bytes), signer: m.publicKey.trim().toLowerCase(), signature: m.signature.trim().toLowerCase() });
}

/**
 * KASANE の封筒、`{"message","publicKey","signature"}`、または NanoWallet の `{"message"(16進),"signer","signature"}`。
 * どれでもなければ null。NanoWallet 形式（`publicKey` がなく `signer` がある）で message が 16 進なら、文章に戻して返す。
 */
export function parseNemSignedMessage(text: string): NemSignedMessage | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  let json: unknown;
  try {
    json = JSON.parse(t);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object') return null;
  let d = json as Record<string, unknown>;
  let from: NemSignedMessage['from'] = 'plain';
  if (d.kasane !== undefined) {
    if (d.kasane !== KASANE_QR_VERSION || d.kind !== NEM_SIGNED_MESSAGE_KIND || d.data === null || typeof d.data !== 'object') return null;
    d = d.data as Record<string, unknown>;
    from = 'kasane';
  }
  const key = d.publicKey ?? d.signer;
  if (typeof d.message !== 'string' || typeof key !== 'string' || typeof d.signature !== 'string') return null;
  if (!isNemPublicKeyHex(key) || !isNemSignatureHex(d.signature)) return null;
  let message = d.message;
  if (from === 'plain' && d.publicKey === undefined) {
    // NanoWallet: the message is the signed bytes in hex.
    const decoded = nemHexToText(message);
    if (decoded !== null) { message = decoded; from = 'nanowallet'; }
  }
  return { message, publicKey: key.trim().toUpperCase(), signature: d.signature.trim().toUpperCase(), from };
}
