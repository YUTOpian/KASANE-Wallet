// アドレス帳：連絡先の検証・JSONバックアップ・インポート（統合/置き換え）・ブラック/ホワイトリストの判定。
// ここは純粋な処理だけ（保存先や画面には依存しない）。アドレスの判定（Symbol / NEM、メインネット / テストネット）は
// 呼び出し側が `parse` として渡す（実体は watchAddress.ts の parseWatchAddress）ので、単体でテストできる。
import type { ChainKey } from './chain';

import type { SymbolNetwork } from './symbol/constants';

export type AddressNetwork = SymbolNetwork;

/** white = ホワイトリスト（信頼する相手） / black = ブラックリスト（警戒する相手）。連絡先は必ずどちらかに入る。 */
export type ContactList = 'white' | 'black';
export const CONTACT_LISTS: ContactList[] = ['white', 'black'];

/**
 * 保存済み・バックアップの値を ContactList にそろえる。black 以外は white。
 * 以前あった「通常」（none）の連絡先は、ホワイトリストとして扱う（署名依頼で未登録の警告が出ないのは、以前と同じ）。
 */
export function normalizeList(value: unknown): ContactList {
  return value === 'black' ? 'black' : 'white';
}

export interface AddressBookEntry {
  id: string;
  chain: ChainKey;
  network: AddressNetwork;
  /** ハイフンなしの大文字（parse が返す正規の形）。 */
  address: string;
  name: string;
  email: string;
  phone: string;
  memo: string;
  list: ContactList;
  createdAt: number;
  updatedAt: number;
}

export interface ParsedAddress { chain: ChainKey; network: AddressNetwork; address: string }
export type AddressParser = (input: string) => ParsedAddress | null;

export interface ContactInput {
  name: string;
  address: string;
  email?: string;
  phone?: string;
  memo?: string;
  list?: ContactList;
}

export const LIMITS = { name: 100, email: 254, phone: 40, memo: 1000, entries: 5000 } as const;

export const BACKUP_FORMAT = 'kasane-address-book';
export const BACKUP_VERSION = 1;

/** ハイフン・空白を除いた大文字。履歴のアドレスとの比較に使う。 */
export function plainAddress(address: string): string {
  return address.replace(/[-\s]/g, '').toUpperCase();
}

export function entryKey(chain: ChainKey, network: AddressNetwork, address: string): string {
  return `${chain}:${network}:${plainAddress(address)}`;
}

export function keyOf(entry: Pick<AddressBookEntry, 'chain' | 'network' | 'address'>): string {
  return entryKey(entry.chain, entry.network, entry.address);
}

export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// 制御文字を落として長さを切る（インポートしたファイルは信用しない）。
function clean(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(multiline ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '');
  return stripped.trim().slice(0, max);
}

export function isValidEmail(email: string): boolean {
  return email.length <= LIMITS.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export type ContactError = 'invalid_address' | 'invalid_email' | 'name_required' | 'duplicate' | 'limit';

export type ContactResult =
  | { ok: true; fields: Omit<AddressBookEntry, 'id' | 'createdAt' | 'updatedAt'> }
  | { ok: false; error: ContactError };

export function findEntry(entries: AddressBookEntry[], chain: ChainKey, network: AddressNetwork, address: string): AddressBookEntry | null {
  const key = entryKey(chain, network, address);
  return entries.find((e) => keyOf(e) === key) ?? null;
}

/** フォームの入力を検証して保存できる形にする。editingId は編集中の連絡先（自分自身との重複は除く）。 */
export function validateContact(input: ContactInput, entries: AddressBookEntry[], parse: AddressParser, editingId?: string): ContactResult {
  const parsed = parse(input.address.trim());
  if (!parsed) return { ok: false, error: 'invalid_address' };
  const list: ContactList = normalizeList(input.list);
  const name = clean(input.name, LIMITS.name);
  if (name === '' && list !== 'black') return { ok: false, error: 'name_required' };
  const email = clean(input.email, LIMITS.email);
  if (email !== '' && !isValidEmail(email)) return { ok: false, error: 'invalid_email' };
  const dup = findEntry(entries, parsed.chain, parsed.network, parsed.address);
  if (dup && dup.id !== editingId) return { ok: false, error: 'duplicate' };
  return {
    ok: true,
    fields: {
      chain: parsed.chain,
      network: parsed.network,
      address: parsed.address,
      name,
      email,
      phone: clean(input.phone, LIMITS.phone),
      memo: clean(input.memo, LIMITS.memo, true),
      list,
    },
  };
}

// ---- バックアップ（JSON） ------------------------------------------------------------------------

export function serializeBackup(entries: AddressBookEntry[], now = Date.now()): string {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    entries: entries.map((e) => ({
      chain: e.chain, network: e.network, address: e.address, name: e.name,
      email: e.email, phone: e.phone, memo: e.memo, list: e.list,
      createdAt: e.createdAt, updatedAt: e.updatedAt,
    })),
  }, null, 2);
}

