// コンソールの `walletKeyPair.sign(bytes)`（任意のバイト列への署名）の守り。
//
// Symbol は「生成ハッシュ(32バイト) + トランザクションのうち version から後ろ」への署名が、そのままトランザクションの署名になる。
// NEM は「署名欄を含まないトランザクションそのもの」への署名が、トランザクションの署名になる。
// つまり悪意のあるコードが、本物の送金を「データ署名」として出せてしまう。確認画面に16進の羅列を出しても、人間には見分けられない。
// そこで、署名するバイト列をトランザクションとして読み直す。
//   - 読めた       → 「トランザクションへの署名」として、送金先・金額などを見せる（wallet.signTransaction と同じ確認画面）。
//   - 読めない     → トランザクションの形をしているのに読めないものは、署名しない。
//   - 32バイトちょうど → 連署（トランザクションのハッシュへの署名）と同じ形。署名はできるが、強い警告を付ける。
//   - それ以外     → 本当にただのデータ。これまでどおり、データ署名の警告つきで署名できる。
//
// SDK には依存しない（読み直しは、呼び出し側が渡す関数で行う）。テストしやすくするため。

export type DataSignVerdict =
  | { verdict: 'plain' }
  | { verdict: 'hash32' }
  | { verdict: 'transaction'; payloadHex: string }
  | { verdict: 'refuse'; reason: string };

export interface DataSignGuardOptions {
  isNem: boolean;
  /** Symbol: 既知の生成ハッシュ（今のネットワーク + メインネット + テストネット）。 */
  generationHashes: Uint8Array[];
  /** Symbol: ウォレットの公開鍵（32バイト）。署名されるバイト列には署名者の公開鍵が含まれないので、復元に使う。 */
  signerPublicKey: Uint8Array;
  /**
   * Symbol: 復元した完全なトランザクション（署名欄は0）を SDK に読み直させ、その署名対象バイト列（生成ハッシュ + 本体）を返す。読めなければ投げる。
   * 呼び出し側は、これが元のバイト列と一致するかをここで確かめる（一致しなければ「読めた」とは扱わない）。
   */
  deriveSymbolSigningBytes: (fullTransaction: Uint8Array) => Uint8Array;
  /** NEM: SDK に読み直させ、そのまま直列化し直したバイト列を返す。読めなければ投げる。 */
  reserializeNem: (bytes: Uint8Array) => Uint8Array;
}

/** 署名者の公開鍵・署名欄・予約領域より前: size(4) + reserved(4) + signature(64) + signerPublicKey(32) + reserved(4) */
const SYMBOL_TX_HEADER_SIZE = 4 + 4 + 64 + 32 + 4;
/** version(1) + network(1) + type(2) + fee(8) + deadline(8) */
const SYMBOL_MIN_BODY = 1 + 1 + 2 + 8 + 8;

export const bytesToHexUpper = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean => {
  if (prefix.length === 0 || data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
};

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 署名されるバイト列（生成ハッシュ + 本体）から、完全なトランザクション（署名欄0・署名者はウォレット）を組み立てる。 */
export function rebuildSymbolTransaction(data: Uint8Array, signerPublicKey: Uint8Array): Uint8Array {
  const body = data.subarray(32);
  const total = SYMBOL_TX_HEADER_SIZE + body.length;
  const full = new Uint8Array(total);
  new DataView(full.buffer).setUint32(0, total, true);
  full.set(signerPublicKey, 4 + 4 + 64);
  full.set(body, SYMBOL_TX_HEADER_SIZE);
  return full;
}

/** NEM のトランザクションの頭: type(4, LE) + version(4, LE。いちばん上のバイトがネットワーク 0x68 / 0x98) + timestamp(4) + signer(4+32) ... */
function looksLikeNemTransaction(data: Uint8Array): boolean {
  if (data.length < 4 + 4 + 4 + 4 + 32 + 8 + 4 + 4) return false;
  const type = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  const network = data[7];
  const typeOk = type > 0 && type <= 0xffff && data[2] === 0 && data[3] === 0;
  return typeOk && (network === 0x68 || network === 0x98);
}

export function classifyDataSignature(data: Uint8Array, opts: DataSignGuardOptions): DataSignVerdict {
  if (opts.isNem) {
    if (!looksLikeNemTransaction(data)) return { verdict: 'plain' };
    try {
      const again = opts.reserializeNem(data);
      if (!equalBytes(again, data)) return { verdict: 'refuse', reason: 'the bytes look like a NEM transaction but do not read back exactly' };
    } catch {
      return { verdict: 'refuse', reason: 'the bytes look like a NEM transaction but cannot be read' };
    }
    return { verdict: 'transaction', payloadHex: bytesToHexUpper(data) };
  }

  const hasGenerationHash = opts.generationHashes.some((h) => startsWith(data, h));
  if (!hasGenerationHash) return { verdict: data.length === 32 ? 'hash32' : 'plain' };
  // 生成ハッシュで始まる = Symbol のトランザクションへの署名の形。
  if (data.length < 32 + SYMBOL_MIN_BODY) return { verdict: 'refuse', reason: 'the bytes start with a network generation hash but are too short to be a transaction' };
  try {
    const full = rebuildSymbolTransaction(data, opts.signerPublicKey);
    const signing = opts.deriveSymbolSigningBytes(full);
    if (!equalBytes(signing, data)) return { verdict: 'refuse', reason: 'the bytes start with a network generation hash but do not read back as a transaction exactly' };
    return { verdict: 'transaction', payloadHex: bytesToHexUpper(full) };
  } catch {
    return { verdict: 'refuse', reason: 'the bytes start with a network generation hash but cannot be read as a transaction' };
  }
}
