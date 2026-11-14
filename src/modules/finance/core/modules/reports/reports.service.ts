import { addDays, ledgerSums, SumKey } from './ledger-sums';
import { WarehouseService } from '../analytics/warehouse.service';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { Decimal, dec } from '../../common/money';
import { Db } from '../../database/db.service';
import { Account, AccountClass, DEBIT_NORMAL, INCOME_STATEMENT_CLASSES } from '../../database/schemas';

export interface ReportFilters {
  entityId: Types.ObjectId;
  branchIds?: Types.ObjectId[];
  departmentId?: Types.ObjectId;
  costCentreId?: Types.ObjectId;
  projectId?: Types.ObjectId;
}

const IS_CLASSES = INCOME_STATEMENT_CLASSES as string[];

/** Signed balance in the account's natural direction (debit-normal classes positive when in debit). */
function natural(cls: AccountClass, debit: Decimal, credit: Decimal): Decimal {
  return DEBIT_NORMAL.has(cls) ? debit.minus(credit) : credit.minus(debit);
}

export class ReportsService {
  constructor(
    private readonly db: Db,
    private readonly warehouse: WarehouseService,
  ) {}

  private async context(user: AuthUser, f: ReportFilters) {
    const entity = await this.db.entities.findOne({ _id: f.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    // Monthly totals are only trusted once built for the organisation (normally by the upgrade).
    await this.warehouse.ensureFresh(user.organisationId);
    const org = await this.db.organisations.findById(user.organisationId).lean();
    return { entity, org };
  }

  /** Base ledger filter, intersecting requested branches with the user's branch restriction. */
  private match(user: AuthUser, f: ReportFilters): Record<string, unknown> {
    const m: Record<string, unknown> = { organisationId: user.organisationId, entityId: f.entityId };
    const restricted = allowedBranches(user);
    let branches = f.branchIds?.length ? f.branchIds : null;
    if (restricted) {
      branches = branches ? branches.filter((b) => restricted.some((r) => r.equals(b))) : restricted;
    }
    if (branches) m.branchId = { $in: branches };
    if (f.departmentId) m.departmentId = f.departmentId;
    if (f.costCentreId) m.costCentreId = f.costCentreId;
    if (f.projectId) m.projectId = f.projectId;
    return m;
  }

  private async fiscalYearStart(user: AuthUser, entityId: Types.ObjectId, date: Date): Promise<Date | null> {
    const fy = await this.db.fiscalYears
      .findOne({ organisationId: user.organisationId, entityId, startDate: { $lte: date }, endDate: { $gte: date } })
      .lean();
    return fy?.startDate ?? null;
  }

  private sums(match: Record<string, unknown>, from: Date | null, until: Date, by: SumKey[]) {
    return ledgerSums(this.db, match, from, until, by);
  }

  private async accountMap(user: AuthUser) {
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId }).lean();
    return new Map(accounts.map((a) => [a._id.toHexString(), a]));
  }

  // ------------------------------------------------------------------------------------------

