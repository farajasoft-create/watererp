import { describe, expect, it } from 'vitest';
import { Decimal } from '@/platform/common/money';
import { calculatePay, KENYA_RATES_2025, KENYA_RATES_2026, nssfTiers, taxOnBands } from './engine';

const rates = KENYA_RATES_2026;
const pay = (basic: string, extra: Partial<Parameters<typeof calculatePay>[0]> = {}) => calculatePay({ basic, rates, ...extra });

describe('Kenyan payroll engine', () => {
  it('works a typical salary: NSSF, SHIF and AHL come off before PAYE', () => {
    const r = pay('50000');
    expect(r.nssfEmployee.toFixed(2)).toBe('3000.00');
    expect(r.shif.toFixed(2)).toBe('1375.00');
    expect(r.ahlEmployee.toFixed(2)).toBe('750.00');
    expect(r.taxablePay.toFixed(2)).toBe('44875.00');
    expect(r.taxCharged.toFixed(2)).toBe('8245.85');
    expect(r.paye.toFixed(2)).toBe('5845.85');
    expect(r.netPay.toFixed(2)).toBe('39029.15');
    expect(r.employerCost.toFixed(2)).toBe('53800.00'); // + NSSF 3,000 + AHL 750 + NITA 50
  });

  it('caps NSSF at the upper earnings limit, which rose in February 2026', () => {
    expect(pay('200000').nssfEmployee.toFixed(2)).toBe('6480.00');
    expect(calculatePay({ basic: '200000', rates: KENYA_RATES_2025 }).nssfEmployee.toFixed(2)).toBe('4320.00');
    const tiers = nssfTiers(new Decimal(50000), rates.nssf);
    expect([tiers.tier1.toFixed(2), tiers.tier2.toFixed(2)]).toEqual(['540.00', '2460.00']);
  });

  it('taxes every band up to 35%', () => {
    const r = pay('1000000');
    expect(r.taxablePay.toFixed(2)).toBe('951020.00');
    expect(r.paye.toFixed(2)).toBe('292740.35');
    expect(taxOnBands(new Decimal(24000), rates.paye.bands).toFixed(2)).toBe('2400.00');
  });

  it('charges no PAYE below the relief, and the SHIF minimum on low pay', () => {
    const r = pay('10000');
    expect(r.paye.toFixed(2)).toBe('0.00');
    expect(r.personalRelief.toFixed(2)).toBe('895.00'); // relief never goes beyond the tax
    expect(r.shif.toFixed(2)).toBe('300.00');
    expect(pay('20000').paye.toFixed(2)).toBe('0.00');
  });

  it('gives pension relief up to the cap, NSSF included', () => {
    const r = pay('100000', { deductions: [{ code: 'PENSION', name: 'Staff pension', amount: '30000', pension: true }] });
    expect(r.pensionRelief.toFixed(2)).toBe('24000.00');
    expect(r.otherDeductions.toFixed(2)).toBe('30000.00');
  });

  it('keeps reimbursements out of statutory pay but pays them', () => {
    const r = pay('40000', { earnings: [{ code: 'HOUSE', name: 'House allowance', amount: '10000' }, { code: 'MILEAGE', name: 'Mileage claim', amount: '5000', taxable: false }] });
    expect(r.grossPay.toFixed(2)).toBe('50000.00');
    expect(r.gross.toFixed(2)).toBe('55000.00');
    expect(r.netPay.toFixed(2)).toBe('44029.15');
    expect(r.lines.map((l) => l.code)).toEqual(['BASIC', 'HOUSE', 'MILEAGE', 'PAYE', 'NSSF', 'SHIF', 'AHL', 'NSSF_ER', 'AHL_ER', 'NITA']);
  });

  it('honours exemptions and warns when deductions pass two-thirds of pay', () => {
    expect(pay('50000', { exempt: { paye: true } }).paye.toFixed(2)).toBe('0.00');
    const r = pay('30000', { deductions: [{ code: 'LOAN', name: 'Salary advance', amount: '20000' }] });
    expect(r.warnings[0]).toMatch(/two-thirds/);
    expect(pay('0').netPay.toFixed(2)).toBe('0.00');
  });

  it('takes from a second payroll in the month only what the first left owing', () => {
    const keys = ['nssfEmployee', 'shif', 'ahlEmployee', 'ahlEmployer', 'taxCharged', 'personalRelief', 'paye', 'nita'] as const;
    for (const [salary, bonus] of [['50000', '20000'], ['10000', '15000'], ['100000', '150000'], ['20000', '1000']]) {
      const whole = pay(String(Number(salary) + Number(bonus)));
      const first = pay(salary);
      const second = pay('0', { earnings: [{ code: 'BONUS', name: 'Bonus', amount: bonus }], prior: first });
      for (const k of keys) expect(first[k].plus(second[k]).toFixed(2), `${k} on ${salary} + ${bonus}`).toBe(whole[k].toFixed(2));
    }
    // The NITA levy and personal relief are monthly: not given again.
    const bonus = pay('0', { earnings: [{ code: 'BONUS', name: 'Bonus', amount: '20000' }], prior: pay('50000') });
    expect(bonus.nita.toFixed(2)).toBe('0.00');
    expect(bonus.personalRelief.toFixed(2)).toBe('0.00');
    expect(bonus.paye.toFixed(2)).toBe('5385.00'); // 30% of 20,000 less the extra NSSF, SHIF and levy
  });
});
