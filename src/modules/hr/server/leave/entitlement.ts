export type Accrual = 'MONTHLY' | 'ANNUAL';

export interface LeaveRule {
  daysPerYear: number;
  accrual: Accrual;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Days earned in a leave year up to a date. Monthly leave (annual leave: 21 days, 1.75 a month) is
 * earned for each month on the payroll, the current one included; a joiner's first month counts if
 * they started by the 15th. Yearly leave (sick, maternity…) is all available from the start.
 */
export function earned(rule: LeaveRule, year: number, hireDate: Date, asOf: Date): number {
  if (hireDate.getUTCFullYear() > year || asOf.getUTCFullYear() < year) return 0;
  if (rule.accrual === 'ANNUAL') return rule.daysPerYear;
  const hiredThisYear = hireDate.getUTCFullYear() === year;
  const firstMonth = hiredThisYear ? hireDate.getUTCMonth() + (hireDate.getUTCDate() > 15 ? 1 : 0) : 0;
  const lastMonth = asOf.getUTCFullYear() > year ? 11 : asOf.getUTCMonth();
  const months = Math.max(0, lastMonth - firstMonth + 1);
  return r2((rule.daysPerYear / 12) * months);
}

export interface Balance {
  earned: number;
  adjusted: number;
  taken: number;
  pending: number;
  available: number;
}

export function balance(earnedDays: number, adjusted: number, taken: number, pending: number): Balance {
  return { earned: earnedDays, adjusted: r2(adjusted), taken: r2(taken), pending: r2(pending), available: r2(earnedDays + adjusted - taken - pending) };
}
