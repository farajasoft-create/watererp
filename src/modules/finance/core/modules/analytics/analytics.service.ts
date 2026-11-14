import { addDays, ledgerSums } from '../reports/ledger-sums';
import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum } from '../../common/money';
import { Db } from '../../database/db.service';
import { DEBIT_NORMAL } from '../../database/schemas';
import { BudgetsService } from '../budgets/budgets.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { FxReportsService } from '../fx/fx-reports.service';
import { WarehouseService } from './warehouse.service';

const D0 = () => new Decimal(0);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const ym = (d: Date) => d.toISOString().slice(0, 7);
const DAY = 86_400_000;

const CASH_TYPES = ['BANK', 'CASH'];
const CURRENT_ASSET_TYPES = ['BANK', 'CASH', 'RECEIVABLE', 'INVENTORY', 'PREPAYMENT', 'CURRENT_ASSET'];
const CURRENT_LIABILITY_TYPES = ['PAYABLE', 'TAX_PAYABLE', 'ACCRUAL', 'CURRENT_LIABILITY'];
/** Excluded from EBITDA: depreciation, FX and income tax. */
const BELOW_EBITDA = ['DEPRECIATION', 'FX_LOSS', 'FX_GAIN', 'TAX_EXPENSE'];

type Severity = 'high' | 'medium' | 'low';
/** What-if levers on the cash forecast. */
export interface Scenario {
  /** Customers pay this many days later (or earlier, if negative) than their usual pattern. */
  delayDays?: number;
  /** Change in the weekly run rate of other receipts / payments, in percent. */
  receiptsPercent?: number;
  paymentsPercent?: number;
  /** One-off items: positive receipts, negative payments (a loan, a tax payment, capital spend). */
  items?: { date: Date; amount: Decimal; description: string }[];
}

export interface Exception {
  kind: string;
  severity: Severity;
  title: string;
  detail: string;
  date: Date | null;
  amount: Decimal | null;
  link: string | null;
}

/**
 * Executive and predictive analytics over the reporting warehouse: KPIs and trends, cash flow
 * statement, a 13-week cash forecast and exception detection. Branch-restricted users only ever see
 * their branches.
 */
