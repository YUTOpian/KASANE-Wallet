// モザイク保有量で重み付けする投票の、「投票終了時点の保有量」の扱い（NEM・Symbol 共通。通信も SDK も使わない）。
//
// 決まり:
//   ・票の重みは、投票が終わった時点（終了時刻）に持っているモザイクの量で決める。
//     投票してから終わるまでにモザイクを手放した人は、減ったあとの量で数える（増えたときも、終わった時点の量）。
//   ・終了時点でそのモザイクを持っていないアカウントの票は、無効（票の数にも入れない）。
//   ・投票が終わったあとの送金で、結果が変わってはいけない。そのため、終わった投票は
//       「いまの保有量」−「終了後に受け取った量」＋「終了後に送った量」
//     で、終了時点の量に巻き戻す。
//   ・投票の途中は「いまの量」で数える暫定の結果で、終わった時点の量で確定する。
//   ・「モザイク保有者による投票」（POLL_TYPE_MOSAIC_HOLDER）も、同じ「終了時点の保有量」で、持っているかどうかだけを見る
//     （量は票の重みにしない。1 アカウント 1 票）。

/** 票の集計の形（lib/nem/voting.ts と lib/symbol/voting.ts の Tally と同じ）。 */
export interface TallyLike {
  voters: string[][]; // 選択肢ごとの有効な投票者
  occurrences: Map<string, number>; // 有効な投票者が、いくつの選択肢を選んだか
  unique: string[]; // 有効な投票者（重複なし）
}

/** 終了時点の保有量 = いまの量 − 終了後の増減（受け取りはプラス、送りはマイナス）。0 を下回ることはない。 */
export function holdingAtEnd(current: number, changeAfterEnd: number): number {
  const v = current - changeAfterEnd;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 保有量が 0 の投票者の票を、集計から外す。
 * `holdings` は `tally.unique` と同じ並び。外した人のアドレスと、残った人の保有量（同じ並び）も返す。
 */
export function dropZeroHolders<T extends TallyLike>(tally: T, holdings: number[]): { tally: T; holdings: number[]; excluded: string[] } {
  const excluded: string[] = [];
  const kept: string[] = [];
  const keptHoldings: number[] = [];
  tally.unique.forEach((a, i) => {
    const h = holdings[i] ?? 0;
    if (h > 0) {
      kept.push(a);
      keptHoldings.push(h);
    } else {
      excluded.push(a);
    }
  });
  if (excluded.length === 0) return { tally, holdings: keptHoldings, excluded };
  const gone = new Set(excluded);
  const occurrences = new Map<string, number>();
  for (const [a, n] of tally.occurrences) if (!gone.has(a)) occurrences.set(a, n);
  return {
    tally: { ...tally, voters: tally.voters.map((list) => list.filter((a) => !gone.has(a))), occurrences, unique: kept },
    holdings: keptHoldings,
    excluded,
  };
}

/** 票を 1 つも数えない集計（選択肢の数だけ空のリスト）。条件を満たさない投票の結果に使う。 */
export function emptyTally(optionCount: number): TallyLike {
  return { voters: Array.from({ length: optionCount }, () => []), occurrences: new Map(), unique: [] };
}

