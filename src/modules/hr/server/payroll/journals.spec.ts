import { describe, expect, it } from 'vitest';
import { Decimal } from '@/platform/common/money';
import { isBalanced } from '@/platform/ledger/types';
import { calculatePay, KENYA_RATES_2026 } from './engine';
import { AccountMapping, missingAccounts, payrollJournalLines, paymentJournalLines } from './journals';

const mapping = Object.fromEntries(['salaries', 'employerCosts', 'paye', 'nssf', 'shif', 'ahl', 'nita', 'otherDeductions', 'netPay', 'bank'].map((k) => [k, k])) as unknown as AccountMapping;

describe('payroll journals', () => {
  it('balances for a whole run, employer contributions included', () => {
    const slips = ['50000', '23500.50', '180000'].map((basic, i) =>
      calculatePay({ basic, rates: KENYA_RATES_2026, earnings: [{ code: 'HOUSE', name: 'House', amount: '7500' }], deductions: i === 1 ? [{ code: 'SACCO', name: 'SACCO', amount: '2000' }] : [] }),
    );
    const sum = (k: 'gross' | 'paye' | 'nssfEmployee' | 'nssfEmployer' | 'shif' | 'ahlEmployee' | 'ahlEmployer' | 'nita' | 'otherDeductions' | 'netPay') => slips.reduce((s, p) => s.plus(p[k]), new Decimal(0));
    const totals = { gross: sum('gross'), paye: sum('paye'), nssfEmployee: sum('nssfEmployee'), nssfEmployer: sum('nssfEmployer'), shif: sum('shif'), ahlEmployee: sum('ahlEmployee'), ahlEmployer: sum('ahlEmployer'), nita: sum('nita'), otherDeductions: sum('otherDeductions'), netPay: sum('netPay') };
    const lines = payrollJournalLines(totals, mapping, '2026-11');
    expect(isBalanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountId === 'nita')?.credit).toBe('150.00');
    expect(isBalanced(paymentJournalLines(totals.netPay, mapping, 'Salaries'))).toBe(true);
  });

  it('accrues employer pension and gratuity, and charges gratuity paid to the liability', () => {
    const accrue = calculatePay({ basic: '100000', rates: KENYA_RATES_2026, deductions: [{ code: 'KIE', name: 'KIE', amount: '5000', pension: true }, { code: 'LIFE', name: 'Life', amount: '2000', insurance: true }], employerContributions: [{ code: 'KIE_ER', name: 'KIE (employer)', amount: '10000' }, { code: 'GRATUITY', name: 'Gratuity', amount: '20000' }] });
    expect(accrue.insuranceRelief.toFixed(2)).toBe('300.00');
    expect(accrue.employerCost.minus(accrue.gross).minus(accrue.nssfEmployer).minus(accrue.ahlEmployer).minus(accrue.nita).toFixed(2)).toBe('30000.00');
    const m = { ...mapping, pension: 'pension', gratuity: 'gratuity' };
    const lines = payrollJournalLines(accrue, m, '2026-11');
    expect(isBalanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountId === 'gratuity')?.credit).toBe('20000.00');
    expect(lines.find((l) => l.accountId === 'pension')?.credit).toBe('10000.00');

    const payout = calculatePay({ basic: 0, rates: KENYA_RATES_2026, earnings: [{ code: 'GRATUITY_PAY', name: 'Gratuity', amount: '40000' }] });
    expect(payout.gratuityPaid.toFixed(2)).toBe('40000.00');
    const paid = payrollJournalLines(payout, m, '2026-12');
    expect(isBalanced(paid)).toBe(true);
    expect(paid.find((l) => l.accountId === 'gratuity')?.debit).toBe('40000.00');
    expect(paid.find((l) => l.accountId === 'salaries')).toBeUndefined();
  });

  it('names the accounts still to map', () => {
    expect(missingAccounts({ salaries: 'x' }, ['salaries', 'paye'])).toEqual(['PAYE payable']);
  });
});
