// The rules for a NEW wallet password (registering, changing, importing a profile). Checking an existing
// password never uses these: a wallet protected by an older, shorter password must still open.
//
// This is a deliberately small, offline check - no strength meter, no word list download. It refuses the
// passwords an attacker tries first, because whoever copies the browser storage can guess offline
// without any lock-out (the key stretching is the only brake, so the password has to carry weight too).
export const MIN_PASSWORD_LENGTH = 10;

export type PasswordProblem = 'too_short' | 'weak';

// The most common passwords that are long enough to pass the length rule (lower-case, compared as typed).
const COMMON = new Set([
  'password12', 'password123', 'password1234', 'passw0rd123', 'qwertyuiop', 'qwerty1234', 'qwerty12345',
  'qwertyuiop1', 'asdfghjkl1', 'asdfghjklq', 'zxcvbnm123', 'iloveyou12', 'iloveyou123', 'welcome123',
  'welcome1234', 'letmein123', 'letmein1234', 'admin12345', 'administrator', 'abc1234567', 'abcd123456',
  '1q2w3e4r5t', '1qaz2wsx3edc', '1234qwer56', 'monkey1234', 'dragon1234', 'football123', 'baseball123',
  'sunshine123', 'princess123', 'trustno111', 'changeme123', 'symbol1234', 'symbolwallet', 'nemwallet12',
  'kasane1234', 'kasanewallet', 'xymxymxymxym', 'xemxemxemxem', 'mnemonic123',
]);

const SEQUENCES = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
  'qwertyuiopasdfghjklzxcvbnm', '1234567890qwertyuiop'];

function isRepeatOfShortChunk(s: string): boolean {
  for (let size = 1; size <= 3; size += 1) {
    if (s.length % size === 0 && s.slice(0, size).repeat(s.length / size) === s) {
      return true;
    }
  }
  return false;
}

export function passwordProblem(password: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'too_short';
  }
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) {
    return 'weak';
  }
  if (new Set(lower).size < 5) {
    return 'weak';
  }
  if (isRepeatOfShortChunk(lower)) {
    return 'weak';
  }
  // Numbers only: 10 digits is only 10^10 tries. Ask for a much longer one.
  if (/^[0-9]+$/.test(password) && password.length < 16) {
    return 'weak';
  }
  // The whole password is a run of a keyboard / alphabet / digit sequence (e.g. "abcdefghij", "1234567890").
  if (SEQUENCES.some((seq) => seq.includes(lower))) {
    return 'weak';
  }
  return null;
}
