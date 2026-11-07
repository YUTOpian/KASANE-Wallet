// NEM: 既存モザイクの定義の編集（同じ名前でモザイク定義を送り直す）に使う判定・入力チェック。
// 画面（NemMosaicEdit）とテスト（dev-tests/nem-mosaic-edit.test.ts）で共用する。通信はしない。
import { isValidNemAddress, normalizeNemAddress } from './crypto';
import { NEM_MAX_MOSAIC_DESCRIPTION_BYTES, NEM_MAX_MOSAIC_DIVISIBILITY, NEM_MAX_MOSAIC_INITIAL_SUPPLY, splitNemMosaicId } from './tx';
import type { NemMosaicLevyParams } from './tx';

/** 徴収（レビー）の上限。NIS1 の数量の上限（9,000,000,000,000,000）に合わせる。 */
export const NEM_MAX_LEVY_FEE = 9_000_000_000_000_000n;
/** パーセンタイル徴収は「1万あたり」なので、10,000 で 100%。 */
export const NEM_MAX_LEVY_PERCENTILE = 10_000n;

/** ネットワーク上のモザイク定義（最新のもの）。 */
export interface NemMosaicDefinition {
  id: string; // "namespace:name"
  creator: string; // public key (hex)
  description: string;
  divisibility: number;
  initialSupply: bigint; // whole units
  supplyMutable: boolean;
  transferable: boolean;
  levy: NemMosaicLevyParams | null;
}

/** 編集できる値（送り直す定義の中身）。 */
export interface NemMosaicEditValues {
  description: string;
  divisibility: number;
  initialSupply: bigint; // whole units
  supplyMutable: boolean;
  transferable: boolean;
  levy: NemMosaicLevyParams | null;
}

/**
 * - full: 作成者が供給量のすべてを持っている。説明・分割可能数・供給量・各設定・徴収をすべて変えられる。
 * - description: 作成者の保有量が供給量より少ない。変えられるのは説明だけ（プロパティと徴収は今のまま送り直す）。
 * - unknown: 供給量か保有量が読めなかった。画面は全項目を出して警告し、送れるかはノードの判定に任せる（拒否されても費用はかからない）。
 */
export type NemMosaicEditAccess = 'full' | 'description' | 'unknown';

/** NIS1 の徴収の定義（REST の levy）を読む。徴収なし、または読めない形は null。 */
export function nemLevyFromRaw(raw: unknown): NemMosaicLevyParams | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { type?: number; recipient?: string; mosaicId?: { namespaceId?: string; name?: string }; fee?: number | string };
  if (!r.mosaicId?.namespaceId || !r.mosaicId.name || !r.recipient || r.fee === undefined || r.fee === null) return null;
  if (typeof r.fee === 'string' ? !/^\d+$/.test(r.fee) : !Number.isSafeInteger(r.fee) || r.fee < 0) return null;
  return {
    feeType: r.type === 2 ? 'percentile' : 'absolute',
    recipient: normalizeNemAddress(r.recipient),
    mosaicId: `${r.mosaicId.namespaceId}:${r.mosaicId.name}`.toLowerCase(),
    fee: BigInt(r.fee),
  };
}

export function nemLevyEquals(a: NemMosaicLevyParams | null, b: NemMosaicLevyParams | null): boolean {
  if (a === null || b === null) return a === b;
  return a.feeType === b.feeType
    && normalizeNemAddress(a.recipient) === normalizeNemAddress(b.recipient)
    && a.mosaicId.toLowerCase() === b.mosaicId.toLowerCase()
    && a.fee === b.fee;
}

/** 作成者が供給量のすべてを持っているか。`supplyUnits` は供給量（整数部）、`creatorBalance` は作成者の保有量（最小単位）。 */
export function nemMosaicEditAccess(def: Pick<NemMosaicDefinition, 'divisibility' | 'initialSupply' | 'supplyMutable'>, creatorBalance: bigint | null, supplyUnits: bigint | null): NemMosaicEditAccess {
  // 供給量が変わらないモザイクは、定義の初期供給量がそのまま今の供給量。
  const units = def.supplyMutable ? supplyUnits : def.initialSupply;
  if (units === null || creatorBalance === null) return 'unknown';
  return creatorBalance === units * 10n ** BigInt(def.divisibility) ? 'full' : 'description';
}

