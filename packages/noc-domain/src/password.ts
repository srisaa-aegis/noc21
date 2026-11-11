/**
 * Password policy (decision Q-5: raised from the legacy 6-character minimum).
 *
 * Applies whenever a password is *set* (registration, change, reset, temporary
 * passwords). Existing passwords keep working until they are next changed.
 */
export const MIN_PASSWORD_LENGTH = 10;

const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;
const DIGIT = /\d/;
const SYMBOL = /[^A-Za-z0-9]/;

/** Human-readable summary, for the forms. */
export const PASSWORD_RULES =
  'At least 10 characters, with an upper-case letter, a lower-case letter, a digit and a symbol, and not containing your username.';

/** Every rule the password breaks (empty = acceptable). */
export function passwordPolicyProblems(password: string, identity: { username?: string; email?: string } = {}): string[] {
  const out: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) out.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (!UPPER.test(password)) out.push('Include an upper-case letter.');
  if (!LOWER.test(password)) out.push('Include a lower-case letter.');
  if (!DIGIT.test(password)) out.push('Include a digit.');
  if (!SYMBOL.test(password)) out.push('Include a symbol (for example ! @ # $ %).');
  const lower = password.toLowerCase();
  const names = [identity.username, identity.email?.split('@')[0]].filter((n): n is string => !!n && n.length >= 3);
  if (names.some((n) => lower.includes(n.toLowerCase()))) out.push('Do not include your username or e-mail name.');
  return out;
}

/** One message for the forms, or null when the password is acceptable. */
export function passwordProblem(password: string, confirm: string, identity: { username?: string; email?: string } = {}): string | null {
  const problems = passwordPolicyProblems(password, identity);
  if (problems.length) return `The password does not meet the policy: ${problems.join(' ')}`;
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}

const UPPERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERS = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*!?';
const ALPHABET = UPPERS + LOWERS + DIGITS;

/**
 * Temporary password for new accounts and resets: no ambiguous characters, and
 * always compliant with the policy.
 */
export function generateTemporaryPassword(length = 12, random: () => number = Math.random): string {
  const pick = (set: string) => set[Math.floor(random() * set.length)];
  const chars = [pick(UPPERS), pick(LOWERS), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < Math.max(length, MIN_PASSWORD_LENGTH)) chars.push(pick(ALPHABET));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
