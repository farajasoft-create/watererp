import { describe, expect, it } from 'vitest';
import { balance, earned } from './entitlement';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const annual = { daysPerYear: 21, accrual: 'MONTHLY' as const };

describe('leave entitlement', () => {
  it('earns annual leave month by month', () => {
    expect(earned(annual, 2026, d('2020-03-01'), d('2026-11-02'))).toBe(19.25);
    expect(earned(annual, 2026, d('2020-03-01'), d('2027-01-05'))).toBe(21);
    expect(earned(annual, 2026, d('2026-09-10'), d('2026-11-02'))).toBe(5.25);
    expect(earned(annual, 2026, d('2026-09-20'), d('2026-11-02'))).toBe(3.5);
  });

  it('grants yearly leave at once, and nothing before joining', () => {
    expect(earned({ daysPerYear: 14, accrual: 'ANNUAL' }, 2026, d('2026-10-01'), d('2026-10-02'))).toBe(14);
    expect(earned(annual, 2025, d('2026-01-01'), d('2026-11-02'))).toBe(0);
  });

  it('nets what is taken and waiting from what is earned', () => {
    expect(balance(19.25, 5, 10, 2).available).toBe(12.25);
  });
});
