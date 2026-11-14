import { Types } from 'mongoose';
import { Decimal, dec } from '../../common/money';
import { Db } from '../../database/db.service';

export type SumKey = 'account' | 'branch' | 'class' | 'month';

export interface SumRow {
  account?: Types.ObjectId;
  branch?: Types.ObjectId;
  cls?: string;
  month?: Date;
  debit: Decimal;
  credit: Decimal;
}

const monthOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const next = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Debit and credit totals (functional currency) over [from, until) — `from` null meaning the beginning —
 * grouped as asked. Whole months come from the monthly totals, which every posting updates in its own
 * transaction; only the partial months at either end are summed from the ledger, so the result is
 * exactly what summing the ledger gives, without scanning it.
 *
 * `match` may only use fields both collections share: organisationId, entityId, branchId, accountId,
 * accountClass, departmentId, costCentreId and projectId.
 */
export async function ledgerSums(db: Db, match: Record<string, unknown>, from: Date | null, until: Date, by: SumKey[]): Promise<SumRow[]> {
  const lastFull = monthOf(until); // months before this end on or before `until`
  const firstFull = from === null ? null : monthOf(from).getTime() === from.getTime() ? from : next(from);
  const out = new Map<string, SumRow>();
  const add = (rows: { _id: Record<string, unknown> | null; debit: unknown; credit: unknown }[]) => {
    for (const row of rows) {
      const id = (row._id ?? {}) as Omit<SumRow, 'debit' | 'credit'>;
      const key = [id.account?.toHexString(), id.branch?.toHexString(), id.cls, id.month?.getTime()].join('|');
      const current = out.get(key) ?? { ...id, debit: new Decimal(0), credit: new Decimal(0) };
      current.debit = current.debit.plus(dec(row.debit as never));
      current.credit = current.credit.plus(dec(row.credit as never));
      out.set(key, current);
    }
  };
  const group = (monthField: unknown) => {
    const g: Record<string, unknown> = {};
    if (by.includes('account')) g.account = '$accountId';
    if (by.includes('branch')) g.branch = '$branchId';
    if (by.includes('class')) g.cls = '$accountClass';
    if (by.includes('month')) g.month = monthField;
    return Object.keys(g).length ? g : null;
  };
  const fromLedger = (range: Record<string, Date>) =>
    db.ledger.aggregate<{ _id: Record<string, unknown> | null; debit: unknown; credit: unknown }>([
      { $match: { ...match, date: range } },
      { $group: { _id: group({ $dateTrunc: { date: '$date', unit: 'month' } }), debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
  // Until the organisation's totals have been built, sum the ledger itself.
  const live = await db.warehouseState.exists({ organisationId: match.organisationId, live: true });
  if (!live || (firstFull !== null && firstFull >= lastFull)) {
    add(await fromLedger({ ...(from && { $gte: from }), $lt: until }));
    return [...out.values()];
  }
  const parts = [
    db.ledgerFacts.aggregate<{ _id: Record<string, unknown> | null; debit: unknown; credit: unknown }>([
      { $match: { ...match, month: { ...(firstFull && { $gte: firstFull }), $lt: lastFull } } },
      { $group: { _id: group('$month'), debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]),
  ];
  if (from && firstFull && from < firstFull) parts.push(fromLedger({ $gte: from, $lt: firstFull }));
  if (lastFull < until) parts.push(fromLedger({ $gte: lastFull, $lt: until }));
  for (const rows of await Promise.all(parts)) add(rows);
  return [...out.values()];
}
