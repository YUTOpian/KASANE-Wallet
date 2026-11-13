/** Atomic units -> plain decimal string ("1234567", 6 -> "1.234567"; trailing zeros trimmed). */
export function formatAtomic(amount: bigint, divisibility: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(divisibility);
  const whole = abs / base;
  const frac = divisibility > 0 ? (abs % base).toString().padStart(divisibility, '0').replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

// No real amount needs anywhere near this many characters: the entire XYM/XEM supply is ~9 billion
// units (10 digits), and even at the largest divisibility (6) the longest legitimate value - the
// whole supply with every decimal place filled - is under 20 characters. Converting a decimal string
// to BigInt is not O(length) in V8 (it got measurably slower than linear in testing: ~150ms for a
// million-digit string, over a second for five million), so an unbounded amount field is a cheap
// client-side freeze: paste/autofill a few-million-digit string (a mis-scanned QR, a crafted deep
// link, an address-book/aggregate import with an attacker-controlled amount) and the tab hangs for
// as long as whoever supplied the string wants. Rejecting absurdly long input before it ever reaches
// BigInt(...) costs nothing for every real amount and closes that off.
const MAX_DECIMAL_TEXT_LENGTH = 40;

/** Plain decimal string -> atomic units, or null when malformed / too many decimals / absurdly long. */
export function parseDecimal(text: string, divisibility: number): bigint | null {
  const t = text.trim();
  if (t.length > MAX_DECIMAL_TEXT_LENGTH) return null;
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [whole, frac = ''] = t.split('.');
  if (frac.length > divisibility) return null;
  return BigInt(whole || '0') * 10n ** BigInt(divisibility) + BigInt(frac.padEnd(divisibility, '0') || '0');
}
