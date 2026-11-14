import { describe, expect, it } from 'vitest';
import { adjustmentJournalLines, AccountMapping, billRunJournalLines, feeJournalLines, isBalanced, paymentJournalLines } from './journals';

const mapping: AccountMapping = {
  receivable: 'a'.repeat(24),
  water: 'b'.repeat(24),
  sewer: 'c'.repeat(24),
  meterRent: 'd'.repeat(24),
  penalty: 'e'.repeat(24),
  adjustments: 'f'.repeat(24),
  deposits: '1'.repeat(24),
  mpesa: '2'.repeat(24),
  bank: '3'.repeat(24),
  cash: '4'.repeat(24),
  other: '5'.repeat(24),
  reconnection: '6'.repeat(24),
};

describe('journal lines', () => {
  it('debits debtors with everything billed and credits each revenue stream', () => {
    const lines = billRunJournalLines({ WATER: '120000.50', SEWER: '30000', METER_RENT: '5000', PENALTY: '0' }, mapping, '2026-10');
    expect(lines[0]).toMatchObject({ accountId: mapping.receivable, debit: '155000.50' });
    expect(lines.slice(1).map((l) => [l.accountId, l.credit])).toEqual([
      [mapping.water, '120000.50'],
      [mapping.sewer, '30000.00'],
      [mapping.meterRent, '5000.00'],
    ]);
    expect(isBalanced(lines)).toBe(true);
  });

  it('posts an M-Pesa payment against the paybill account', () => {
    const lines = paymentJournalLines('1500', 'MPESA', mapping, 'RCT-1');
    expect(lines).toEqual([
      { accountId: mapping.mpesa, description: 'RCT-1', debit: '1500.00' },
      { accountId: mapping.receivable, description: 'RCT-1', credit: '1500.00' },
    ]);
  });

  it('turns a credit adjustment into a debit to adjustments', () => {
    const [first, second] = adjustmentJournalLines('-250', mapping, 'Leak allowance');
    expect(first).toMatchObject({ accountId: mapping.adjustments, debit: '250.00' });
    expect(second).toMatchObject({ accountId: mapping.receivable, credit: '250.00' });
  });

  it('posts cheques to the bank, supplementary charges to other income and reconnection fees to fee income', () => {
    const cheque = paymentJournalLines('2500', 'CHEQUE', mapping, 'cheque');
    expect(cheque[0]).toMatchObject({ accountId: mapping.bank, debit: '2500.00' });
    const supp = billRunJournalLines({ WATER: '300', OTHER: '1500' }, mapping, '2026-10');
    expect(supp.find((l) => l.accountId === mapping.other)).toMatchObject({ credit: '1500.00' });
    expect(isBalanced(supp)).toBe(true);
    const fee = feeJournalLines('1000', mapping, 'fee');
    expect(fee).toEqual([
      { accountId: mapping.receivable, description: 'fee', debit: '1000.00' },
      { accountId: mapping.reconnection, description: 'fee', credit: '1000.00' },
    ]);
  });
});
