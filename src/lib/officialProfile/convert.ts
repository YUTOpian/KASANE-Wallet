// Symbol 公式ウォレットのプロファイル ⇔ KASANE のプロファイル の変換。
// 形式そのものの読み書きは format.ts。ここは「パスワードで開く」「KASANE に保存する」「KASANE から作る」。
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../passwordPolicy';
import { compareAccounts, PinCodeHelper, Wallet, WalletsHelper } from '../storage';
import { profileAccounts } from '../accounts';
import { keyPairFromPrivateKey, addressFromPublicKey } from '../symbol/crypto';
import { MnemonicHelper, PROFILE_ACCOUNT_COUNT, SYMBOL_MAINNET_COIN_TYPE, SYMBOL_TESTNET_COIN_TYPE, symbolPath } from '../symbol/hd';
import { getNetwork } from '../symbol/network';
import { NETWORKS } from '../symbol/constants';
import type { PublicNetwork } from '../symbol/constants';
import {
  buildOfficialExport,
  OFFICIAL_ACCOUNT_TYPE,
  OFFICIAL_NETWORK_TYPE,
  officialDecrypt,
  officialEncrypt,
  officialPasswordHash,
  officialPasswordMatches,
  parseOfficialPath,
} from './format';
import type { OfficialAccount, OfficialData, OfficialExport, OfficialProfile } from './format';

// KASANE のパスワードの決まり（bcrypt は 72 バイトまで）。
export const KASANE_MIN_PASSWORD = MIN_PASSWORD_LENGTH;
export const KASANE_MAX_PASSWORD_BYTES = 72;
// 1つのプロファイルに事前に導出しておくインデックスの上限（これを超えるものは秘密鍵のアカウントとして持ち込む）。
const MAX_DERIVED_INDEX_COUNT = 200;

export function isKasanePasswordUsable(password: string): boolean {
  return passwordProblem(password) === null && new TextEncoder().encode(password).length <= KASANE_MAX_PASSWORD_BYTES;
}

// --- listing -------------------------------------------------------------------------------

export interface OfficialProfileSummary {
  profileName: string;
  network: PublicNetwork | null;
  accountCount: number;
  hasSeed: boolean;
}

function networkOf(profile: OfficialProfile): PublicNetwork | null {
  if (profile.networkType === OFFICIAL_NETWORK_TYPE.mainnet) return 'mainnet';
  if (profile.networkType === OFFICIAL_NETWORK_TYPE.testnet) return 'testnet';
  return null;
}

/** プロファイルに属するアカウント。profile.accounts の並びを優先し、空なら profileName が合うものを使う。 */
function accountsOf(data: OfficialData, profile: OfficialProfile): OfficialAccount[] {
  const listed = profile.accounts.map((id) => data.accounts[id]).filter((a): a is OfficialAccount => a !== undefined);
  if (listed.length > 0) return listed;
  return Object.values(data.accounts).filter((a) => a.profileName === profile.profileName);
}

/**
 * KASANE にすでにある Symbol の公開鍵（大文字）。1つのアカウントは、メインネット用（m/44'/4343'）の鍵と、
 * 公式互換のテストネット用（m/44'/1'）の鍵の両方を持ち、テストネット表示中は publicKey がテストネット用に差し替わっている。
 * どちらの鍵で公式のプロファイルが入っていても「すでにある」と分かるよう、3つとも集める。
 */
export async function existingSymbolPublicKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const w of await WalletsHelper.gets()) {
    if (w.chain !== 'symbol') continue;
    for (const k of [w.publicKey, w.testnetPublicKey, w.stash?.publicKey]) {
      if (k) keys.add(k.toUpperCase());
    }
  }
  return keys;
}

/** 公式のプロファイルにあるアカウントの公開鍵（パスワード無しで読める）。KASANE にすでにあるかの判定に使う。 */
export function officialPublicKeys(data: OfficialData, profileName: string): string[] {
  const profile = data.profiles[profileName];
  if (!profile) return [];
  return accountsOf(data, profile).map((a) => a.publicKey).filter((k) => /^[0-9A-F]{64}$/.test(k));
}

export function listOfficialProfiles(data: OfficialData): OfficialProfileSummary[] {
  return Object.values(data.profiles).map((profile) => ({
    profileName: profile.profileName,
    network: networkOf(profile),
    accountCount: accountsOf(data, profile).length,
    hasSeed: profile.seed !== '',
  }));
}

// --- open (official → memory) ----------------------------------------------------------------

export type SkipReason = 'trezor' | 'ledger-optin' | 'unsupported-type' | 'key-unreadable' | 'key-mismatch' | 'ledger-path';

export interface OpenedAccount {
  name: string;
  /** derived: ニーモニックのインデックスから導出できるもの / imported: 秘密鍵として持ち込むもの / ledger */
  kind: 'derived' | 'imported' | 'ledger';
  index: number | null;
  publicKey: string;
  privateKey: string | null;
}

