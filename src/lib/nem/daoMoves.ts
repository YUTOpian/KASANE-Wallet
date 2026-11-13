// NEM 版 DAO: ノードが返す送金（/account/transfers/…・/account/unconfirmedTransactions）を読みやすい形にする。通信しない。
// 画面（dao.ts）と自動ボット（src/server/nem-dao-bot）の両方が使う。
import { NEM_EPOCH_SECONDS, NEM_TX_TYPE_MULTISIG, NEM_TX_TYPE_TRANSFER } from './constants';
import { nemAddressFromPublicKey, normalizeNemAddress } from './crypto';

/** 送金に添えるモザイクの量は「量 × 倍率」。倍率は取引の amount（1,000,000 = 1 倍）。 */
export const NEM_MOSAIC_MULTIPLIER_ONE = 1_000_000n;

export interface RawMove {
  meta?: { id?: number; hash?: { data?: string }; innerHash?: { data?: string } };
  transaction: RawMoveTx;
}

export interface RawMoveTx {
  type: number;
  signer: string;
  version?: number;
  timeStamp?: number;
  amount?: number | string;
  recipient?: string;
  message?: { payload?: string; type?: number };
  mosaics?: Array<{ quantity?: number | string; mosaicId?: { namespaceId?: string; name?: string } }>;
  otherTrans?: RawMoveTx;
}

export interface DaoMove {
  hash: string;
  from: string; // 送り主のアドレス
  to: string;
  message: string | null;
  mosaics: Map<string, bigint>; // モザイク ID → 実際に動く量（量 × 倍率）
  /** 取引の時刻（Unix ミリ秒）。読めなければ null。 */
  timeMs: number | null;
}

const hexToBytes = (hex: string): Uint8Array => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

export const hexToUtf8 = (hex: string): string => {
  try { return new TextDecoder().decode(hexToBytes(hex)); } catch { return ''; }
};

/** 量 × 倍率（1,000,000 = 1 倍）。倍率が 1 倍でない送金（例: 0 倍）は、見かけの量より少なくしか動かない。 */
export const effectiveQuantity = (quantity: bigint, multiplier: bigint): bigint => (quantity * multiplier) / NEM_MOSAIC_MULTIPLIER_ONE;

/**
 * ノードの 1 件（マルチシグ経由なら中身の送金）を DaoMove にする。送金でないもの・宛先の無いものは null。
 * `defaultNetworkByte` は、取引の version からネットワークが読めないときの値。
 */
export function toDaoMove(entry: RawMove, defaultNetworkByte: number): DaoMove | null {
  const tx = entry.transaction.type === NEM_TX_TYPE_MULTISIG && entry.transaction.otherTrans ? entry.transaction.otherTrans : entry.transaction;
  if (tx.type !== NEM_TX_TYPE_TRANSFER || !tx.recipient) return null;
  const networkByte = ((tx.version ?? 0) >>> 24) & 0xff || defaultNetworkByte;
  let multiplier = NEM_MOSAIC_MULTIPLIER_ONE;
  try { multiplier = BigInt(tx.amount ?? 0); } catch { multiplier = 0n; }
  const mosaics = new Map<string, bigint>();
  for (const m of tx.mosaics ?? []) {
    if (!m.mosaicId) continue;
    const id = `${m.mosaicId.namespaceId}:${m.mosaicId.name}`.toLowerCase();
    let quantity = 0n;
    try { quantity = BigInt(m.quantity ?? 0); } catch { quantity = 0n; }
    mosaics.set(id, (mosaics.get(id) ?? 0n) + effectiveQuantity(quantity, multiplier));
  }
  const stamp = entry.transaction.timeStamp ?? tx.timeStamp;
  return {
    hash: (entry.meta?.hash?.data ?? '').toUpperCase(),
    from: nemAddressFromPublicKey(tx.signer, networkByte),
    to: normalizeNemAddress(tx.recipient),
    message: tx.message?.type === 1 && tx.message.payload ? hexToUtf8(tx.message.payload) : null,
    mosaics,
    timeMs: typeof stamp === 'number' ? (NEM_EPOCH_SECONDS + stamp) * 1000 : null,
  };
}
