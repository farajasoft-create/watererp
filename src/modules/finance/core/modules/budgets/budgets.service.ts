import { addDays, ledgerSums } from '../reports/ledger-sums';
import { ClientSession, Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { PERMISSIONS } from '../../common/permissions';
import { assertSegregation, transition } from '../../common/workflow';
import { Budget } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AccountClass, DEBIT_NORMAL, INCOME_STATEMENT_CLASSES } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

export interface BudgetInput {
  entityId: Types.ObjectId;
  fiscalYearId: Types.ObjectId;
  name: string;
  kind: 'BUDGET' | 'FORECAST';
  notes?: string;
  lines: { accountId: Types.ObjectId; branchId?: Types.ObjectId | null; departmentId?: Types.ObjectId | null; projectId?: Types.ObjectId | null; amounts: Decimal[] }[];
}

const IS = INCOME_STATEMENT_CLASSES as string[];

/**
 * Budgets and forecasts by account (optionally by branch, department or project) and period, with
 * budget-vs-actual reporting and spending control on purchases. One budget per entity and fiscal
 * year is approved at a time; approving a new version supersedes the previous one.
 */
export class BudgetsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly workflow: WorkflowService,
  ) {}

  private async build(user: AuthUser, input: BudgetInput, session?: ClientSession) {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(session ?? null).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const fy = await this.db.fiscalYears.findOne({ _id: input.fiscalYearId, organisationId: org, entityId: entity._id }).session(session ?? null).lean();
    if (!fy) throw new BadRequestException('Fiscal year not found for this entity');
    const periods = await this.db.periods.countDocuments({ organisationId: org, fiscalYearId: fy._id }).session(session ?? null);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const accounts = await this.db.accounts.find({ organisationId: org, _id: { $in: input.lines.map((l) => l.accountId) } }).session(session ?? null).lean();
    const seen = new Set<string>();
    const lines = input.lines.map((l, i) => {
      const a = accounts.find((x) => x._id.equals(l.accountId));
      if (!a?.isPostable) throw new BadRequestException(`Line ${i + 1}: choose a postable account`);
      const key = [l.accountId, l.branchId, l.departmentId, l.projectId].map(String).join('|');
      if (seen.has(key)) throw new BadRequestException(`Line ${i + 1}: ${a.code} is budgeted twice for the same dimensions`);
      seen.add(key);
      if (l.amounts.length !== periods) throw new BadRequestException(`Line ${i + 1}: enter ${periods} period amounts`);
      return {
        accountId: a._id,
        branchId: l.branchId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        amounts: l.amounts.map((v) => toD128(round(v, fp))),
      };
    });
    return {
      entity,
      fields: {
        entityId: entity._id,
        fiscalYearId: fy._id,
        name: input.name,
        kind: input.kind,
        currency: entity.functionalCurrency,
        notes: input.notes ?? '',
        lines,
        total: toD128(sum(lines.flatMap((l) => l.amounts))),
      },
    };
  }

  list(user: AuthUser, entityId?: Types.ObjectId) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (entityId) filter.entityId = entityId;
    return this.db.budgets.find(filter, { lines: 0 }).sort({ createdAt: -1 }).limit(100).lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const b = await this.db.budgets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!b) throw new NotFoundException('Budget not found');
    return withTrail(this.db, b);
  }

  async create(user: AuthUser, input: BudgetInput) {
    const { fields } = await this.build(user, input);
    const [b] = await this.db.budgets.create([{ ...fields, organisationId: user.organisationId, createdBy: user.id }]);
    await this.audit.log(user, { action: 'budget.create', recordType: 'Budget', recordId: b._id, summary: `Created ${input.kind.toLowerCase()} ${input.name}` });
    return b.toObject();
  }

  async update(user: AuthUser, id: Types.ObjectId, input: BudgetInput) {
    const before = await this.get(user, id);
    if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only draft or rejected budgets can be edited');
    const { fields } = await this.build(user, input);
    const after = await transition(this.db.budgets, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT' });
    await this.audit.log(user, { action: 'budget.update', recordType: 'Budget', recordId: id, summary: `Edited ${before.name} (total ${dec(before.total).toFixed()} → ${dec(after.total).toFixed()})` });
    return after;
  }

  /** Seeds budget lines from the previous fiscal year's actuals, uplifted by a percentage. */
  async fromActuals(user: AuthUser, q: { entityId: Types.ObjectId; fiscalYearId: Types.ObjectId; upliftPercent: Decimal }) {
    const fy = await this.db.fiscalYears.findOne({ _id: q.fiscalYearId, organisationId: user.organisationId, entityId: q.entityId }).lean();
    if (!fy) throw new NotFoundException('Fiscal year not found');
    const prevStart = new Date(Date.UTC(fy.startDate.getUTCFullYear() - 1, fy.startDate.getUTCMonth(), 1));
    const prevEnd = new Date(fy.startDate.getTime() - 86_400_000);
    const entity = (await this.db.entities.findById(q.entityId).lean())!;
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const rows = (await ledgerSums(this.db, { organisationId: user.organisationId, entityId: q.entityId, accountClass: { $in: IS } }, prevStart, addDays(prevEnd, 1), ['account', 'class', 'month'])).map((r) => ({
      _id: { account: r.account!, cls: r.cls as AccountClass, m: r.month!.getUTCMonth() + 1 },
      debit: r.debit,
      credit: r.credit,
    }));
    const factor = new Decimal(100).plus(q.upliftPercent).div(100);
    const byAccount = new Map<string, Decimal[]>();
    for (const r of rows) {
      const key = r._id.account.toHexString();
      const amounts = byAccount.get(key) ?? Array.from({ length: 12 }, () => new Decimal(0));
      const natural = DEBIT_NORMAL.has(r._id.cls) ? dec(r.debit as never).minus(dec(r.credit as never)) : dec(r.credit as never).minus(dec(r.debit as never));
      // Period index relative to the fiscal year start month.
      const idx = (r._id.m - 1 - fy.startDate.getUTCMonth() + 12) % 12;
      amounts[idx] = amounts[idx].plus(natural);
      byAccount.set(key, amounts);
    }
    return [...byAccount.entries()].map(([accountId, amounts]) => ({ accountId, amounts: amounts.map((a) => round(a.times(factor), fp)) }));
  }

  async act(user: AuthUser, id: Types.ObjectId, action: 'submit' | 'approve' | 'reject', reason?: string) {
    return this.db.transaction(async (session) => {
      const b = (await this.db.budgets.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as Budget | null;
      if (!b) throw new NotFoundException('Budget not found');
      const now = new Date();
      let after;
      if (action === 'submit') {
        after = await transition(this.db.budgets, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
        await this.workflow.open(user, subjectOf('BUDGET', after), session);
      } else if (action === 'reject') {
        after = await transition(this.db.budgets, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason ?? '' }, session);
        await this.workflow.close(user, 'BUDGET', id, 'REJECTED', reason ?? '', session);
      } else {
        if (b.status !== 'SUBMITTED') throw new BadRequestException('Only submitted budgets can be approved');
        assertSegregation(user, b, 'a budget');
        const gate = await this.workflow.gate(user, subjectOf('BUDGET', b), reason, session);
        if (!gate.final) return { ...b, approval: this.workflow.view(gate.request) };
        // One approved version per entity, year and kind: the new one supersedes the old.
        await this.db.budgets.updateMany({ organisationId: user.organisationId, entityId: b.entityId, fiscalYearId: b.fiscalYearId, kind: b.kind, status: 'APPROVED' }, { status: 'SUPERSEDED' }, { session });
        after = await transition(this.db.budgets, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now }, session);
      }
      await this.audit.log(user, { action: `budget.${action}`, recordType: 'Budget', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${b.kind.toLowerCase()} ${b.name}${reason ? `: ${reason}` : ''}` }, session);
      return after;
    });
  }

  private async approved(organisationId: Types.ObjectId, entityId: Types.ObjectId, date: Date, kind: 'BUDGET' | 'FORECAST', session?: ClientSession) {
    const fy = await this.db.fiscalYears.findOne({ organisationId, entityId, startDate: { $lte: date }, endDate: { $gte: date } }).session(session ?? null).lean();
    if (!fy) return null;
    const budget = await this.db.budgets.findOne({ organisationId, entityId, fiscalYearId: fy._id, kind, status: 'APPROVED' }).session(session ?? null).lean();
    return budget ? { budget, fy } : null;
  }

  /**
   * Budget (and optional forecast) vs actual by account for a range of periods, optionally filtered by
   * branch, department or project. Amounts are in each account's natural direction.
   */
  async vsActual(user: AuthUser, q: { entityId: Types.ObjectId; budgetId?: Types.ObjectId; from: Date; to: Date; branchId?: Types.ObjectId; departmentId?: Types.ObjectId; projectId?: Types.ObjectId }) {
    const entity = await this.db.entities.findOne({ _id: q.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const budget = q.budgetId
      ? await this.db.budgets.findOne({ _id: q.budgetId, organisationId: user.organisationId, entityId: q.entityId }).lean()
      : (await this.approved(user.organisationId, q.entityId, q.from, 'BUDGET'))?.budget ?? null;
    const forecast = (await this.approved(user.organisationId, q.entityId, q.from, 'FORECAST'))?.budget ?? null;
    const periods = budget ? await this.db.periods.find({ organisationId: user.organisationId, fiscalYearId: budget.fiscalYearId }).sort({ number: 1 }).lean() : [];
    const inRange = periods.map((p) => p.endDate >= q.from && p.startDate <= q.to);
    const matches = (l: Budget['lines'][number]) =>
      (!q.branchId || l.branchId?.equals(q.branchId)) && (!q.departmentId || l.departmentId?.equals(q.departmentId)) && (!q.projectId || l.projectId?.equals(q.projectId));
    const planned = (b: Pick<Budget, 'lines'> | null) => {
      const m = new Map<string, Decimal>();
      for (const l of b?.lines ?? []) {
        if (!matches(l)) continue;
        const v = sum(l.amounts.filter((_, i) => inRange[i]));
        m.set(l.accountId.toHexString(), (m.get(l.accountId.toHexString()) ?? new Decimal(0)).plus(v));
      }
      return m;
    };
    const budgetBy = planned(budget);
    const forecastBy = planned(forecast);
    // Original budget as first approved, when changes have since been applied (IPSAS 24: original vs final).
    const originalBy = budget?.original ? planned(budget.original as Pick<Budget, 'lines'>) : null;

    const match: Record<string, unknown> = { organisationId: user.organisationId, entityId: q.entityId, accountClass: { $in: IS } };
    if (q.branchId) match.branchId = q.branchId;
    if (q.departmentId) match.departmentId = q.departmentId;
    if (q.projectId) match.projectId = q.projectId;
    const restricted = allowedBranches(user);
    if (restricted) match.branchId = q.branchId ? q.branchId : { $in: restricted };
    const actual = (await ledgerSums(this.db, match, q.from, addDays(q.to, 1), ['account', 'class'])).map((r) => ({ _id: r.account!, cls: r.cls as AccountClass, debit: r.debit, credit: r.credit }));
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId }).lean();
    const keys = new Set([...budgetBy.keys(), ...forecastBy.keys(), ...(originalBy?.keys() ?? []), ...actual.map((a) => a._id.toHexString())]);
    const rows = [...keys]
      .map((key) => {
        const a = accounts.find((x) => x._id.toHexString() === key);
        if (!a || !IS.includes(a.accountClass)) return null;
        const act = actual.find((x) => x._id.toHexString() === key);
        const actualAmt = act ? (DEBIT_NORMAL.has(a.accountClass as AccountClass) ? dec(act.debit as never).minus(dec(act.credit as never)) : dec(act.credit as never).minus(dec(act.debit as never))) : new Decimal(0);
        const b = budgetBy.get(key) ?? new Decimal(0);
        const variance = actualAmt.minus(b);
        // Favourable when revenue beats budget or costs come in under it.
        const favourable = a.accountClass === 'REVENUE' ? variance.gte(0) : variance.lte(0);
        return {
          accountId: a._id,
          code: a.code,
          name: a.name,
          accountClass: a.accountClass,
          budget: b,
          originalBudget: originalBy ? (originalBy.get(key) ?? new Decimal(0)) : null,
          forecast: forecastBy.get(key) ?? null,
          actual: actualAmt,
          variance,
          variancePercent: b.isZero() ? null : variance.div(b).times(100).toDecimalPlaces(1),
          favourable,
        };
      })
      .filter((r): r is NonNullable<typeof r> => !!r && !(r.budget.isZero() && r.actual.isZero() && !r.forecast))
      .sort((x, y) => x.code.localeCompare(y.code));
    const total = (cls: string[], k: 'budget' | 'actual') => sum(rows.filter((r) => cls.includes(r.accountClass)).map((r) => r[k]));
    const np = (k: 'budget' | 'actual') => total(['REVENUE'], k).minus(total(['COST_OF_SALES', 'EXPENSE'], k));
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      from: q.from,
      to: q.to,
      budget: budget && { id: budget._id, name: budget.name, status: budget.status, revisions: budget.revisions ?? 0 },
      forecast: forecast && { id: forecast._id, name: forecast.name },
      rows,
      totals: { revenueBudget: total(['REVENUE'], 'budget'), revenueActual: total(['REVENUE'], 'actual'), netBudget: np('budget'), netActual: np('actual') },
    };
  }

  /**
   * Spending check for purchases: annual budget for each expense account against actual spend to date,
   * open purchase-order commitments and the new amount. Depending on the organisation setting, an
   * overrun is only reported (WARN) or blocks approval (BLOCK) unless the user may override budgets.
   */
  async check(user: AuthUser, p: { entityId: Types.ObjectId; date: Date; amounts: { accountId: Types.ObjectId; amount: Decimal }[]; excludeOrderId?: Types.ObjectId }, session?: ClientSession) {
    const org = await this.db.organisations.findById(user.organisationId).session(session ?? null).lean();
    const mode = org?.settings?.budgetControl ?? 'WARN';
    if (mode === 'OFF') return { mode, overruns: [] as { accountId: Types.ObjectId; code: string; budget: Decimal; spent: Decimal; committed: Decimal; requested: Decimal; available: Decimal }[] };
    const found = await this.approved(user.organisationId, p.entityId, p.date, 'BUDGET', session);
    if (!found) return { mode, overruns: [] };
    const { budget, fy } = found;
    const byAccount = new Map<string, Decimal>();
    for (const a of p.amounts) byAccount.set(a.accountId.toHexString(), (byAccount.get(a.accountId.toHexString()) ?? new Decimal(0)).plus(a.amount));
    const overruns = [];
    for (const [accountId, requested] of byAccount) {
      const account = await this.db.accounts.findById(accountId).session(session ?? null).lean();
      if (!account || !['EXPENSE', 'COST_OF_SALES'].includes(account.accountClass)) continue;
      const lines = budget.lines.filter((l) => l.accountId.toHexString() === accountId);
      if (!lines.length) continue;
      const annual = sum(lines.flatMap((l) => l.amounts));
      const { spent: spentAmt, committed } = await this.usage(user.organisationId, p.entityId, fy, new Types.ObjectId(accountId), { excludeOrderId: p.excludeOrderId }, session);
      const available = annual.minus(spentAmt).minus(committed);
      if (requested.gt(available)) {
        overruns.push({ accountId: account._id, code: account.code, budget: annual, spent: spentAmt, committed: round(committed, 2), requested, available: round(available, 2) });
      }
    }
    return { mode, overruns };
  }

  /**
   * Spending on an expense account in the fiscal year (debits less credits, to `asOf` when given) and
   * open purchase-order commitments not yet billed, optionally for one department.
   */
  async usage(
    organisationId: Types.ObjectId,
    entityId: Types.ObjectId,
    fy: { startDate: Date; endDate: Date },
    accountId: Types.ObjectId,
    opts: { departmentId?: Types.ObjectId | null; asOf?: Date; excludeOrderId?: Types.ObjectId },
    session?: ClientSession,
  ) {
    const end = opts.asOf && opts.asOf < fy.endDate ? opts.asOf : fy.endDate;
    const [spent] = await this.db.ledger
      .aggregate<{ debit: unknown; credit: unknown }>([
        { $match: { organisationId, entityId, accountId, date: { $gte: fy.startDate, $lte: end }, ...(opts.departmentId !== undefined && { departmentId: opts.departmentId }) } },
        { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ])
      .session(session ?? null);
    // Commitments: approved purchase orders not yet billed, at their estimated functional value.
    const orders = await this.db.purchaseOrders
      .find({ organisationId, entityId, status: { $in: ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'] }, 'lines.accountId': accountId, ...(opts.excludeOrderId && { _id: { $ne: opts.excludeOrderId } }) })
      .session(session ?? null)
      .lean();
    const committed = sum(
      orders.flatMap((o) =>
        o.lines
          .filter((l) => l.accountId.equals(accountId) && (opts.departmentId === undefined || String(l.departmentId ?? null) === String(opts.departmentId)))
          .map((l) => dec(l.unitPrice).times(dec(l.quantity).minus(dec(l.quantityBilled))).times(dec(o.exchangeRate))),
      ),
    );
    return { spent: spent ? dec(spent.debit as never).minus(dec(spent.credit as never)) : new Decimal(0), committed };
  }

  /** Throws when spending control is BLOCK and the user cannot override. Returns notes for the audit trail. */
  async enforce(user: AuthUser, p: Parameters<BudgetsService['check']>[1], session?: ClientSession): Promise<string[]> {
    const { mode, overruns } = await this.check(user, p, session);
    if (!overruns.length) return [];
    const notes = overruns.map((o) => `${o.code}: ${o.requested.toFixed()} requested, ${o.available.toFixed()} left of the ${o.budget.toFixed()} budget`);
    if (mode === 'BLOCK' && !hasPermission(user, PERMISSIONS.BUDGET_OVERRIDE)) {
      throw new ForbiddenException(`Over budget: ${notes.join('; ')}. Approval requires budget.override.`);
    }
    return notes;
  }

  /** Project profitability: contract value and cost budget against revenue and cost posted to each project. */
  async projects(user: AuthUser, entityId: Types.ObjectId, asOf: Date) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const projects = await this.db.dimensions.find({ organisationId: user.organisationId, type: 'PROJECT', $or: [{ entityId: null }, { entityId }] }).sort({ code: 1 }).lean();
    const match: Record<string, unknown> = { organisationId: user.organisationId, entityId, projectId: { $in: projects.map((p) => p._id) }, date: { $lte: asOf }, accountClass: { $in: IS } };
    const restricted = allowedBranches(user);
    if (restricted) match.branchId = { $in: restricted };
    const rows = await this.db.ledger.aggregate<{ _id: { project: Types.ObjectId; cls: string }; debit: unknown; credit: unknown }>([
      { $match: match },
      { $group: { _id: { project: '$projectId', cls: '$accountClass' }, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
    const customers = await this.db.customers.find({ _id: { $in: projects.map((p) => p.project?.customerId).filter(Boolean) } }, { name: 1 }).lean();
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      asOf,
      rows: projects.map((p) => {
        const of = (cls: string[]) => rows.filter((r) => r._id.project.equals(p._id) && cls.includes(r._id.cls));
        const revenue = sum(of(['REVENUE']).map((r) => dec(r.credit as never).minus(dec(r.debit as never))));
        const cost = sum(of(['COST_OF_SALES', 'EXPENSE']).map((r) => dec(r.debit as never).minus(dec(r.credit as never))));
        const budgetCost = p.project?.budgetCost ? dec(p.project.budgetCost) : null;
        const contract = p.project?.contractValue ? dec(p.project.contractValue) : null;
        return {
          projectId: p._id,
          code: p.code,
          name: p.name,
          status: p.project?.status ?? 'ACTIVE',
          customerId: p.project?.customerId ?? null,
          customer: customers.find((c) => c._id.equals(p.project?.customerId ?? undefined))?.name ?? null,
          startDate: p.project?.startDate ?? null,
          endDate: p.project?.endDate ?? null,
          contractValue: contract,
          budgetCost,
          revenue,
          cost,
          margin: revenue.minus(cost),
          marginPercent: revenue.isZero() ? null : revenue.minus(cost).div(revenue).times(100).toDecimalPlaces(1),
          budgetUsedPercent: budgetCost && !budgetCost.isZero() ? cost.div(budgetCost).times(100).toDecimalPlaces(1) : null,
          billedPercent: contract && !contract.isZero() ? revenue.div(contract).times(100).toDecimalPlaces(1) : null,
        };
      }),
    };
  }
}
