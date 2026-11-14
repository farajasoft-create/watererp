import { describe, expect, it } from 'vitest';
import { allocate, planState, schedule } from './plan';

describe('payment plans', () => {
  const start = new Date('2026-11-05T00:00:00Z');

  it('splits arrears after the deposit into monthly instalments that add up exactly', () => {
    const s = schedule('10000', '1000', 3, start);
    expect(s.map((i) => i.amount.toFixed(2))).toEqual(['3000.00', '3000.00', '3000.00']);
    expect(s.map((i) => i.dueDate.toISOString().slice(0, 10))).toEqual(['2026-12-05', '2027-01-05', '2027-02-05']);
    const odd = schedule('1000', '0', 3, start);
    expect(odd.map((i) => i.amount.toFixed(2))).toEqual(['333.33', '333.33', '333.34']);
  });

  it('clears the deposit first, then instalments in order', () => {
    const s = schedule('10000', '1000', 3, start);
    const a = allocate('1000', s, '4500');
    expect(a.depositPaid).toBe(true);
    expect(a.instalments.map((i) => i.paid.toFixed(2))).toEqual(['3000.00', '500.00', '0.00']);
  });

  it('is in default once an instalment is past the grace days, and complete when all is paid', () => {
    const s = schedule('10000', '1000', 3, start);
    const plan = { deposit: '1000', startDate: start, instalments: s, graceDays: 7 };
    expect(planState({ ...plan, paidToDate: '1000' }, new Date('2026-12-10T00:00:00Z')).status).toBe('ACTIVE');
    expect(planState({ ...plan, paidToDate: '1000' }, new Date('2026-12-13T00:00:00Z')).status).toBe('DEFAULTED');
    expect(planState({ ...plan, paidToDate: '0' }, new Date('2026-11-20T00:00:00Z')).status).toBe('DEFAULTED');
    expect(planState({ ...plan, paidToDate: '10000' }, new Date('2027-06-01T00:00:00Z')).status).toBe('COMPLETED');
  });
});
