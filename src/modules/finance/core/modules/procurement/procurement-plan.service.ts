import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { assertSegregation, transition } from '../../common/workflow';
import { PROCUREMENT_CATEGORIES, PROCUREMENT_METHODS, ProcurementPlan } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';

type Id = Types.ObjectId;

export interface PlanItemInput {
  id?: Id | null;
  description: string;
  category: (typeof PROCUREMENT_CATEGORIES)[number];
  method: (typeof PROCUREMENT_METHODS)[number];
  departmentId?: Id | null;
  accountId: Id;
  quantity: Decimal;
  unit?: string;
  estimatedCost: Decimal;
  quarter: number;
  sourceOfFunds?: string;
  agpo?: boolean;
}

export interface PlanInput {
  entityId: Id;
  fiscalYearId: Id;
  title: string;
  notes?: string;
  items: PlanItemInput[];
}

const LIVE_REQUISITIONS = ['SUBMITTED', 'APPROVED', 'ORDERED'];
const LIVE_ORDERS = ['SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

/** The approved plan of the entity for the fiscal year containing `date`. */
async function approvedPlanOn(db: Db, organisationId: Id, entityId: Id, date: Date, session?: ClientSession) {
  const fy = await db.fiscalYears.findOne({ organisationId, entityId, startDate: { $lte: date }, endDate: { $gte: date } }).session(session ?? null).lean();
  if (!fy) return null;
  return db.procurementPlans.findOne({ organisationId, entityId, fiscalYearId: fy._id, status: 'APPROVED' }).session(session ?? null).lean();
}

/**
 * Checks requisition lines against the approved annual procurement plan: a line that names a plan item
 * must match its account and department and stay within what is left of it; when the organisation
 * requires it, every line must name one. Fills the account and department from the item when blank.
 */
export async function checkRequisitionAgainstPlan(
  db: Db,
  user: AuthUser,
  q: { entityId: Id; date: Date; requisitionId?: Id | null; lines: { lineNo: number; accountId: Id | null; departmentId: Id | null; planItemId?: Id | null; quantity: unknown; estimatedUnitPrice: unknown }[] },
  session?: ClientSession,
) {
  const org = await db.organisations.findById(user.organisationId, { settings: 1 }).session(session ?? null).lean();
  const required = !!org?.settings?.requireProcurementPlan;
  if (!required && !q.lines.some((l) => l.planItemId)) return;
  const plan = await approvedPlanOn(db, user.organisationId, q.entityId, q.date, session);
  if (!plan) throw new BadRequestException('There is no approved procurement plan for this year; requisitions must draw on one');
  const used = new Map<string, Decimal>();
  for (const l of q.lines) {
    if (!l.planItemId) {
      if (required) throw new BadRequestException(`Line ${l.lineNo}: choose the procurement plan item this request is for`);
      continue;
    }
    const item = plan.items.find((i) => i._id.equals(l.planItemId!));
    if (!item) throw new BadRequestException(`Line ${l.lineNo}: that item is not in the approved procurement plan`);
    if (l.accountId && !l.accountId.equals(item.accountId)) throw new BadRequestException(`Line ${l.lineNo}: plan item ${item.itemNo} is budgeted on a different account`);
    if (l.departmentId && item.departmentId && !l.departmentId.equals(item.departmentId)) throw new BadRequestException(`Line ${l.lineNo}: plan item ${item.itemNo} belongs to another department`);
    l.accountId = item.accountId;
    l.departmentId = l.departmentId ?? item.departmentId ?? null;
    const k = item._id.toHexString();
    used.set(k, (used.get(k) ?? new Decimal(0)).plus(dec(l.quantity as never).times(dec(l.estimatedUnitPrice as never))));
  }
  for (const [k, amount] of used) {
    const item = plan.items.find((i) => i._id.toHexString() === k)!;
    const others = await db.requisitions
      .find({ organisationId: user.organisationId, status: { $in: LIVE_REQUISITIONS }, 'lines.planItemId': item._id, ...(q.requisitionId && { _id: { $ne: q.requisitionId } }) }, { lines: 1 })
      .session(session ?? null)
      .lean();
    const before = sum(others.flatMap((r) => r.lines.filter((l) => l.planItemId?.equals(item._id)).map((l) => dec(l.quantity).times(dec(l.estimatedUnitPrice)))));
    const left = dec(item.estimatedCost).minus(before);
    if (amount.gt(left)) throw new BadRequestException(`Plan item ${item.itemNo} (${item.description}) has ${left.toFixed(2)} left of ${dec(item.estimatedCost).toFixed(2)}; this request needs ${amount.toFixed(2)}`);
  }
}

/**
 * Annual procurement plan: what each department will buy in the year, by category, method and
 * quarter, checked against the approved budget before approval. Requisitions draw on its items, and
 * the execution report compares plan, requisitions and orders.
 */
export class ProcurementPlanService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
  ) {}

  list(user: AuthUser, q: { entityId: Id; fiscalYearId?: Id }) {
    return this.db.procurementPlans.find({ organisationId: user.organisationId, entityId: q.entityId, ...(q.fiscalYearId && { fiscalYearId: q.fiscalYearId }) }, { items: 0 }).sort({ createdAt: -1 }).limit(100).lean();
  }

  async get(user: AuthUser, id: Id) {
    const plan = await this.db.procurementPlans.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!plan) throw new NotFoundException('Procurement plan not found');
    return { ...(await withTrail(this.db, plan)), budgetCheck: await this.budgetCheck(plan) };
  }

  private async build(user: AuthUser, input: PlanInput, keepIds: boolean) {
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const fy = await this.db.fiscalYears.findOne({ _id: input.fiscalYearId, organisationId: user.organisationId, entityId: entity._id }).lean();
    if (!fy) throw new BadRequestException('Fiscal year not found for this entity');
    if (!input.items.length) throw new BadRequestException('Add the items to be procured');
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, _id: { $in: input.items.map((i) => i.accountId) } }).lean();
    const items = input.items.map((i, n) => {
      const a = accounts.find((x) => x._id.equals(i.accountId));
      if (!a?.isPostable || !['EXPENSE', 'COST_OF_SALES', 'ASSET'].includes(a.accountClass)) throw new BadRequestException(`Item ${n + 1}: choose a postable expense or asset account`);
      if (!i.quantity.gt(0)) throw new BadRequestException(`Item ${n + 1}: quantity must be positive`);
      if (!i.estimatedCost.gt(0)) throw new BadRequestException(`Item ${n + 1}: enter the estimated cost`);
      if (i.quarter < 1 || i.quarter > 4) throw new BadRequestException(`Item ${n + 1}: the quarter is 1 to 4`);
      return {
        _id: keepIds && i.id ? i.id : new Types.ObjectId(),
        itemNo: n + 1,
        description: i.description,
        category: i.category,
        method: i.method,
        departmentId: i.departmentId ?? null,
        accountId: a._id,
        quantity: toD128(i.quantity),
        unit: i.unit ?? '',
        estimatedCost: toD128(round(i.estimatedCost, fp)),
        quarter: i.quarter,
        sourceOfFunds: i.sourceOfFunds ?? '',
        agpo: !!i.agpo,
      };
    });
    return { entity, fy, fields: { entityId: entity._id, fiscalYearId: fy._id, title: input.title, notes: input.notes ?? '', items, total: toD128(sum(items.map((i) => dec(i.estimatedCost)))) } };
  }

  async save(user: AuthUser, id: Id | null, input: PlanInput) {
    if (!id) {
      const { entity, fields } = await this.build(user, input, false);
      const number = await this.db.nextNumber(user.organisationId, entity, 'APP');
      const [doc] = await this.db.procurementPlans.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }]);
      await this.audit.log(user, { action: 'procurementPlan.create', recordType: 'ProcurementPlan', recordId: doc._id, summary: `Prepared procurement plan ${number} (${dec(fields.total).toFixed()})` });
      return doc.toObject();
    }
    const before = await this.get(user, id);
    if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only draft or returned plans can be edited');
    if (!before.fiscalYearId.equals(input.fiscalYearId)) throw new BadRequestException('The fiscal year of a plan cannot change');
    // A revision keeps the ids of the items it carries over, so requisitions stay linked to them.
    const { fields } = await this.build(user, input, !!before.revisionOf);
    const after = await transition(this.db.procurementPlans, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT' });
    await this.audit.log(user, { action: 'procurementPlan.update', recordType: 'ProcurementPlan', recordId: id, summary: `Edited ${before.number}` });
    return after;
  }

  /** Starts a revision of the approved plan as a new draft version with the same items. */
  async revise(user: AuthUser, id: Id) {
    const plan = await this.get(user, id);
    if (plan.status !== 'APPROVED') throw new BadRequestException('Only the approved plan can be revised');
    if (await this.db.procurementPlans.exists({ organisationId: user.organisationId, revisionOf: plan._id, status: { $in: ['DRAFT', 'SUBMITTED', 'REJECTED'] } })) throw new BadRequestException('A revision of this plan is already in progress');
    const entity = (await this.db.entities.findById(plan.entityId).lean())!;
    const number = await this.db.nextNumber(user.organisationId, entity, 'APP');
    const [doc] = await this.db.procurementPlans.create([
      { organisationId: user.organisationId, entityId: plan.entityId, fiscalYearId: plan.fiscalYearId, number, title: plan.title, notes: plan.notes, version: (plan.version ?? 1) + 1, revisionOf: plan._id, items: plan.items, total: plan.total, createdBy: user.id },
    ]);
    await this.audit.log(user, { action: 'procurementPlan.revise', recordType: 'ProcurementPlan', recordId: doc._id, summary: `Started revision ${number} of ${plan.number}` });
    return doc.toObject();
  }

  /**
   * Planned cost by account and department against the approved budget for the year: a department's
   * plan cannot exceed its budget lines on that account (items with no department are checked against
   * the account's whole budget).
   */
  private async budgetCheck(plan: Pick<ProcurementPlan, 'organisationId' | 'entityId' | 'fiscalYearId' | 'items'>) {
    const budget = await this.db.budgets.findOne({ organisationId: plan.organisationId, entityId: plan.entityId, fiscalYearId: plan.fiscalYearId, kind: 'BUDGET', status: 'APPROVED' }).lean();
    const groups = new Map<string, { accountId: Id; departmentId: Id | null; planned: Decimal }>();
    for (const i of plan.items) {
      const k = `${i.accountId}|${i.departmentId ?? null}`;
      const g = groups.get(k) ?? { accountId: i.accountId, departmentId: i.departmentId ?? null, planned: new Decimal(0) };
      g.planned = g.planned.plus(dec(i.estimatedCost));
      groups.set(k, g);
    }
    const accounts = await this.db.accounts.find({ _id: { $in: [...groups.values()].map((g) => g.accountId) } }, { code: 1, name: 1, accountClass: 1 }).lean();
    const rows = [...groups.values()].map((g) => {
      const account = accounts.find((a) => a._id.equals(g.accountId));
      // Capital items (asset accounts) are not in the income-statement budget; they are reported, not limited.
      const capital = account?.accountClass === 'ASSET';
      const lines = (budget?.lines ?? []).filter((l) => l.accountId.equals(g.accountId) && (!g.departmentId || l.departmentId?.equals(g.departmentId)));
      const budgeted = sum(lines.flatMap((l) => l.amounts.map((a) => dec(a))));
      return { accountId: g.accountId, code: account?.code ?? '', name: account?.name ?? '', departmentId: g.departmentId, planned: g.planned, budget: capital ? null : budgeted, over: !capital && g.planned.gt(budgeted) };
    });
    return { budgetId: budget?._id ?? null, budgetName: budget?.name ?? null, rows, ok: !!budget && !rows.some((r) => r.over) };
  }

  async act(user: AuthUser, id: Id, action: 'submit' | 'approve' | 'reject', reason?: string) {
    return this.db.transaction(async (session) => {
      const plan = (await this.db.procurementPlans.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as ProcurementPlan | null;
      if (!plan) throw new NotFoundException('Procurement plan not found');
      const now = new Date();
      let after;
      if (action === 'submit' || action === 'approve') {
        const check = await this.budgetCheck(plan);
        if (!check.budgetId) throw new BadRequestException('Approve the budget for the year before the procurement plan');
        const over = check.rows.filter((r) => r.over);
        if (over.length) throw new BadRequestException(`The plan exceeds the approved budget: ${over.map((r) => `${r.code} planned ${r.planned.toFixed(2)} against ${r.budget!.toFixed(2)}`).join('; ')}`);
      }
      if (action === 'submit') {
        after = await transition(this.db.procurementPlans, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
      } else if (action === 'reject') {
        if (!reason?.trim()) throw new BadRequestException('Give the reason');
        after = await transition(this.db.procurementPlans, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason }, session);
      } else {
        if (plan.status !== 'SUBMITTED') throw new BadRequestException('Only submitted plans can be approved');
        assertSegregation(user, plan, 'a procurement plan');
        await this.db.procurementPlans.updateMany({ organisationId: user.organisationId, entityId: plan.entityId, fiscalYearId: plan.fiscalYearId, status: 'APPROVED' }, { status: 'SUPERSEDED' }, { session });
        after = await transition(this.db.procurementPlans, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now }, session);
      }
      await this.audit.log(user, { action: `procurementPlan.${action}`, recordType: 'ProcurementPlan', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${plan.number}${reason ? `: ${reason}` : ''}` }, session);
      return after;
    });
  }

  /** Items of the approved plan for requisition forms, with what is left on each. */
  async items(user: AuthUser, q: { entityId: Id; date: Date }) {
    const plan = await approvedPlanOn(this.db, user.organisationId, q.entityId, q.date);
    if (!plan) return { plan: null, items: [] };
    const exec = await this.execution(user, plan._id);
    return { plan: { id: plan._id, number: plan.number, title: plan.title }, items: exec.rows.map((r) => ({ id: r.id, itemNo: r.itemNo, description: r.description, accountId: r.accountId, departmentId: r.departmentId, estimatedCost: r.planned, left: r.left })) };
  }

  /** Plan execution: for each item, what has been requisitioned and ordered against it, and when. */
  async execution(user: AuthUser, id: Id) {
    const plan = await this.db.procurementPlans.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!plan) throw new NotFoundException('Procurement plan not found');
    const fy = (await this.db.fiscalYears.findById(plan.fiscalYearId).lean())!;
    const ids = plan.items.map((i) => i._id);
    const [reqs, orders] = await Promise.all([
      this.db.requisitions.find({ organisationId: user.organisationId, status: { $in: LIVE_REQUISITIONS }, 'lines.planItemId': { $in: ids } }, { number: 1, lines: 1 }).lean(),
      this.db.purchaseOrders.find({ organisationId: user.organisationId, status: { $in: LIVE_ORDERS }, 'lines.planItemId': { $in: ids } }, { number: 1, lines: 1, exchangeRate: 1 }).lean(),
    ]);
    const now = new Date();
    const quarterEnd = (q: number) => new Date(Date.UTC(fy.startDate.getUTCFullYear(), fy.startDate.getUTCMonth() + q * 3, 0));
    const rows = plan.items.map((i) => {
      const reqLines = reqs.flatMap((r) => r.lines.filter((l) => l.planItemId?.equals(i._id)).map((l) => ({ number: r.number, amount: dec(l.quantity).times(dec(l.estimatedUnitPrice)) })));
      const poLines = orders.flatMap((o) => o.lines.filter((l) => l.planItemId?.equals(i._id)).map((l) => ({ number: o.number, amount: dec(l.netAmount).times(dec(o.exchangeRate)) })));
      const planned = dec(i.estimatedCost);
      const requisitioned = sum(reqLines.map((x) => x.amount));
      const ordered = round(sum(poLines.map((x) => x.amount)), 2);
      const status = !requisitioned.isZero() || !ordered.isZero() ? (ordered.gte(planned) ? 'COMPLETE' : 'IN_PROGRESS') : now > quarterEnd(i.quarter) ? 'BEHIND' : 'NOT_STARTED';
      return {
        id: i._id,
        itemNo: i.itemNo,
        description: i.description,
        category: i.category,
        method: i.method,
        quarter: i.quarter,
        accountId: i.accountId,
        departmentId: i.departmentId ?? null,
        agpo: i.agpo,
        planned,
        requisitioned,
        ordered,
        left: planned.minus(requisitioned),
        requisitions: [...new Set(reqLines.map((x) => x.number))],
        orders: [...new Set(poLines.map((x) => x.number))],
        status,
      };
    });
    const total = (k: 'planned' | 'requisitioned' | 'ordered') => sum(rows.map((r) => r[k]));
    const agpo = sum(rows.filter((r) => r.agpo).map((r) => r.planned));
    return {
      plan: { id: plan._id, number: plan.number, title: plan.title, status: plan.status, version: plan.version },
      rows,
      totals: { planned: total('planned'), requisitioned: total('requisitioned'), ordered: total('ordered'), agpo, agpoPercent: total('planned').isZero() ? null : agpo.div(total('planned')).times(100).toDecimalPlaces(1) },
    };
  }
}
