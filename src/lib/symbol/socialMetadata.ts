// ソーシャルメタデータ（NFTDriveEX 仕様）: アドレスに「そのアドレスが載っている SNS などの URL」をメタデータとして登録し、
// 受け取った側が URL から「誰のアドレスか」を確かめるための補助機能。
//
//  - 登録先: アカウントのメタデータ。キーは文字列 "social_meta_data"（SDK 共通の metadataGenerateKey で 64bit のキーにする）。
//  - 値: text/JSON  { url: string, name: string, imageUrl: string, namespace: string }（namespace は任意なので空文字でもよい）。
//  - 取得: Symbol ノードに REST で問い合わせる。誰でも読める。
//  - 検証はあくまで「利用者の自己申告」。メタデータの発起人（source）のアドレスと、見ているアドレス（target）が一致している
//    ものだけを使う（他人が付けたメタデータは無視する）。URL の先でアドレス・ネームスペースが合っているかは、人が確かめる。
//
// 外部から読み込んだ文字列なので、URL は http(s) だけを通し（javascript: などは捨てる）、画像は fetch で取り、先頭バイトで
// 画像と見分けられたものだけを blob: にして <img> に渡す（CSP の img-src は絞ったまま。SVG は使わない）。
import { MAX_METADATA_VALUE_BYTES, decodeValueText, encodeValue, generateMetadataKey, keyToHex } from './metadata';
import { fetchMetadataValue, nodeRequest } from './api';
import { addressBytesToString, hexToBytes, normalizeAddress } from './crypto';
import { getNetwork } from './network';

export const SOCIAL_METADATA_KEY_TEXT = 'social_meta_data';
export const SOCIAL_METADATA_KEY: bigint = generateMetadataKey(SOCIAL_METADATA_KEY_TEXT);

export interface SocialMetadata {
  url: string;
  name: string;
  imageUrl: string;
  namespace: string;
}

export const SOCIAL_FIELD_MAX = { url: 300, name: 100, imageUrl: 300, namespace: 150 } as const;

export type SocialFieldError = 'required' | 'too_long' | 'bad_url' | 'bad_namespace' | 'too_big' | null;
export type SocialErrors = Record<keyof SocialMetadata, SocialFieldError>;

/** http(s) の URL だけを通し、正規化した文字列を返す。それ以外（javascript:, data:, 相対パスなど）は null。 */
export function safeHttpUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\u0000-\u001F\u007F\s]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname === '' || url.username !== '' || url.password !== '') return null; // user:pass@host で見た目を偽る形は使わない
    return url.toString();
  } catch {
    return null;
  }
}

/** Symbol のネームスペース名: 先頭が英数字、小文字・数字・_ ・- 、ドットで区切る（最大3階層）。 */
export function isValidNamespaceName(text: string): boolean {
  const parts = text.split('.');
  return parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(p));
}

/** ノードから読んだ値（text/JSON）を取り込む。形が合わなければ null。文字列以外の項目は空文字として扱い、URL は http(s) だけ残す。 */
export function parseSocialMetadata(text: string | null): SocialMetadata | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const url = safeHttpUrl(obj.url) ?? '';
  const name = str(obj.name, SOCIAL_FIELD_MAX.name);
  const imageUrl = safeHttpUrl(obj.imageUrl) ?? '';
  const namespace = str(obj.namespace, SOCIAL_FIELD_MAX.namespace).replace(/^@/, '');
  // 何も使える項目が無ければ、ソーシャルメタデータとして扱わない。
  if (url === '' && name === '' && imageUrl === '' && namespace === '') return null;
  return { url, name, imageUrl, namespace };
}

/** 入力フォームの検証。url / name / imageUrl は必須、namespace は任意。 */
export function validateSocialMetadata(input: SocialMetadata): SocialErrors {
  const errors: SocialErrors = { url: null, name: null, imageUrl: null, namespace: null };
  const trimmed = {
    url: input.url.trim(),
    name: input.name.trim(),
    imageUrl: input.imageUrl.trim(),
    namespace: input.namespace.trim().replace(/^@/, ''),
  };
  for (const field of ['url', 'imageUrl'] as const) {
    if (trimmed[field] === '') errors[field] = 'required';
    else if (trimmed[field].length > SOCIAL_FIELD_MAX[field]) errors[field] = 'too_long';
    else if (safeHttpUrl(trimmed[field]) === null) errors[field] = 'bad_url';
  }
  if (trimmed.name === '') errors.name = 'required';
  else if (trimmed.name.length > SOCIAL_FIELD_MAX.name) errors.name = 'too_long';
  if (trimmed.namespace !== '' && !isValidNamespaceName(trimmed.namespace)) errors.namespace = 'bad_namespace';
  // 全部そろっても値が 1,024 バイトに収まること。
  if (Object.values(errors).every((e) => e === null) && encodeValue(serializeSocialMetadata(input)).length > MAX_METADATA_VALUE_BYTES) {
    errors.url = 'too_big';
  }
  return errors;
}

