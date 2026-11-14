import { ClientSession, Types } from 'mongoose';
import { Db } from '../../database/db.service';

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

export interface FactLine {
  organisationId: Types.ObjectId;
  entityId: Types.ObjectId;
  date: Date;
  branchId: Types.ObjectId;
  accountId: Types.ObjectId;
  accountClass: string;
  accountType: string | null;
  departmentId?: Types.ObjectId | null;
  costCentreId?: Types.ObjectId | null;
  projectId?: Types.ObjectId | null;
  debit: Types.Decimal128;
  credit: Types.Decimal128;
  /** Typed in, imported or sent by API (rather than created by a document). */
  manual: boolean;
}

export const MANUAL_SOURCES = ['MANUAL', 'API', 'IMPORT'];

/**
 * The reporting warehouse: monthly ledger totals by entity, branch, account and dimension. They are kept
 * in step with the ledger in the same transaction as every posting (see `apply`), so reports can read
 * whole months from here and only scan the ledger for partial months, with results identical to summing
 * the ledger itself. `rebuild` recomputes them from the ledger (first use, or repair).
 */
export class WarehouseService {
  constructor(private readonly db: Db) {}

  /** Adds newly posted ledger lines to their monthly totals, inside the posting transaction. */
  async apply(lines: FactLine[], session: ClientSession) {
    const groups = new Map<string, FactLine & { month: Date; entries: number; debits: Types.Decimal128[]; credits: Types.Decimal128[]; mCount: number; mSum: number; mSumSq: number }>();
    for (const l of lines) {
      const month = monthStart(l.date);
      const key = [l.entityId, month.getTime(), l.branchId, l.accountId, l.departmentId ?? '', l.costCentreId ?? '', l.projectId ?? ''].join('|');
      const g = groups.get(key) ?? { ...l, month, entries: 0, debits: [], credits: [], mCount: 0, mSum: 0, mSumSq: 0 };
      g.entries++;
      if (l.manual) {
        const v = Number(l.debit.toString()) + Number(l.credit.toString());
        g.mCount++;
        g.mSum += v;
        g.mSumSq += v * v;
      }
      g.debits.push(l.debit);
      g.credits.push(l.credit);
      groups.set(key, g);
    }
    if (!groups.size) return;
    await this.db.ledgerFacts.bulkWrite(
      [...groups.values()].map((g) => ({
        updateOne: {
          filter: {
            organisationId: g.organisationId,
            entityId: g.entityId,
            month: g.month,
            branchId: g.branchId,
            accountId: g.accountId,
            departmentId: g.departmentId ?? null,
            costCentreId: g.costCentreId ?? null,
            projectId: g.projectId ?? null,
          },
          update: [
            {
              $set: {
                accountClass: { $ifNull: ['$accountClass', g.accountClass] },
                accountType: { $ifNull: ['$accountType', g.accountType] },
                // Exact decimal sums: pipeline $add keeps Decimal128 arithmetic.
                debit: { $add: [{ $ifNull: ['$debit', Types.Decimal128.fromString('0')] }, ...g.debits] },
                credit: { $add: [{ $ifNull: ['$credit', Types.Decimal128.fromString('0')] }, ...g.credits] },
                entries: { $add: [{ $ifNull: ['$entries', 0] }, g.entries] },
                manualCount: { $add: [{ $ifNull: ['$manualCount', 0] }, g.mCount] },
                manualSum: { $add: [{ $ifNull: ['$manualSum', 0] }, g.mSum] },
                manualSumSq: { $add: [{ $ifNull: ['$manualSumSq', 0] }, g.mSumSq] },
              },
            },
          ],
          upsert: true,
        },
      })),
      { session, ordered: true },
    );
  }

  async state(organisationId: Types.ObjectId) {
    return this.db.warehouseState.findOne({ organisationId }).lean();
  }

