// NFTビューアー：COMSA / NFT-Drive の画像のつなぎ方の確認（通信はしない。ノードから読んだ形のデータを作って渡す）。
// 実行: npx tsx dev-tests/nft-image.test.ts
import { comsaBase64, nemberArtCid, nftDriveBase64, rawHex, ukraineHashes } from '../src/lib/symbol/nftImage';
import type { RawTx } from '../src/lib/symbol/nftImage';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
}

// 1x1 の PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const msg = (text: string) => ({ transaction: { type: 0x4154, message: `00${Buffer.from(text, 'utf8').toString('hex').toUpperCase()}` } });
const agg = (...texts: string[]): RawTx => ({ meta: { hash: 'A'.repeat(64) }, transaction: { type: 0x4141, transactions: texts.map(msg) } });
const chunks = (s: string, n: number) => Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));
const pngStart = (b64: string) => Buffer.from(b64, 'base64').subarray(0, 4).toString('hex') === '89504e47';

// --- COMSA: 1件目はヘッダ、2件目以降は先頭6文字を除いてつなぐ ---
const [c1, c2, c3] = chunks(PNG_B64, 30);
const comsa = comsaBase64([
  agg('{"header":1}', `000001${c1}`, `000002${c2}`),
  agg('{"header":2}', `000003${c3}`, ...chunks(PNG_B64, 30).slice(3).map((c, i) => `00000${i + 4}${c}`)),
]);
check('COMSA: base64 が元どおりにつながる', comsa === PNG_B64, comsa);
check('COMSA: PNG として読める', pngStart(comsa));

// --- NFT-Drive: 通し番号で並べ、最初のアグリゲートはヘッダ（15件）を飛ばす ---
const dataUrl = `data:image/png;base64,${PNG_B64}`;
const parts = chunks(dataUrl, 40);
const head = Array.from({ length: 14 }, (_, i) => `header-${i}`); // 通し番号 "0" と合わせて15件
const first = agg('0', ...head, ...parts.slice(0, 2));
const second = agg('1', ...parts.slice(2, 3));
const third = agg('2', ...parts.slice(3));
const drive = nftDriveBase64([third, first, second]); // 順不同で渡す
check('NFT-Drive: 順不同でも通し番号で並ぶ', drive === PNG_B64, String(drive));
check('NFT-Drive: PNG として読める', drive !== null && pngStart(drive));

// ヘッダの数が15でなくても、data URL の始まりを見つけて読む
const odd = nftDriveBase64([agg('0', 'a', 'b', ...parts.slice(0, 2)), agg('1', ...parts.slice(2))]);
check('NFT-Drive: ヘッダの数が違っても読める', odd === PNG_B64, String(odd));

// 画像でないもの・空のものは取れない
check('NFT-Drive: data URL が無ければ null', nftDriveBase64([agg('0', 'hello', 'world')]) === null);
check('NFT-Drive: 空なら null', nftDriveBase64([]) === null);
check('COMSA: 空なら空文字', comsaBase64([]) === '');

// 暗号化メッセージ（先頭が 01）や送金でないものは無視される
const enc: RawTx = { transaction: { type: 0x4141, transactions: [msg('x'), { transaction: { type: 0x4154, message: '01AABB' } }, { transaction: { type: 0x4144 } }] } };
check('COMSA: 暗号化・送金以外は読み飛ばす', comsaBase64([enc]) === '');

// --- COMSA(NCFT) / ウクライナNFT: 生のバイト列（16進）をそのままつなぐ ---
const PNG_HEX = Buffer.from(PNG_B64, 'base64').toString('hex').toUpperCase();
const raw = (hex: string) => ({ transaction: { type: 0x4154, message: hex } });
const rawAgg = (...hex: string[]): RawTx => ({ transaction: { type: 0x4141, transactions: hex.map(raw) } });
const hexChunks = chunks(PNG_HEX, 20);
const ncft = rawHex([rawAgg('AABB', ...hexChunks.slice(0, 2)), rawAgg('CCDD', ...hexChunks.slice(2))], true);
check('NCFT: 1件目（ヘッダ）を飛ばして生のバイト列がつながる', ncft === PNG_HEX, ncft);
const ukr = rawHex([rawAgg(...hexChunks.slice(0, 2)), rawAgg(...hexChunks.slice(2))], false);
check('ウクライナ: 全部つなぐと PNG になる', ukr === PNG_HEX);
check('NCFT: 空なら空文字', rawHex([], true) === '');

const h1 = 'A'.repeat(64), h2 = 'B'.repeat(64);
const rootPlain: RawTx = { transaction: { type: 0x4141, transactions: [msg('x'), msg(h1 + h2)] } };
const rootRaw: RawTx = { transaction: { type: 0x4141, transactions: [msg('x'), raw(Buffer.from(h1 + h2).toString('hex'))] } };
check('ウクライナ: 64文字ずつのハッシュ一覧（平文）', ukraineHashes(rootPlain).join() === `${h1},${h2}`);
check('ウクライナ: 64文字ずつのハッシュ一覧（生のメッセージ）', ukraineHashes(rootRaw).join() === `${h1},${h2}`);
check('ウクライナ: 長さが合わなければ空', ukraineHashes({ transaction: { transactions: [msg('x'), msg(`${h1}ZZ`)] } }).length === 0);

// --- NEMber ART: IPFS のハッシュだけを取り出す（形が違えば捨てる）---
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const json = JSON.stringify({ data: { media: { ipfs: CID } } });
const hexOf = (t: string) => Buffer.from(t, 'utf8').toString('hex').toUpperCase();
check('NEMber ART: JSON の値からハッシュ', nemberArtCid(hexOf(json)) === CID);
check('NEMber ART: JSON を16進にした値からハッシュ', nemberArtCid(hexOf(hexOf(json))) === CID);
check('NEMber ART: ハッシュに記号が混じれば捨てる', nemberArtCid(hexOf(JSON.stringify({ data: { media: { ipfs: `${CID}/../x` } } }))) === null);
check('NEMber ART: JSON でなければ null', nemberArtCid(hexOf('hello')) === null);

if (failed > 0) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
