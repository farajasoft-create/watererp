import { describe, expect, it } from 'vitest';
import { averageConsumption, classify, consumption, estimateUnits } from './consumption';

describe('consumption', () => {
  it('is the difference between readings', () => {
    const r = consumption(1200, 1218);
    expect(r.ok && r.units.toFixed()).toBe('18');
  });

  it('detects a register rollover on a 5-dial meter', () => {
    const r = consumption(99_990, 12, 5);
    expect(r).toMatchObject({ ok: true, rollover: true });
    expect(r.ok && r.units.toFixed()).toBe('22');
  });

  it('treats a lower reading far from the top of the register as negative', () => {
    expect(consumption(5_000, 4_990, 5)).toEqual({ ok: false, reason: 'NEGATIVE' });
  });
});

describe('classify', () => {
  it('flags zero, high and low consumption against the average', () => {
    expect(classify(consumption(100, 100), 15)).toBe('ZERO');
    expect(classify(consumption(100, 150), 15)).toBe('HIGH');
    expect(classify(consumption(100, 103), 15)).toBe('LOW');
    expect(classify(consumption(100, 118), 15)).toBe('NONE');
  });

  it('does not judge connections without history or with tiny averages', () => {
    expect(classify(consumption(100, 190), null)).toBe('NONE');
    expect(classify(consumption(100, 110), 1)).toBe('NONE');
  });

  it('reports negatives and rollovers for review', () => {
    expect(classify(consumption(50, 40), 10)).toBe('NEGATIVE');
    expect(classify(consumption(99_995, 3, 5), 10)).toBe('ROLLOVER');
  });
});

describe('estimates', () => {
  it('averages the latest three readings', () => {
    expect(averageConsumption([12, 18, 15, 100])!.toFixed(2)).toBe('15.00');
    expect(averageConsumption([])).toBeNull();
  });

  it('falls back to the tariff default without history', () => {
    expect(estimateUnits([], 10).toFixed()).toBe('10');
    expect(estimateUnits([13, 14], 10).toFixed()).toBe('14');
  });
});
