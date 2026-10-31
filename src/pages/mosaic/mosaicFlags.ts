import {
  MOSAIC_FLAG_REVOKABLE,
  MOSAIC_FLAG_RESTRICTABLE,
  MOSAIC_FLAG_SUPPLY_MUTABLE,
  MOSAIC_FLAG_TRANSFERABLE,
  } from '../../lib/symbol/tx';

// The four mosaic options in display order, with the i18n key of their short label.
export const MOSAIC_FLAG_LABELS: { mask: number; labelKey: string }[] = [
  { mask: MOSAIC_FLAG_SUPPLY_MUTABLE, labelKey: 'mosaic.flag_supply_mutable' },
  { mask: MOSAIC_FLAG_TRANSFERABLE, labelKey: 'mosaic.flag_transferable' },
  { mask: MOSAIC_FLAG_RESTRICTABLE, labelKey: 'mosaic.flag_restrictable' },
  { mask: MOSAIC_FLAG_REVOKABLE, labelKey: 'mosaic.flag_revokable' },
];

/** "1234567.5" -> "1,234,567.5" without going through Number (supplies can exceed 2^53 in atomic units). */
export function groupDigits(decimalText: string): string {
  const [whole, frac] = decimalText.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}