export function socialMetadataValid(input: SocialMetadata): boolean {
  return Object.values(validateSocialMetadata(input)).every((e) => e === null);
}

/** メタデータの値（JSON 文字列）。キーの順番は仕様どおり url, name, imageUrl, namespace。 */
export function serializeSocialMetadata(input: SocialMetadata): string {
  return JSON.stringify({
    url: safeHttpUrl(input.url) ?? input.url.trim(),
    name: input.name.trim(),
    imageUrl: safeHttpUrl(input.imageUrl) ?? input.imageUrl.trim(),
    namespace: input.namespace.trim().replace(/^@/, ''),
  });
}

export function sameSocialMetadata(a: SocialMetadata | null, b: SocialMetadata | null): boolean {
  if (a === null || b === null) return a === b;
  return a.url === b.url && a.name === b.name && a.imageUrl === b.imageUrl && a.namespace === b.namespace;
}

// --- reading from the node ----------------------------------------------------------------------

/**
 * そのアドレス自身が（source = target として）登録したソーシャルメタデータ。無ければ null。
 * 他のアカウントが付けたものは、この問い合わせの対象外（source を指定して引くので混ざらない）。
 */
export async function fetchSocialMetadata(address: string): Promise<SocialMetadata | null> {
  const addr = normalizeAddress(address);
  const bytes = await fetchMetadataValue({ type: 'account', address: addr, sourceAddress: addr }, SOCIAL_METADATA_KEY);
  if (bytes.length === 0) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return parseSocialMetadata(text);
}

type CacheEntry = { at: number; value: SocialMetadata | null };
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SocialMetadata | null>>();
const waiting: Array<() => void> = [];
let running = 0;
const MAX_PARALLEL = 4;

const cacheKey = (address: string) => `${getNetwork()}:${normalizeAddress(address)}`;

/** 取得済みの値（無ければ undefined。null は「登録なし」を取得済みの意味）。 */
export function cachedSocialMetadata(address: string): SocialMetadata | null | undefined {
  const hit = cache.get(cacheKey(address));
  return hit && Date.now() - hit.at < CACHE_MS ? hit.value : undefined;
}