export interface OpenedProfile {
  profileName: string;
  network: PublicNetwork | null;
  mnemonic: string | null;
  /** 公式ウォレットにニーモニックがあったが、開けなかった（壊れている）。 */
  mnemonicUnreadable: boolean;
  accounts: OpenedAccount[];
  skipped: { name: string; reason: SkipReason }[];
}

export type OpenResult =
  | { ok: true; profile: OpenedProfile }
  | { ok: false; reason: 'no-profile' | 'wrong-password' | 'no-accounts' };

const HEX64 = /^[0-9a-fA-F]{64}$/;

function pathIndexOrMax(account: OfficialAccount): number {
  return parseOfficialPath(account.path)?.index ?? Number.MAX_SAFE_INTEGER;
}

/** 公式ウォレットのパスワードで、プロファイルのニーモニックと各アカウントの秘密鍵を取り出す（メモリの中だけ）。 */
export async function openOfficialProfile(data: OfficialData, profileName: string, password: string): Promise<OpenResult> {
  const profile = data.profiles[profileName];
  if (!profile) return { ok: false, reason: 'no-profile' };
  if (!officialPasswordMatches(profile, password)) return { ok: false, reason: 'wrong-password' };

  const list = accountsOf(data, profile);
  if (list.length === 0) return { ok: false, reason: 'no-accounts' };

  let mnemonic: string | null = null;
  let mnemonicUnreadable = false;
  if (profile.seed !== '') {
    const phrase = await officialDecrypt(profile.seed, password);
    if (phrase !== null && MnemonicHelper.isValid(phrase)) mnemonic = MnemonicHelper.normalize(phrase);
    else mnemonicUnreadable = true;
  }

  const accounts: OpenedAccount[] = [];
  const skipped: OpenedProfile['skipped'] = [];
  const seen = new Set<string>();
  const sorted = [...list].sort((a, b) => pathIndexOrMax(a) - pathIndexOrMax(b));

  for (const account of sorted) {
    const name = account.name;
    const type = account.type;

    if (type === OFFICIAL_ACCOUNT_TYPE.TREZOR) { skipped.push({ name, reason: 'trezor' }); continue; }
    if (type === OFFICIAL_ACCOUNT_TYPE.LEDGER_OPT_IN) { skipped.push({ name, reason: 'ledger-optin' }); continue; }

    if (type === OFFICIAL_ACCOUNT_TYPE.LEDGER) {
      const parsed = parseOfficialPath(account.path);
      if (!parsed || parsed.coinType !== 4343 || !HEX64.test(account.publicKey)) { skipped.push({ name, reason: 'ledger-path' }); continue; }
      if (seen.has(account.publicKey)) continue;
      seen.add(account.publicKey);
      accounts.push({ name, kind: 'ledger', index: parsed.index, publicKey: account.publicKey.toUpperCase(), privateKey: null });
      continue;
    }

    const isKeyType = type === OFFICIAL_ACCOUNT_TYPE.SEED || type === OFFICIAL_ACCOUNT_TYPE.PRIVATE_KEY
      || type === OFFICIAL_ACCOUNT_TYPE.KEYSTORE || type === OFFICIAL_ACCOUNT_TYPE.OPT_IN;
    if (!isKeyType) { skipped.push({ name, reason: 'unsupported-type' }); continue; }

    const privateKey = await officialDecrypt(account.encryptedPrivateKey, password);
    if (privateKey === null || !HEX64.test(privateKey)) { skipped.push({ name, reason: 'key-unreadable' }); continue; }
    const pair = keyPairFromPrivateKey(privateKey);
    // 保存されている公開鍵と、秘密鍵から作った公開鍵が同じか（壊れていないか）を確かめる。
    if (account.publicKey !== '' && pair.publicKey !== account.publicKey.toUpperCase()) { skipped.push({ name, reason: 'key-mismatch' }); continue; }
    if (seen.has(pair.publicKey)) continue;
    seen.add(pair.publicKey);

    // ニーモニックの m/44'/<コイン種別>'/n'/0'/0' から導出できる鍵なら、KASANE でもインデックス n のアカウントとして扱える。
    // コイン種別は、メインネットが 4343、テストネットが 1（公式ウォレットと同じ。KASANE も新しいプロファイルはテストネットで 1 を使う）。
    let index: number | null = null;
    const parsed = parseOfficialPath(account.path);
    const coinType = profile.networkType === OFFICIAL_NETWORK_TYPE.testnet ? SYMBOL_TESTNET_COIN_TYPE : SYMBOL_MAINNET_COIN_TYPE;
    if (type === OFFICIAL_ACCOUNT_TYPE.SEED && mnemonic !== null && parsed && parsed.coinType === coinType && parsed.index < MAX_DERIVED_INDEX_COUNT) {
      if (MnemonicHelper.accountFromMnemonic(mnemonic, parsed.index, coinType).publicKey === pair.publicKey) index = parsed.index;
    }
    accounts.push({ name, kind: index !== null ? 'derived' : 'imported', index, publicKey: pair.publicKey, privateKey: pair.privateKey });
  }

  if (accounts.length === 0) return { ok: false, reason: 'no-accounts' };
  return { ok: true, profile: { profileName, network: networkOf(profile), mnemonic, mnemonicUnreadable, accounts, skipped } };
}

