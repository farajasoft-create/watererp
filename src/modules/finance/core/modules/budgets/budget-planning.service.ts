import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { PERMISSIONS } from '../../common/permissions';
import { assertSegregation, transition } from '../../common/workflow';
import { Budget, BudgetReallocation, BudgetSubmission } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { INCOME_STATEMENT_CLASSES } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';
import { BudgetsService } from './budgets.service';

const IS = INCOME_STATEMENT_CLASSES as string[];
const SPEND = ['EXPENSE', 'COST_OF_SALES'];

type Id = Types.ObjectId;
type LineKey = { accountId: Id; branchId?: Id | null; departmentId?: Id | null; projectId?: Id | null };
const keyOf = (l: LineKey) => [l.accountId, l.branchId ?? null, l.departmentId ?? null, l.projectId ?? null].map(String).join('|');

export interface SubmissionInput {
  entityId: Id;
  fiscalYearId: Id;
  departmentId: Id;
  title: string;
  objectives?: string;
  workplan: { activity: string; output?: string; indicator?: string; target?: string; quarters?: number[]; cost: Decimal }[];
  lines: { accountId: Id; branchId?: Id | null; projectId?: Id | null; amounts: Decimal[] }[];
}

export interface ChangeInput {
  budgetId: Id;
  date: Date;
  kind: 'REALLOCATION' | 'SUPPLEMENTARY' | 'REDUCTION';
  reason: string;
  lines: { accountId: Id; branchId?: Id | null; departmentId?: Id | null; projectId?: Id | null; period: number; change: Decimal }[];
}

/**
 * Budget preparation and in-year control: departments submit budgets backed by workplans, finance
 * consolidates the approved submissions into the entity budget, approved budgets change only through
 * reallocation, supplementary or reduction documents, and department heads see (and are told about)
 * what is left on their lines.
 */
