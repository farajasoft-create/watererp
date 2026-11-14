import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException } from '../../common/errors';
import { Decimal, dec, sum } from '../../common/money';
import { PERMISSIONS as P } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { BankingService } from '../banking/banking.service';
import { BudgetsService } from '../budgets/budgets.service';
import { FxReportsService } from '../fx/fx-reports.service';
import { InventoryService } from '../inventory/inventory.service';
import { ReportsService } from './reports.service';
import { SubledgerReportsService } from './subledger-reports.service';

const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1));
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0));
const fmt = (d: Decimal) => d.toDecimalPlaces(0).toNumber().toLocaleString('en');
const pct = (part: Decimal, whole: Decimal) => (whole.isZero() ? null : part.div(whole).times(100).toDecimalPlaces(1).toNumber());

/** Runs one section; a section the user cannot see, or that has no data, is left out rather than failing the pack. */
async function section<T>(allowed: boolean, fn: () => Promise<T>): Promise<T | null> {
  if (!allowed) return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * The monthly management reporting pack: executive summary with commentary, group of financial
 * statements, budget, working capital, cash, FX, inventory, capital expenditure, projects and the key
 * exceptions — assembled from the same services as the individual reports.
 */
export class PackService {
  constructor(
    private readonly db: Db,
    private readonly reports: ReportsService,
    private readonly subledgers: SubledgerReportsService,
    private readonly analytics: AnalyticsService,
    private readonly budgets: BudgetsService,
    private readonly banking: BankingService,
    private readonly fxReports: FxReportsService,
    private readonly inventory: InventoryService,
  ) {}

  async build(user: AuthUser, entityId: Types.ObjectId, month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('Month must be YYYY-MM');
    const [y, m] = month.split('-').map(Number);
    const from = monthStart(y, m);
    const to = monthEnd(y, m);
    const prevFrom = monthStart(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
    const prevTo = monthEnd(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const fy = await this.db.fiscalYears.findOne({ organisationId: user.organisationId, entityId, startDate: { $lte: to }, endDate: { $gte: to } }).lean();
    const ytdFrom = fy?.startDate ?? monthStart(y, 1);
    const f = { entityId };
    const can = (p: string) => hasPermission(user, p as never);

    const [executive, plMonth, plPrev, plYtd, balanceSheet, cashFlow, bva, ar, ap, banks, fx, stock, exceptions, projects, capex] = await Promise.all([
      section(can(P.ANALYTICS_VIEW), () => this.analytics.executive(user, entityId, to)),
      section(can(P.REPORTS_VIEW), () => this.reports.profitAndLoss(user, f, from, to, true)),
      section(can(P.REPORTS_VIEW), () => this.reports.profitAndLoss(user, f, prevFrom, prevTo, false)),
      section(can(P.REPORTS_VIEW), () => this.reports.profitAndLoss(user, f, ytdFrom, to, false)),
      section(can(P.REPORTS_VIEW), () => this.reports.balanceSheet(user, f, to)),
      section(can(P.REPORTS_VIEW), () => this.analytics.cashFlow(user, entityId, ytdFrom, to)),
      section(can(P.BUDGETS_VIEW), () => this.budgets.vsActual(user, { entityId, from: ytdFrom, to })),
      section(can(P.AR_VIEW), () => this.subledgers.aging(user, 'CUSTOMER', entityId, to)),
      section(can(P.AP_VIEW), () => this.subledgers.aging(user, 'SUPPLIER', entityId, to)),
      section(can(P.BANKING_VIEW), () => this.banking.list(user, entityId)),
      section(can(P.REPORTS_VIEW), () => this.fxReports.exposure(user, entityId, to)),
      section(can(P.INVENTORY_VIEW), () => this.inventory.onHand(user, entityId)),
      section(can(P.ANALYTICS_VIEW), () => this.analytics.exceptions(user, entityId, from, to)),
      section(can(P.REPORTS_VIEW), () => this.budgets.projects(user, entityId, to)),
      section(can(P.ASSETS_VIEW), () => this.db.fixedAssets.find({ organisationId: user.organisationId, entityId, acquisitionDate: { $gte: ytdFrom, $lte: to } }, { number: 1, name: 1, acquisitionDate: 1, cost: 1, branchId: 1 }).sort({ acquisitionDate: 1 }).lean()),
    ]);

    // ----- Commentary, written from the numbers ----------------------------------------------------
    const commentary: string[] = [];
    const cur = entity.functionalCurrency;
    if (plMonth && plPrev) {
      const rev = plMonth.totals.revenue;
      const change = pct(rev.minus(plPrev.totals.revenue), plPrev.totals.revenue.abs());
      commentary.push(
        `Revenue for the month was ${cur} ${fmt(rev)}${change !== null ? `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% on the previous month` : ''}. ` +
          `Gross margin was ${pct(plMonth.totals.grossProfit, rev) ?? '—'}% and the month ${plMonth.totals.netProfit.isNeg() ? `made a loss of ${cur} ${fmt(plMonth.totals.netProfit.abs())}` : `made a profit of ${cur} ${fmt(plMonth.totals.netProfit)}`}.`,
      );
      if (plMonth.columns.length > 1) {
        const ranked = plMonth.columns.map((c) => ({ c, rev: plMonth.sections[0].totals[c.id] ?? new Decimal(0), net: plMonth.netProfit[c.id] ?? new Decimal(0) })).sort((a, b) => b.rev.cmp(a.rev));
        const losing = ranked.filter((r) => r.net.isNeg());
        commentary.push(`${ranked[0].c.name} contributed the most revenue (${cur} ${fmt(ranked[0].rev)}).${losing.length ? ` ${losing.map((l) => l.c.name).join(', ')} made a loss this month.` : ''}`);
      }
    }
    if (plYtd && bva?.budget) {
      const revBudget = dec(bva.totals.revenueBudget);
      const netBudget = dec(bva.totals.netBudget);
      commentary.push(
        `Year to date revenue is ${pct(plYtd.totals.revenue, revBudget) ?? '—'}% of budget and net profit ${cur} ${fmt(plYtd.totals.netProfit)} against ${cur} ${fmt(netBudget)} budgeted.`,
      );
      const over = bva.rows.filter((r) => r.accountClass !== 'REVENUE' && dec(r.budget).gt(0) && dec(r.actual).gt(dec(r.budget))).sort((a, b) => dec(b.actual).minus(dec(b.budget)).cmp(dec(a.actual).minus(dec(a.budget))));
      if (over.length) commentary.push(`Costs over budget: ${over.slice(0, 3).map((r) => `${r.name} (+${cur} ${fmt(dec(r.actual).minus(dec(r.budget)))})`).join(', ')}.`);
    }
    if (executive) {
      const k = executive.kpis;
      commentary.push(
        `Cash and bank stood at ${cur} ${fmt(k.cash.balance)}; the 13-week forecast low is ${cur} ${fmt(k.cash.forecastLow)}.` +
          (k.receivables.dso !== null ? ` Customers take ${k.receivables.dso} days to pay on average` : '') +
          (k.payables.dpo !== null ? ` and suppliers are paid in ${k.payables.dpo} days.` : '.'),
      );
    }
    if (ar) {
      const overdue = sum(Object.entries(ar.totals).filter(([b]) => !['current', 'credits', 'total'].includes(b)).map(([, v]) => v as Decimal));
      if (overdue.gt(0)) commentary.push(`${cur} ${fmt(overdue)} of receivables (${pct(overdue, ar.totals.total) ?? '—'}%) is overdue.`);
    }
    if (exceptions?.length) {
      const high = exceptions.filter((e) => e.severity === 'high');
      commentary.push(`${exceptions.length} exception${exceptions.length === 1 ? '' : 's'} flagged this month${high.length ? `, ${high.length} high priority: ${high.slice(0, 2).map((e) => e.title).join('; ')}` : ''}.`);
    }

    const branches = await this.db.branches.find({ organisationId: user.organisationId, entityId }, { code: 1, name: 1 }).lean();
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name, legalName: entity.legalName },
      currency: cur,
      month,
      from,
      to,
      ytdFrom,
      preparedBy: user.name,
      preparedAt: new Date(),
      commentary,
      kpis: executive?.kpis ?? null,
      trend: executive?.trend ?? null,
      profitAndLoss: plMonth,
      profitAndLossYtd: plYtd ? { totals: plYtd.totals, sections: plYtd.sections } : null,
      balanceSheet,
      cashFlow,
      budget: bva?.budget ? { name: bva.budget.name, rows: bva.rows, totals: bva.totals } : null,
      receivables: ar ? { totals: ar.totals, top: [...ar.rows].sort((a, b) => b.totalFunctional.cmp(a.totalFunctional)).slice(0, 8).map((r) => ({ name: r.partyName, total: r.totalFunctional, buckets: r.bucketsFunctional })) } : null,
      payables: ap ? { totals: ap.totals, top: [...ap.rows].sort((a, b) => b.totalFunctional.cmp(a.totalFunctional)).slice(0, 8).map((r) => ({ name: r.partyName, total: r.totalFunctional, buckets: r.bucketsFunctional })) } : null,
      cash: banks
        ? banks.map((b) => ({ name: b.name, currency: b.currency, balance: b.balance, glAccountCode: b.glAccountCode, unmatchedStatementLines: b.unmatchedStatementLines, reconciledTo: (b as { lastReconciledDate?: Date | null }).lastReconciledDate ?? null }))
        : null,
      fx: fx ? { rows: fx.rows.map((r) => ({ currency: r.currency, rate: r.rate, net: r.net, atRate: r.atRate, unrealised: r.unrealised, sensitivity10: r.sensitivity10 })), totals: fx.totals } : null,
      inventory: stock ? { total: stock.total, difference: stock.difference, items: stock.rows.length, belowReorder: stock.rows.filter((r) => r.belowReorder).map((r) => r.code), top: [...stock.rows].sort((a, b) => dec(b.value).cmp(dec(a.value))).slice(0, 8).map((r) => ({ code: r.code, name: r.name, quantity: r.quantity, value: r.value })) } : null,
      capex: capex ? capex.map((a) => ({ number: a.number, name: a.name, date: a.acquisitionDate, cost: dec(a.cost), branch: branches.find((b) => b._id.equals(a.branchId))?.code ?? '' })) : null,
      projects: projects?.rows ?? null,
      exceptions: exceptions ? exceptions.slice(0, 20) : null,
    };
  }
}
