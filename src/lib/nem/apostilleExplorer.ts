// アポスティーユのエクスプローラー — 公式 NEM Wallet（NanoWallet）の「Explorer - Apostilles」と同じ仕組み。
//   公証用のシンクアカウントに届いた送金（incoming）のうち、メッセージが 0xFE 'N' 'T' 'Y' で始まるものだけを並べる。
//   公開（パブリック）のアポスティーユはシンクに送られる。署名つき（非公開）のものは専用アカウントに送られるので、ここには出ない。
//   マルチシグの送金（type 4100）は、中に入っている送金のメッセージを見る。
// ここは取得と絞り込みだけ（通信は `request` を受け取る。テスト: dev-tests/nem-apostille-explorer.test.ts）。
import { APOSTILLE_PREFIX } from './apostille';
import { NEM_EPOCH_SECONDS, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';

/** NIS1 returns at most 25 entries per request. */
export const APOSTILLE_EXPLORER_PAGE_SIZE = 25;

interface RawTransfer {
  signer?: string;
  timeStamp?: number;
  message?: { payload?: string };
}

export interface RawSinkEntry {
  meta?: { id?: number; hash?: { data?: string }; innerHash?: { data?: string } };
  transaction?: RawTransfer & { type?: number; otherTrans?: RawTransfer };
}

export interface ApostilleExplorerRow {
  /** Hash that identifies the row (the inner transaction's hash for a multisig transfer). */
  txHash: string;
  /** Public key (hex) of the account that notarized: for a multisig transfer, the multisig account itself. */
  signer: string;
  /** The recorded message (hex, lower case): the 4-byte prefix, the hash type and the file hash. */
  payloadHex: string;
  timestampMs: number;
}

/** Keeps only the apostille messages, newest first as the node lists them. */
export function parseApostilleExplorerEntries(entries: RawSinkEntry[]): ApostilleExplorerRow[] {
  const rows: ApostilleExplorerRow[] = [];
  for (const entry of entries) {
    const outer = entry.transaction;
    if (!outer) continue;
    let inner: RawTransfer | undefined;
    let txHash: string | undefined;
    if (outer.type === NEM_TX_TYPE_TRANSFER) {
      inner = outer;
      txHash = entry.meta?.hash?.data;
    } else if (outer.type === NEM_TX_TYPE_MULTISIG) {
      inner = outer.otherTrans;
      txHash = entry.meta?.innerHash?.data ?? entry.meta?.hash?.data;
    }
    const payload = inner?.message?.payload?.toLowerCase();
    const signer = inner?.signer ?? outer.signer;
    if (!inner || !txHash || !signer || !payload || !payload.startsWith(APOSTILLE_PREFIX)) continue;
    rows.push({ txHash, signer: signer.toUpperCase(), payloadHex: payload, timestampMs: (NEM_EPOCH_SECONDS + (outer.timeStamp ?? 0)) * 1000 });
  }
  return rows;
}

export interface ApostilleExplorerPage {
  rows: ApostilleExplorerRow[];
  /** Pass to the next call to read the older entries. */
  nextId: number | undefined;
  /** False once the node has no older entry. */
  hasMore: boolean;
}

/** One page of the sink's incoming transfers (`lastId` = the `nextId` of the page before it). */
export async function fetchApostilleExplorerPage(
  request: <T>(path: string) => Promise<T>,
  sink: string,
  lastId?: number,
): Promise<ApostilleExplorerPage> {
  const res = await request<{ data?: RawSinkEntry[] }>(
    `/account/transfers/incoming?address=${sink}&pageSize=${APOSTILLE_EXPLORER_PAGE_SIZE}${lastId !== undefined ? `&id=${lastId}` : ''}`,
  );
  const entries = res.data ?? [];
  const nextId = entries.length > 0 ? entries[entries.length - 1].meta?.id : undefined;
  return { rows: parseApostilleExplorerEntries(entries), nextId, hasMore: entries.length >= APOSTILLE_EXPLORER_PAGE_SIZE && nextId !== undefined };
}
