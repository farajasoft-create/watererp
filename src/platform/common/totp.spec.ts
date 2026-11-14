import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, newTotpSecret, totp, verifyTotp } from './totp';

describe('authenticator codes (RFC 6238)', () => {
  // RFC 6238 appendix B: the ASCII secret "12345678901234567890", SHA-1, 8 digits.
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world');
    expect(rfcSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('matches the RFC test vectors', () => {
    expect(totp(rfcSecret, 59_000, 30, 8)).toBe('94287082');
    expect(totp(rfcSecret, 1_111_111_109_000, 30, 8)).toBe('07081804');
    expect(totp(rfcSecret, 2_000_000_000_000, 30, 8)).toBe('69279037');
  });

  it('accepts a code from the step before or after, but not older', () => {
    const secret = newTotpSecret();
    const now = 1_800_000_000_000;
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
  });
});
