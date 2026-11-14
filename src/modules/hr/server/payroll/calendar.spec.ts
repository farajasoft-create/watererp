import { describe, expect, it } from 'vitest';
import { periodEnd, proratedBasic, unpaidLeaveDeduction, workingDays } from './calendar';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('payroll calendar', () => {
  it('counts weekdays less holidays', () => {
    expect(workingDays(d('2026-12-01'), d('2026-12-31'))).toBe(23);
    expect(workingDays(d('2026-12-01'), d('2026-12-31'), ['2026-12-25', '2026-12-26'])).toBe(22); // the 26th is a Saturday
    expect(workingDays(d('2026-11-07'), d('2026-11-08'))).toBe(0);
  });

  it('finds the end of any month', () => {
    expect(periodEnd('2026-02').toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(periodEnd('2028-02').toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('pro-rates joiners and leavers by calendar days', () => {
    expect(proratedBasic('60000', '2026-11', d('2025-01-10'), null).amount.toFixed(2)).toBe('60000.00');
    const joiner = proratedBasic('60000', '2026-11', d('2026-11-16'), null);
    expect([joiner.days, joiner.ofDays, joiner.amount.toFixed(2)]).toEqual([15, 30, '30000.00']);
    expect(proratedBasic('60000', '2026-11', d('2024-01-01'), d('2026-11-10')).amount.toFixed(2)).toBe('20000.00');
    expect(proratedBasic('60000', '2026-11', d('2026-12-01'), null).amount.toFixed(2)).toBe('0.00');
  });

  it('withholds a day of basic per unpaid working day', () => {
    expect(unpaidLeaveDeduction('44000', 2, 22).toFixed(2)).toBe('4000.00');
    expect(unpaidLeaveDeduction('44000', 30, 22).toFixed(2)).toBe('44000.00');
  });
});
