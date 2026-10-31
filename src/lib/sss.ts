// SSS Extension（Symbol の署名用ブラウザ拡張）との橋渡し。
// SSS は秘密鍵を拡張の中に持ち、ページには `window.SSS`（いま選んでいるアカウントの公開鍵など）と、
// 署名を頼む関数だけを見せる。このアプリは公開鍵だけを持ち、署名のたびに拡張へ頼む（Ledger と同じ考え方）。
// ページごとの許可（SSS の画面で「このサイトと連携」）が済んでいないと、`window.SSS` は使えない。
import { addressFromPublicKey, verifySignature } from './symbol/crypto';

interface SssObject {
  activePublicKey?: string;
  activeAddress?: string;
  activeNetworkType?: number;
  activeName?: string;
  setTransactionByPayload?: (payload: string) => void;
  requestSign?: () => Promise<{ payload: string; hash?: string }>;
}

declare global {
  interface Window {
    SSS?: SssObject;
    isAllowedSSS?: () => boolean;
  }
}

export type SssState = 'missing' | 'not_allowed' | 'ready';

export interface SssAccount {
  publicKey: string; // 大文字16進（64文字）
  name: string;
  networkType: number; // 104 = メインネット、152 = テストネット
  network: 'mainnet' | 'testnet';
  /** 公開鍵から作り直したアドレス（拡張が返す値は使わない）。 */
  address: string;
}

export type SssErrorKind = 'not_ready' | 'account_mismatch' | 'network_mismatch' | 'rejected' | 'bad_response' | 'signature_mismatch';

export class SssError extends Error {
  kind: SssErrorKind;
  constructor(kind: SssErrorKind, message?: string) {
    super(message ?? kind);
    this.kind = kind;
  }
}

export const SSS_NETWORK_TYPE = { mainnet: 0x68, testnet: 0x98 } as const;

/** SSS が入っているか・このページが許可されているか。 */
export function sssState(): SssState {
  if (typeof window === 'undefined') return 'missing';
  const hasAllowFn = typeof window.isAllowedSSS === 'function';
  if (!hasAllowFn && window.SSS === undefined) return 'missing';
  let allowed = true;
  if (hasAllowFn) {
    try { allowed = Boolean(window.isAllowedSSS?.()); } catch { allowed = false; }
  }
  return allowed && window.SSS !== undefined ? 'ready' : 'not_allowed';
}

/** SSS でいま選ばれているアカウント。使えない・値が揃っていないときは null。 */
export function readSssAccount(): SssAccount | null {
  if (sssState() !== 'ready') return null;
  const sss = window.SSS;
  const publicKey = typeof sss?.activePublicKey === 'string' ? sss.activePublicKey.toUpperCase() : '';
  const networkType = sss?.activeNetworkType;
  if (!/^[0-9A-F]{64}$/.test(publicKey)) return null;
  if (networkType !== SSS_NETWORK_TYPE.mainnet && networkType !== SSS_NETWORK_TYPE.testnet) return null;
  return {
    publicKey,
    name: typeof sss?.activeName === 'string' ? sss.activeName.trim() : '',
    networkType,
    network: networkType === SSS_NETWORK_TYPE.mainnet ? 'mainnet' : 'testnet',
    address: addressFromPublicKey(publicKey, networkType),
  };
}

/**
 * SSS に署名を頼み、署名（64バイト）だけを取り出す。
 * 署名のあとで、こちらが作ったトランザクションに対する署名かを検算する（拡張が別の内容に署名していたら止める）。
 * `signingPayload` は署名の対象（ジェネレーションハッシュ＋本体）、`serializedTx` は署名前のトランザクション全体。
 */
export async function signWithSss(input: {
  expectedPublicKey: string;
  networkByte: number;
  serializedTx: Uint8Array;
  signingPayload: Uint8Array;
}): Promise<Uint8Array> {
  const account = readSssAccount();
  if (account === null || typeof window.SSS?.setTransactionByPayload !== 'function' || typeof window.SSS?.requestSign !== 'function') {
    throw new SssError('not_ready');
  }
  if (account.publicKey !== input.expectedPublicKey.toUpperCase()) throw new SssError('account_mismatch');
  if (account.networkType !== input.networkByte) throw new SssError('network_mismatch');
  let signedPayload: string;
  try {
    window.SSS.setTransactionByPayload(Array.from(input.serializedTx, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
    const signed = await window.SSS.requestSign();
    signedPayload = String(signed?.payload ?? '');
  } catch (e) {
    throw new SssError('rejected', (e as Error)?.message);
  }
  // Symbol のトランザクション: サイズ(4) + 予約(4) + 署名(64) + 署名者の公開鍵(32) …
  if (!/^[0-9a-fA-F]+$/.test(signedPayload) || signedPayload.length < 2 * 104) throw new SssError('bad_response');
  const signature = Uint8Array.from(signedPayload.slice(16, 16 + 128).match(/../g) ?? [], (h) => parseInt(h, 16));
  if (signature.length !== 64 || !verifySignature(input.expectedPublicKey, input.signingPayload, signature)) {
    throw new SssError('signature_mismatch');
  }
  return signature;
}

/** 画面に出す文言のキー（messages.json の sss.error_*）。 */
export function sssErrorKey(e: unknown): string {
  return e instanceof SssError ? `sss.error_${e.kind}` : 'sss.error_unknown';
}

// --- 「SSS で切り替えたアカウントを、確認せず自動で追加する」設定（この端末のブラウザだけ） ---
const AUTO_ADD_KEY = 'kasane_sss_auto_add';

export function isSssAutoAdd(): boolean {
  try { return localStorage.getItem(AUTO_ADD_KEY) === '1'; } catch { return false; }
}

export function setSssAutoAdd(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_ADD_KEY, '1'); else localStorage.removeItem(AUTO_ADD_KEY);
  } catch { /* 保存できない環境 */ }
}
