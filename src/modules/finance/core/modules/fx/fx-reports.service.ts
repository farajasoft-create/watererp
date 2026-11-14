import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum } from '../../common/money';
import { Db } from '../../database/db.service';
import { RevaluationService } from './revaluation.service';

/** FX exposure, gains and losses, and the inter-branch position. */
export class FxReportsService {
  constructor(
    private readonly db: Db,
    private readonly revaluation: RevaluationService,
  ) {}

  /**
   * Net foreign-currency exposure by currency: cash, receivables, payables and other monetary
   * balances in transaction currency, their carrying value, their value at the current rate, and the
   * effect of a 1% / 10% move in the rate.
   */
  async exposure(user: AuthUser, entityId: Types.ObjectId, asOf: Date) {
    const r = await this.revaluation.compute(user, entityId, asOf, 'SPOT');
    const byCurrency = new Map<string, { cash: Decimal; receivables: Decimal; payables: Decimal; other: Decimal; carrying: Decimal; atRate: Decimal }>();
    const accounts = await this.db.accounts.find({ _id: { $in: [...new Set(r.all.map((l) => l.accountId.toHexString()))] } }, { accountType: 1 }).lean();
    const typeOf = (id: Types.ObjectId) => accounts.find((a) => a._id.equals(id))?.accountType;
    for (const l of r.all) {
      const row = byCurrency.get(l.currency) ?? { cash: new Decimal(0), receivables: new Decimal(0), payables: new Decimal(0), other: new Decimal(0), carrying: new Decimal(0), atRate: new Decimal(0) };
      if (l.kind === 'OPEN_ITEM') {
        if (l.partyType === 'CUSTOMER') row.receivables = row.receivables.plus(l.balanceTx);
        else row.payables = row.payables.plus(l.balanceTx);
      } else if (['BANK', 'CASH'].includes(typeOf(l.accountId) ?? '')) row.cash = row.cash.plus(l.balanceTx);
      else row.other = row.other.plus(l.balanceTx);
      row.carrying = row.carrying.plus(l.carrying);
      row.atRate = row.atRate.plus(l.revalued);
      byCurrency.set(l.currency, row);
    }
    const rows = [...byCurrency.entries()]
      .map(([currency, v]) => {
        const net = v.cash.plus(v.receivables).plus(v.payables).plus(v.other);
        const rate = r.rates.find((x) => x.currency === currency);
        return {
          currency,
          rate: rate?.rate ?? null,
          rateDate: rate?.effectiveDate ?? null,
          ...v,
          net,
          unrealised: v.atRate.minus(v.carrying),
          sensitivity1: v.atRate.times('0.01').toDecimalPlaces(2),
          sensitivity10: v.atRate.times('0.10').toDecimalPlaces(2),
        };
      })
      .sort((a, b) => a.currency.localeCompare(b.currency));
    return {
      entity: r.entity,
      currency: r.currency,
      asOf,
      rows,
      totals: { carrying: sum(rows.map((x) => x.carrying)), atRate: sum(rows.map((x) => x.atRate)), unrealised: sum(rows.map((x) => x.unrealised)) },
    };
  }