export class BudgetPlanningService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly workflow: WorkflowService,
    private readonly budgets: BudgetsService,
  ) {}

  // ----- Shared ---------------------------------------------------------------------------------

  private async context(organisationId: Id, entityId: Id, fiscalYearId: Id, session?: ClientSession) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId }).session(session ?? null).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const fy = await this.db.fiscalYears.findOne({ _id: fiscalYearId, organisationId, entityId }).session(session ?? null).lean();
    if (!fy) throw new BadRequestException('Fiscal year not found for this entity');
    const periods = await this.db.periods.find({ organisationId, fiscalYearId }).sort({ number: 1 }).session(session ?? null).lean();
    const fp = await this.currencies.precision(entity.functionalCurrency);
    return { entity, fy, periods, fp };
  }

  private async department(organisationId: Id, id: Id) {
    const d = await this.db.dimensions.findOne({ _id: id, organisationId, type: 'DEPARTMENT' }).lean();
    if (!d) throw new BadRequestException('Department not found');
    return d;
  }

  // ----- Departmental submissions ----------------------------------------------------------------

  listSubmissions(user: AuthUser, q: { entityId: Id; fiscalYearId?: Id; departmentId?: Id }) {
    return this.db.budgetSubmissions
      .find({ organisationId: user.organisationId, entityId: q.entityId, ...(q.fiscalYearId && { fiscalYearId: q.fiscalYearId }), ...(q.departmentId && { departmentId: q.departmentId }) }, { lines: 0, workplan: 0 })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
  }

  async getSubmission(user: AuthUser, id: Id) {
    const s = await this.db.budgetSubmissions.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!s) throw new NotFoundException('Budget submission not found');
    return withTrail(this.db, s);
  }

  private async buildSubmission(user: AuthUser, input: SubmissionInput) {
    const { entity, fy, periods, fp } = await this.context(user.organisationId, input.entityId, input.fiscalYearId);
    const dept = await this.department(user.organisationId, input.departmentId);
    if (dept.entityId && !dept.entityId.equals(entity._id)) throw new BadRequestException(`${dept.name} belongs to another entity`);
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, _id: { $in: input.lines.map((l) => l.accountId) } }).lean();
    const seen = new Set<string>();
    const lines = input.lines.map((l, i) => {
      const a = accounts.find((x) => x._id.equals(l.accountId));
      if (!a?.isPostable || !IS.includes(a.accountClass)) throw new BadRequestException(`Line ${i + 1}: choose a postable income or expense account`);
      const line = { accountId: a._id, branchId: l.branchId ?? null, departmentId: dept._id, projectId: l.projectId ?? null };
      if (seen.has(keyOf(line))) throw new BadRequestException(`Line ${i + 1}: ${a.code} appears twice`);
      seen.add(keyOf(line));
      if (l.amounts.length !== periods.length) throw new BadRequestException(`Line ${i + 1}: enter ${periods.length} period amounts`);
      if (l.amounts.some((v) => v.lt(0))) throw new BadRequestException(`Line ${i + 1}: amounts cannot be negative`);
      return { ...line, amounts: l.amounts.map((v) => toD128(round(v, fp))) };
    });
    const workplan = input.workplan.map((w, i) => {
      if (w.cost.lt(0)) throw new BadRequestException(`Activity ${i + 1}: cost cannot be negative`);
      const quarters = [...new Set(w.quarters ?? [])].sort();
      if (quarters.some((q) => q < 1 || q > 4)) throw new BadRequestException(`Activity ${i + 1}: quarters are 1 to 4`);
      return { activity: w.activity, output: w.output ?? '', indicator: w.indicator ?? '', target: w.target ?? '', quarters, cost: toD128(round(w.cost, fp)) };
    });
    return {
      entity,
      fy,
      dept,
      fields: {
        entityId: entity._id,
        fiscalYearId: fy._id,
        departmentId: dept._id,
        title: input.title,
        objectives: input.objectives ?? '',
        workplan,
        lines,
        total: toD128(sum(lines.flatMap((l) => l.amounts.map((a) => dec(a))))),
      },
    };
  }

  async saveSubmission(user: AuthUser, id: Id | null, input: SubmissionInput) {
    const { entity, dept, fields } = await this.buildSubmission(user, input);
    if (!id) {
      const number = await this.db.nextNumber(user.organisationId, entity, 'BSUB');
      const [doc] = await this.db.budgetSubmissions.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }]);
      await this.audit.log(user, { action: 'budgetSubmission.create', recordType: 'BudgetSubmission', recordId: doc._id, summary: `Prepared ${dept.name} budget ${number} (${dec(fields.total).toFixed()})` });
      return doc.toObject();
    }
    const before = await this.getSubmission(user, id);
    if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only draft or returned submissions can be edited');
    const after = await transition(this.db.budgetSubmissions, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT' });
    await this.audit.log(user, { action: 'budgetSubmission.update', recordType: 'BudgetSubmission', recordId: id, summary: `Edited ${before.number} (total ${dec(before.total).toFixed()} → ${dec(after.total).toFixed()})` });
    return after;
  }

  /**
   * A department's starting point: its lines in the current approved budget for the year if there is
   * one, otherwise in the approved budget of the previous year (the departmental template).
   */
  async template(user: AuthUser, q: { entityId: Id; fiscalYearId: Id; departmentId: Id }) {
    const { fy, periods } = await this.context(user.organisationId, q.entityId, q.fiscalYearId);
    await this.department(user.organisationId, q.departmentId);
    let budget = await this.db.budgets.findOne({ organisationId: user.organisationId, entityId: q.entityId, fiscalYearId: fy._id, kind: 'BUDGET', status: 'APPROVED' }).lean();
    let source = 'this year’s approved budget';
    if (!budget) {
      const prev = await this.db.fiscalYears.findOne({ organisationId: user.organisationId, entityId: q.entityId, endDate: { $lt: fy.startDate } }).sort({ endDate: -1 }).lean();
      budget = prev ? await this.db.budgets.findOne({ organisationId: user.organisationId, entityId: q.entityId, fiscalYearId: prev._id, kind: 'BUDGET', status: { $in: ['APPROVED', 'SUPERSEDED'] } }).sort({ status: 1, approvedAt: -1 }).lean() : null;
      source = prev ? `the ${prev.name} budget` : '';
    }
    const lines = (budget?.lines ?? [])
      .filter((l) => l.departmentId?.equals(q.departmentId))
      .map((l) => {
        const amounts = periods.map((_, i) => (l.amounts[i] ? dec(l.amounts[i]) : new Decimal(0)));
        return { accountId: l.accountId, branchId: l.branchId, projectId: l.projectId, amounts };
      });
    return { source: lines.length ? source : '', lines };
  }

  async actSubmission(user: AuthUser, id: Id, action: 'submit' | 'approve' | 'reject', reason?: string) {
    return this.db.transaction(async (session) => {
      const s = (await this.db.budgetSubmissions.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as BudgetSubmission | null;
      if (!s) throw new NotFoundException('Budget submission not found');
      const now = new Date();
      let after;
      if (action === 'submit') {
        if (!s.workplan.length) throw new BadRequestException('Add the workplan activities this budget pays for before submitting');
        if (!s.lines.length) throw new BadRequestException('Add at least one budget line');
        const planned = sum(s.workplan.map((w) => dec(w.cost)));
        if (!planned.eq(dec(s.total))) throw new BadRequestException(`The workplan costs ${planned.toFixed()} but the budget lines total ${dec(s.total).toFixed()}; they must agree`);
        after = await transition(this.db.budgetSubmissions, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
        await this.workflow.open(user, subjectOf('BUDGET_SUBMISSION', after), session);
      } else if (action === 'reject') {
        if (!reason?.trim()) throw new BadRequestException('Say what the department should change');
        after = await transition(this.db.budgetSubmissions, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason }, session);
        await this.workflow.close(user, 'BUDGET_SUBMISSION', id, 'REJECTED', reason, session);
      } else {
        if (s.status !== 'SUBMITTED') throw new BadRequestException('Only submitted budgets can be approved');
        assertSegregation(user, s, 'a department budget');
        const gate = await this.workflow.gate(user, subjectOf('BUDGET_SUBMISSION', s), reason, session);
        if (!gate.final) return { ...s, approval: this.workflow.view(gate.request) };
        after = await transition(this.db.budgetSubmissions, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now }, session);
      }
      await this.audit.log(user, { action: `budgetSubmission.${action}`, recordType: 'BudgetSubmission', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${s.number} ${s.title}${reason ? `: ${reason}` : ''}` }, session);
      return after;
    });
  }

  /** Where each department stands for the year: its latest submission and total. */
  async consolidation(user: AuthUser, q: { entityId: Id; fiscalYearId: Id }) {
    const { entity } = await this.context(user.organisationId, q.entityId, q.fiscalYearId);
    const [departments, submissions] = await Promise.all([
      this.db.dimensions.find({ organisationId: user.organisationId, type: 'DEPARTMENT', isActive: true, $or: [{ entityId: null }, { entityId: entity._id }] }).sort({ code: 1 }).lean(),
      this.db.budgetSubmissions.find({ organisationId: user.organisationId, entityId: entity._id, fiscalYearId: q.fiscalYearId }, { lines: 0 }).sort({ createdAt: -1 }).lean(),
    ]);
    const rows = departments.map((d) => {
      const mine = submissions.filter((s) => s.departmentId.equals(d._id));
      const latest = mine[0] ?? null;
      return {
        departmentId: d._id,
        code: d.code,
        name: d.name,
        submissions: mine.length,
        latest: latest && { id: latest._id, number: latest.number, title: latest.title, status: latest.status, total: latest.total, budgetId: latest.budgetId },
        approvedTotal: sum(mine.filter((s) => s.status === 'APPROVED').map((s) => dec(s.total))),
      };
    });
    return {
      currency: entity.functionalCurrency,
      rows,
      readyToConsolidate: submissions.filter((s) => s.status === 'APPROVED').length,
      approvedTotal: sum(submissions.filter((s) => s.status === 'APPROVED').map((s) => dec(s.total))),
    };
  }

  /**
   * Merges approved department submissions into a draft entity budget (the consolidated budget), which
   * then goes through the normal budget approval. Each submission is consolidated once.
   */
  async consolidate(user: AuthUser, q: { entityId: Id; fiscalYearId: Id; name: string; submissionIds?: Id[]; notes?: string }) {
    const filter = { organisationId: user.organisationId, entityId: q.entityId, fiscalYearId: q.fiscalYearId, status: 'APPROVED', ...(q.submissionIds?.length && { _id: { $in: q.submissionIds } }) };
    const subs = await this.db.budgetSubmissions.find(filter).lean();
    if (!subs.length) throw new BadRequestException('No approved department budgets to consolidate');
    if (q.submissionIds?.length && subs.length !== q.submissionIds.length) throw new BadRequestException('Only approved submissions can be consolidated');
    const merged = new Map<string, { accountId: Id; branchId: Id | null; departmentId: Id | null; projectId: Id | null; amounts: Decimal[] }>();
    for (const s of subs) {
      for (const l of s.lines) {
        const k = keyOf(l);
        const current = merged.get(k);
        const amounts = l.amounts.map((a) => dec(a));
        if (current) current.amounts = current.amounts.map((a, i) => a.plus(amounts[i] ?? 0));
        else merged.set(k, { accountId: l.accountId, branchId: l.branchId ?? null, departmentId: l.departmentId ?? null, projectId: l.projectId ?? null, amounts });
      }
    }
    const notes = q.notes ?? `Consolidated from ${subs.map((s) => s.number).join(', ')}`;
    const budget = await this.budgets.create(user, { entityId: q.entityId, fiscalYearId: q.fiscalYearId, name: q.name, kind: 'BUDGET', notes, lines: [...merged.values()] });
    const res = await this.db.budgetSubmissions.updateMany({ _id: { $in: subs.map((s) => s._id) }, status: 'APPROVED' }, { $set: { status: 'CONSOLIDATED', budgetId: budget._id, consolidatedAt: new Date() } });
    if (res.modifiedCount !== subs.length) {
      // Someone consolidated part of the set at the same moment: undo our draft rather than double count.
      await this.db.budgetSubmissions.updateMany({ budgetId: budget._id }, { $set: { status: 'APPROVED', budgetId: null, consolidatedAt: null } });
      await this.db.budgets.deleteOne({ _id: budget._id, status: 'DRAFT' });
      throw new BadRequestException('Some of these submissions were consolidated by someone else; reload and try again');
    }
    await this.audit.log(user, { action: 'budget.consolidate', recordType: 'Budget', recordId: budget._id, summary: `Consolidated ${subs.length} department budgets into ${q.name} (${dec(budget.total).toFixed()})` });
    return budget;
  }

  // ----- Reallocations, supplementary budgets and reductions -------------------------------------

  listChanges(user: AuthUser, q: { entityId: Id; budgetId?: Id }) {
    return this.db.budgetReallocations
      .find({ organisationId: user.organisationId, entityId: q.entityId, ...(q.budgetId && { budgetId: q.budgetId }) })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
  }

  async getChange(user: AuthUser, id: Id) {
    const c = await this.db.budgetReallocations.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!c) throw new NotFoundException('Budget change not found');
    return withTrail(this.db, c);
  }

  private async buildChange(user: AuthUser, input: ChangeInput) {
    const budget = await this.db.budgets.findOne({ _id: input.budgetId, organisationId: user.organisationId }).lean();
    if (!budget) throw new BadRequestException('Budget not found');
    if (budget.status !== 'APPROVED') throw new BadRequestException('Only the approved budget can be changed');
    const { entity, fy, periods, fp } = await this.context(user.organisationId, budget.entityId, budget.fiscalYearId);
    if (input.date < fy.startDate || input.date > fy.endDate) throw new BadRequestException('The change must be dated within the budget year');
    if (!input.lines.length) throw new BadRequestException('Add the lines to change');
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, _id: { $in: input.lines.map((l) => l.accountId) } }).lean();
    const lines = input.lines.map((l, i) => {
      const a = accounts.find((x) => x._id.equals(l.accountId));
      if (!a?.isPostable || !IS.includes(a.accountClass)) throw new BadRequestException(`Line ${i + 1}: choose a postable income or expense account`);
      if (l.period < 0 || l.period >= periods.length) throw new BadRequestException(`Line ${i + 1}: choose a period of the budget year`);
      const change = round(l.change, fp);
      if (change.isZero()) throw new BadRequestException(`Line ${i + 1}: enter an amount`);
      if (input.kind === 'SUPPLEMENTARY' && change.lt(0)) throw new BadRequestException(`Line ${i + 1}: a supplementary budget only adds`);
      if (input.kind === 'REDUCTION' && change.gt(0)) throw new BadRequestException(`Line ${i + 1}: a reduction only takes away`);
      return { accountId: a._id, branchId: l.branchId ?? null, departmentId: l.departmentId ?? null, projectId: l.projectId ?? null, period: l.period, change: toD128(change) };
    });
    const increase = sum(lines.map((l) => dec(l.change)).filter((c) => c.gt(0)));
    const decrease = sum(lines.map((l) => dec(l.change)).filter((c) => c.lt(0))).neg();
    if (input.kind === 'REALLOCATION') {
      if (increase.isZero() || decrease.isZero()) throw new BadRequestException('A reallocation moves money from at least one line to another');
      if (!increase.eq(decrease)) throw new BadRequestException(`A reallocation must net to zero: ${decrease.toFixed()} taken, ${increase.toFixed()} given`);
    }
    return { entity, budget, fields: { entityId: entity._id, budgetId: budget._id, date: input.date, kind: input.kind, reason: input.reason, lines, increase: toD128(increase), decrease: toD128(decrease) } };
  }

  async saveChange(user: AuthUser, id: Id | null, input: ChangeInput) {
    const { entity, budget, fields } = await this.buildChange(user, input);
    if (!id) {
      const number = await this.db.nextNumber(user.organisationId, entity, 'BCH');
      const [doc] = await this.db.budgetReallocations.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }]);
      await this.audit.log(user, { action: 'budgetChange.create', recordType: 'BudgetReallocation', recordId: doc._id, summary: `Prepared ${input.kind.toLowerCase()} ${number} on ${budget.name}` });
      return doc.toObject();
    }
    const before = await this.getChange(user, id);
    if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only draft or returned changes can be edited');
    const after = await transition(this.db.budgetReallocations, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT' });
    await this.audit.log(user, { action: 'budgetChange.update', recordType: 'BudgetReallocation', recordId: id, summary: `Edited ${before.number}` });
    return after;
  }

  async actChange(user: AuthUser, id: Id, action: 'submit' | 'approve' | 'reject' | 'cancel', reason?: string) {
    return this.db.transaction(async (session) => {
      const c = (await this.db.budgetReallocations.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as BudgetReallocation | null;
      if (!c) throw new NotFoundException('Budget change not found');
      const now = new Date();
      let after;
      if (action === 'submit') {
        after = await transition(this.db.budgetReallocations, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
        await this.workflow.open(user, subjectOf('BUDGET_REALLOCATION', after), session);
      } else if (action === 'reject') {
        if (!reason?.trim()) throw new BadRequestException('Give the reason');
        after = await transition(this.db.budgetReallocations, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason }, session);
        await this.workflow.close(user, 'BUDGET_REALLOCATION', id, 'REJECTED', reason, session);
      } else if (action === 'cancel') {
        if (c.status === 'SUBMITTED') await this.workflow.close(user, 'BUDGET_REALLOCATION', id, 'CANCELLED', reason ?? '', session);
        after = await transition(this.db.budgetReallocations, id, ['DRAFT', 'REJECTED', 'SUBMITTED'], { status: 'CANCELLED' }, session);
      } else {
        if (c.status !== 'SUBMITTED') throw new BadRequestException('Only submitted changes can be approved');
        assertSegregation(user, c, 'a budget change');
        const gate = await this.workflow.gate(user, subjectOf('BUDGET_REALLOCATION', c), reason, session);
        if (!gate.final) return { ...c, approval: this.workflow.view(gate.request) };
        await this.apply(user, c, session);
        after = await transition(this.db.budgetReallocations, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now }, session);
      }
      await this.audit.log(user, { action: `budgetChange.${action}`, recordType: 'BudgetReallocation', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${c.number}: ${c.reason}${reason ? ` (${reason})` : ''}` }, session);
      return after;
    });
  }

  /** Applies an approved change to the budget's lines, keeping the original approved lines the first time. */
  private async apply(user: AuthUser, c: BudgetReallocation, session: ClientSession) {
    const budget = (await this.db.budgets.findOne({ _id: c.budgetId, organisationId: user.organisationId }).session(session).lean()) as Budget | null;
    if (!budget || budget.status !== 'APPROVED') throw new BadRequestException('The budget is no longer the approved version; prepare the change on the current one');
    const fy = (await this.db.fiscalYears.findById(budget.fiscalYearId).session(session).lean())!;
    const periods = await this.db.periods.countDocuments({ organisationId: user.organisationId, fiscalYearId: fy._id }).session(session);
    const lines = budget.lines.map((l) => ({ accountId: l.accountId, branchId: l.branchId ?? null, departmentId: l.departmentId ?? null, projectId: l.projectId ?? null, amounts: l.amounts.map((a) => dec(a)) }));
    const accounts = await this.db.accounts.find({ _id: { $in: c.lines.map((l) => l.accountId) } }).session(session).lean();
    for (const ch of c.lines) {
      const change = dec(ch.change);
      let line = lines.find((l) => keyOf(l) === keyOf(ch));
      if (!line) {
        if (change.lt(0)) throw new BadRequestException(`${accounts.find((a) => a._id.equals(ch.accountId))?.code}: there is no such budget line to take from`);
        line = { accountId: ch.accountId, branchId: ch.branchId ?? null, departmentId: ch.departmentId ?? null, projectId: ch.projectId ?? null, amounts: Array.from({ length: periods }, () => new Decimal(0)) };
        lines.push(line);
      }
      line.amounts[ch.period] = line.amounts[ch.period].plus(change);
      if (line.amounts[ch.period].lt(0)) {
        throw new BadRequestException(`${accounts.find((a) => a._id.equals(ch.accountId))?.code}: only ${line.amounts[ch.period].minus(change).toFixed()} is budgeted in that period`);
      }
    }
    // Money already spent or committed cannot be moved away: check every line that loses budget.
    const losing = new Map<string, { accountId: Id; departmentId: Id | null; net: Decimal }>();
    for (const ch of c.lines) {
      const k = `${ch.accountId}|${ch.departmentId ?? null}`;
      const cur = losing.get(k) ?? { accountId: ch.accountId, departmentId: ch.departmentId ?? null, net: new Decimal(0) };
      cur.net = cur.net.plus(dec(ch.change));
      losing.set(k, cur);
    }
    for (const g of losing.values()) {
      const account = accounts.find((a) => a._id.equals(g.accountId))!;
      if (!g.net.lt(0) || !SPEND.includes(account.accountClass)) continue;
      const remaining = sum(lines.filter((l) => l.accountId.equals(g.accountId) && String(l.departmentId) === String(g.departmentId)).flatMap((l) => l.amounts));
      const { spent, committed } = await this.budgets.usage(user.organisationId, budget.entityId, fy, g.accountId, { departmentId: g.departmentId }, session);
      if (remaining.lt(spent.plus(committed))) {
        throw new BadRequestException(`${account.code}: ${spent.plus(committed).toFixed(2)} is already spent or committed, more than the ${remaining.toFixed(2)} that would be left`);
      }
    }
    const original = budget.original ?? { lines: budget.lines, total: budget.total };
    const total = sum(lines.flatMap((l) => l.amounts));
    await this.db.budgets.updateOne(
      { _id: budget._id, status: 'APPROVED' },
      { $set: { lines: lines.map((l) => ({ ...l, amounts: l.amounts.map((a) => toD128(a)) })), total: toD128(total), original }, $inc: { revisions: 1 } },
      { session },
    );
    const heads = await this.db.dimensions.find({ _id: { $in: c.lines.map((l) => l.departmentId).filter(Boolean) as Id[] }, headUserId: { $ne: null } }, { headUserId: 1 }).session(session).lean();
    await this.workflow.notify(
      user.organisationId,
      heads.map((h) => h.headUserId!),
      { kind: 'budget-change', title: `Budget change ${c.number} approved`, body: c.reason, link: `/finance/budgets/planning?tab=changes&change=${c._id}` },
      session,
    );
  }

  // ----- Balances and notices ----------------------------------------------------------------------

  /**
   * What is left on each department's expense lines of the approved budget: annual and to-date budget,
   * spending to date, open commitments and the balance available.
   */
  async balances(user: AuthUser, q: { entityId: Id; asOf: Date; departmentId?: Id }) {
    const entity = await this.db.entities.findOne({ _id: q.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const fy = await this.db.fiscalYears.findOne({ organisationId: user.organisationId, entityId: entity._id, startDate: { $lte: q.asOf }, endDate: { $gte: q.asOf } }).lean();
    const budget = fy ? await this.db.budgets.findOne({ organisationId: user.organisationId, entityId: entity._id, fiscalYearId: fy._id, kind: 'BUDGET', status: 'APPROVED' }).lean() : null;
    const empty = { entity: { id: entity._id, code: entity.code, name: entity.name }, currency: entity.functionalCurrency, asOf: q.asOf, budget: null, rows: [], departments: [] };
    if (!fy || !budget) return empty;
    const periods = await this.db.periods.find({ organisationId: user.organisationId, fiscalYearId: fy._id }).sort({ number: 1 }).lean();
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, _id: { $in: budget.lines.map((l) => l.accountId) } }).lean();
    const groups = new Map<string, { accountId: Id; departmentId: Id | null; annual: Decimal; toDate: Decimal }>();
    for (const l of budget.lines) {
      const account = accounts.find((a) => a._id.equals(l.accountId));
      if (!account || !SPEND.includes(account.accountClass)) continue;
      if (q.departmentId && !l.departmentId?.equals(q.departmentId)) continue;
      const k = `${l.accountId}|${l.departmentId ?? null}`;
      const g = groups.get(k) ?? { accountId: l.accountId, departmentId: l.departmentId ?? null, annual: new Decimal(0), toDate: new Decimal(0) };
      g.annual = g.annual.plus(sum(l.amounts.map((a) => dec(a))));
      g.toDate = g.toDate.plus(sum(l.amounts.filter((_, i) => periods[i] && periods[i].startDate <= q.asOf).map((a) => dec(a))));
      groups.set(k, g);
    }
    const departments = await this.db.dimensions.find({ organisationId: user.organisationId, _id: { $in: [...groups.values()].map((g) => g.departmentId).filter(Boolean) as Id[] } }).lean();
    const rows = [];
    for (const g of groups.values()) {
      const account = accounts.find((a) => a._id.equals(g.accountId))!;
      const dept = departments.find((d) => g.departmentId && d._id.equals(g.departmentId));
      const { spent, committed } = await this.budgets.usage(user.organisationId, entity._id, fy, g.accountId, { departmentId: g.departmentId, asOf: q.asOf });
      const used = spent.plus(committed);
      rows.push({
        departmentId: g.departmentId,
        department: dept ? `${dept.code} · ${dept.name}` : 'No department',
        headUserId: dept?.headUserId ?? null,
        accountId: account._id,
        code: account.code,
        name: account.name,
        annual: g.annual,
        toDate: g.toDate,
        spent,
        committed: round(committed, 2),
        available: round(g.annual.minus(used), 2),
        usedPercent: g.annual.isZero() ? null : used.div(g.annual).times(100).toDecimalPlaces(1),
      });
    }
    rows.sort((a, b) => a.department.localeCompare(b.department) || a.code.localeCompare(b.code));
    const byDept = new Map<string, { departmentId: Id | null; department: string; annual: Decimal; spent: Decimal; committed: Decimal; available: Decimal }>();
    for (const r of rows) {
      const k = String(r.departmentId);
      const d = byDept.get(k) ?? { departmentId: r.departmentId, department: r.department, annual: new Decimal(0), spent: new Decimal(0), committed: new Decimal(0), available: new Decimal(0) };
      d.annual = d.annual.plus(r.annual);
      d.spent = d.spent.plus(r.spent);
      d.committed = d.committed.plus(r.committed);
      d.available = d.available.plus(r.available);
      byDept.set(k, d);
    }
    return {
      ...empty,
      budget: { id: budget._id, name: budget.name, revisions: budget.revisions ?? 0 },
      rows,
      departments: [...byDept.values()].map((d) => ({ ...d, usedPercent: d.annual.isZero() ? null : d.spent.plus(d.committed).div(d.annual).times(100).toDecimalPlaces(1) })),
    };
  }

  /**
   * Scheduled: tells department heads (or, without a head, budget managers) when spending and
   * commitments on a line reach the organisation's alert level, and again when the line is used up.
   * Each notice goes once per line, level and fiscal year.
   */
  async notifyBalances(now = new Date()) {
    let sent = 0;
    const orgs = await this.db.organisations.find({ 'settings.budgetAlertPercent': { $ne: null } }, { settings: 1 }).lean();
    for (const org of orgs) {
      const threshold = org.settings?.budgetAlertPercent;
      if (threshold === null || threshold === undefined) continue;
      const system = { id: new Types.ObjectId(), organisationId: org._id, name: 'system', email: '', permissions: [], allBranches: true, branchIds: [], approvalLimit: null, ip: null, userAgent: null } as AuthUser;
      const managerRoles = await this.db.roles.find({ organisationId: org._id, permissions: PERMISSIONS.BUDGETS_MANAGE }, { _id: 1 }).lean();
      const managers = (await this.db.users.find({ organisationId: org._id, isActive: true, roleIds: { $in: managerRoles.map((r) => r._id) } }, { _id: 1 }).lean()).map((u) => u._id);
      const entities = await this.db.entities.find({ organisationId: org._id }, { _id: 1 }).lean();
      for (const e of entities) {
        const fy = await this.db.fiscalYears.findOne({ organisationId: org._id, entityId: e._id, startDate: { $lte: now }, endDate: { $gte: now } }).lean();
        if (!fy) continue;
        const report = await this.balances(system, { entityId: e._id, asOf: now });
        for (const r of report.rows) {
          if (r.usedPercent === null || r.usedPercent.lt(threshold)) continue;
          const level = r.usedPercent.gte(100) ? 'fully used' : `${threshold}% used`;
          const title = `Budget ${level}: ${r.department}, ${r.code} ${r.name}`;
          if (await this.db.notifications.exists({ organisationId: org._id, kind: 'budget-balance', title, createdAt: { $gte: fy.startDate } })) continue;
          const to = r.headUserId ? [r.headUserId] : managers;
          if (!to.length) continue;
          const body = `Budget ${r.annual.toFixed(2)}, spent ${r.spent.toFixed(2)}, committed ${r.committed.toFixed(2)}, available ${r.available.toFixed(2)} (${r.usedPercent.toFixed(1)}% used).`;
          await this.workflow.notify(org._id, to, { kind: 'budget-balance', title, body, link: '/finance/budgets/planning?tab=balances' });
          sent++;
        }
      }
    }
    return { sent };
  }
}
