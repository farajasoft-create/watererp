import { Decimal, dec, DecimalInput } from '@/platform/common/money';
import { JournalLine } from '@/platform/ledger/types';

/** General-ledger accounts that payroll posts to (account ids). */
export interface AccountMapping {
  salaries: string;
  employerCosts: string;
  paye: string;
  nssf: string;
  shif: string;
  ahl: string;
  nita: string;
  otherDeductions: string;
  netPay: string;
  bank: string;
  /** Employer pension owed to the scheme; other deductions payable when not set. */
  pension?: string;
  /** Gratuity accrued to contract staff; other deductions payable when not set. */
  gratuity?: string;
}

export const MAPPING_LABELS: Record<keyof AccountMapping, string> = {
  salaries: 'Salaries and wages (expense)',
  employerCosts: 'Employer statutory contributions (expense)',
  paye: 'PAYE payable',
  nssf: 'NSSF payable',
  shif: 'SHIF payable',
  ahl: 'Housing levy payable',
  nita: 'NITA levy payable',
  otherDeductions: 'Other staff deductions payable (loans, SACCO…)',
  netPay: 'Net salaries payable',
  bank: 'Bank account salaries are paid from',
  pension: 'Pension contributions payable (optional)',
  gratuity: 'Gratuity payable (optional)',
};

export interface RunTotals {
  gross: DecimalInput;
  paye: DecimalInput;
  nssfEmployee: DecimalInput;
  nssfEmployer: DecimalInput;
  shif: DecimalInput;
  ahlEmployee: DecimalInput;
  ahlEmployer: DecimalInput;
  nita: DecimalInput;
  otherDeductions: DecimalInput;
  netPay: DecimalInput;
  employerPension?: DecimalInput;
  gratuity?: DecimalInput;
  /** Gratuity paid out on this payroll: part of gross, charged to the gratuity liability. */
  gratuityPaid?: DecimalInput;
}

const money = (d: Decimal) => d.toFixed(2);

/** A debit, or a credit when negative (and the other way round). Zero gives no line. */
function entry(accountId: string, description: string, amount: Decimal, side: 'debit' | 'credit'): JournalLine[] {
  if (amount.isZero()) return [];
  const flipped = amount.isNegative();
  const s = flipped ? (side === 'debit' ? 'credit' : 'debit') : side;
  return [{ accountId, description, [s]: money(amount.abs()) }];
}

/**
 * The payroll journal on approval: pay and the employer's contributions are expensed, and what is owed
 * to KRA, NSSF, SHA, the housing fund, NITA, other payees and the staff is recognised as payable.
 */
export function payrollJournalLines(t: RunTotals, m: AccountMapping, period: string): JournalLine[] {
  const employer = dec(t.nssfEmployer).plus(dec(t.ahlEmployer)).plus(dec(t.nita));
  const pension = dec(t.employerPension ?? 0);
  const gratuity = dec(t.gratuity ?? 0);
  const gratuityPaid = dec(t.gratuityPaid ?? 0);
  return [
    ...entry(m.salaries, `Gross pay ${period}`, dec(t.gross).minus(gratuityPaid), 'debit'),
    ...entry(m.gratuity || m.otherDeductions, `Gratuity paid ${period}`, gratuityPaid, 'debit'),
    ...entry(m.employerCosts, `Employer NSSF, housing levy and NITA ${period}`, employer, 'debit'),
    ...entry(m.employerCosts, `Employer pension ${period}`, pension, 'debit'),
    ...entry(m.employerCosts, `Gratuity accrued ${period}`, gratuity, 'debit'),
    ...entry(m.pension || m.otherDeductions, `Employer pension payable ${period}`, pension, 'credit'),
    ...entry(m.gratuity || m.otherDeductions, `Gratuity payable ${period}`, gratuity, 'credit'),
    ...entry(m.paye, `PAYE ${period}`, dec(t.paye), 'credit'),
    ...entry(m.nssf, `NSSF ${period}`, dec(t.nssfEmployee).plus(dec(t.nssfEmployer)), 'credit'),
    ...entry(m.shif, `SHIF ${period}`, dec(t.shif), 'credit'),
    ...entry(m.ahl, `Housing levy ${period}`, dec(t.ahlEmployee).plus(dec(t.ahlEmployer)), 'credit'),
    ...entry(m.nita, `NITA ${period}`, dec(t.nita), 'credit'),
    ...entry(m.otherDeductions, `Staff deductions ${period}`, dec(t.otherDeductions), 'credit'),
    ...entry(m.netPay, `Net pay ${period}`, dec(t.netPay), 'credit'),
  ];
}

/** Salaries paid out: the net pay liability is cleared against the bank. */
export function paymentJournalLines(netPay: DecimalInput, m: AccountMapping, narrative: string): JournalLine[] {
  return [...entry(m.netPay, narrative, dec(netPay), 'debit'), ...entry(m.bank, narrative, dec(netPay), 'credit')];
}

export const APPROVAL_ACCOUNTS: (keyof AccountMapping)[] = ['salaries', 'employerCosts', 'paye', 'nssf', 'shif', 'ahl', 'nita', 'otherDeductions', 'netPay'];
export const PAYMENT_ACCOUNTS: (keyof AccountMapping)[] = ['netPay', 'bank'];

/** Mapping slots still empty; journals are not sent until every slot they use is filled. */
export function missingAccounts(mapping: Partial<AccountMapping>, keys: (keyof AccountMapping)[]): string[] {
  return keys.filter((k) => !mapping[k]).map((k) => MAPPING_LABELS[k]);
}