export class BackupFormatError extends Error {
  constructor() { super('invalid_backup'); }
}

export interface ParsedBackup { entries: AddressBookEntry[]; skipped: number }

/** バックアップのJSONを読む。形式が違えば BackupFormatError。読めない行は skipped に数える。 */
export function parseBackup(text: string, parse: AddressParser, now = Date.now()): ParsedBackup {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new BackupFormatError(); }
  const rows = Array.isArray(data) ? data : (data as { format?: unknown; entries?: unknown } | null)?.entries;
  if (!Array.isArray(data) && (data as { format?: unknown } | null)?.format !== BACKUP_FORMAT) throw new BackupFormatError();
  if (!Array.isArray(rows)) throw new BackupFormatError();

  const byKey = new Map<string, AddressBookEntry>();
  let skipped = 0;
  for (const row of rows.slice(0, LIMITS.entries + 1)) {
    if (byKey.size >= LIMITS.entries) { skipped += 1; continue; }
    const r = (row ?? {}) as Record<string, unknown>;
    const parsed = typeof r.address === 'string' ? parse(r.address.trim()) : null;
    if (!parsed) { skipped += 1; continue; }
    const list: ContactList = normalizeList(r.list);
    const name = clean(r.name, LIMITS.name);
    const email = clean(r.email, LIMITS.email);
    const created = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now;
    const updated = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : created;
    const entry: AddressBookEntry = {
      id: newId(),
      chain: parsed.chain,
      network: parsed.network,
      address: parsed.address,
      name,
      email: email !== '' && isValidEmail(email) ? email : '',
      phone: clean(r.phone, LIMITS.phone),
      memo: clean(r.memo, LIMITS.memo, true),
      list,
      createdAt: created,
      updatedAt: updated,
    };
    byKey.set(keyOf(entry), entry); // 同じアドレスが重複していたら後のものが勝つ
  }
  return { entries: [...byKey.values()], skipped };
}

export type ImportMode = 'merge' | 'replace';

export interface MergeResult { entries: AddressBookEntry[]; added: number; updated: number }

/** merge: 同じアドレスは取り込んだ内容で更新し、無いものは追加。replace: 取り込んだものだけにする。 */
export function mergeImported(existing: AddressBookEntry[], incoming: AddressBookEntry[], mode: ImportMode, now = Date.now()): MergeResult {
  if (mode === 'replace') return { entries: incoming.slice(0, LIMITS.entries), added: incoming.length, updated: 0 };
  const result = [...existing];
  const index = new Map(result.map((e, i) => [keyOf(e), i]));
  let added = 0;
  let updated = 0;
  for (const inc of incoming) {
    const at = index.get(keyOf(inc));
    if (at !== undefined) {
      const old = result[at];
      result[at] = { ...inc, id: old.id, createdAt: old.createdAt, updatedAt: now };
      updated += 1;
    } else if (result.length < LIMITS.entries) {
      index.set(keyOf(inc), result.length);
      result.push(inc);
      added += 1;
    }
  }
  return { entries: result, added, updated };
}

// ---- 信頼度（署名依頼・送金先・履歴の判定） --------------------------------------------------------

/** self = 自分のアカウント / white = ホワイトリスト / black = ブラックリスト / unknown = アドレス帳に無い。 */
export type Trust = 'self' | 'white' | 'black' | 'unknown';

export function trustOf(
  entries: AddressBookEntry[],
  chain: ChainKey,
  network: AddressNetwork,
  address: string,
  ownAddresses: ReadonlySet<string> = new Set(),
): { trust: Trust; entry: AddressBookEntry | null } {
  const entry = findEntry(entries, chain, network, address);
  // ブラックリストは自分のアカウントより優先しない（自分のアドレスを誤ってブロックしても締め出されないように）。
  if (ownAddresses.has(plainAddress(address))) return { trust: 'self', entry };
  if (!entry) return { trust: 'unknown', entry: null };
  if (entry.list === 'black') return { trust: 'black', entry };
  return { trust: 'white', entry };
}

/** ブラックリストのアドレス（比較用に plainAddress にしたもの）。自分のアドレスは含めない。 */
export function blockedAddresses(entries: AddressBookEntry[], chain: ChainKey, network: AddressNetwork, ownAddresses: ReadonlySet<string> = new Set()): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.list === 'black' && e.chain === chain && e.network === network && !ownAddresses.has(plainAddress(e.address))) set.add(plainAddress(e.address));
  }
  return set;
}

/** 表示名：名前があれば名前、無ければ短縮したアドレス。 */
export function displayName(entry: Pick<AddressBookEntry, 'name' | 'address'>): string {
  if (entry.name) return entry.name;
  const a = plainAddress(entry.address);
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
