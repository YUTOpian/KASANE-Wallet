// アポスティーユの履歴（.nty ファイル）— NanoWallet の「Nty file」と同じ形。この端末に保存し、バックアップとして書き出し・読み込みできる。
//   {"data":[{"filename","tags","fileHash","owner","fromMultisig","dedicatedAccount","dedicatedPrivateKey","txHash","txMultisigHash","timeStamp"}]}
// fileHash は取引のメッセージ（16進、先頭 fe4e5459）。専用アカウントの秘密鍵は、自分の鍵とファイル名からいつでも計算できるので、このアプリは保存しない。
export interface ApostilleRecord {
  filename: string;
  tags: string;
  /** The transaction message (hex, starting with fe4e5459). */
  fileHash: string;
  /** Account that made the apostille (address). */
  owner: string;
  fromMultisig: string;
  /** Account the apostille was sent to: the dedicated account (signed) or the sink (public). */
  dedicatedAccount: string;
  dedicatedPrivateKey?: string;
  txHash: string;
  txMultisigHash: string;
  /** UTC string, e.g. "Mon, 12 Oct 2026 11:00:00 GMT". */
  timeStamp: string;
}

export interface NtyFile {
  data: ApostilleRecord[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Reads a .nty JSON text. Null when it is not one; records without a transaction hash are skipped. */
export function parseNty(text: string): NtyFile | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const list = (json as { data?: unknown })?.data;
  if (!Array.isArray(list)) return null;
  const data: ApostilleRecord[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const txHash = str(r.txHash).toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(txHash)) continue;
    const record: ApostilleRecord = {
      filename: str(r.filename),
      tags: str(r.tags),
      fileHash: str(r.fileHash).toLowerCase(),
      owner: str(r.owner),
      fromMultisig: str(r.fromMultisig),
      dedicatedAccount: str(r.dedicatedAccount),
      txHash,
      txMultisigHash: str(r.txMultisigHash).toUpperCase(),
      timeStamp: str(r.timeStamp),
    };
    if (str(r.dedicatedPrivateKey)) record.dedicatedPrivateKey = str(r.dedicatedPrivateKey);
    data.push(record);
  }
  return { data };
}

/** `incoming` added to `existing`; a record already there (same transaction hash) is kept as it is. */
export function mergeNty(existing: ApostilleRecord[], incoming: ApostilleRecord[]): { records: ApostilleRecord[]; added: number } {
  const seen = new Set(existing.map((r) => r.txHash));
  const records = [...existing];
  let added = 0;
  for (const r of incoming) {
    if (seen.has(r.txHash)) continue;
    seen.add(r.txHash);
    records.push(r);
    added += 1;
  }
  return { records, added };
}

export function serializeNty(records: ApostilleRecord[]): string {
  return JSON.stringify({ data: records } satisfies NtyFile);
}
