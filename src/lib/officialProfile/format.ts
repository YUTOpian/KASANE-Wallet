// Symbol 公式ウォレット（symbol-desktop-wallet 1.2.0）のプロファイルデータの形式。
// ブラウザ版の公式ウォレットは、プロファイルとアカウントを localStorage に JSON で持つ：
//   profiles                … { version, data: { [profileName]: ProfileModel } }
//   accounts                … { version, data: { [accountId]: AccountModel } }
//   (settings / addressBookPerProfile もあるが、無くても既定値で動くので扱わない)
// この形式の読み取り・組み立てと、パスワードまわりの暗号（SDK の Crypto.encrypt / decrypt と同じ方式）を
// 扱う。KASANE の保存先（localForage）や鍵の導出には依存しない純粋な部分。
import { sha3_512 } from '@noble/hashes/sha3.js';

// 公式ウォレット 1.2.0 の VersionedObjectStorage の版数（= マイグレーション数 + 1）。
// 版数が合わないと、公式ウォレットは起動時にデータを移行（古い場合は消去）する、または読めずに止まる
// （新しい場合は例外）ので、書き出すときはこの値を使う。
export const OFFICIAL_STORAGE_VERSIONS = { profiles: 8, accounts: 7 } as const;
export const OFFICIAL_STORAGE_KEYS = { profiles: 'profiles', accounts: 'accounts' } as const;

export const OFFICIAL_NETWORK_TYPE = { mainnet: 104, testnet: 152 } as const;

export const OFFICIAL_ACCOUNT_TYPE = {
  SEED: 1,
  PRIVATE_KEY: 2,
  KEYSTORE: 3,
  TREZOR: 4,
  LEDGER: 5,
  OPT_IN: 6,
  LEDGER_OPT_IN: 7,
} as const;

export interface OfficialProfile {
  profileName: string;
  accounts: string[];
  /** ニーモニックを公式ウォレットのパスワードで暗号化したもの。無いときは空文字。 */
  seed: string;
  /** パスワードの SHA3-512（16進）。パスワード自体は持たない。 */
  password: string;
  hint: string;
  networkType: number;
  generationHash: string;
  termsAndConditionsApproved: boolean;
  selectedNodeUrlToConnect: string;
}

export interface OfficialAccount {
  id: string;
  name: string;
  profileName: string;
  node: string;
  type: number;
  /** ハイフンなしのアドレス。 */
  address: string;
  publicKey: string;
  /** 秘密鍵を公式ウォレットのパスワードで暗号化したもの。Ledger などは空文字。 */
  encryptedPrivateKey: string;
  path: string;
  isMultisig: boolean;
  encRemoteAccountPrivateKey?: string;
}

export interface OfficialData {
  profiles: Record<string, OfficialProfile>;
  accounts: Record<string, OfficialAccount>;
  /** 読み込んだデータの版数（無ければ undefined）。 */
  versions: { profiles?: number; accounts?: number };
}

export type OfficialFormatErrorCode = 'empty' | 'not-json' | 'no-profiles' | 'bad-shape';

export class OfficialFormatError extends Error {
  code: OfficialFormatErrorCode;
  constructor(code: OfficialFormatErrorCode) {
    super(code);
    this.name = 'OfficialFormatError';
    this.code = code;
  }
}

// --- bytes / text helpers -----------------------------------------------------------------
const encoder = new TextEncoder();

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

function bytesToHex(bytes: Uint8Array, upper = false): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return upper ? out.toUpperCase() : out;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// --- password hash / encryption (same as symbol-sdk's Crypto.encrypt / decrypt) ---------------

/** 公式ウォレットが profile.password に入れる値：パスワード（UTF-8）の SHA3-512 を大文字の16進で。 */
export function officialPasswordHash(password: string): string {
  return bytesToHex(sha3_512(utf8(password)), true);
}

