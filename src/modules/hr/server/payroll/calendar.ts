import { Decimal, dec, DecimalInput, round } from '@/platform/common/money';

const DAY = 86_400_000;

export function periodStart(period: string): Date {
  return new Date(`${period}-01T00:00:00.000Z`);
}

/** The last day of the period, at midnight UTC. */
export function periodEnd(period: string): Date {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Monday to Friday between two dates inclusive, less public holidays. */
export function workingDays(from: Date, to: Date, holidays: Iterable<string> = []): number {
  const off = new Set(holidays);
  let n = 0;
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= to.getTime(); t += DAY) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !off.has(iso(d))) n++;
  }
  return n;
}

/**
 * Basic pay for the part of the month an employee was on the payroll (calendar days): joiners from
 * their first day, leavers to their last.
 */
export function proratedBasic(basic: DecimalInput, period: string, hireDate: Date | null | undefined, endDate: Date | null | undefined): { amount: Decimal; days: number; ofDays: number } {
  const start = periodStart(period);
  const end = periodEnd(period);
  const ofDays = end.getUTCDate();
  const from = hireDate && hireDate > start ? hireDate : start;
  const to = endDate && endDate < end ? endDate : end;
  const days = to < from ? 0 : Math.round((to.getTime() - from.getTime()) / DAY) + 1;
  const amount = days >= ofDays ? round(basic, 2) : round(dec(basic).times(days).dividedBy(ofDays), 2);
  return { amount, days, ofDays };
}

/** Pay withheld for unpaid leave: a day's basic (basic ÷ working days of the month) per working day off. */
export function unpaidLeaveDeduction(basic: DecimalInput, unpaidDays: number, workingDaysInMonth: number): Decimal {
  if (unpaidDays <= 0 || workingDaysInMonth <= 0) return new Decimal(0);
  return round(dec(basic).times(Math.min(unpaidDays, workingDaysInMonth)).dividedBy(workingDaysInMonth), 2);
}
