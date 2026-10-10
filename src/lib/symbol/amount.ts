/** Atomic units -> plain decimal string ("1234567", 6 -> "1.234567"; trailing zeros trimmed). */
export function formatAtomic(amount: bigint, divisibility: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(divisibility);
  const whole = abs / base;
  const frac = divisibility > 0 ? (abs % base).toString().padStart(divisibility, '0').replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Plain decimal string -> atomic units, or null when malformed / too many decimals. */
export function parseDecimal(text: string, divisibility: number): bigint | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [whole, frac = ''] = t.split('.');
  if (frac.length > divisibility) return null;
  return BigInt(whole || '0') * 10n ** BigInt(divisibility) + BigInt(frac.padEnd(divisibility, '0') || '0');
}