export function officialPasswordMatches(profile: Pick<OfficialProfile, 'password'>, password: string): boolean {
  const expected = String(profile.password ?? '').toUpperCase();
  const actual = officialPasswordHash(password);
  if (expected.length !== actual.length) return false;
  // 全桁を比べる（途中で止めない）。
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// SDK の Crypto.encrypt: salt(16) と iv(16) をランダムに作り、PBKDF2（CryptoJS の既定＝HMAC-SHA1、1024 回、32 バイト）で
// 鍵を作り、AES-256-CBC（PKCS#7）で暗号化する。出力は 「salt の16進(32桁) + iv の16進(32桁) + 暗号文の Base64」。
// ※ 公式ウォレットが使う crypto-js は PBKDF2 の既定が SHA-1。KASANE が入れている crypto-js 4.2 は既定が SHA-256 に
//   変わっているので、crypto-js は使わず、ここで SHA-1 を明示している。
const PBKDF2_ITERATIONS = 1024;

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-1' },
    base,
    { name: 'AES-CBC', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function officialEncrypt(plain: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, utf8(plain)));
  return bytesToHex(salt) + bytesToHex(iv) + bytesToBase64(cipher);
}

/** 復号に失敗（形式が違う・パスワードが違う・壊れている）したら null。 */
export async function officialDecrypt(encrypted: string, password: string): Promise<string | null> {
  try {
    if (typeof encrypted !== 'string' || encrypted.length <= 64) return null;
    const head = encrypted.slice(0, 64);
    if (!/^[0-9a-fA-F]{64}$/.test(head)) return null;
    const salt = hexToBytes(head.slice(0, 32));
    const iv = hexToBytes(head.slice(32, 64));
    const cipher = base64ToBytes(encrypted.slice(64));
    const key = await deriveKey(password, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, cipher);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

// --- reading what the person gives us -----------------------------------------------------

/** 値が JSON の文字列（localStorage の中身そのまま）でもオブジェクトでも受ける。 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** { version, data } の形なら中身（data）と版数を、そうでなければ値そのものを返す。 */
function unwrapVersioned(value: unknown): { data: Record<string, unknown> | null; version?: number } {
  const obj = asObject(value);
  if (obj === null) return { data: null };
  if (typeof obj.version === 'number' && obj.data !== undefined) {
    return { data: asObject(obj.data), version: obj.version };
  }
  return { data: obj };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function toProfile(name: string, raw: unknown): OfficialProfile | null {
  const o = asObject(raw);
  if (o === null) return null;
  const profileName = str(o.profileName) || name;
  if (profileName === '') return null;
  return {
    profileName,
    accounts: Array.isArray(o.accounts) ? o.accounts.filter((a): a is string => typeof a === 'string') : [],
    seed: str(o.seed),
    password: str(o.password),
    hint: str(o.hint),
    networkType: typeof o.networkType === 'number' ? o.networkType : 0,
    generationHash: str(o.generationHash),
    termsAndConditionsApproved: o.termsAndConditionsApproved === true,
    selectedNodeUrlToConnect: str(o.selectedNodeUrlToConnect),
  };
}

function toAccount(id: string, raw: unknown): OfficialAccount | null {
  const o = asObject(raw);
  if (o === null) return null;
  if (typeof o.type !== 'number') return null;
  return {
    id: str(o.id) || id,
    name: str(o.name),
    profileName: str(o.profileName),
    node: str(o.node),
    type: o.type,
    address: str(o.address),
    publicKey: str(o.publicKey).toUpperCase(),
    encryptedPrivateKey: str(o.encryptedPrivateKey),
    path: str(o.path),
    isMultisig: o.isMultisig === true,
    encRemoteAccountPrivateKey: typeof o.encRemoteAccountPrivateKey === 'string' ? o.encRemoteAccountPrivateKey : undefined,
  };
}

/**
 * 公式ウォレットのデータを読む。受け付ける形：
 *  - localStorage の `profiles` と `accounts` を並べた JSON（値は文字列でもオブジェクトでもよい）
 *    例: { "profiles": "{\"version\":8,\"data\":{…}}", "accounts": "{…}" }
 *  - localStorage 全体を JSON.stringify したもの（同じ形。ほかのキーは無視する）
 *  - KASANE が書き出したファイル（同じ形に "format" などが付いたもの）
 */
export function parseOfficialData(text: string): OfficialData {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') throw new OfficialFormatError('empty');
  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    throw new OfficialFormatError('not-json');
  }
  const top = asObject(root);
  if (top === null) throw new OfficialFormatError('bad-shape');

  const profilesRaw = unwrapVersioned(top[OFFICIAL_STORAGE_KEYS.profiles]);
  if (profilesRaw.data === null || Object.keys(profilesRaw.data).length === 0) throw new OfficialFormatError('no-profiles');
  const accountsRaw = unwrapVersioned(top[OFFICIAL_STORAGE_KEYS.accounts]);

  const profiles: Record<string, OfficialProfile> = {};
  for (const [name, raw] of Object.entries(profilesRaw.data)) {
    const profile = toProfile(name, raw);
    if (profile !== null) profiles[profile.profileName] = profile;
  }
  if (Object.keys(profiles).length === 0) throw new OfficialFormatError('bad-shape');

  const accounts: Record<string, OfficialAccount> = {};
  for (const [id, raw] of Object.entries(accountsRaw.data ?? {})) {
    const account = toAccount(id, raw);
    if (account !== null) accounts[account.id] = account;
  }
  return { profiles, accounts, versions: { profiles: profilesRaw.version, accounts: accountsRaw.version } };
}

// --- writing it back ----------------------------------------------------------------------

export interface OfficialExport {
  profiles: { version: number; data: Record<string, OfficialProfile> };
  accounts: { version: number; data: Record<string, OfficialAccount> };
}

export function buildOfficialExport(profile: OfficialProfile, accounts: OfficialAccount[]): OfficialExport {
  const accountData: Record<string, OfficialAccount> = {};
  for (const account of accounts) accountData[account.id] = account;
  return {
    profiles: { version: OFFICIAL_STORAGE_VERSIONS.profiles, data: { [profile.profileName]: profile } },
    accounts: { version: OFFICIAL_STORAGE_VERSIONS.accounts, data: accountData },
  };
}

/** 書き出すファイルの中身（JSON）。parseOfficialData でそのまま読み戻せる。 */
export function officialExportToJson(data: OfficialExport): string {
  return JSON.stringify({ format: 'kasane-official-profile', version: 1, ...data }, null, 2);
}

/**
 * 公式ウォレットのページ（ブラウザの開発者ツールのコンソール）に貼って実行するスクリプト。
 * 公式ウォレットの localStorage の `profiles` / `accounts` に、このプロファイルを**追加**する
 * （すでにあるプロファイルは消さない。同じ名前のプロファイルがあれば、上書きせずに何もしない）。
 * 実行後にページを読み込み直す。
 */
export function officialConsoleScript(data: OfficialExport): string {
  const payload = JSON.stringify({ profiles: data.profiles, accounts: data.accounts });
  return `(() => {
  const incoming = ${payload};
  const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } };
  const profiles = read('profiles') || { version: incoming.profiles.version, data: {} };
  const accounts = read('accounts') || { version: incoming.accounts.version, data: {} };
  const added = [];
  for (const name of Object.keys(incoming.profiles.data)) {
    if (profiles.data[name]) { console.warn('同じ名前のプロファイルがあるので追加しませんでした: ' + name); continue; }
    profiles.data[name] = incoming.profiles.data[name];
    for (const id of incoming.profiles.data[name].accounts) accounts.data[id] = incoming.accounts.data[id];
    added.push(name);
  }
  if (added.length === 0) return 'nothing added';
  localStorage.setItem('profiles', JSON.stringify(profiles));
  localStorage.setItem('accounts', JSON.stringify(accounts));
  location.reload();
  return 'added: ' + added.join(', ');
})()`;
}

/** 公式ウォレットのページのコンソールに貼って、データを取り出す（コピーする）ためのスクリプト。 */
export const OFFICIAL_EXTRACT_SCRIPT =
  "copy(JSON.stringify({ profiles: localStorage.getItem('profiles'), accounts: localStorage.getItem('accounts') }))";

// --- derivation path ----------------------------------------------------------------------

/** "m/44'/4343'/3'/0'/0'" → { coinType: 4343, index: 3 }。この形でなければ null。 */
export function parseOfficialPath(path: string): { coinType: number; index: number } | null {
  const m = /^m\/44'\/(\d+)'\/(\d+)'\/\d+'\/\d+'/.exec(path);
  if (!m) return null;
  return { coinType: Number(m[1]), index: Number(m[2]) };
}
