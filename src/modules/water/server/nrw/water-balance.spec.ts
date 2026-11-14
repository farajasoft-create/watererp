import { describe, expect, it } from 'vitest';
import { nrwRating, waterBalance } from './water-balance';

describe('waterBalance', () => {
  it('computes NRW as system input less billed consumption', () => {
    const b = waterBalance({ systemInput: 10_000, billedMetered: 6_500, billedUnmetered: 500, unbilledAuthorised: 200 });
    expect(b.revenueWater.toFixed()).toBe('7000');
    expect(b.nonRevenueWater.toFixed()).toBe('3000');
    expect(b.nrwPercent!.toFixed(1)).toBe('30.0');
    expect(b.waterLosses.toFixed()).toBe('2800');
    expect(nrwRating(b.nrwPercent)).toBe('UNACCEPTABLE');
  });

  it('has no percentage without a system input', () => {
    expect(waterBalance({ systemInput: 0, billedMetered: 10, billedUnmetered: 0 }).nrwPercent).toBeNull();
  });

  it('rates against the WASREB bands', () => {
    expect(nrwRating(18)).toBe('GOOD');
    expect(nrwRating(25)).toBe('ACCEPTABLE');
    expect(nrwRating(null)).toBeNull();
  });
});