  /** Recomputes the monthly totals from the ledger, one month at a time, each in its own transaction. */
  async rebuild(organisationId: Types.ObjectId) {
    const started = Date.now();
    const months = await this.db.ledger.aggregate<{ _id: { entity: Types.ObjectId; month: Date } }>([
      { $match: { organisationId } },
      { $group: { _id: { entity: '$entityId', month: { $dateTrunc: { date: '$date', unit: 'month' } } } } },
    ]);
    const accounts = new Map((await this.db.accounts.find({ organisationId }, { accountType: 1 }).lean()).map((a) => [a._id.toHexString(), a.accountType]));
    // Months with facts but no ledger rows any more (should not happen; the ledger is append-only).
    const known = new Set(months.map((m) => `${m._id.entity.toHexString()}|${monthStart(m._id.month).getTime()}`));
    const stale = await this.db.ledgerFacts.aggregate<{ _id: { entity: Types.ObjectId; month: Date } }>([{ $match: { organisationId } }, { $group: { _id: { entity: '$entityId', month: '$month' } } }]);
    for (const s of stale) {
      if (!known.has(`${s._id.entity.toHexString()}|${s._id.month.getTime()}`)) await this.db.ledgerFacts.deleteMany({ organisationId, entityId: s._id.entity, month: s._id.month });
    }
    for (const m of months) {
      const month = monthStart(m._id.month);
      // Reading the ledger inside the transaction that replaces the month's totals means a posting
      // committed concurrently either is in the snapshot or conflicts and is retried after this commit.
      await this.db.transaction(async (session) => {
        const rows = await this.db.ledger
          .aggregate<{
            _id: { branch: Types.ObjectId; account: Types.ObjectId; dept: Types.ObjectId | null; cc: Types.ObjectId | null; project: Types.ObjectId | null };
            cls: string;
            debit: Types.Decimal128;
            credit: Types.Decimal128;
            entries: number;
            mCount: number;
            mSum: number;
            mSumSq: number;
          }>([
            { $match: { organisationId, entityId: m._id.entity, date: { $gte: month, $lt: nextMonth(month) } } },
            {
              $group: {
                // Missing and null dimensions are the same thing.
                _id: {
                  branch: '$branchId',
                  account: '$accountId',
                  dept: { $ifNull: ['$departmentId', null] },
                  cc: { $ifNull: ['$costCentreId', null] },
                  project: { $ifNull: ['$projectId', null] },
                },
                cls: { $first: '$accountClass' },
                debit: { $sum: '$debit' },
                credit: { $sum: '$credit' },
                entries: { $sum: 1 },
                mCount: { $sum: { $cond: [{ $in: ['$source', MANUAL_SOURCES] }, 1, 0] } },
                mSum: { $sum: { $cond: [{ $in: ['$source', MANUAL_SOURCES] }, { $toDouble: { $add: ['$debit', '$credit'] } }, 0] } },
                mSumSq: { $sum: { $cond: [{ $in: ['$source', MANUAL_SOURCES] }, { $pow: [{ $toDouble: { $add: ['$debit', '$credit'] } }, 2] }, 0] } },
              },
            },
          ])
          .session(session);
        await this.db.ledgerFacts.deleteMany({ organisationId, entityId: m._id.entity, month }, { session });
        if (rows.length) {
          await this.db.ledgerFacts.insertMany(
            rows.map((r) => ({
              organisationId,
              entityId: m._id.entity,
              month,
              branchId: r._id.branch,
              accountId: r._id.account,
              accountClass: r.cls,
              accountType: accounts.get(r._id.account.toHexString()) ?? null,
              departmentId: r._id.dept ?? null,
              costCentreId: r._id.cc ?? null,
              projectId: r._id.project ?? null,
              debit: r.debit,
              credit: r.credit,
              entries: r.entries,
              manualCount: r.mCount,
              manualSum: r.mSum,
              manualSumSq: r.mSumSq,
            })),
            { session },
          );
        }
      });
    }
    const facts = await this.db.ledgerFacts.countDocuments({ organisationId });
    return this.db.warehouseState
      .findOneAndUpdate(
        { organisationId },
        { organisationId, live: true, lastRefreshedAt: new Date(), lastDurationMs: Date.now() - started, monthsRefreshed: months.length, facts, lockedUntil: null },
        { upsert: true, new: true },
      )
      .lean();
  }

  /** Kept for the analytics screen's "rebuild" button and older callers: a full rebuild. */
  async refresh(organisationId: Types.ObjectId, _opts: { full?: boolean } = {}) {
    return this.rebuild(organisationId);
  }

  /** The totals are maintained live; this only builds them the first time for organisations that predate that. */
  async ensureFresh(organisationId: Types.ObjectId) {
    const state = await this.state(organisationId);
    if (state?.live) return state;
    return this.rebuild(organisationId);
  }

  /** Cron: builds totals for any organisation not yet maintained live (normally none). */
  async refreshAll() {
    const orgs = await this.db.organisations.find({}, { _id: 1 }).lean();
    let rebuilt = 0;
    for (const o of orgs) {
      const state = await this.state(o._id);
      if (!state?.live) {
        await this.rebuild(o._id);
        rebuilt++;
      }
    }
    return { organisations: orgs.length, rebuilt };
  }
}
