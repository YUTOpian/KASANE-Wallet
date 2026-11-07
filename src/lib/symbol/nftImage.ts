// モザイクに紐づけられた画像（オンチェーンNFT）を取り出す。Symbol のみ。対応は COMSA(NFT)・COMSA(NCFT)・NFT-Drive・ウクライナNFT・NEMber ART の5形式。
//
// どちらも、画像の中身そのものをブロックチェーンのトランザクションのメッセージに分割して書いてある（フルオンチェーン）。
// 取り出し方は、公開されている実装（Qiita「Symbolブロックチェーン上で持ってるNFT画像を全部出す。」）の手順に合わせた。
// 公式の仕様書があるわけではなく「こうすれば表示された」という形なので、サービス側の仕様が変わると取れなくなりうる。
//
//  - COMSA(NFT): モザイクのメタデータに、ヘッダ（キー DA030AA7795EBE75、{ mime_type } の JSON）と、画像を書いた
//    アグリゲートトランザクションのハッシュ一覧（JSON の配列、キーは下の COMSA_HASH_KEYS）が入っている。
//    各アグリゲートの2件目以降の送金メッセージの、先頭6文字を除いた部分をつなぐと base64 になる。
//  - NFT-Drive: モザイクの作成者アカウントが、そのNFT専用のアカウント。そこへ宛てた最初の送金に
//    「Please note that this mosaic is an NFT.」とあり、同じアカウントのアグリゲートに data URL が分割して入っている。
//    各アグリゲートの最初のメッセージが通し番号（これで並べる）、最初のアグリゲートだけ先頭にヘッダ用の送金が並ぶ。
//
//  - COMSA(NCFT): ヘッダのキーが 8E0823CEF8A40075。ハッシュ一覧は COMSA(NFT) と同じキー。各アグリゲートの2件目以降の
//    送金メッセージが生のバイト列（RawMessage）で、そのままつなぐと画像になる。
//  - ウクライナNFT: ヘッダ（キー 8AFD95A719B1BB90）の info.rootTransactionHash のアグリゲートの2件目の送金に、画像を書いた
//    アグリゲートのハッシュが64文字ずつ区切りなしで並ぶ。各アグリゲートの送金メッセージ（生のバイト列）を全部つなぐと PNG。
//  - NEMber ART（サービス終了）: メタデータ（キー D2E513530574930D）の JSON に IPFS のハッシュ（data.media.ipfs）がある。
//    画像は IPFS の中にあって、ブロックチェーンには無い。公開ゲートウェイ ipfs.io から取るので、そこへ通信が出る
//    （CSP の img-src は絞ったまま、fetch で取って blob: にする）。IPFS 側から消えていれば取れない。
//
// 表示の安全のため、取り出した中身は <img> でしか使わない。MIME は自分で見分け（先頭バイト）、画像でなければ捨てる。
import { TX_TYPE_AGGREGATE_BONDED, TX_TYPE_AGGREGATE_COMPLETE, TX_TYPE_TRANSFER } from './constants';
import { nodeRequest } from './api';
import { addressBytesToString, hexToBytes } from './crypto';
import { getNetwork } from './network';

export type NftKind = 'comsa' | 'comsancft' | 'nftdrive' | 'ukraine' | 'nemberart';

export interface NftImage {
  kind: NftKind;
  mime: string;
  /** blob: URL。<img src> に使う（CSP の img-src は blob: を許可している）。 */
  url: string;
  bytes: number;
}

const COMSA_HEADER_KEY = 'DA030AA7795EBE75';
const COMSA_NCFT_HEADER_KEY = '8E0823CEF8A40075';
const UKRAINE_HEADER_KEY = '8AFD95A719B1BB90';
const NEMBERART_KEY = 'D2E513530574930D';
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const IPFS_TIMEOUT_MS = 25_000;
const MAX_IMAGE_BYTES = 12_000_000; // 生のバイト列（NCFT・ウクライナ・IPFS）の上限
// 画像を書いたトランザクションのハッシュ一覧が入るキー。並びは先頭Indexの順（Qiita の表）。
const COMSA_HASH_KEYS = [
  'D77BFE313AF3EF1F', 'AACFBE3CC93EABF3', 'A0B069B710B3754C', 'D75B016AA9FAC056', 'BABD9C10F590F0F3', 'D4B5933FA2FD62E7',
  'FA60A37C56457F1A', 'FEDD372E157E9CF0', 'C9384119AD73CF95', 'EADE00D8D78AC0BD', 'F6578214308E7990', 'CE7226A968287482',
  'C2811F3B6F49C568', '886A58DBE955A788', '87300B99E5B10E2C', 'EE553D7141B98753', 'B3084C09176CA990',
];
const NFTDRIVE_MARKER = 'Please note that this mosaic is an NFT.';
const NFTDRIVE_HEADER_TXS = 15; // 最初のアグリゲートの先頭にあるヘッダ用の送金の数（見つからないときの既定）