/** 今の定義から、編集前の値を作る。供給量が変えられるモザイクは、分かっていれば「今の供給量」を初期供給量として出す。 */
export function nemMosaicEditBase(def: NemMosaicDefinition, currentSupply: bigint | null): NemMosaicEditValues {
  return {
    description: def.description,
    divisibility: def.divisibility,
    initialSupply: def.supplyMutable && currentSupply !== null ? currentSupply : def.initialSupply,
    supplyMutable: def.supplyMutable,
    transferable: def.transferable,
    levy: def.levy,
  };
}

export interface NemMosaicEditDiff {
  description: boolean;
  divisibility: boolean;
  initialSupply: boolean;
  supplyMutable: boolean;
  transferable: boolean;
  levy: boolean;
  /** 説明以外（プロパティか徴収）が変わる。 */
  propertiesOrLevy: boolean;
  any: boolean;
}

export function nemMosaicEditDiff(base: NemMosaicEditValues, next: NemMosaicEditValues): NemMosaicEditDiff {
  const description = base.description !== next.description;
  const divisibility = base.divisibility !== next.divisibility;
  const initialSupply = base.initialSupply !== next.initialSupply;
  const supplyMutable = base.supplyMutable !== next.supplyMutable;
  const transferable = base.transferable !== next.transferable;
  const levy = !nemLevyEquals(base.levy, next.levy);
  const propertiesOrLevy = divisibility || initialSupply || supplyMutable || transferable || levy;
  return { description, divisibility, initialSupply, supplyMutable, transferable, levy, propertiesOrLevy, any: description || propertiesOrLevy };
}

/**
 * 実際に送る定義。保有量が足りない（description）ときは、説明以外は今の定義をそのまま送り直す。
 * （画面で触れないようにしてあるが、ここでも守る。徴収を落として送ると、徴収が消えてしまう。）
 */
export function nemMosaicEditSend(def: NemMosaicDefinition, values: NemMosaicEditValues, access: NemMosaicEditAccess): NemMosaicEditValues {
  if (access === 'description') {
    return { description: values.description, divisibility: def.divisibility, initialSupply: def.initialSupply, supplyMutable: def.supplyMutable, transferable: def.transferable, levy: def.levy };
  }
  return values;
}

export type NemLevyError = 'recipient' | 'mosaic' | 'fee';

/** 徴収の入力チェック。問題がなければ null。 */
export function validateNemLevy(levy: NemMosaicLevyParams, networkByte: number): NemLevyError | null {
  if (!isValidNemAddress(levy.recipient, networkByte)) return 'recipient';
  try {
    splitNemMosaicId(levy.mosaicId);
  } catch {
    return 'mosaic';
  }
  if (levy.fee <= 0n) return 'fee';
  if (levy.feeType === 'percentile' ? levy.fee > NEM_MAX_LEVY_PERCENTILE : levy.fee > NEM_MAX_LEVY_FEE) return 'fee';
  return null;
}

export type NemMosaicEditError = 'description' | 'divisibility' | 'supply' | 'supply_too_large' | 'levy' | 'no_changes' | 'not_creator';

/** 送る前の全体チェック。問題がなければ null。 */
export function validateNemMosaicEdit(
  def: NemMosaicDefinition,
  base: NemMosaicEditValues,
  values: NemMosaicEditValues,
  access: NemMosaicEditAccess,
  networkByte: number,
  signerPublicKey: string,
): NemMosaicEditError | null {
  if (def.creator.toLowerCase() !== signerPublicKey.toLowerCase()) return 'not_creator';
  if (new TextEncoder().encode(values.description).length > NEM_MAX_MOSAIC_DESCRIPTION_BYTES) return 'description';
  // 保有量が足りないとき、変えられるのは説明だけ。
  if (access === 'description') return values.description !== base.description ? null : 'no_changes';
  if (values.divisibility < 0 || !Number.isInteger(values.divisibility) || values.divisibility > NEM_MAX_MOSAIC_DIVISIBILITY) return 'divisibility';
  if (values.initialSupply <= 0n) return 'supply';
  if (values.initialSupply > NEM_MAX_MOSAIC_INITIAL_SUPPLY) return 'supply_too_large';
  if (values.levy && !nemLevyEquals(values.levy, base.levy) && validateNemLevy(values.levy, networkByte)) return 'levy';
  // 何も変わらない定義は NIS1 が受け付けない（Failure_Mosaic_Modification_No_Changes）。
  return nemMosaicEditDiff(base, values).any ? null : 'no_changes';
}
