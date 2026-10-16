// Ledger との接続を1つだけ持ち、鍵の照合と署名（署名の検算つき）をまとめる。
// 接続の開始（デバイスの選択）はブラウザの決まりで、ボタンを押した直後にしかできない。
// 画面側は、署名の前に `ensureLedgerConnected(link)` をボタンの処理の中で呼ぶこと。
import { LedgerError } from './framing';
import { getLedgerAccount, ledgerSign } from './apps';
import { openLink, supportedLinks } from './transport';
import type { LedgerTransport, LinkKind, TransportKind } from './transport';
import { addressFromPublicKey } from '../symbol/crypto';
import { nemAddressFromPublicKey } from '../nem/crypto';

let current: LedgerTransport | null = null;

const LINK_KEY = 'kasane_ledger_link';

/** 画面に出す「つなぎ方」（USBケーブル / Bluetooth）のうち、この端末で使えるもの。 */
export function availableLedgerLinks(): LinkKind[] {
  return supportedLinks();
}

/** 前回うまくつながった「つなぎ方」（なければ、使えるものの先頭）。 */
export function preferredLedgerLink(): LinkKind | null {
  const usable = availableLedgerLinks();
  try {
    const saved = localStorage.getItem(LINK_KEY) as LinkKind | null;
    if (saved && usable.includes(saved)) return saved;
  } catch { /* 保存できない環境 */ }
  return usable[0] ?? null;
}
const listeners = new Set<() => void>();

function notify() { listeners.forEach((l) => l()); }

export function subscribeLedger(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function ledgerConnection(): TransportKind | null {
  return current ? current.kind : null;
}

/** デバイスを選んで接続する（ボタンを押した直後に呼ぶ）。すでに接続していればそのまま使う。 */
export async function ensureLedgerConnected(link: LinkKind): Promise<LedgerTransport> {
  if (current) return current;
  const t = await openLink(link);
  t.onDisconnect(() => { if (current === t) { current = null; notify(); } });
  current = t;
  try { localStorage.setItem(LINK_KEY, link); } catch { /* 保存できない環境 */ }
  notify();
  return t;
}

export async function disconnectLedger(): Promise<void> {
  const t = current;
  current = null;
  notify();
  if (t) await t.close();
}

function requireConnected(): LedgerTransport {
  if (!current) throw new LedgerError('disconnected', 'not_connected');
  return current;
}

/** 接続中のデバイスから、そのアカウントの公開鍵とアドレスを読む。 */
export async function readLedgerAccount(chain: 'symbol' | 'nem', index: number, networkByte: number, display = false) {
  const t = requireConnected();
  const toAddress = chain === 'symbol' ? addressFromPublicKey : nemAddressFromPublicKey;
  try {
    return await getLedgerAccount(t, chain, index, networkByte, toAddress, display);
  } catch (e) {
    if (e instanceof LedgerError && (e.kind === 'disconnected')) { await disconnectLedger(); }
    throw e;
  }
}

/**
 * デバイスで署名する。署名の前に、デバイスのこのパスの公開鍵が `expectedPublicKey` と同じかを確かめ
 * （別のLedgerや別のニーモニックフレーズを繋いだときに止める）、署名のあとに `verify` で署名を検算する
 * （デバイスが想定と違うものに署名していたら、送らずにエラーにする）。
 */
export async function signWithLedger(
  chain: 'symbol' | 'nem',
  index: number,
  expectedPublicKey: string,
  networkByte: number,
  payload: Uint8Array,
  verify: (publicKeyHex: string, payload: Uint8Array, signature: Uint8Array) => boolean,
): Promise<Uint8Array> {
  const t = requireConnected();
  const account = await readLedgerAccount(chain, index, networkByte, false);
  if (account.publicKey.toUpperCase() !== expectedPublicKey.toUpperCase()) throw new LedgerError('key_mismatch');
  let signature: Uint8Array;
  try {
    signature = await ledgerSign(t, chain, index, networkByte, payload);
  } catch (e) {
    if (e instanceof LedgerError && e.kind === 'disconnected') { await disconnectLedger(); }
    throw e;
  }
  if (!verify(expectedPublicKey, payload, signature)) throw new LedgerError('bad_response', 'signature_verify');
  return signature;
}

/** 画面に出す文言のキー（messages.json の ledger.error_*）。 */
export function ledgerErrorKey(e: unknown): string {
  return e instanceof LedgerError ? `ledger.error_${e.kind}` : 'ledger.error_unknown';
}