// --- import (memory → KASANE) ----------------------------------------------------------------

/** 公式ウォレットの既定名（"Seed Account 1" など）は、KASANE の「インデックス N」表示に任せる。 */
function cleanAccountName(name: string): string {
  const trimmed = name.trim();
  return /^Seed Account \d+$/.test(trimmed) ? '' : trimmed;
}

export type ImportResult =
  | { status: 'imported'; activeId: string; accountCount: number; keptMnemonic: boolean }
  | { status: 'duplicate'; names: string[] };

/** 開いたプロファイルを、KASANE のプロファイルとして保存する。`password` は KASANE 側のパスワード（公式と同じでよい）。 */
export async function importOpenedProfile(opened: OpenedProfile, password: string): Promise<ImportResult> {
  if (!isKasanePasswordUsable(password)) throw new Error('password-invalid');

  // すでに KASANE にある鍵は、重複してプロファイルを作らない。
  const existing = await existingSymbolPublicKeys();
  const duplicates = opened.accounts.filter((a) => existing.has(a.publicKey));
  if (duplicates.length > 0) return { status: 'duplicate', names: duplicates.map((a) => a.name) };

  const derived = opened.accounts.filter((a) => a.kind === 'derived' && a.index !== null);
  const extras = opened.accounts.filter((a) => a.kind !== 'derived');
  const usedIds = new Set((await WalletsHelper.gets()).map((w) => w.id));
  const freshId = () => {
    let id = Wallet.createId();
    while (usedIds.has(id)) id = Wallet.createId();
    usedIds.add(id);
    return id;
  };

  let wallets: Wallet[];
  let keptMnemonic = false;
  if (opened.mnemonic !== null && derived.length > 0) {
    // ふつうの KASANE のプロファイルと同じ作り方（Symbol と NEM の 0..N-1 を導出）。公式ウォレットにあったインデックスを表示にする。
    const count = Math.min(Math.max(PROFILE_ACCOUNT_COUNT, Math.max(...derived.map((a) => a.index as number)) + 1), MAX_DERIVED_INDEX_COUNT);
    const byIndex = new Map(derived.map((a) => [a.index as number, a]));
    const first = byIndex.get(0);
    wallets = await WalletsHelper.createProfileWithMnemonic(
      opened.profileName,
      opened.mnemonic,
      password,
      profileAccounts(opened.mnemonic, count),
      first ? cleanAccountName(first.name) : '',
    );
    for (const wallet of wallets) {
      const account = wallet.accountIndex === null ? undefined : byIndex.get(wallet.accountIndex);
      if (!account) continue;
      wallet.hidden = false;
      if (wallet.accountIndex !== 0) wallet.accountName = cleanAccountName(account.name);
    }
    keptMnemonic = true;
  } else {
    wallets = [];
  }

  const profileId = wallets.length > 0 ? wallets[0].profileKey : Wallet.createId();
  const toAdd = wallets.length > 0 ? extras : opened.accounts; // ニーモニックを持ち込まないときは、全部を鍵のアカウントとして
  for (const account of toAdd) {
    const wallet = account.kind === 'ledger'
      ? Wallet.createLedger(opened.profileName, 'symbol', account.publicKey, account.index ?? 0)
      : await Wallet.createWithKeys(opened.profileName, account.publicKey, account.privateKey as string, password, 'symbol');
    wallet.id = freshId();
    wallet.profileId = profileId;
    wallet.accountName = cleanAccountName(account.name);
    wallet.hidden = false;
    wallets.push(wallet);
  }

  const visibleSymbol = wallets.filter((w) => w.chain === 'symbol' && !w.hidden).sort(compareAccounts);
  const activeId = (visibleSymbol[0] ?? wallets[0]).id;
  await WalletsHelper.addProfile(wallets, activeId, password);
  return { status: 'imported', activeId, accountCount: opened.accounts.length, keptMnemonic };
}

// --- export (KASANE → official) --------------------------------------------------------------

export type ExportResult =
  | {
      ok: true;
      data: OfficialExport;
      profileName: string;
      network: PublicNetwork;
      accountCount: number;
      /** ニーモニックを公式ウォレットの seed に入れたか（メインネットのみ）。 */
      withSeed: boolean;
      /** 公式ウォレットに持ち込めなかったアカウントの数（Ledger のテストネットなど）。 */
      skippedCount: number;
    }
  | { ok: false; reason: 'no-accounts' | 'locked' | 'wrong-password' | 'unsupported-network' };

function randomAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * KASANE のプロファイル（Symbol のアカウント）を、公式ウォレットが読める形にする。パスワードは公式ウォレットでもそのまま使える。
 * メインネットでニーモニックがあるときは、公式の「ニーモニックから作ったプロファイル」と同じ形（seed ＋ 導出パス）にする。
 * テストネットは、公式ウォレットはコイン種別 1、KASANE の古いプロファイルは 4343 でニーモニックからの導出が違う。KASANE が公式互換の
 * テストネット鍵（コイン種別 1）を使っているアカウントはニーモニックからの導出として、それ以外は秘密鍵のアカウントとして書き出す。
 */
export async function exportProfileToOfficial(profileWalletId: string, password: string): Promise<ExportResult> {
  const wallets = (await WalletsHelper.getProfileWallets(profileWalletId, 'symbol')).filter((w) => !w.watchOnly);
  if (wallets.length === 0) return { ok: false, reason: 'no-accounts' };
  const profileKey = wallets[0].profileKey;
  if ((await PinCodeHelper.getLockoutRemainingMs(profileKey)) > 0) return { ok: false, reason: 'locked' };
  if (!(await PinCodeHelper.check(profileKey, password))) return { ok: false, reason: 'wrong-password' };

  const network = getNetwork();
  // Symbol Wallet (the official app) knows mainnet and testnet only, not mijin v2.
  if (network === 'mijin') return { ok: false, reason: 'unsupported-network' };
  const config = NETWORKS[network];
  const mainnet = network === 'mainnet';
  const source = wallets.find((w) => w.hasMnemonic());
  const mnemonic = source ? await source.decryptMnemonic(password) : null;
  // 書き出すアカウントの鍵が、公式ウォレットのニーモニックの導出と同じか：メインネットは常に同じ、テストネットは公式互換の鍵を使っているときだけ。
  const coinType = mainnet ? SYMBOL_MAINNET_COIN_TYPE : SYMBOL_TESTNET_COIN_TYPE;
  const matchesOfficialDerivation = (w: Wallet) => w.accountIndex !== null && !w.ledger && (mainnet || w.usesTestnetKeys);
  const withSeed = mnemonic !== null && wallets.some((w) => !w.hidden && matchesOfficialDerivation(w));

  const profileName = wallets[0].name.trim() || 'KASANE';
  const accounts: OfficialAccount[] = [];
  let skippedCount = 0;
  for (const wallet of wallets.filter((w) => !w.hidden)) {
    const indexed = wallet.accountIndex !== null;
    const base = {
      id: randomAccountId(),
      name: wallet.accountName || (indexed ? `${profileName} #${wallet.accountIndex}` : profileName),
      profileName,
      node: '',
      address: addressFromPublicKey(wallet.publicKey, config.networkByte),
      publicKey: wallet.publicKey.toUpperCase(),
      isMultisig: false,
    };
    if (wallet.ledger) {
      // 公式ウォレットの Ledger のパスはメインネット m/44'/4343'…、テストネット m/44'/1'…。KASANE は 4343 だけなのでメインネットのみ。
      if (!mainnet || !indexed) { skippedCount += 1; continue; }
      accounts.push({ ...base, type: OFFICIAL_ACCOUNT_TYPE.LEDGER, encryptedPrivateKey: '', path: symbolPath(wallet.accountIndex as number) });
      continue;
    }
    const secret = await wallet.decryptSecret(password);
    if (secret === null) { skippedCount += 1; continue; }
    const derived = withSeed && matchesOfficialDerivation(wallet);
    accounts.push({
      ...base,
      type: derived ? OFFICIAL_ACCOUNT_TYPE.SEED : OFFICIAL_ACCOUNT_TYPE.PRIVATE_KEY,
      encryptedPrivateKey: await officialEncrypt(secret, password),
      path: derived ? symbolPath(wallet.accountIndex as number, coinType) : '',
    });
  }
  if (accounts.length === 0) return { ok: false, reason: 'no-accounts' };

  const profile: OfficialProfile = {
    profileName,
    accounts: accounts.map((a) => a.id),
    seed: withSeed ? await officialEncrypt(mnemonic as string, password) : '',
    password: officialPasswordHash(password),
    hint: '',
    networkType: OFFICIAL_NETWORK_TYPE[network],
    generationHash: config.generationHash,
    termsAndConditionsApproved: true,
    selectedNodeUrlToConnect: '',
  };
  return { ok: true, data: buildOfficialExport(profile, accounts), profileName, network, accountCount: accounts.length, withSeed, skippedCount };
}
