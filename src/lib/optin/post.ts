// Symbol 事後オプトイン（NEM Wallet 2.5.1 の「Symbolオプトイン」の、ローンチ後の画面）のデモ用：
// 画面の判定だけを、画面から切り離して置く（外のものを import しないので、単体で試せる）。
//
// 当時の流れ：NIS1 アカウントを選ぶ → ステータスを見る → Symbol の公開鍵を入れる → 内容を確かめて署名・送信
// → 状態が「保留中」になり、あとで処理されて「完了」になる。
// 当時のステータス番号（symbol-post-launch-optin-module の StatusCode）のうち、通常のアカウントのものだけ使う。

/** 通常アカウントのステータス。1 = 未実施、2 = 保留中（リクエスト済み）、6 = 完了（XYM を受け取り済み）。 */
export type PostOptinStatus = 1 | 2 | 6;

/** これ未満の額は「請求できない」扱い。デモの金額は 1 XYM 以上のランダムなので、1 にしてある。単位は XYM。 */
export const MIN_CLAIM_XYM = 1;

/** デモで請求額にするランダムな額の範囲（1 XYM 〜 100 万 XYM、マイクロ単位）。 */
export const RANDOM_CLAIM_MIN_MICRO = 1_000_000n;
export const RANDOM_CLAIM_MAX_MICRO = 1_000_000_000_000n;

/** 当時の画面に出ていた手数料（通常のオプトイン、XEM）。 */
export const POST_OPTIN_FEE_XEM = '0.2';

/** ノードのアカウント情報から、この画面で使う分だけ。取れなかったときは null を渡す。 */
export interface NemAccountLookup {
  balance: number;
  publicKey: string | null;
}

/** Symbol の公開鍵として入力できる形か（16進数で 64 文字）。 */
export function isPublicKeyFormat(input: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(input.trim());
}

/**
 * 入力された 64 文字が NIS1 の鍵ではないか調べる（当時の checkIfNIS1PublicKeyOrPrivateKey と同じ考え方）。
 * 「公開鍵として見たときの NEM アドレス」と「秘密鍵として見たときの NEM アドレス」の両方が、
 * 残高も公開鍵の記録も無い（＝使われていない）なら、Symbol の鍵として受け付ける。
 * どちらかが NEM のチェーンで使われていれば、NIS1 の鍵を入れてしまっている。
 * ノードに聞けなかった（null）ときは、判断できないので受け付ける。
 */
export function isUnusedOnNem(asPublicKey: NemAccountLookup | null, asPrivateKey: NemAccountLookup | null): boolean {
  const used = (a: NemAccountLookup | null) => a !== null && (a.balance !== 0 || a.publicKey != null);
  return !used(asPublicKey) && !used(asPrivateKey);
}

/**
 * デモで請求する額（マイクロ単位）を、1 XYM 〜 100 万 XYM のあいだでランダムに決める。
 * random は 0 以上 1 未満の値を返す関数（テストで差し替えられる）。小数以下 6 桁まで含めて選ぶ。
 */
export function randomClaimAmount(random: () => number = defaultRandom): bigint {
  const span = RANDOM_CLAIM_MAX_MICRO - RANDOM_CLAIM_MIN_MICRO + 1n;
  // 上位 / 下位に分けて引き、2^53 を超えても偏りが出ないようにする。
  const hi = BigInt(Math.floor(random() * 1_000_000));
  const lo = BigInt(Math.floor(random() * 1_000_000));
  const r = (hi * 1_000_000n + lo) % span;
  return RANDOM_CLAIM_MIN_MICRO + r;
}

function defaultRandom(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] / 4_294_967_296;
  return Math.random();
}

/** 当時の画面は数値をそのまま出していた（1234.5 のように、末尾の 0 は付かない）。 */
export function formatClaimAmount(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole.toString()}.${frac}`;
}

/** 請求できる額か（当時の `optinAmount >= 2`）。 */
export function canClaim(micro: bigint): boolean {
  return micro >= BigInt(MIN_CLAIM_XYM) * 1_000_000n;
}

/** 「オプトイン開始」ボタンを出すか（当時：保留中・完了では出さない）。 */
export function canStart(status: PostOptinStatus, micro: bigint): boolean {
  return status === 1 && canClaim(micro);
}

/** 金額の見出し：請求前は「請求する金額」、保留中・完了では「請求額」。 */
export function amountLabelKey(status: PostOptinStatus): 'amount' | 'amount_claimed' {
  return status === 1 ? 'amount' : 'amount_claimed';
}

/** 送信先アドレスを出すか（保留中・完了のとき）。 */
export function showsDestination(status: PostOptinStatus): boolean {
  return status === 2 || status === 6;
}