const MAX_HASHES = 400; // COMSA: 読むアグリゲートの上限
const MAX_AGGREGATES = 100; // NFT-Drive: 読むアグリゲートの上限（検索の1ページ分）
const MAX_BASE64_CHARS = 16_000_000; // これより大きいものは表示しない
const FETCH_CONCURRENCY = 4;

// --- 小さな部品 --------------------------------------------------------------------------------------------

export interface RawEmbedded { transaction?: { type?: number; message?: string } }
export interface RawTx { meta?: { hash?: string }; transaction?: { type?: number; message?: string; transactions?: RawEmbedded[] } }

/** 送金メッセージ（先頭1バイトが種類、0 = 平文）の本文。平文でなければ null。 */
function plainMessage(hex: string | undefined): string | null {
  if (!hex || hex.length < 2) return null;
  let bytes: Uint8Array;
  try { bytes = hexToBytes(hex); } catch { return null; }
  if (bytes[0] !== 0) return null;
  return new TextDecoder().decode(bytes.subarray(1));
}

/** メタデータの値（16進）を文字列にする。 */
function metadataText(hex: string): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(hex)); } catch { return null; }
}

/** 同時に走らせる数を絞って、順番どおりの結果を返す。 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = Array.from({ length: items.length }) as R[];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const fetchAggregate = (hash: string): Promise<RawTx> => nodeRequest<RawTx>(`/transactions/confirmed/${hash.toUpperCase()}`);

/** アグリゲートの中の送金のメッセージ（平文）を、並びのまま。送金でないもの・平文でないものは '' に。 */
function innerTexts(tx: RawTx): string[] {
  return (tx.transaction?.transactions ?? []).map((e) =>
    e.transaction?.type === TX_TYPE_TRANSFER ? plainMessage(e.transaction.message) ?? '' : '');
}

// --- 画像として確かめる ----------------------------------------------------------------------------------------

function sniffMime(b: Uint8Array): string | null {
  const startsWith = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (startsWith(0x42, 0x4d)) return 'image/bmp';
  if (b.length > 12 && startsWith(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66) return 'image/avif';
  // SVG は <img> の中では script も外部読み込みも動かない。先頭の文字で見分ける。
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

function base64ToBytes(b64: string): Uint8Array | null {
  const clean = b64.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function toImage(kind: NftKind, b64: string): NftImage | null {
  const bytes = base64ToBytes(b64);
  return bytes ? toImageBytes(kind, bytes) : null;
}

function toImageBytes(kind: NftKind, bytes: Uint8Array): NftImage | null {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const mime = sniffMime(bytes);
  if (!mime) return null;
  return { kind, mime, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })), bytes: bytes.length };
}

// --- COMSA(NFT) --------------------------------------------------------------------------------------------

interface RawMetadataPage { data?: Array<{ metadataEntry: { scopedMetadataKey: string; value: string } }> }

type MetaMap = Map<string, string>;

/** モザイクのメタデータ（キー → 値の16進）。同じキーが複数あれば最初のもの。 */
async function readMetadata(mosaicId: string): Promise<MetaMap> {
  const page = await nodeRequest<RawMetadataPage>(`/metadata?targetId=${mosaicId}&metadataType=1&pageSize=100`);
  const byKey: MetaMap = new Map();
  for (const d of page.data ?? []) {
    const key = d.metadataEntry.scopedMetadataKey.toUpperCase();
    if (!byKey.has(key)) byKey.set(key, d.metadataEntry.value);
  }
  return byKey;
}

/** COMSA の NFT / NCFT 共通: 画像を書いたアグリゲートのハッシュ一覧（メタデータの17個のキーを順に読む）。 */
function comsaHashes(byKey: MetaMap): string[] | null {
  const texts = COMSA_HASH_KEYS.map((k) => byKey.get(k)).filter((v): v is string => v !== undefined).map((v) => metadataText(v) ?? '');
  if (texts.length === 0) return null;
  // 値はそれぞれが JSON の配列。もし1つの JSON を分けて入れたものなら、つなげてから読む。
  let hashes: string[] = [];
  try {
    for (const t of texts) hashes = hashes.concat(JSON.parse(t) as string[]);
  } catch {
    try { hashes = JSON.parse(texts.join('')) as string[]; } catch { return null; }
  }
  hashes = hashes.filter((h) => typeof h === 'string' && /^[0-9A-Fa-f]{64}$/.test(h));
  return hashes.length === 0 || hashes.length > MAX_HASHES ? null : hashes;
}