export class AnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly currencies: CurrenciesService,
    private readonly warehouse: WarehouseService,
    private readonly budgets: BudgetsService,
    private readonly fxReports: FxReportsService,
  ) {}

  private async entity(user: AuthUser, entityId: Types.ObjectId) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    return entity;
  }

  /** Monthly facts grouped by month, class, type and branch (natural sign: + for normal balance). */
  private async facts(user: AuthUser, entityId: Types.ObjectId, from: Date | null, to: Date) {
    const restricted = allowedBranches(user);
    const rows = await this.db.ledgerFacts.aggregate<{ _id: { month: Date; cls: string; type: string | null; branch: Types.ObjectId }; debit: Types.Decimal128; credit: Types.Decimal128 }>([
      {
        $match: {
          organisationId: user.organisationId,
          entityId,
          month: { ...(from && { $gte: monthStart(from) }), $lte: monthStart(to) },
          ...(restricted && { branchId: { $in: restricted } }),
        },
      },
      { $group: { _id: { month: '$month', cls: '$accountClass', type: '$accountType', branch: '$branchId' }, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
    return rows.map((r) => {
      const dr = dec(r.debit as never).minus(dec(r.credit as never));
      return { month: r._id.month, cls: r._id.cls, type: r._id.type ?? '', branch: r._id.branch, natural: DEBIT_NORMAL.has(r._id.cls as never) ? dr : dr.neg(), dr };
    });
  }

  private pl(rows: { cls: string; type: string; natural: Decimal }[]) {
    const pick = (f: (r: (typeof rows)[number]) => boolean) => sum(rows.filter(f).map((r) => r.natural));
    const revenue = pick((r) => r.cls === 'REVENUE' && r.type !== 'FX_GAIN');
    const costOfSales = pick((r) => r.cls === 'COST_OF_SALES');
    const opex = pick((r) => r.cls === 'EXPENSE' && !BELOW_EBITDA.includes(r.type));
    const depreciation = pick((r) => r.type === 'DEPRECIATION');
    const fx = pick((r) => r.type === 'FX_GAIN').minus(pick((r) => r.type === 'FX_LOSS'));
    const tax = pick((r) => r.type === 'TAX_EXPENSE');
    const grossProfit = revenue.minus(costOfSales);
    const ebitda = grossProfit.minus(opex);
    const netProfit = ebitda.minus(depreciation).plus(fx).minus(tax);
    return { revenue, costOfSales, grossProfit, opex, ebitda, depreciation, fx, tax, netProfit };
  }

  private pct(part: Decimal, whole: Decimal): string | null {
    return whole.isZero() ? null : part.div(whole).times(100).toDecimalPlaces(1).toFixed(1);
  }

  /** The executive dashboard: KPIs year to date against last year and budget, trends and exceptions. */
  async executive(user: AuthUser, entityId: Types.ObjectId, asOf: Date) {
    const entity = await this.entity(user, entityId);
    const state = await this.warehouse.ensureFresh(user.organisationId);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const fy = await this.db.fiscalYears.findOne({ organisationId: user.organisationId, entityId, startDate: { $lte: asOf }, endDate: { $gte: asOf } }).lean();
    const fyStart = fy?.startDate ?? monthStart(new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1)));
    const current = monthStart(asOf);
    const trendStart = addMonths(current, -11);
    const lyStart = addMonths(fyStart, -12);
    const lyEnd = addMonths(current, -12);

    const all = await this.facts(user, entityId, null, asOf);
    const isPL = (cls: string) => cls === 'REVENUE' || cls === 'COST_OF_SALES' || cls === 'EXPENSE';
    const inRange = (m: Date, from: Date, to: Date) => m >= from && m <= to;
    const ytd = this.pl(all.filter((r) => isPL(r.cls) && inRange(r.month, monthStart(fyStart), current)));
    const lastYear = this.pl(all.filter((r) => isPL(r.cls) && inRange(r.month, monthStart(lyStart), lyEnd)));
    const mtd = this.pl(all.filter((r) => isPL(r.cls) && r.month.getTime() === current.getTime()));

    // Balances at the end of the current month.
    const bal = (types: string[]) => sum(all.filter((r) => types.includes(r.type)).map((r) => r.dr));
    const cash = bal(CASH_TYPES);
    const receivables = bal(['RECEIVABLE']);
    const payables = bal(['PAYABLE']).neg();
    const inventory = bal(['INVENTORY']);
    const currentAssets = bal(CURRENT_ASSET_TYPES);
    const currentLiabilities = bal(CURRENT_LIABILITY_TYPES).neg();
    const last3 = this.pl(all.filter((r) => isPL(r.cls) && inRange(r.month, addMonths(current, -2), current)));
    const days = Math.round((asOf.getTime() - addMonths(current, -2).getTime()) / DAY) + 1;
    const dso = last3.revenue.gt(0) ? receivables.div(last3.revenue).times(days).toDecimalPlaces(0).toNumber() : null;
    const purchases = last3.costOfSales.plus(last3.opex);
    const dpo = purchases.gt(0) ? payables.div(purchases).times(days).toDecimalPlaces(0).toNumber() : null;

    // Twelve-month trend with month-end cash.
    const months = Array.from({ length: 12 }, (_, i) => addMonths(trendStart, i));
    let runningCash = sum(all.filter((r) => CASH_TYPES.includes(r.type) && r.month < trendStart).map((r) => r.dr));
    const trend = months.map((m) => {
      const rows = all.filter((r) => r.month.getTime() === m.getTime());
      const p = this.pl(rows.filter((r) => isPL(r.cls)));
      runningCash = runningCash.plus(sum(rows.filter((r) => CASH_TYPES.includes(r.type)).map((r) => r.dr)));
      return { month: ym(m), revenue: p.revenue, grossProfit: p.grossProfit, opex: p.opex, netProfit: p.netProfit, cash: runningCash };
    });

    // Branch performance (year to date).
    const branches = await this.db.branches.find({ organisationId: user.organisationId, entityId }, { code: 1, name: 1 }).lean();
    const branchRows = branches
      .map((b) => {
        const p = this.pl(all.filter((r) => isPL(r.cls) && r.branch.equals(b._id) && inRange(r.month, monthStart(fyStart), current)));
        return { branchId: b._id, code: b.code, name: b.name, revenue: p.revenue, grossProfit: p.grossProfit, grossMarginPercent: this.pct(p.grossProfit, p.revenue), netProfit: p.netProfit };
      })
      .filter((b) => !(b.revenue.isZero() && b.netProfit.isZero()))
      .sort((a, b) => b.revenue.cmp(a.revenue));

    // Budget utilisation (year to date) from the approved budget.
    let budget: { name: string; revenue: Decimal; revenueActual: Decimal; costs: Decimal; costsActual: Decimal; utilisationPercent: string | null; overBudget: { code: string; name: string; budget: Decimal; actual: Decimal }[] } | null = null;
    try {
      const bva = await this.budgets.vsActual(user, { entityId, from: fyStart, to: monthEnd(current) });
      if (bva.budget) {
        const cost = bva.rows.filter((r) => r.accountClass !== 'REVENUE');
        const costs = sum(cost.map((r) => dec(r.budget)));
        const costsActual = sum(cost.map((r) => dec(r.actual)));
        budget = {
          name: bva.budget.name,
          revenue: dec(bva.totals.revenueBudget),
          revenueActual: dec(bva.totals.revenueActual),
          costs,
          costsActual,
          utilisationPercent: this.pct(costsActual, costs),
          overBudget: cost
            .filter((r) => dec(r.actual).gt(dec(r.budget)) && dec(r.budget).gt(0))
            .map((r) => ({ code: r.code, name: r.name, budget: dec(r.budget), actual: dec(r.actual) }))
            .slice(0, 5),
        };
      }
    } catch {
      budget = null;
    }

    // FX exposure (foreign-currency monetary items at closing rates).
    let fx: { currency: string; net: Decimal; atRate: Decimal; sensitivity10: Decimal }[] = [];
    try {
      const exposure = await this.fxReports.exposure(user, entityId, asOf);
      fx = exposure.rows.map((r) => ({ currency: r.currency, net: r.net, atRate: r.atRate, sensitivity10: r.sensitivity10 }));
    } catch {
      fx = [];
    }

    const exceptions = await this.exceptions(user, entityId, monthStart(addMonths(current, -2)), asOf);
    const forecast = await this.forecast(user, entityId, { weeks: 13, today: asOf });

    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      asOf,
      fiscalYearStart: fyStart,
      warehouse: { lastRefreshedAt: state?.lastRefreshedAt ?? null, facts: state?.facts ?? 0 },
      kpis: {
        revenue: { ytd: ytd.revenue, lastYear: lastYear.revenue, changePercent: this.pct(ytd.revenue.minus(lastYear.revenue), lastYear.revenue.abs()), mtd: mtd.revenue },
        grossMargin: { ytd: ytd.grossProfit, percent: this.pct(ytd.grossProfit, ytd.revenue), lastYearPercent: this.pct(lastYear.grossProfit, lastYear.revenue) },
        opex: { ytd: ytd.opex, lastYear: lastYear.opex, changePercent: this.pct(ytd.opex.minus(lastYear.opex), lastYear.opex.abs()) },
        ebitda: { ytd: ytd.ebitda, percent: this.pct(ytd.ebitda, ytd.revenue), lastYear: lastYear.ebitda },
        netProfit: { ytd: ytd.netProfit, lastYear: lastYear.netProfit, mtd: mtd.netProfit },
        cash: { balance: cash, forecastLow: forecast.lowest.balance, forecastLowWeek: forecast.lowest.weekStart },
        receivables: { balance: receivables, dso },
        payables: { balance: payables, dpo },
        inventory: { balance: inventory },
        workingCapital: { amount: currentAssets.minus(currentLiabilities), currentRatio: currentLiabilities.gt(0) ? currentAssets.div(currentLiabilities).toDecimalPlaces(2).toFixed(2) : null },
      },
      pl: { ytd, lastYear, mtd },
      trend,
      branches: branchRows,
      budget,
      fx,
      exceptions: { total: exceptions.length, high: exceptions.filter((e) => e.severity === 'high').length, top: exceptions.slice(0, 6) },
      precision: fp,
    };
  }

  /**
   * Statement of cash flows (indirect method) between two dates. Every non-cash account's movement is
   * classified by type, so operating + investing + financing always equals the change in cash.
   */
  async cashFlow(user: AuthUser, entityId: Types.ObjectId, from: Date, to: Date) {
    if (from > to) throw new BadRequestException('"from" must be on or before "to"');
    const entity = await this.entity(user, entityId);
    const restricted = allowedBranches(user);
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId }, { code: 1, name: 1, accountClass: 1, accountType: 1 }).lean();
    const byId = new Map(accounts.map((a) => [a._id.toHexString(), a]));
    const branchFilter = restricted ? { branchId: { $in: restricted } } : {};
    // Opening-balance journals set the starting position; they are not cash flows of the period.
    const openingJournals = (await this.db.journals.find({ organisationId: user.organisationId, entityId, type: 'OPENING', status: 'POSTED' }, { _id: 1 }).lean()).map((j) => j._id);
    // Totals come from the monthly totals plus partial months; the few opening-balance journal lines
    // in the period are read directly and moved from the period's flows to the opening position.
    const cashIds = accounts.filter((a) => CASH_TYPES.includes(a.accountType)).map((a) => a._id);
    const scope = { organisationId: user.organisationId, entityId, ...branchFilter };
    const [period, openingLines, before] = await Promise.all([
      ledgerSums(this.db, scope, from, addDays(to, 1), ['account']),
      openingJournals.length
        ? this.db.ledger.aggregate<{ _id: Types.ObjectId; dr: Types.Decimal128 }>([
            { $match: { ...scope, journalId: { $in: openingJournals }, date: { $gte: from, $lte: to } } },
            { $group: { _id: '$accountId', dr: { $sum: { $subtract: ['$debit', '$credit'] } } } },
          ])
        : Promise.resolve([]),
      ledgerSums(this.db, { ...scope, accountId: { $in: cashIds } }, null, from, []),
    ]);
    const openingBy = new Map(openingLines.map((o) => [o._id.toHexString(), dec(o.dr as never)]));
    const movements = period.map((r) => ({ _id: r.account!, dr: r.debit.minus(r.credit).minus(openingBy.get(r.account!.toHexString()) ?? D0()) }));
    const opening = [{ _id: null, dr: (before[0] ? before[0].debit.minus(before[0].credit) : D0()).plus(sum(openingLines.filter((o) => cashIds.some((c) => c.equals(o._id))).map((o) => dec(o.dr as never)))) }];
    const lines = new Map<string, Decimal>();
    const add = (k: string, v: Decimal) => lines.set(k, (lines.get(k) ?? D0()).plus(v));
    let cashChange = D0();
    const cashByAccount: { code: string; name: string; change: Decimal }[] = [];
    for (const m of movements) {
      const a = byId.get(m._id.toHexString());
      if (!a) continue;
      const dr = dec(m.dr as never);
      if (CASH_TYPES.includes(a.accountType)) {
        cashChange = cashChange.plus(dr);
        cashByAccount.push({ code: a.code, name: a.name, change: dr });
        continue;
      }
      // A debit to a non-cash account is a use of cash; a credit is a source.
      const c = dr.neg();
      switch (a.accountClass) {
        case 'REVENUE':
        case 'COST_OF_SALES':
        case 'EXPENSE':
          add('profit', c);
          if (a.accountType === 'DEPRECIATION') add('depreciation', dr);
          break;
        case 'ASSET':
          if (a.accountType === 'RECEIVABLE') add('receivables', c);
          else if (a.accountType === 'INVENTORY') add('inventory', c);
          else if (['PREPAYMENT', 'CURRENT_ASSET', 'INTER_BRANCH'].includes(a.accountType)) add('otherCurrentAssets', c);
          else add('investing', c);
          break;
        case 'LIABILITY':
          if (a.accountType === 'PAYABLE') add('payables', c);
          else if (a.accountType === 'TAX_PAYABLE') add('taxes', c);
          else if (['ACCRUAL', 'CURRENT_LIABILITY'].includes(a.accountType)) add('otherCurrentLiabilities', c);
          else add('borrowings', c);
          break;
        default:
          add('equity', c);
      }
    }
    // Depreciation is charged against accumulated depreciation (an investing-class account); move it
    // to operating so investing shows only purchases and disposals.
    const depreciation = lines.get('depreciation') ?? D0();
    add('investing', depreciation.neg());
    const g = (k: string) => lines.get(k) ?? D0();
    const operatingItems = [
      { key: 'profit', label: 'Profit for the period', amount: g('profit') },
      { key: 'depreciation', label: 'Depreciation', amount: depreciation },
      { key: 'receivables', label: '(Increase) / decrease in receivables', amount: g('receivables') },
      { key: 'inventory', label: '(Increase) / decrease in inventory', amount: g('inventory') },
      { key: 'otherCurrentAssets', label: '(Increase) / decrease in other current assets', amount: g('otherCurrentAssets') },
      { key: 'payables', label: 'Increase / (decrease) in payables', amount: g('payables') },
      { key: 'taxes', label: 'Increase / (decrease) in taxes payable', amount: g('taxes') },
      { key: 'otherCurrentLiabilities', label: 'Increase / (decrease) in accruals and other liabilities', amount: g('otherCurrentLiabilities') },
    ];
    const operating = sum(operatingItems.map((i) => i.amount));
    const investingItems = [{ key: 'capex', label: 'Purchase and disposal of fixed and other non-current assets', amount: g('investing') }];
    const financingItems = [
      { key: 'borrowings', label: 'Borrowings raised / (repaid)', amount: g('borrowings') },
      { key: 'equity', label: 'Equity issued / (distributed)', amount: g('equity') },
    ];
    const investing = sum(investingItems.map((i) => i.amount));
    const financing = sum(financingItems.map((i) => i.amount));
    const openingCash = opening[0] ? opening[0].dr : D0();
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      from,
      to,
      operating: { items: operatingItems, total: operating },
      investing: { items: investingItems, total: investing },
      financing: { items: financingItems, total: financing },
      netChange: operating.plus(investing).plus(financing),
      openingCash,
      closingCash: openingCash.plus(cashChange),
      cashChange,
      reconciles: operating.plus(investing).plus(financing).eq(cashChange),
      cashAccounts: cashByAccount.sort((a, b) => a.code.localeCompare(b.code)),
    };
  }

  /**
   * Thirteen-week cash forecast: customer receipts at each customer's historical payment behaviour,
   * supplier bills at their due dates, committed purchase orders, and the run rate of other cash
   * movements (cash sales, payroll, rent) from the last 13 weeks.
   */
  async forecast(user: AuthUser, entityId: Types.ObjectId, opts: { weeks?: number; today?: Date; minimumCash?: Decimal; scenario?: Scenario } = {}) {
    const sc = opts.scenario;
    const entity = await this.entity(user, entityId);
    const weeks = Math.min(Math.max(opts.weeks ?? 13, 4), 26);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const org = user.organisationId;
    const today = opts.today ?? new Date();
    const day0 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    // Weeks start on Monday.
    const start = new Date(day0.getTime() - ((day0.getUTCDay() + 6) % 7) * DAY);
    const weekOf = (d: Date) => Math.max(0, Math.floor((d.getTime() - start.getTime()) / (7 * DAY)));
    const restricted = allowedBranches(user);
    const branchFilter = restricted ? { branchId: { $in: restricted } } : {};

    const accounts = await this.db.accounts.find({ organisationId: org, accountType: { $in: CASH_TYPES } }, { _id: 1 }).lean();
    const cashIds = accounts.map((a) => a._id);
    const [openingRow] = await ledgerSums(this.db, { organisationId: org, entityId, accountId: { $in: cashIds }, ...branchFilter }, null, addDays(day0, 1), []);
    const opening = openingRow ? openingRow.debit.minus(openingRow.credit) : D0();

    const buckets = Array.from({ length: weeks }, (_, i) => ({ week: i + 1, weekStart: new Date(start.getTime() + i * 7 * DAY), customers: D0(), otherReceipts: D0(), suppliers: D0(), purchaseOrders: D0(), otherPayments: D0() }));
    const put = (d: Date, key: 'customers' | 'otherReceipts' | 'suppliers' | 'purchaseOrders' | 'otherPayments', v: Decimal) => {
      const i = weekOf(d);
      if (i < weeks) buckets[i][key] = buckets[i][key].plus(v);
    };

    // Customer payment behaviour: average days paid after the due date over the last year.
    const allocations = await this.db.allocations.find({ organisationId: org, entityId, partyType: 'CUSTOMER', status: 'ACTIVE', date: { $gte: new Date(day0.getTime() - 365 * DAY) } }, { partyId: 1, date: 1, documentId: 1 }).lean();
    const docs = await this.db.invoices.find({ _id: { $in: allocations.map((a) => a.documentId) } }, { dueDate: 1 }).lean();
    const due = new Map(docs.map((x) => [x._id.toHexString(), x.dueDate]));
    const lateness = new Map<string, number[]>();
    for (const a of allocations) {
      const d = due.get(a.documentId.toHexString());
      if (!d) continue;
      const key = a.partyId.toHexString();
      lateness.set(key, [...(lateness.get(key) ?? []), Math.round((a.date.getTime() - d.getTime()) / DAY)]);
    }
    const avgLate = (party: Types.ObjectId) => {
      const xs = lateness.get(party.toHexString());
      return xs?.length ? Math.max(0, Math.round(xs.reduce((s, x) => s + x, 0) / xs.length)) : 0;
    };

    const open = await this.db.invoices
      .find({ organisationId: org, entityId, status: 'POSTED', paymentStatus: { $ne: 'PAID' }, ...branchFilter }, { kind: 1, partyId: 1, partyName: 1, dueDate: 1, amountDueFunctional: 1, number: 1 })
      .lean();
    const customers = new Map<string, { name: string; amount: Decimal; daysLate: number }>();
    for (const inv of open) {
      const amount = dec(inv.amountDueFunctional);
      if (amount.isZero()) continue;
      if (inv.kind === 'SALES_INVOICE') {
        const late = avgLate(inv.partyId);
        put(new Date(Math.max(inv.dueDate.getTime() + (late + (sc?.delayDays ?? 0)) * DAY, day0.getTime())), 'customers', amount);
        const c = customers.get(inv.partyId.toHexString()) ?? { name: inv.partyName, amount: D0(), daysLate: late };
        c.amount = c.amount.plus(amount);
        customers.set(inv.partyId.toHexString(), c);
      } else if (inv.kind === 'SALES_CREDIT') put(day0, 'customers', amount.neg());
      else if (inv.kind === 'PURCHASE_BILL') put(new Date(Math.max(inv.dueDate.getTime(), day0.getTime())), 'suppliers', amount);
      else if (inv.kind === 'PURCHASE_CREDIT') put(day0, 'suppliers', amount.neg());
    }

    // Approved purchase orders not yet billed: paid on the supplier's terms after expected delivery.
    const orders = await this.db.purchaseOrders.find({ organisationId: org, entityId, status: { $in: ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'] }, ...branchFilter }).lean();
    const suppliers = new Map((await this.db.suppliers.find({ organisationId: org, _id: { $in: orders.map((o) => o.supplierId) } }, { paymentTermsDays: 1 }).lean()).map((s) => [s._id.toHexString(), s.paymentTermsDays]));
    for (const o of orders) {
      const unbilled = sum(o.lines.map((l) => dec(l.unitPrice).times(dec(l.quantity).minus(dec(l.quantityBilled))))).times(dec(o.exchangeRate));
      if (unbilled.lte(0)) continue;
      const delivery = o.expectedDate ?? o.date;
      put(new Date(Math.max(delivery.getTime() + (suppliers.get(o.supplierId.toHexString()) ?? 30) * DAY, day0.getTime())), 'purchaseOrders', unbilled);
    }

    // Run rate of other cash movements (journals that are not from customer, supplier or bank documents).
    const lookback = new Date(day0.getTime() - 91 * DAY);
    const [runRate] = await this.db.ledger.aggregate<{ dr: Types.Decimal128; cr: Types.Decimal128 }>([
      { $match: { organisationId: org, entityId, accountId: { $in: cashIds }, source: { $in: ['MANUAL', 'API', 'IMPORT'] }, date: { $gt: lookback, $lte: day0 }, ...branchFilter } },
      { $group: { _id: null, dr: { $sum: '$debit' }, cr: { $sum: '$credit' } } },
    ]);
    // Scenario levers scale the run rate of other receipts and payments.
    const scale = (v: Decimal, pct?: number) => (pct ? round(v.times(100 + pct).div(100), fp) : v);
    const weeklyIn = scale(runRate ? round(dec(runRate.dr as never).div(13), fp) : D0(), sc?.receiptsPercent);
    const weeklyOut = scale(runRate ? round(dec(runRate.cr as never).div(13), fp) : D0(), sc?.paymentsPercent);
    for (const item of sc?.items ?? []) {
      const when = new Date(Math.max(item.date.getTime(), day0.getTime()));
      if (item.amount.isNeg()) put(when, 'otherPayments', item.amount.abs());
      else put(when, 'otherReceipts', item.amount);
    }

    let balance = opening;
    const rows = buckets.map((b) => {
      const otherReceipts = b.otherReceipts.plus(weeklyIn);
      const otherPayments = b.otherPayments.plus(weeklyOut);
      const inflow = b.customers.plus(otherReceipts);
      const outflow = b.suppliers.plus(b.purchaseOrders).plus(otherPayments);
      const openingBalance = balance;
      balance = balance.plus(inflow).minus(outflow);
      return { ...b, otherReceipts, otherPayments, inflow, outflow, net: inflow.minus(outflow), opening: openingBalance, closing: balance };
    });
    const lowest = rows.reduce((m, r) => (r.closing.lt(m.closing) ? r : m), rows[0]);
    const minimum = opts.minimumCash ?? D0();
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      startDate: start,
      openingCash: opening,
      weeks: rows,
      lowest: { weekStart: lowest.weekStart, balance: lowest.closing },
      shortfallWeeks: rows.filter((r) => r.closing.lt(minimum)).map((r) => r.week),
      assumptions: {
        weeklyOtherReceipts: weeklyIn,
        weeklyOtherPayments: weeklyOut,
        customers: [...customers.values()].sort((a, b) => b.amount.cmp(a.amount)).slice(0, 10),
      },
    };
  }

  /**
   * Key exceptions for review: unusual manual journals, weekend and back-dated postings, possible
   * duplicate bills, payments soon after a supplier's bank details changed, overdue approvals,
   * credit and budget overrides and expense-policy exceptions.
   */
  async exceptions(user: AuthUser, entityId: Types.ObjectId, from: Date, to: Date): Promise<Exception[]> {
    const org = user.organisationId;
    const restricted = allowedBranches(user);
    const branchFilter = restricted ? { branchId: { $in: restricted } } : {};
    const out: Exception[] = [];
    const manual = { $in: ['MANUAL', 'API', 'IMPORT'] };

    // Unusually large manual lines compared with the account's own history (z-score over the twelve
    // months before the window). The history comes from the monthly totals (count, sum and sum of
    // squares of manual line amounts); only lines above each account's threshold are read.
    const historyFrom = addMonths(monthStart(from), -12);
    const history = await this.db.ledgerFacts.aggregate<{ _id: Types.ObjectId; n: number; s: number; ss: number }>([
      { $match: { organisationId: org, entityId, month: { $gte: historyFrom, $lt: monthStart(from) }, manualCount: { $gt: 0 }, ...branchFilter } },
      { $group: { _id: '$accountId', n: { $sum: '$manualCount' }, s: { $sum: '$manualSum' }, ss: { $sum: '$manualSumSq' } } },
    ]);
    const stats = history
      .filter((h) => h.n >= 5)
      .map((h) => {
        const mean = h.s / h.n;
        const sd = Math.sqrt(Math.max(0, h.ss / h.n - mean * mean));
        return { _id: h._id, mean, sd, n: h.n, threshold: Math.max(mean + 3 * sd, mean * 3) };
      })
      .filter((x) => x.sd > 0);
    // One simple query per account (account and date index); a single $or over every account makes the
    // query planner far slower than the queries themselves.
    const found = await Promise.all(
      stats.slice(0, 500).map((x) => {
        const t = Types.Decimal128.fromString(x.threshold.toFixed(2));
        return this.db.ledger
          .find({ organisationId: org, entityId, accountId: x._id, date: { $gte: from, $lte: to }, source: manual, ...branchFilter, $or: [{ debit: { $gte: t } }, { credit: { $gte: t } }] }, { journalId: 1, journalNumber: 1, accountId: 1, debit: 1, credit: 1, date: 1 })
          // The account-and-date index bounds the window; left to itself the planner tends to pick a worse one.
          .hint({ organisationId: 1, entityId: 1, accountId: 1, date: 1, journalNumber: 1, lineNo: 1 })
          .limit(200)
          .lean();
      }),
    );
    const byLine = new Map<string, { _id: { journal: Types.ObjectId; number: string; account: Types.ObjectId }; amount: number; date: Date }>();
    for (const l of found.flat()) {
      const key = `${l.journalId.toHexString()}|${l.accountId.toHexString()}`;
      const amount = Number(dec(l.debit).plus(dec(l.credit)).toFixed(2));
      const current = byLine.get(key);
      if (!current || amount > current.amount) byLine.set(key, { _id: { journal: l.journalId, number: l.journalNumber, account: l.accountId }, amount, date: l.date });
    }
    const lines = [...byLine.values()];
    if (lines.length) {
      const accountIds = [...new Set(lines.map((l) => l._id.account.toHexString()))].map((x) => new Types.ObjectId(x));
      const accounts = new Map((await this.db.accounts.find({ _id: { $in: accountIds } }, { code: 1, name: 1 }).lean()).map((a) => [a._id.toHexString(), a]));
      for (const l of lines) {
        const s = stats.find((x) => x._id.equals(l._id.account));
        if (!s) continue;
        const z = (l.amount - s.mean) / s.sd;
        if (z < 3 || l.amount < s.mean * 3) continue;
        const a = accounts.get(l._id.account.toHexString());
        out.push({
          kind: 'unusual_amount',
          severity: z > 6 ? 'high' : 'medium',
          title: `Unusually large posting to ${a?.code} ${a?.name}`,
          detail: `${l._id.number}: ${l.amount.toLocaleString('en', { maximumFractionDigits: 2 })} is ${z.toFixed(1)} standard deviations above this account's usual manual postings (average ${s.mean.toLocaleString('en', { maximumFractionDigits: 0 })}).`,
          date: l.date,
          amount: new Decimal(l.amount.toFixed(2)),
          link: `/finance/journals/${l._id.journal.toHexString()}`,
        });
      }
    }

    // Weekend-dated and back-dated manual journals.
    const journals = await this.db.journals.find({ organisationId: org, entityId, status: 'POSTED', source: manual, journalDate: { $gte: from, $lte: to }, ...branchFilter }, { number: 1, journalDate: 1, postedAt: 1, totalDebit: 1, description: 1, type: 1 }).lean();
    for (const j of journals) {
      const dow = j.journalDate.getUTCDay();
      if (dow === 0 || dow === 6) {
        out.push({ kind: 'weekend', severity: 'low', title: `Journal dated on a ${dow === 0 ? 'Sunday' : 'Saturday'}`, detail: `${j.number} · ${j.description}`, date: j.journalDate, amount: dec(j.totalDebit), link: `/finance/journals/${j._id}` });
      }
      if (j.postedAt && j.type !== 'OPENING' && j.postedAt.getTime() - j.journalDate.getTime() > 45 * DAY) {
        out.push({
          kind: 'backdated',
          severity: 'medium',
          title: 'Back-dated journal',
          detail: `${j.number} was posted ${Math.round((j.postedAt.getTime() - j.journalDate.getTime()) / DAY)} days after its date · ${j.description}`,
          date: j.journalDate,
          amount: dec(j.totalDebit),
          link: `/finance/journals/${j._id}`,
        });
      }
    }

    // Possible duplicate supplier bills: same supplier and amount within 14 days.
    const bills = await this.db.invoices.find({ organisationId: org, entityId, kind: 'PURCHASE_BILL', status: 'POSTED', date: { $gte: new Date(from.getTime() - 14 * DAY), $lte: to }, ...branchFilter }, { number: 1, partyId: 1, partyName: 1, total: 1, date: 1, supplierInvoiceNumber: 1 }).sort({ date: 1 }).lean();
    for (let i = 0; i < bills.length; i++) {
      for (let k = i + 1; k < bills.length; k++) {
        const a = bills[i];
        const b = bills[k];
        if (b.date.getTime() - a.date.getTime() > 14 * DAY) break;
        if (!a.partyId.equals(b.partyId) || !dec(a.total).eq(dec(b.total)) || b.date < from) continue;
        out.push({
          kind: 'duplicate_bill',
          severity: 'high',
          title: `Possible duplicate bill from ${b.partyName}`,
          detail: `${a.number} (${a.supplierInvoiceNumber || 'no ref'}) and ${b.number} (${b.supplierInvoiceNumber || 'no ref'}) have the same amount within ${Math.round((b.date.getTime() - a.date.getTime()) / DAY)} days.`,
          date: b.date,
          amount: dec(b.total),
          link: `/finance/purchases/bills/${b._id}`,
        });
      }
    }

    // Supplier payments made soon after the supplier's bank details changed (a common fraud pattern).
    // Compared on when things happened (audit time, approval time), not on document dates.
    const changes = await this.db.auditEvents.find({ organisationId: org, action: 'supplier.update', createdAt: { $gte: new Date(from.getTime() - 60 * DAY) } }, { recordId: 1, before: 1, after: 1, createdAt: 1, userName: 1 }).lean();
    const bankChanges = changes.filter((c) => {
      const before = (c.before ?? {}) as Record<string, unknown>;
      const after = (c.after ?? {}) as Record<string, unknown>;
      return ['bankAccountNumber', 'bankName', 'bankAccountName'].some((k) => k in after && after[k] !== before[k]);
    });
    if (bankChanges.length) {
      const payments = await this.db.payments.find({ organisationId: org, entityId, kind: 'PAYMENT', status: 'POSTED', partyId: { $in: bankChanges.map((c) => c.recordId) }, date: { $gte: from, $lte: to } }, { number: 1, partyId: 1, partyName: 1, amount: 1, date: 1, approvedAt: 1 }).lean();
      for (const p of payments) {
        const paidAt = p.approvedAt ?? p.date;
        const change = bankChanges.filter((c) => c.recordId?.equals(p.partyId) && c.createdAt <= paidAt && paidAt.getTime() - c.createdAt.getTime() <= 60 * DAY).pop();
        if (!change) continue;
        out.push({
          kind: 'bank_change_payment',
          severity: 'high',
          title: `Payment to ${p.partyName} after a bank-details change`,
          detail: `${p.number} was approved ${Math.max(0, Math.round((paidAt.getTime() - change.createdAt.getTime()) / DAY))} day(s) after ${change.userName} changed the supplier's bank details. Confirm the change with the supplier independently.`,
          date: p.date,
          amount: dec(p.amount),
          link: `/finance/purchases/payments/${p._id}`,
        });
      }
    }

    // The same file attached to different invoices or bills usually means a duplicate invoice.
    const sharedFiles = await this.db.attachments.aggregate<{ _id: string; records: { id: Types.ObjectId; label: string }[]; name: string; at: Date }>([
      { $match: { organisationId: org, entityId, recordType: 'Invoice', deletedAt: null, status: { $ne: 'PENDING' }, createdAt: { $gte: from, $lte: new Date(to.getTime() + DAY) } } },
      { $group: { _id: '$sha256', records: { $addToSet: { id: '$recordId', label: '$recordLabel' } }, name: { $first: '$name' }, at: { $max: '$createdAt' } } },
      { $match: { 'records.1': { $exists: true } } },
    ]);
    for (const f of sharedFiles) {
      out.push({
        kind: 'duplicate_attachment',
        severity: 'high',
        title: 'The same document is attached to different invoices',
        detail: `${f.name} is attached to ${f.records.map((r) => r.label).join(' and ')}.`,
        date: f.at,
        amount: null,
        link: null,
      });
    }

    // Overdue approvals.
    const overdue = await this.db.approvalRequests.find({ organisationId: org, entityId, status: 'PENDING', dueAt: { $lt: new Date() } }, { documentType: 1, documentNumber: 1, documentId: 1, description: 1, dueAt: 1, amount: 1, escalatedAt: 1 }).lean();
    for (const r of overdue) {
      out.push({ kind: 'overdue_approval', severity: r.escalatedAt ? 'medium' : 'low', title: `Approval overdue: ${r.documentNumber}`, detail: `${r.description}${r.escalatedAt ? ' · escalated' : ''}`, date: r.dueAt ?? null, amount: r.amount ? dec(r.amount) : null, link: '/finance/approvals' });
    }

    // Approvals that overrode a control (credit limits, matching, budgets).
    const overrides = await this.db.auditEvents.find({ organisationId: org, action: { $in: ['document.approve', 'purchase_order.approve'] }, createdAt: { $gte: from, $lte: new Date(to.getTime() + DAY) }, summary: /exceptions|override|over budget/i }, { summary: 1, createdAt: 1, userName: 1, recordId: 1, recordType: 1 }).lean();
    for (const o of overrides) {
      out.push({ kind: 'control_override', severity: 'medium', title: 'Control overridden on approval', detail: `${o.userName}: ${o.summary}`, date: o.createdAt, amount: null, link: o.recordType === 'Invoice' && o.recordId ? `/finance/sales/invoices/${o.recordId}` : null });
    }

    // Expense claims approved with policy exceptions.
    const claims = await this.db.expenseClaims.find({ organisationId: org, entityId, status: { $in: ['APPROVED', 'PAID'] }, policyBreaches: { $gt: 0 }, approvedAt: { $gte: from, $lte: new Date(to.getTime() + DAY) }, ...branchFilter }, { number: 1, claimantName: 1, total: 1, approvedAt: 1, policyBreaches: 1 }).lean();
    for (const c of claims) {
      out.push({ kind: 'expense_policy', severity: 'low', title: `Expense claim approved with ${c.policyBreaches} policy exception(s)`, detail: `${c.number} · ${c.claimantName}`, date: c.approvedAt ?? null, amount: dec(c.total), link: '/finance/expenses' });
    }

    const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)).slice(0, 200);
  }
}
