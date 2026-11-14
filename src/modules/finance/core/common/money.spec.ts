import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { dec, round, sum, toD128 } from './money';

describe('money', () => {
  it('avoids binary floating point errors', () => {
    expect(sum(['0.1', '0.2']).toFixed()).toBe('0.3');
  });

  it('rounds half up to currency precision', () => {
    expect(round('10.005', 2).toFixed(2)).toBe('10.01');
    expect(round('-10.005', 2).toFixed(2)).toBe('-10.01');
    expect(round('1234.5', 0).toFixed(0)).toBe('1235');
  });

  it('round-trips through Decimal128', () => {
    const stored = toD128('12345678901234.1234');
    expect(stored).toBeInstanceOf(Types.Decimal128);
    expect(dec(stored).toFixed()).toBe('12345678901234.1234');
  });

  it('treats missing values as zero', () => {
    expect(dec(undefined).isZero()).toBe(true);
    expect(dec('').isZero()).toBe(true);
  });
});
