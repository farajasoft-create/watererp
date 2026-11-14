import { Decimal, dec, DecimalInput } from '@/platform/common/money';
import { JournalLine } from '@/platform/ledger/types';

export { isBalanced } from '@/platform/ledger/types';
export type { JournalLine };

/** General-ledger accounts that water transactions post to (account ids). */
export interface AccountMapping {
  receivable: string;
  water: string;
  sewer: string;
  meterRent: string;
  penalty: string;
  other: string;
  reconnection: string;
  adjustments: string;
  deposits: string;
  mpesa: string;
  bank: string;
  cash: string;
}

export const MAPPING_LABELS: Record<keyof AccountMapping, string> = {
  receivable: 'Water debtors (receivable control)',
  water: 'Water sales revenue',
  sewer: 'Sewerage revenue',
  meterRent: 'Meter rent revenue',
  penalty: 'Penalty / late payment income',
  other: 'Other water charges (supplementary, bowser water)',
  reconnection: 'Reconnection fee income',
  adjustments: 'Billing adjustments (credits)',
  deposits: 'Customer deposits (liability)',
  mpesa: 'M-Pesa paybill account',
  bank: 'Bank account',
  cash: 'Cash office account',
};

const CHARGE_ACCOUNT: Record<string, keyof AccountMapping> = {
  WATER: 'water',
  SEWER: 'sewer',
  METER_RENT: 'meterRent',
  PENALTY: 'penalty',
  OTHER: 'other',
};

/** The mapping slot each bill charge code posts to. */
export const chargeAccount = (code: string): keyof AccountMapping | undefined => CHARGE_ACCOUNT[code];

export type PaymentChannel = 'MPESA' | 'BANK' | 'CASH' | 'CHEQUE';

/** Cheques are banked, so they post to the bank account. */
export const channelAccount = (channel: PaymentChannel): keyof AccountMapping => (channel === 'MPESA' ? 'mpesa' : channel === 'CASH' ? 'cash' : 'bank');

const money = (d: Decimal) => d.toFixed(2);

/**
 * One journal for an approved billing run: the receivable control is debited with everything billed,
 * and each revenue stream is credited with its total.
 */
export function billRunJournalLines(totals: Record<string, DecimalInput>, mapping: AccountMapping, period: string): JournalLine[] {
  const lines: JournalLine[] = [];
  let total = new Decimal(0);
  for (const [code, amount] of Object.entries(totals)) {
    const value = dec(amount);
    if (value.isZero()) continue;
    const key = CHARGE_ACCOUNT[code];
    if (!key) throw new Error(`No ledger account for charge ${code}`);
    total = total.plus(value);
    lines.push({ accountId: mapping[key], description: `${code.replace('_', ' ').toLowerCase()} billed ${period}`, credit: money(value) });
  }
  if (total.isZero()) return [];
  return [{ accountId: mapping.receivable, description: `Water bills ${period}`, debit: money(total) }, ...lines];
}

/** A customer payment: the receiving account is debited and the water debtors credited. */
export function paymentJournalLines(amount: DecimalInput, channel: PaymentChannel, mapping: AccountMapping, narrative: string): JournalLine[] {
  const value = dec(amount);
  const account = mapping[channelAccount(channel)];
  return [
    { accountId: account, description: narrative, debit: money(value) },
    { accountId: mapping.receivable, description: narrative, credit: money(value) },
  ];
}

/** A billing adjustment: a credit reduces debtors against the adjustments account; a debit does the reverse. */
export function adjustmentJournalLines(amount: DecimalInput, mapping: AccountMapping, narrative: string): JournalLine[] {
  const value = dec(amount);
  const abs = money(value.abs());
  return value.isNegative()
    ? [
        { accountId: mapping.adjustments, description: narrative, debit: abs },
        { accountId: mapping.receivable, description: narrative, credit: abs },
      ]
    : [
        { accountId: mapping.receivable, description: narrative, debit: abs },
        { accountId: mapping.adjustments, description: narrative, credit: abs },
      ];
}

/** A reconnection fee charged to an account: debtors up, fee income credited. */
export function feeJournalLines(amount: DecimalInput, mapping: AccountMapping, narrative: string): JournalLine[] {
  const value = money(dec(amount));
  return [
    { accountId: mapping.receivable, description: narrative, debit: value },
    { accountId: mapping.reconnection, description: narrative, credit: value },
  ];
}

/** Mapping slots still empty; journals are not sent until every slot they use is filled. */
export function missingAccounts(mapping: Partial<AccountMapping>, keys: (keyof AccountMapping)[]): string[] {
  return keys.filter((k) => !mapping[k]).map((k) => MAPPING_LABELS[k]);
}
