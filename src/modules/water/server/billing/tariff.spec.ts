import { describe, expect, it } from 'vitest';
import { billCharges, tariffProblems, waterCharge } from './tariff';

/** A typical WASREB domestic structure: a 0–6 m³ minimum charge, then rising blocks. */
const domestic = {
  blocks: [
    { upTo: 6, rate: 0, fixedAmount: 600 },
    { upTo: 20, rate: 120 },
    { upTo: 50, rate: 140 },
    { upTo: null, rate: 160 },
  ],
  meterRent: 50,
  sewerPercent: 75,
};

describe('waterCharge', () => {
  it('charges the minimum for zero and for anything inside the first band', () => {
    expect(waterCharge(domestic.blocks, 0).amount.toFixed(2)).toBe('600.00');
    expect(waterCharge(domestic.blocks, 6).amount.toFixed(2)).toBe('600.00');
  });

  it('prices each block incrementally', () => {
    // 600 + 14 × 120 + 5 × 140
    expect(waterCharge(domestic.blocks, 25).amount.toFixed(2)).toBe('2980.00');
    // 600 + 14 × 120 + 30 × 140 + 10 × 160
    expect(waterCharge(domestic.blocks, 60).amount.toFixed(2)).toBe('8080.00');
  });

  it('handles fractional units without floating-point drift', () => {
    expect(waterCharge(domestic.blocks, '7.3').amount.toFixed(2)).toBe('756.00');
  });

  it('rejects negative consumption', () => {
    expect(() => waterCharge(domestic.blocks, -1)).toThrow();
  });
});

describe('billCharges', () => {
  it('adds sewerage for sewered connections and meter rent', () => {
    const lines = billCharges(domestic, 25, { sewered: true });
    expect(lines.map((l) => [l.code, l.amount.toFixed(2)])).toEqual([
      ['WATER', '2980.00'],
      ['SEWER', '2235.00'],
      ['METER_RENT', '50.00'],
    ]);
  });

  it('leaves sewerage off unsewered connections', () => {
    expect(billCharges(domestic, 25, { sewered: false }).map((l) => l.code)).toEqual(['WATER', 'METER_RENT']);
  });

  it('applies a minimum charge on flat tariffs', () => {
    const kiosk = { blocks: [{ upTo: null, rate: 50 }], minimumCharge: 300 };
    expect(billCharges(kiosk, 2, { sewered: false })[0].amount.toFixed(2)).toBe('300.00');
    expect(billCharges(kiosk, 10, { sewered: false })[0].amount.toFixed(2)).toBe('500.00');
  });
});

describe('tariffProblems', () => {
  it('accepts a well-formed tariff', () => {
    expect(tariffProblems(domestic)).toEqual([]);
  });

  it('requires an open-ended last band and rising limits', () => {
    expect(tariffProblems({ blocks: [{ upTo: 10, rate: 100 }] })).toContain('The last band must be open-ended so every consumption is priced');
    expect(tariffProblems({ blocks: [{ upTo: 10, rate: 100 }, { upTo: 5, rate: 120 }, { upTo: null, rate: 130 }] })[0]).toMatch(/upper limit/);
    expect(tariffProblems({ blocks: [{ upTo: null, rate: 100 }, { upTo: null, rate: 120 }] })[0]).toMatch(/only the last band/);
  });
});