async function readComsa(byKey: MetaMap): Promise<NftImage | null> {
  const headerHex = byKey.get(COMSA_HEADER_KEY);
  if (headerHex === undefined) return null; // COMSA(NFT) ではない
  // ヘッダは JSON であることだけ確かめる。画像の種類は、ヘッダの mime_type ではなく中身の先頭バイトで見分ける。
  try { JSON.parse(metadataText(headerHex) ?? ''); } catch { return null; }

  const hashes = comsaHashes(byKey);
  if (!hashes) return null;

  const txs = await mapLimited(hashes, FETCH_CONCURRENCY, fetchAggregate);
  return toImage('comsa', comsaBase64(txs));
}

/** COMSA: 読んだアグリゲート（ハッシュ一覧の順）から base64 をつなぐ。1件目はヘッダ用、2件目以降のメッセージは先頭6文字を除いた部分。 */
export function comsaBase64(txs: RawTx[]): string {
  let b64 = '';
  for (const tx of txs) {
    for (const text of innerTexts(tx).slice(1)) b64 += text.slice(6);
    if (b64.length > MAX_BASE64_CHARS) return '';
  }
  return b64;
}

// --- 生のバイト列をつなぐ形式（COMSA(NCFT)・ウクライナNFT）------------------------------------------------------

/** アグリゲートの中の送金のメッセージ（16進のまま、生のバイト列）をつなぐ。skipFirst = 1件目（ヘッダ）を飛ばす。 */
export function rawHex(txs: RawTx[], skipFirst: boolean): string {
  let hex = '';
  for (const tx of txs) {
    const inner = tx.transaction?.transactions ?? [];
    for (const e of skipFirst ? inner.slice(1) : inner) {
      if (e.transaction?.type === TX_TYPE_TRANSFER && e.transaction.message) hex += e.transaction.message;
    }
    if (hex.length > MAX_IMAGE_BYTES * 2) return '';
  }
  return hex;
}

function hexImage(kind: NftKind, hex: string): NftImage | null {
  if (hex === '' || hex.length % 2 !== 0) return null;
  try { return toImageBytes(kind, hexToBytes(hex)); } catch { return null; }
}

async function readComsaNcft(byKey: MetaMap): Promise<NftImage | null> {
  const headerHex = byKey.get(COMSA_NCFT_HEADER_KEY);
  if (headerHex === undefined) return null; // COMSA(NCFT) ではない
  try { JSON.parse(metadataText(headerHex) ?? ''); } catch { return null; }
  const hashes = comsaHashes(byKey);
  if (!hashes) return null;
  const txs = await mapLimited(hashes, FETCH_CONCURRENCY, fetchAggregate);
  return hexImage('comsancft', rawHex(txs, true));
}

/** ウクライナNFT: ルートのアグリゲートの2件目の送金に、64文字ずつ区切りなしで並んでいるハッシュ。 */
export function ukraineHashes(root: RawTx): string[] {
  const hex = root.transaction?.transactions?.[1]?.transaction?.message;
  if (!hex) return [];
  let bytes: Uint8Array;
  try { bytes = hexToBytes(hex); } catch { return []; }
  // 平文（先頭1バイトが種類）か、生のメッセージか。どちらも試す。
  for (const part of [bytes.subarray(1), bytes]) {
    const text = new TextDecoder().decode(part).trim();
    if (text.length > 0 && text.length % 64 === 0 && /^[0-9A-Fa-f]+$/.test(text)) return text.match(/.{64}/g) ?? [];
  }
  return [];
}

async function readUkraine(byKey: MetaMap): Promise<NftImage | null> {
  const headerHex = byKey.get(UKRAINE_HEADER_KEY);
  if (headerHex === undefined) return null; // ウクライナNFT ではない
  let root: unknown;
  try { root = (JSON.parse(metadataText(headerHex) ?? '') as { info?: { rootTransactionHash?: unknown } }).info?.rootTransactionHash; } catch { return null; }
  if (typeof root !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(root)) return null;
  const hashes = ukraineHashes(await fetchAggregate(root));
  if (hashes.length === 0 || hashes.length > MAX_HASHES) return null;
  const txs = await mapLimited(hashes, FETCH_CONCURRENCY, fetchAggregate);
  return hexImage('ukraine', rawHex(txs, false));
}

// --- NEMber ART（IPFS）-----------------------------------------------------------------------------------------

