import { describe, expect, it } from 'vitest';
import { buildMonthlyPeriods, fiscalYearName } from './periods.service';

describe('fiscal calendar', () => {
  it('builds twelve contiguous monthly periods for a calendar year', () => {
    const periods = buildMonthlyPeriods(new Date('2026-01-01T00:00:00Z'));
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({ number: 1, name: 'Jan 2026' });
    expect(periods[1].endDate.toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(periods[11].endDate.toISOString().slice(0, 10)).toBe('2026-12-31');
    for (let i = 1; i < 12; i++) {
      expect(periods[i].startDate.getTime() - periods[i - 1].endDate.getTime()).toBe(86_400_000);
    }
  });

  it('handles non-calendar fiscal years spanning a leap February', () => {
    const periods = buildMonthlyPeriods(new Date('2027-07-01T00:00:00Z'));
    expect(periods[0].name).toBe('Jul 2027');
    expect(periods[7].endDate.toISOString().slice(0, 10)).toBe('2028-02-29');
    expect(periods[11].endDate.toISOString().slice(0, 10)).toBe('2028-06-30');
    expect(fiscalYearName(new Date('2027-07-01T00:00:00Z'))).toBe('FY2027/28');
    expect(fiscalYearName(new Date('2026-01-01T00:00:00Z'))).toBe('FY2026');
  });
});