  /**
   * Trial balance for a date range. Income-statement accounts reset at the start of the fiscal
   * year; earlier profit or loss is carried into retained earnings so the opening still balances.
   */
  async trialBalance(user: AuthUser, f: ReportFilters, from: Date, to: Date) {
    if (from > to) throw new BadRequestException('"from" must be on or before "to"');
    const { entity, org } = await this.context(user, f);
    const fyStart = await this.fiscalYearStart(user, f.entityId, from);
    const m = this.match(user, f);
    const until = addDays(to, 1);
    // Balance-sheet accounts carry forward from the beginning; income-statement accounts only from the
    // start of the fiscal year, with earlier profit or loss rolled into retained earnings.
    const [inRange, openingBS, openingPL, prior] = await Promise.all([
      this.sums(m, from, until, ['account']),
      this.sums(fyStart ? { ...m, accountClass: { $nin: IS_CLASSES } } : m, null, from, ['account']),
      fyStart && fyStart < from ? this.sums({ ...m, accountClass: { $in: IS_CLASSES } }, fyStart, from, ['account']) : Promise.resolve([]),
      fyStart ? this.sums({ ...m, accountClass: { $in: IS_CLASSES } }, null, fyStart < from ? fyStart : from, []) : Promise.resolve([]),
    ]);

    const accounts = await this.accountMap(user);
    const reId = org?.settings?.retainedEarningsAccountId?.toHexString() ?? null;
    let priorPL$ = new Decimal(0); // net debit
    for (const r of prior) priorPL$ = priorPL$.plus(r.debit).minus(r.credit);
    const lines = new Map<string, { opening: Decimal; debit: Decimal; credit: Decimal }>();
    const line = (id: string) => {
      const l = lines.get(id) ?? { opening: new Decimal(0), debit: new Decimal(0), credit: new Decimal(0) };
      lines.set(id, l);
      return l;
    };
    for (const r of [...openingBS, ...openingPL]) {
      const l = line(r.account!.toHexString());
      l.opening = l.opening.plus(r.debit).minus(r.credit);
    }
    for (const r of inRange) {
      const l = line(r.account!.toHexString());
      l.debit = l.debit.plus(r.debit);
      l.credit = l.credit.plus(r.credit);
    }
    if (!priorPL$.isZero()) {
      const key = reId ?? 'unallocated-retained-earnings';
      const row = lines.get(key) ?? { opening: new Decimal(0), debit: new Decimal(0), credit: new Decimal(0) };
      row.opening = row.opening.plus(priorPL$);
      lines.set(key, row);
    }

    const result = [...lines.entries()]
      .map(([id, v]) => {
        const account = accounts.get(id);
        const closing = v.opening.plus(v.debit).minus(v.credit);
        return {
          accountId: account ? id : null,
          code: account?.code ?? '3999',
          name: account?.name ?? 'Retained earnings (no account configured)',
          accountClass: account?.accountClass ?? 'EQUITY',
          openingDebit: v.opening.gt(0) ? v.opening : new Decimal(0),
          openingCredit: v.opening.lt(0) ? v.opening.neg() : new Decimal(0),
          debit: v.debit,
          credit: v.credit,
          closingDebit: closing.gt(0) ? closing : new Decimal(0),
          closingCredit: closing.lt(0) ? closing.neg() : new Decimal(0),
        };
      })
      .filter((r) => !(r.openingDebit.isZero() && r.openingCredit.isZero() && r.debit.isZero() && r.credit.isZero()))
      .sort((a, b) => a.code.localeCompare(b.code));

    const total = (k: keyof (typeof result)[number]) => result.reduce((acc, r) => acc.plus(r[k] as Decimal), new Decimal(0));
    const totals = {
      openingDebit: total('openingDebit'),
      openingCredit: total('openingCredit'),
      debit: total('debit'),
      credit: total('credit'),
      closingDebit: total('closingDebit'),
      closingCredit: total('closingCredit'),
    };
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      from,
      to,
      fiscalYearStart: fyStart,
      rows: result,
      totals,
      balanced: totals.closingDebit.eq(totals.closingCredit) && totals.debit.eq(totals.credit),
    };
  }

  // ------------------------------------------------------------------------------------------

  async accountActivity(user: AuthUser, f: ReportFilters, accountId: Types.ObjectId, from: Date, to: Date) {
    const { entity } = await this.context(user, f);
    const account = await this.db.accounts.findOne({ _id: accountId, organisationId: user.organisationId }).lean();
    if (!account) throw new NotFoundException('Account not found');
    const isPL = IS_CLASSES.includes(account.accountClass);
    const fyStart = isPL ? await this.fiscalYearStart(user, f.entityId, from) : null;
    const base = { ...this.match(user, f), accountId };

    const [opening] = await this.sums(base, fyStart && fyStart < from ? fyStart : fyStart ? from : null, from, []);
    const LIMIT = 5000;
    const entries = await this.db.ledger
      .find({ ...base, date: { $gte: from, $lte: to } })
      .sort({ date: 1, journalNumber: 1, lineNo: 1 })
      .limit(LIMIT + 1)
      .lean();

    let running = dec(opening?.debit as never).minus(dec(opening?.credit as never));
    const openingBalance = running;
    const rows = entries.slice(0, LIMIT).map((e) => {
      running = running.plus(dec(e.debit)).minus(dec(e.credit));
      return { ...e, balance: running };
    });
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      account: { id: account._id, code: account.code, name: account.name, accountClass: account.accountClass },
      from,
      to,
      openingBalance,
      closingBalance: running,
      totalDebit: rows.reduce((a, r) => a.plus(dec(r.debit)), new Decimal(0)),
      totalCredit: rows.reduce((a, r) => a.plus(dec(r.credit)), new Decimal(0)),
      rows,
      truncated: entries.length > LIMIT,
    };
  }

  // ------------------------------------------------------------------------------------------

  /** Profit & loss, optionally broken down into one column per branch. */
  async profitAndLoss(user: AuthUser, f: ReportFilters, from: Date, to: Date, byBranch: boolean) {
    const { entity } = await this.context(user, f);
    const rows = (await this.sums({ ...this.match(user, f), accountClass: { $in: IS_CLASSES } }, from, addDays(to, 1), byBranch ? ['account', 'branch'] : ['account'])).map((r) => ({
      _id: { account: r.account!, branch: r.branch ?? null },
      debit: r.debit,
      credit: r.credit,
    }));
    const accounts = await this.accountMap(user);
    const branchIds = byBranch ? [...new Set(rows.map((r) => r._id.branch!.toHexString()))] : [];
    const branches = byBranch
      ? (await this.db.branches.find({ _id: { $in: branchIds } }, { code: 1, name: 1 }).sort({ code: 1 }).lean()).map((b) => ({
          id: b._id.toHexString(),
          code: b.code,
          name: b.name,
        }))
      : [];
    const columns = byBranch ? branches.map((b) => b.id) : ['total'];

    const byAccount = new Map<string, { account: Account; values: Record<string, Decimal> }>();
    for (const r of rows) {
      const account = accounts.get(r._id.account.toHexString());
      if (!account) continue;
      const key = account._id.toHexString();
      const entry = byAccount.get(key) ?? { account, values: Object.fromEntries(columns.map((c) => [c, new Decimal(0)])) };
      const col = byBranch ? r._id.branch!.toHexString() : 'total';
      entry.values[col] = entry.values[col].plus(natural(account.accountClass as AccountClass, dec(r.debit as never), dec(r.credit as never)));
      byAccount.set(key, entry);
    }

    const section = (cls: AccountClass, title: string) => {
      const lines = [...byAccount.values()]
        .filter((e) => e.account.accountClass === cls)
        .sort((a, b) => a.account.code.localeCompare(b.account.code))
        .map((e) => ({
          accountId: e.account._id,
          code: e.account.code,
          name: e.account.name,
          values: e.values,
          total: Object.values(e.values).reduce((a, v) => a.plus(v), new Decimal(0)),
        }));
      const totals = Object.fromEntries(columns.map((c) => [c, lines.reduce((a, l) => a.plus(l.values[c]), new Decimal(0))]));
      return { title, accountClass: cls, lines, totals, total: lines.reduce((a, l) => a.plus(l.total), new Decimal(0)) };
    };
    const revenue = section('REVENUE', 'Revenue');
    const cogs = section('COST_OF_SALES', 'Cost of sales');
    const expenses = section('EXPENSE', 'Operating expenses');
    const combine = (fn: (c: string) => Decimal) => Object.fromEntries(columns.map((c) => [c, fn(c)]));
    const grossProfit = combine((c) => revenue.totals[c].minus(cogs.totals[c]));
    const netProfit = combine((c) => grossProfit[c].minus(expenses.totals[c]));

    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      from,
      to,
      columns: byBranch ? branches : [{ id: 'total', code: 'TOTAL', name: 'Total' }],
      sections: [revenue, cogs, expenses],
      grossProfit,
      netProfit,
      totals: {
        revenue: revenue.total,
        costOfSales: cogs.total,
        grossProfit: revenue.total.minus(cogs.total),
        expenses: expenses.total,
        netProfit: revenue.total.minus(cogs.total).minus(expenses.total),
      },
    };
  }

  // ------------------------------------------------------------------------------------------

  async balanceSheet(user: AuthUser, f: ReportFilters, asOf: Date) {
    const { entity, org } = await this.context(user, f);
    const fyStart = await this.fiscalYearStart(user, f.entityId, asOf);
    const until = addDays(asOf, 1);
    const rows = (await this.sums(this.match(user, f), null, until, ['account', 'class'])).map((r) => ({ _id: r.account!, cls: r.cls as AccountClass, debit: r.debit, credit: r.credit }));
    const [currentPL] = fyStart ? await this.sums({ ...this.match(user, f), accountClass: { $in: IS_CLASSES } }, fyStart, until, []) : [];

    const accounts = await this.accountMap(user);
    let totalPL = new Decimal(0); // credit-positive profit, all time
    const balances: { account: Account; amount: Decimal }[] = [];
    for (const r of rows) {
      const debit = dec(r.debit as never);
      const credit = dec(r.credit as never);
      if (IS_CLASSES.includes(r.cls)) {
        totalPL = totalPL.plus(credit.minus(debit));
        continue;
      }
      const account = accounts.get(r._id.toHexString());
      if (account) balances.push({ account, amount: natural(account.accountClass as AccountClass, debit, credit) });
    }
    const currentYearEarnings = currentPL ? dec(currentPL.credit as never).minus(dec(currentPL.debit as never)) : totalPL;
    const retainedFromPriorYears = totalPL.minus(currentYearEarnings);

    const reId = org?.settings?.retainedEarningsAccountId?.toHexString();
    const reRow = balances.find((b) => b.account._id.toHexString() === reId);
    const extraEquity: { code: string; name: string; amount: Decimal }[] = [];
    if (!retainedFromPriorYears.isZero()) {
      if (reRow) reRow.amount = reRow.amount.plus(retainedFromPriorYears);
      else extraEquity.push({ code: '', name: 'Retained earnings brought forward', amount: retainedFromPriorYears });
    }
    extraEquity.push({ code: '', name: 'Current year earnings', amount: currentYearEarnings });

    const section = (cls: AccountClass, title: string) => {
      const lines = balances
        .filter((b) => b.account.accountClass === cls && !b.amount.isZero())
        .sort((a, b) => a.account.code.localeCompare(b.account.code))
        .map((b) => ({ accountId: b.account._id, code: b.account.code, name: b.account.name, accountType: b.account.accountType, amount: b.amount }));
      if (cls === 'EQUITY') lines.push(...extraEquity.map((e) => ({ accountId: null as never, accountType: 'EQUITY', ...e })));
      return { title, accountClass: cls, lines, total: lines.reduce((a, l) => a.plus(l.amount), new Decimal(0)) };
    };
    const assets = section('ASSET', 'Assets');
    const liabilities = section('LIABILITY', 'Liabilities');
    const equity = section('EQUITY', 'Equity');
    const liabilitiesAndEquity = liabilities.total.plus(equity.total);
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      asOf,
      fiscalYearStart: fyStart,
      sections: [assets, liabilities, equity],
      totals: { assets: assets.total, liabilities: liabilities.total, equity: equity.total, liabilitiesAndEquity },
      balanced: assets.total.eq(liabilitiesAndEquity),
    };
  }

  // ------------------------------------------------------------------------------------------

  /**
   * Statement of changes in net assets (IPSAS 1): for each component of net assets (equity account),
   * the opening balance, the surplus or deficit for the period, other movements posted to it, and the
   * closing balance. Surplus earned before the period is part of the accumulated surplus opening.
   */
  async changesInNetAssets(user: AuthUser, f: ReportFilters, from: Date, to: Date) {
    if (from > to) throw new BadRequestException('"from" must be on or before "to"');
    const { entity, org } = await this.context(user, f);
    const match = this.match(user, f);
    const [before, during] = await Promise.all([this.sums(match, null, from, ['account', 'class']), this.sums(match, from, addDays(to, 1), ['account', 'class'])]);
    const accounts = await this.accountMap(user);
    const credit = (r: { debit: Decimal; credit: Decimal }) => r.credit.minus(r.debit);
    const surplusBefore = before.filter((r) => IS_CLASSES.includes(r.cls!)).reduce((a, r) => a.plus(credit(r)), new Decimal(0));
    const surplus = during.filter((r) => IS_CLASSES.includes(r.cls!)).reduce((a, r) => a.plus(credit(r)), new Decimal(0));
    const reId = org?.settings?.retainedEarningsAccountId?.toHexString() ?? null;
    const ids = new Set([...before, ...during].filter((r) => r.cls === 'EQUITY').map((r) => r.account!.toHexString()));
    if (reId) ids.add(reId);
    const rows = [...ids]
      .map((id) => {
        const a = accounts.get(id);
        if (!a) return null;
        const o = before.find((r) => r.account?.toHexString() === id);
        const d = during.find((r) => r.account?.toHexString() === id);
        const isSurplus = id === reId;
        const opening = (o ? credit(o) : new Decimal(0)).plus(isSurplus ? surplusBefore : 0);
        const movements = d ? credit(d) : new Decimal(0);
        const periodSurplus = isSurplus ? surplus : new Decimal(0);
        return { accountId: a._id, code: a.code, name: isSurplus ? `${a.name} (accumulated surplus)` : a.name, opening, surplus: periodSurplus, otherMovements: movements, closing: opening.plus(periodSurplus).plus(movements) };
      })
      .filter((r): r is NonNullable<typeof r> => !!r && !(r.opening.isZero() && r.surplus.isZero() && r.otherMovements.isZero()))
      .sort((a, b) => a.code.localeCompare(b.code));
    if (!reId && !(surplusBefore.isZero() && surplus.isZero())) {
      rows.push({ accountId: null as never, code: '', name: 'Accumulated surplus', opening: surplusBefore, surplus, otherMovements: new Decimal(0), closing: surplusBefore.plus(surplus) });
    }
    const total = (k: 'opening' | 'surplus' | 'otherMovements' | 'closing') => rows.reduce((a, r) => a.plus(r[k]), new Decimal(0));
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      from,
      to,
      rows,
      totals: { opening: total('opening'), surplus: total('surplus'), otherMovements: total('otherMovements'), closing: total('closing') },
    };
  }

  // ------------------------------------------------------------------------------------------

  async dashboard(user: AuthUser, f: ReportFilters, asOf: Date) {
    const { entity } = await this.context(user, f);
    const fyStart = (await this.fiscalYearStart(user, f.entityId, asOf)) ?? new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
    const match = this.match(user, f);
    const accounts = await this.accountMap(user);

    const byAccount = (await this.sums(match, null, addDays(asOf, 1), ['account'])).map((r) => ({ _id: r.account!, debit: r.debit, credit: r.credit }));
    const balanceOfTypes = (types: string[]) =>
      byAccount.reduce((acc, r) => {
        const a = accounts.get(r._id.toHexString());
        return a && types.includes(a.accountType) ? acc.plus(dec(r.debit as never)).minus(dec(r.credit as never)) : acc;
      }, new Decimal(0));

    const monthly = (await this.sums({ ...match, accountClass: { $in: IS_CLASSES } }, fyStart, addDays(asOf, 1), ['month', 'class'])).map((r) => ({
      _id: { y: r.month!.getUTCFullYear(), m: r.month!.getUTCMonth() + 1, cls: r.cls! },
      debit: r.debit,
      credit: r.credit,
    }));
    const months: { month: string; revenue: Decimal; costOfSales: Decimal; expenses: Decimal; netProfit: Decimal }[] = [];
    for (let t = new Date(fyStart); t <= asOf && months.length < 12; t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1))) {
      const pick = (cls: AccountClass) => {
        const r = monthly.find((x) => x._id.y === t.getUTCFullYear() && x._id.m === t.getUTCMonth() + 1 && x._id.cls === cls);
        return r ? natural(cls, dec(r.debit as never), dec(r.credit as never)) : new Decimal(0);
      };
      const revenue = pick('REVENUE');
      const costOfSales = pick('COST_OF_SALES');
      const expenses = pick('EXPENSE');
      months.push({
        month: t.toISOString().slice(0, 7),
        revenue,
        costOfSales,
        expenses,
        netProfit: revenue.minus(costOfSales).minus(expenses),
      });
    }
    const ytd = (k: 'revenue' | 'costOfSales' | 'expenses' | 'netProfit') => months.reduce((a, m) => a.plus(m[k]), new Decimal(0));

    const journalScope: Record<string, unknown> = { organisationId: user.organisationId, entityId: f.entityId };
    const restricted = allowedBranches(user);
    if (restricted) journalScope.branchId = { $in: restricted };
    const [pendingApproval, awaitingPosting, drafts, period] = await Promise.all([
      this.db.journals.countDocuments({ ...journalScope, status: 'SUBMITTED' }),
      this.db.journals.countDocuments({ ...journalScope, status: 'APPROVED' }),
      this.db.journals.countDocuments({ ...journalScope, status: { $in: ['DRAFT', 'REJECTED'] } }),
      this.db.periods
        .findOne({ organisationId: user.organisationId, entityId: f.entityId, startDate: { $lte: asOf }, endDate: { $gte: asOf } })
        .lean(),
    ]);
    const revenue = ytd('revenue');
    const grossProfit = revenue.minus(ytd('costOfSales'));

    // Commercial workflow: documents and payments waiting for a second person, and overdue balances.
    const scope = { ...journalScope };
    const [invoicesAwaiting, billsAwaiting, paymentsAwaiting, overdue] = await Promise.all([
      this.db.invoices.countDocuments({ ...scope, kind: { $in: ['SALES_INVOICE', 'SALES_CREDIT'] }, status: 'SUBMITTED' }),
      this.db.invoices.countDocuments({ ...scope, kind: { $in: ['PURCHASE_BILL', 'PURCHASE_CREDIT'] }, status: 'SUBMITTED' }),
      this.db.payments.countDocuments({ ...scope, kind: 'PAYMENT', status: 'SUBMITTED' }),
      this.db.invoices.aggregate<{ _id: string; amount: unknown }>([
        { $match: { ...scope, kind: { $in: ['SALES_INVOICE', 'PURCHASE_BILL'] }, status: 'POSTED', paymentStatus: { $ne: 'PAID' }, dueDate: { $lt: asOf } } },
        { $group: { _id: '$kind', amount: { $sum: '$amountDueFunctional' } } },
      ]),
    ]);
    const overdueOf = (kind: string) => dec(overdue.find((o) => o._id === kind)?.amount as never);

    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      asOf,
      fiscalYearStart: fyStart,
      kpis: {
        cash: balanceOfTypes(['BANK', 'CASH']),
        receivables: balanceOfTypes(['RECEIVABLE']),
        payables: balanceOfTypes(['PAYABLE']).neg(),
        revenueYtd: revenue,
        grossProfitYtd: grossProfit,
        grossMarginPct: revenue.isZero() ? null : grossProfit.div(revenue).times(100).toDecimalPlaces(1),
        expensesYtd: ytd('expenses'),
        netProfitYtd: ytd('netProfit'),
      },
      months,
      workflow: { pendingApproval, awaitingPosting, drafts, invoicesAwaiting, billsAwaiting, paymentsAwaiting },
      overdue: { receivables: overdueOf('SALES_INVOICE'), payables: overdueOf('PURCHASE_BILL') },
      currentPeriod: period ? { id: period._id, name: period.name, status: period.status } : null,
      generatedAt: new Date(),
    };
  }
}
