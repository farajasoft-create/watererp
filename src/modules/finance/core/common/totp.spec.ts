import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, decryptSecret, encryptSecret, generateRecoveryCodes, hashRecoveryCode, hotp, verifyTotp } from './totp';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" (SHA-1); these are the low 6 digits.
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('round-trips base32', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(SECRET).toString()).toBe('12345678901234567890');
  });

  it('matches the RFC 6238 test vectors', () => {
    expect(hotp(SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(hotp(SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepts one step of drift and refuses replays', () => {
    const now = 1111111109_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(SECRET, hotp(SECRET, step + 1), { now })).toBe(step + 1);
    expect(verifyTotp(SECRET, hotp(SECRET, step + 2), { now })).toBeNull();
    expect(verifyTotp(SECRET, hotp(SECRET, step), { now, afterStep: step })).toBeNull();
  });

  it('encrypts secrets and hashes recovery codes', () => {
    process.env.JWT_SECRET ??= 'unit-test-secret-unit-test-secret-1234';
    const stored = encryptSecret(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(decryptSecret(stored)).toBe(SECRET);
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(hashRecoveryCode(codes[0].toUpperCase())).toBe(hashRecoveryCode(codes[0]));
  });
});
