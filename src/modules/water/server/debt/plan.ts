import { Decimal, dec, DecimalInput } from '@/platform/common/money';

export interface Instalment {
  dueDate: Date;
  amount: Decimal;
  paid: Decimal;
}

/**
 * Splits arrears (less the deposit) into equal monthly instalments, the last one taking the cents left
 * over, starting a month after the start date.
 */
export function schedule(arrears: DecimalInput, deposit: DecimalInput, count: number, start: Date): Instalment[] {
  const rest = dec(arrears).minus(dec(deposit));
  if (rest.lte(0) || count < 1) return [];
  const each = rest.dividedBy(count).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return Array.from({ length: count }, (_, i) => {
    const due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, Math.min(start.getUTCDate(), 28)));
    const amount = i === count - 1 ? rest.minus(each.times(count - 1)) : each;
    return { dueDate: due, amount, paid: new Decimal(0) };
  });
}

/** Spreads what has been paid since the plan started over the deposit, then the instalments in date order. */
export function allocate(deposit: DecimalInput, instalments: { dueDate: Date; amount: DecimalInput }[], paidToDate: DecimalInput) {
  let left = dec(paidToDate).minus(dec(deposit));
  const depositPaid = left.gte(0);
  const out = instalments.map((i) => {
    const amount = dec(i.amount);
    const paid = Decimal.max(0, Decimal.min(amount, left));
    left = left.minus(paid);
    return { dueDate: i.dueDate, amount, paid };
  });
  return { depositPaid, instalments: out };
}

/**
 * Where the plan stands on a date: COMPLETED once everything is paid, DEFAULTED if the deposit or an
 * instalment is more than the grace days late, otherwise ACTIVE.
 */
export function planState(p: { deposit: DecimalInput; startDate: Date; instalments: { dueDate: Date; amount: DecimalInput }[]; paidToDate: DecimalInput; graceDays: number }, today: Date) {
  const { depositPaid, instalments } = allocate(p.deposit, p.instalments, p.paidToDate);
  const grace = p.graceDays * 86_400_000;
  const total = dec(p.deposit).plus(instalments.reduce((s, i) => s.plus(i.amount), new Decimal(0)));
  if (dec(p.paidToDate).gte(total)) return { status: 'COMPLETED' as const, instalments };
  if (!depositPaid && today.getTime() > p.startDate.getTime() + grace) return { status: 'DEFAULTED' as const, instalments };
  const late = instalments.find((i) => i.paid.lt(i.amount) && today.getTime() > i.dueDate.getTime() + grace);
  return { status: late ? ('DEFAULTED' as const) : ('ACTIVE' as const), instalments, late: late ?? null };
}
