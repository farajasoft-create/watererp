import { Decimal, dec, DecimalInput, round } from '@/platform/common/money';

/** Late-payment penalty on the balance still unpaid after the due date; zero when nothing is overdue. */
export function penalty(overdueBalance: DecimalInput, ratePercent: DecimalInput): Decimal {
  const overdue = dec(overdueBalance);
  const rate = dec(ratePercent);
  if (overdue.lte(0) || rate.lte(0)) return new Decimal(0);
  return round(overdue.times(rate).div(100), 2);
}

export interface DisconnectionPolicy {
  /** Smallest arrears (KES) that puts a connection on the list. */
  minArrears: DecimalInput;
  /** Days past the oldest unpaid bill's due date. */
  graceDays: number;
}

/** Whether a connection's arrears warrant a disconnection notice. */
export function dueForDisconnection(balance: DecimalInput, oldestUnpaidDueDate: Date | null, policy: DisconnectionPolicy, today: Date): boolean {
  if (!oldestUnpaidDueDate || dec(balance).lt(dec(policy.minArrears)) || dec(balance).lte(0)) return false;
  const days = Math.floor((today.getTime() - oldestUnpaidDueDate.getTime()) / 86_400_000);
  return days >= policy.graceDays;
}

export const AGEING_BUCKETS = ['current', 'd30', 'd60', 'd90', 'over90'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** The ageing bucket of a debt by days past due. */
export function ageingBucket(dueDate: Date, today: Date): AgeingBucket {
  const days = Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'over90';
}
