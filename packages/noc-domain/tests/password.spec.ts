import { generateTemporaryPassword, passwordPolicyProblems, passwordProblem } from '../src/password.js';

describe('password policy (10+ characters with complexity)', () => {
  it('generates compliant temporary passwords without ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(12);
      expect(p).not.toMatch(/[O0Il1]/);
      expect(passwordPolicyProblems(p)).toEqual([]);
    }
    expect(generateTemporaryPassword(40)).toHaveLength(40);
  });

  it('lists every rule a password breaks', () => {
    expect(passwordPolicyProblems('abc')).toEqual([
      'Use at least 10 characters.',
      'Include an upper-case letter.',
      'Include a digit.',
      'Include a symbol (for example ! @ # $ %).',
    ]);
    expect(passwordPolicyProblems('Str0ng!Passw0rd')).toEqual([]);
  });

  it('refuses a password containing the username or e-mail name', () => {
    expect(passwordPolicyProblems('Citizen1!xyz', { username: 'citizen1' })).toContain('Do not include your username or e-mail name.');
    expect(passwordPolicyProblems('Builder1!xyz9', { email: 'builder1@example.com' })).toContain('Do not include your username or e-mail name.');
  });

  it('validates the confirmation', () => {
    expect(passwordProblem('abc', 'abc')).toContain('does not meet the policy');
    expect(passwordProblem('Str0ng!Passw0rd', 'Str0ng!Passw0rX')).toBe('Passwords do not match.');
    expect(passwordProblem('Str0ng!Passw0rd', 'Str0ng!Passw0rd')).toBeNull();
  });
});