/** 履歴の一覧などで多くのアドレスを引いても、ノードに同時に投げすぎないよう、同時実行を絞ってキャッシュする。 */
export function loadSocialMetadata(address: string, force = false): Promise<SocialMetadata | null> {
  const key = cacheKey(address);
  if (!force) {
    const hit = cachedSocialMetadata(address);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  const job = new Promise<SocialMetadata | null>((resolve) => {
    const start = () => {
      running += 1;
      fetchSocialMetadata(address)
        .then((value) => { cache.set(key, { at: Date.now(), value }); resolve(value); })
        .catch(() => resolve(null)) // 取れなかったときは何も出さない（キャッシュもしない）
        .finally(() => {
          running -= 1;
          inflight.delete(key);
          waiting.shift()?.();
        });
    };
    if (running < MAX_PARALLEL) start();
    else waiting.push(start);
  });
  inflight.set(key, job);
  return job;
}

export function clearSocialMetadataCache(address?: string): void {
  if (address === undefined) cache.clear();
  else cache.delete(cacheKey(address));
}

// --- icon image -----------------------------------------------------------------------------------

export const SOCIAL_IMAGE_MAX_BYTES = 1024 * 1024;
const SOCIAL_IMAGE_TIMEOUT_MS = 8000;

/** 先頭バイトで見分ける画像の種類。SVG・その他は使わない（null）。 */
export function sniffRasterMime(b: Uint8Array): string | null {
  const startsWith = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (b.length > 12 && startsWith(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

const imageCache = new Map<string, Promise<string | null>>();

// 一覧で何十枚も同時に取りに行かないよう、同時に取る画像は6枚まで。
const MAX_IMAGE_PARALLEL = 6;
let imageRunning = 0;
const imageWaiting: Array<() => void> = [];
function acquireImageSlot(): Promise<void> {
  if (imageRunning < MAX_IMAGE_PARALLEL) { imageRunning += 1; return Promise.resolve(); }
  return new Promise((resolve) => imageWaiting.push(() => { imageRunning += 1; resolve(); }));
}
function releaseImageSlot(): void {
  imageRunning -= 1;
  imageWaiting.shift()?.();
}

/**
 * アイコン画像を取って blob: URL にする。取れない・大きすぎる・画像でない・時間切れは null（呼び出し側は頭文字の丸で代用する）。
 * Cookie や Referer は付けない。
 */
export function loadSocialImage(imageUrl: string): Promise<string | null> {
  const safe = safeHttpUrl(imageUrl);
  if (safe === null) return Promise.resolve(null);
  const hit = imageCache.get(safe);
  if (hit) return hit;
  const job = (async () => {
    await acquireImageSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOCIAL_IMAGE_TIMEOUT_MS);
    try {
      const res = await fetch(safe, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' });
      if (!res.ok) return null;
      const length = Number(res.headers.get('content-length') ?? '0');
      if (length > SOCIAL_IMAGE_MAX_BYTES) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > SOCIAL_IMAGE_MAX_BYTES) return null;
      const mime = sniffRasterMime(bytes);
      if (mime === null) return null;
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      releaseImageSlot();
    }
  })();
  imageCache.set(safe, job);
  // 失敗は覚えない（あとでやり直せるように）。
  job.then((url) => { if (url === null) imageCache.delete(safe); });
  return job;
}

// --- the directory of registered addresses (the S.M.D list) ---------------------------------------------

export interface SocialDirectoryItem { address: string; meta: SocialMetadata }
export interface SocialDirectoryPage { items: SocialDirectoryItem[]; hasMore: boolean }

export const SOCIAL_DIRECTORY_PAGE_SIZE = 100;

interface RawDirectoryPage {
  data?: Array<{ metadataEntry?: { sourceAddress?: string; targetAddress?: string; value?: string } }>;
}

/**
 * ノードに、キー social_meta_data のメタデータを持つアカウントを、新しい順に1ページ（100件）ずつ問い合わせる。
 * 「発起人（source）= 対象（target）」の自己登録だけを残し、仕様の形（JSON）でない値は捨てる。
 * 取れた内容は、アドレスごとのキャッシュにも入れる（あとで詳細を開くときに、もう一度問い合わせなくて済む）。
 */
export async function fetchSocialDirectoryPage(pageNumber: number): Promise<SocialDirectoryPage> {
  const res = await nodeRequest<RawDirectoryPage>(
    `/metadata?scopedMetadataKey=${keyToHex(SOCIAL_METADATA_KEY)}&metadataType=0&order=desc&pageSize=${SOCIAL_DIRECTORY_PAGE_SIZE}&pageNumber=${pageNumber}`,
  );
  const rows = res.data ?? [];
  const items: SocialDirectoryItem[] = [];
  for (const row of rows) {
    const entry = row.metadataEntry;
    if (!entry?.sourceAddress || !entry.targetAddress || !entry.value) continue;
    if (entry.sourceAddress.toUpperCase() !== entry.targetAddress.toUpperCase()) continue;
    let address: string;
    try {
      address = addressBytesToString(hexToBytes(entry.targetAddress));
    } catch {
      continue;
    }
    const meta = parseSocialMetadata(decodeValueText(hexToBytes(entry.value)));
    if (meta === null) continue;
    cache.set(cacheKey(address), { at: Date.now(), value: meta });
    items.push({ address, meta });
  }
  return { items, hasMore: rows.length >= SOCIAL_DIRECTORY_PAGE_SIZE };
}

/** 検索: 名前・ネームスペース・URL・アドレスの、どれかに含まれる（大文字小文字・ハイフン・空白は区別しない）。 */
export function matchesSocialQuery(item: SocialDirectoryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const compact = q.replace(/[-\s]/g, '');
  const { meta, address } = item;
  return meta.name.toLowerCase().includes(q) || meta.namespace.toLowerCase().includes(q.replace(/^@/, ''))
    || meta.url.toLowerCase().includes(q) || (compact !== '' && address.toLowerCase().includes(compact));
}
