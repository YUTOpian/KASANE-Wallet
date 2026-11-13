import { POLL_TYPE_MOSAIC, POLL_TYPE_MOSAIC_HOLDER, POLL_TYPE_SIMPLE, POLL_TYPE_WHITELIST } from '../../lib/symbol/voting';

// Symbol の投票画面の文言の鍵。NEM の投票（nemvoting.*）と共通の文言はそのまま使い、XEM を書いてあるものだけ symbolvoting.* にする。
export function votingErrorKey(kind: string, part: 'title' | 'message'): string {
  return kind === 'insufficient_balance' ? `symbolvoting.error_insufficient_balance_${part}` : `nemvoting.error_${kind}_${part}`;
}

// 集計の種類ごとの文言の鍵（NEM の投票画面も使う。種類の値は NEM と Symbol で同じ）。
export function pollTypeLabelKey(type: number): string {
  if (type === POLL_TYPE_WHITELIST) return 'nemvoting.type_whitelist_short';
  if (type === POLL_TYPE_SIMPLE) return 'nemvoting.type_simple_short';
  if (type === POLL_TYPE_MOSAIC) return 'symbolvoting.type_mosaic_short';
  if (type === POLL_TYPE_MOSAIC_HOLDER) return 'symbolvoting.type_holder_short';
  return 'nemvoting.type_poi_short';
}

export function pollTypeHintKey(type: number): string {
  if (type === POLL_TYPE_WHITELIST) return 'nemvoting.type_whitelist_hint';
  if (type === POLL_TYPE_SIMPLE) return 'nemvoting.type_simple_hint';
  if (type === POLL_TYPE_MOSAIC) return 'symbolvoting.type_mosaic_hint';
  if (type === POLL_TYPE_MOSAIC_HOLDER) return 'symbolvoting.type_holder_hint';
  return 'nemvoting.type_poi_hint';
}

export function pollCountingKey(type: number): string {
  if (type === POLL_TYPE_WHITELIST) return 'nemvoting.counting_whitelist';
  if (type === POLL_TYPE_SIMPLE) return 'nemvoting.counting_simple';
  if (type === POLL_TYPE_MOSAIC) return 'symbolvoting.counting_mosaic';
  if (type === POLL_TYPE_MOSAIC_HOLDER) return 'symbolvoting.counting_holder';
  return 'nemvoting.counting_poi';
}

/** 終了時点の値を調べられず、現在の値で数えたときの注記の鍵。 */
export function pollApproximateKey(type: number): string {
  return type === POLL_TYPE_MOSAIC || type === POLL_TYPE_MOSAIC_HOLDER ? 'symbolvoting.approximate_mosaic_note' : 'nemvoting.approximate_note';
}

/** 「モザイクを指定する」画面・詳細の見出しの鍵（重み付けのモザイク／対象のモザイク）。 */
export function pollMosaicLabelKey(type: number, part: 'field' | 'summary' | 'in_use'): string {
  if (type === POLL_TYPE_MOSAIC_HOLDER) return `symbolvoting.holder_mosaic_${part}`;
  return part === 'field' ? 'symbolvoting.mosaic_label' : part === 'summary' ? 'symbolvoting.mosaic_summary_label' : 'symbolvoting.mosaic_in_use';
}

/** 保有者の投票: 「移転できないモザイクのみ」かどうかのバッジの文言の鍵。 */
export function holderRuleBadgeKey(nonTransferableOnly: boolean): string {
  return nonTransferableOnly ? 'symbolvoting.holder_badge_nt' : 'symbolvoting.holder_badge_any';
}

/** モザイクの入力の問題の文言の鍵。 */
export function mosaicInputErrorKey(message: string): string {
  switch (message) {
    case 'mosaic_invalid': return 'symbolvoting.mosaic_err_invalid';
    case 'mosaic_not_found': return 'symbolvoting.mosaic_err_not_found';
    case 'namespace_not_found': return 'symbolvoting.mosaic_err_namespace';
    case 'alias_not_mosaic': return 'symbolvoting.mosaic_err_alias';
    default: return 'symbolvoting.mosaic_err_failed';
  }
}

/** NEM のモザイクの入力の問題の文言の鍵（Symbol とは入力の形が違うので、文言は nemvoting.mosaic_*）。 */
export function nemMosaicInputErrorKey(message: string): string {
  switch (message) {
    case 'mosaic_invalid': return 'nemvoting.mosaic_err_invalid';
    case 'mosaic_not_found': return 'nemvoting.mosaic_err_not_found';
    default: return 'nemvoting.mosaic_err_failed';
  }
}