/** メタデータの値（16進）から IPFS のハッシュ（data.media.ipfs）を取り出す。値は JSON そのもの、または JSON を16進にしたもの。 */
export function nemberArtCid(valueHex: string): string | null {
  const text = metadataText(valueHex)?.trim();
  if (!text) return null;
  const json = text.includes('{') ? text : /^[0-9A-Fa-f]+$/.test(text) && text.length % 2 === 0 ? metadataText(text) : null;
  try {
    const cid = (JSON.parse(json ?? '') as { data?: { media?: { ipfs?: unknown } } }).data?.media?.ipfs;
    // URL に入れるので、ハッシュの形（英数字だけ）だけを通す。
    return typeof cid === 'string' && /^[A-Za-z0-9]{32,120}$/.test(cid) ? cid : null;
  } catch {
    return null;
  }
}

async function readNemberArt(byKey: MetaMap): Promise<NftImage | null> {
  const valueHex = byKey.get(NEMBERART_KEY);
  if (valueHex === undefined) return null; // NEMber ART ではない
  const cid = nemberArtCid(valueHex);
  if (!cid) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IPFS_TIMEOUT_MS);
  try {
    const res = await fetch(`${IPFS_GATEWAY}${cid}`, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // IPFS から消えているとき・ゲートウェイの不調。あとでやり直せるように投げる
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_IMAGE_BYTES) return null;
    return toImageBytes('nemberart', new Uint8Array(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

// --- NFT-Drive ---------------------------------------------------------------------------------------------

async function readNftDrive(mosaicId: string): Promise<NftImage | null> {
  const info = await nodeRequest<{ mosaic?: { ownerAddress?: string } }>(`/mosaics/${mosaicId}`);
  const ownerHex = info.mosaic?.ownerAddress;
  if (!ownerHex) return null;
  const owner = addressBytesToString(hexToBytes(ownerHex));

  // そのアカウントの最初の送金（10件まで）に、目印のメッセージがあるか。
  const first = await nodeRequest<{ data?: RawTx[] }>(`/transactions/confirmed?address=${owner}&type=${TX_TYPE_TRANSFER}&order=asc&pageSize=10`);
  if (!(first.data ?? []).some((t) => plainMessage(t.transaction?.message) === NFTDRIVE_MARKER)) return null; // NFT-Drive ではない

  const [complete, bonded] = await Promise.all([TX_TYPE_AGGREGATE_COMPLETE, TX_TYPE_AGGREGATE_BONDED].map((type) =>
    nodeRequest<{ data?: RawTx[] }>(`/transactions/confirmed?address=${owner}&type=${type}&pageSize=${MAX_AGGREGATES}`)));
  const hashes = [...(complete.data ?? []), ...(bonded.data ?? [])]
    .map((t) => t.meta?.hash).filter((h): h is string => typeof h === 'string').slice(0, MAX_AGGREGATES);
  if (hashes.length === 0) return null;

  const full = await mapLimited(hashes, FETCH_CONCURRENCY, fetchAggregate);
  const b64 = nftDriveBase64(full);
  return b64 === null ? null : toImage('nftdrive', b64);
}

/** NFT-Drive: 読んだアグリゲートから、data URL の base64 の部分を取り出す。見つからなければ null。 */
export function nftDriveBase64(full: RawTx[]): string | null {
  const parts = full
    .map((tx) => innerTexts(tx))
    .filter((texts) => texts.some((t) => t !== ''))
    // 各アグリゲートの最初のメッセージが通し番号。それで並べる。
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  if (parts.length === 0) return null;

  let data = '';
  parts.forEach((texts, i) => {
    let from = 1; // 通し番号の分
    if (i === 0) {
      const marker = texts.findIndex((t) => t.includes('data:image/'));
      from = marker >= 0 ? marker : NFTDRIVE_HEADER_TXS;
    }
    for (const t of texts.slice(from)) data += t;
  });
  const start = data.indexOf('data:image/');
  if (start < 0) return null;
  const m = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]*)$/i.exec(data.slice(start));
  return m ? m[1] : null;
}

// --- 入り口 ------------------------------------------------------------------------------------------------

const cache = new Map<string, Promise<NftImage | null>>();

/**
 * モザイクに紐づけられた画像を探す（メタデータで見分けられる形式を順に、最後に NFT-Drive）。画像が無ければ null。
 * 通信に失敗したときは投げる（その場合は覚えないので、あとでやり直せる）。同じモザイクは1回しか読まない。
 */
export function findNftImage(mosaicId: string): Promise<NftImage | null> {
  const id = mosaicId.toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(id)) return Promise.resolve(null); // URL に入れるので、モザイクIDの形だけを通す
  const key = `${getNetwork()}:${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const task = (async () => {
    const meta = await readMetadata(id);
    return (await readComsa(meta)) ?? (await readComsaNcft(meta)) ?? (await readUkraine(meta)) ?? (await readNemberArt(meta)) ?? (await readNftDrive(id));
  })();
  cache.set(key, task);
  task.catch(() => cache.delete(key));
  return task;
}