  /** Realised and unrealised FX for a period, by currency and branch, reconciled to the FX accounts. */
  async gains(user: AuthUser, entityId: Types.ObjectId, from: Date, to: Date) {
    if (from > to) throw new BadRequestException('"from" must be on or before "to"');
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const restricted = allowedBranches(user);
    const branches = await this.db.branches.find({ organisationId: user.organisationId, entityId }, { code: 1 }).lean();
    const code = (id: Types.ObjectId) => branches.find((b) => b._id.equals(id))?.code ?? '';
    const visible = (id: Types.ObjectId) => !restricted || restricted.some((r) => r.equals(id));

    const rows: { type: 'REALISED' | 'UNREALISED'; source: string; currency: string; branch: string; amount: Decimal }[] = [];
    // Realised on settlement: allocations active in the period (reversals within the period cancel out).
    const allocations = await this.db.allocations.find({ organisationId: user.organisationId, entityId, date: { $gte: from, $lte: to } }).lean();
    const docs = await this.db.invoices.find({ _id: { $in: allocations.map((a) => a.documentId) } }, { branchId: 1 }).lean();
    for (const a of allocations) {
      const reversedInPeriod = a.status === 'REVERSED' && a.reversedAt && a.reversedAt <= to;
      if (reversedInPeriod || dec(a.fxAmount).isZero()) continue;
      const branchId = docs.find((d) => d._id.equals(a.documentId))?.branchId;
      if (!branchId || !visible(branchId)) continue;
      rows.push({ type: 'REALISED', source: 'Settlements', currency: a.currency, branch: code(branchId), amount: dec(a.fxAmount) });
    }
    // Realised on currency conversion: FX lines of bank transfers.
    const org = await this.db.organisations.findById(user.organisationId).lean();
    const s = org?.settings;
    const fxAccounts = [s?.fxGainAccountId, s?.fxLossAccountId, s?.unrealisedFxGainAccountId, s?.unrealisedFxLossAccountId].filter(Boolean) as Types.ObjectId[];
    const transfers = await this.db.bankTransfers.find({ organisationId: user.organisationId, entityId, date: { $gte: from, $lte: to } }).lean();
    if (transfers.length) {
      const lines = await this.db.ledger.find({ journalId: { $in: transfers.map((t) => t.journalId) }, accountId: { $in: fxAccounts } }).lean();
      for (const l of lines) {
        if (!visible(l.branchId)) continue;
        const t = transfers.find((x) => x.journalId.equals(l.journalId))!;
        const from_ = await this.db.bankAccounts.findById(t.fromBankAccountId, { currency: 1 }).lean();
        rows.push({ type: 'REALISED', source: 'Currency conversions', currency: from_?.currency ?? '', branch: code(l.branchId), amount: dec(l.credit).minus(dec(l.debit)) });
      }
    }
    // Unrealised: revaluation runs dated in the period.
    const runs = await this.db.fxRevaluations.find({ organisationId: user.organisationId, entityId, date: { $gte: from, $lte: to } }).lean();
    for (const run of runs) {
      for (const l of run.lines) {
        if (!visible(l.branchId)) continue;
        rows.push({ type: 'UNREALISED', source: `Revaluation ${run.date.toISOString().slice(0, 10)}`, currency: l.currency, branch: code(l.branchId), amount: dec(l.difference) });
      }
    }

    const groups = new Map<string, { type: string; source: string; currency: string; branch: string; amount: Decimal; count: number }>();
    for (const r of rows) {
      const key = `${r.type}|${r.source}|${r.currency}|${r.branch}`;
      const g = groups.get(key) ?? { type: r.type, source: r.source, currency: r.currency, branch: r.branch, amount: new Decimal(0), count: 0 };
      g.amount = g.amount.plus(r.amount);
      g.count++;
      groups.set(key, g);
    }
    // The general ledger view of the FX accounts for the same period, to reconcile against.
    const gl = await this.db.ledger.aggregate<{ _id: Types.ObjectId; debit: unknown; credit: unknown }>([
      { $match: { organisationId: user.organisationId, entityId, accountId: { $in: fxAccounts }, date: { $gte: from, $lte: to }, ...(restricted && { branchId: { $in: restricted } }) } },
      { $group: { _id: '$accountId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
    const accounts = await this.db.accounts.find({ _id: { $in: fxAccounts } }, { code: 1, name: 1 }).lean();
    const realised = sum(rows.filter((r) => r.type === 'REALISED').map((r) => r.amount));
    const unrealised = sum(rows.filter((r) => r.type === 'UNREALISED').map((r) => r.amount));
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      from,
      to,
      rows: [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || a.currency.localeCompare(b.currency) || a.branch.localeCompare(b.branch)),
      totals: { realised, unrealised, total: realised.plus(unrealised) },
      ledger: gl.map((g) => {
        const a = accounts.find((x) => x._id.equals(g._id));
        return { accountId: g._id, code: a?.code, name: a?.name, net: dec(g.credit as never).minus(dec(g.debit as never)) };
      }),
    };
  }

  /**
   * Inter-branch position: each branch's balance on the clearing account (due to / due from) and
   * proof that every branch balances on its own and the clearing nets to zero across the entity.
   */
  async interBranch(user: AuthUser, entityId: Types.ObjectId, asOf: Date) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const org = await this.db.organisations.findById(user.organisationId).lean();
    const clearing = org?.settings?.interBranchAccountId ?? null;
    const branches = await this.db.branches.find({ organisationId: user.organisationId, entityId }).sort({ code: 1 }).lean();
    const [byBranch, clearingBy, journals] = await Promise.all([
      this.db.ledger.aggregate<{ _id: Types.ObjectId; debit: unknown; credit: unknown }>([
        { $match: { organisationId: user.organisationId, entityId, date: { $lte: asOf } } },
        { $group: { _id: '$branchId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ]),
      clearing
        ? this.db.ledger.aggregate<{ _id: Types.ObjectId; debit: unknown; credit: unknown; n: number }>([
            { $match: { organisationId: user.organisationId, entityId, accountId: clearing, date: { $lte: asOf } } },
            { $group: { _id: '$branchId', debit: { $sum: '$debit' }, credit: { $sum: '$credit' }, n: { $sum: 1 } } },
          ])
        : [],
      clearing
        ? this.db.ledger
            .find({ organisationId: user.organisationId, entityId, accountId: clearing, date: { $lte: asOf } }, { journalId: 1, journalNumber: 1, date: 1, branchId: 1, debit: 1, credit: 1, description: 1 })
            .sort({ date: -1 })
            .limit(50)
            .lean()
        : [],
    ]);
    const rows = branches.map((b) => {
      const total = byBranch.find((x) => x._id.equals(b._id));
      const c = clearingBy.find((x) => x._id.equals(b._id));
      const position = c ? dec(c.debit as never).minus(dec(c.credit as never)) : new Decimal(0);
      return {
        branchId: b._id,
        code: b.code,
        name: b.name,
        // Positive: other branches owe this branch (due from); negative: it owes them (due to).
        position,
        entries: c?.n ?? 0,
        balanced: total ? dec(total.debit as never).eq(dec(total.credit as never)) : true,
      };
    });
    const account = clearing ? await this.db.accounts.findById(clearing, { code: 1, name: 1 }).lean() : null;
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      asOf,
      account: account && { id: account._id, code: account.code, name: account.name },
      rows,
      net: sum(rows.map((r) => r.position)),
      recent: journals.map((j) => ({ ...j, branchCode: branches.find((b) => b._id.equals(j.branchId))?.code ?? '', amount: dec(j.debit).minus(dec(j.credit)) })),
    };
  }
}
