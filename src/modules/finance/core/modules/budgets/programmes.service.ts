import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum } from '../../common/money';
import { Programme } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';

type Id = Types.ObjectId;
const SPEND = ['EXPENSE', 'COST_OF_SALES'];

export interface ProgrammeInput {
  code: string;
  name: string;
  entityId?: Id | null;
  parentId?: Id | null;
  objective?: string;
  outcome?: string;
  departmentIds?: Id[];
  projectIds?: Id[];
  kpis?: { id?: Id | null; indicator: string; unit?: string; baseline?: string; target?: string }[];
  isActive?: boolean;
}

/**
 * Programme-based budgeting: programmes and sub-programmes, each delivered by departments and projects.
 * Budget and spending reach a programme through those delivery units (a project's lines go to the
 * project's programme, the rest by department), and each programme reports on its KPIs by quarter.
 */
export class ProgrammesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.db.programmes.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean();
  }

  private async load(user: AuthUser, id: Id) {
    const p = await this.db.programmes.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Programme not found');
    return p;
  }

  async save(user: AuthUser, id: Id | null, input: ProgrammeInput) {
    const before = id ? await this.load(user, id) : null;
    const code = input.code.trim().toUpperCase();
    if (await this.db.programmes.exists({ organisationId: user.organisationId, code, ...(id && { _id: { $ne: id } }) })) throw new BadRequestException(`Programme code ${code} is already used`);
    if (input.parentId) {
      const parent = await this.load(user, input.parentId);
      if (parent.parentId) throw new BadRequestException('Sub-programmes sit under a programme, not under another sub-programme');
      if (id && parent._id.equals(id)) throw new BadRequestException('A programme cannot be its own parent');
      if (id && (await this.db.programmes.exists({ organisationId: user.organisationId, parentId: id }))) throw new BadRequestException('This programme has sub-programmes, so it cannot become one');
    }
    const departmentIds = [...new Map((input.departmentIds ?? []).map((d) => [d.toHexString(), d])).values()];
    const projectIds = [...new Map((input.projectIds ?? []).map((d) => [d.toHexString(), d])).values()];
    const dims = await this.db.dimensions.find({ organisationId: user.organisationId, _id: { $in: [...departmentIds, ...projectIds] } }, { type: 1, name: 1 }).lean();
    for (const d of departmentIds) if (dims.find((x) => x._id.equals(d))?.type !== 'DEPARTMENT') throw new BadRequestException('Choose departments from the department list');
    for (const p of projectIds) if (dims.find((x) => x._id.equals(p))?.type !== 'PROJECT') throw new BadRequestException('Choose projects from the project list');
    // Each delivery unit belongs to one programme, so spending is never counted twice.
    const clash = await this.db.programmes
      .findOne({ organisationId: user.organisationId, isActive: true, ...(id && { _id: { $ne: id } }), $or: [{ departmentIds: { $in: departmentIds } }, { projectIds: { $in: projectIds } }] })
      .lean();
    if (clash) {
      const taken = [...clash.departmentIds, ...clash.projectIds].find((x) => [...departmentIds, ...projectIds].some((y) => y.equals(x)));
      throw new BadRequestException(`${dims.find((d) => taken && d._id.equals(taken))?.name ?? 'A delivery unit'} already belongs to ${clash.code} ${clash.name}`);
    }
    const kpis = (input.kpis ?? []).map((k) => {
      const existing = before?.kpis.find((x) => k.id && x._id.equals(k.id));
      return { _id: existing?._id ?? new Types.ObjectId(), indicator: k.indicator, unit: k.unit ?? '', baseline: k.baseline ?? '', target: k.target ?? '', actuals: existing?.actuals ?? [] };
    });
    const fields = { code, name: input.name, entityId: input.entityId ?? null, parentId: input.parentId ?? null, objective: input.objective ?? '', outcome: input.outcome ?? '', departmentIds, projectIds, kpis, isActive: input.isActive ?? true };
    if (!id) {
      const [doc] = await this.db.programmes.create([{ ...fields, organisationId: user.organisationId, createdBy: user.id }]);
      await this.audit.log(user, { action: 'programme.create', recordType: 'Programme', recordId: doc._id, summary: `Created ${input.parentId ? 'sub-programme' : 'programme'} ${code} ${input.name}` });
      return doc.toObject();
    }
    const after = await this.db.programmes.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean();
    await this.audit.log(user, { action: 'programme.update', recordType: 'Programme', recordId: id, summary: `Updated programme ${code}`, before, after });
    return after;
  }

  /** Records a KPI's achievement for a quarter of a fiscal year (replacing an earlier figure). */
  async reportKpi(user: AuthUser, id: Id, kpiId: Id, input: { fiscalYearId: Id; quarter: number; value: string; note?: string }) {
    const p = await this.load(user, id);
    const kpi = p.kpis.find((k) => k._id.equals(kpiId));
    if (!kpi) throw new NotFoundException('Indicator not found');
    if (input.quarter < 1 || input.quarter > 4) throw new BadRequestException('The quarter is 1 to 4');
    if (!(await this.db.fiscalYears.exists({ _id: input.fiscalYearId, organisationId: user.organisationId }))) throw new BadRequestException('Fiscal year not found');
    const actuals = [...kpi.actuals.filter((a) => !(a.fiscalYearId.equals(input.fiscalYearId) && a.quarter === input.quarter)), { fiscalYearId: input.fiscalYearId, quarter: input.quarter, value: input.value, note: input.note ?? '' }];
    await this.db.programmes.updateOne({ _id: p._id, 'kpis._id': kpiId }, { $set: { 'kpis.$.actuals': actuals } });
    await this.audit.log(user, { action: 'programme.kpi', recordType: 'Programme', recordId: p._id, summary: `${p.code}: ${kpi.indicator} Q${input.quarter} = ${input.value}` });
    return this.load(user, id);
  }

  /**
   * Programme budget report for a fiscal year: approved budget and actual spending by programme and
   * sub-programme, absorption, and KPI targets against what was achieved.
   */
  async report(user: AuthUser, q: { entityId: Id; fiscalYearId: Id }) {
    const entity = await this.db.entities.findOne({ _id: q.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const fy = await this.db.fiscalYears.findOne({ _id: q.fiscalYearId, organisationId: user.organisationId, entityId: entity._id }).lean();
    if (!fy) throw new NotFoundException('Fiscal year not found');
    const programmes = (await this.db.programmes.find({ organisationId: user.organisationId, isActive: true, $or: [{ entityId: null }, { entityId: entity._id }] }).sort({ code: 1 }).lean()) as Programme[];
    const budget = await this.db.budgets.findOne({ organisationId: user.organisationId, entityId: entity._id, fiscalYearId: fy._id, kind: 'BUDGET', status: 'APPROVED' }).lean();
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, accountClass: { $in: SPEND } }, { _id: 1 }).lean();
    const spendIds = new Set(accounts.map((a) => a._id.toHexString()));

    const owner = (departmentId?: Id | null, projectId?: Id | null) => {
      const byProject = projectId && programmes.find((p) => p.projectIds.some((x) => x.equals(projectId)));
      if (byProject) return byProject._id.toHexString();
      const byDept = departmentId && programmes.find((p) => p.departmentIds.some((x) => x.equals(departmentId)));
      return byDept ? byDept._id.toHexString() : 'none';
    };
    const budgetBy = new Map<string, Decimal>();
    for (const l of budget?.lines ?? []) {
      if (!spendIds.has(l.accountId.toHexString())) continue;
      const k = owner(l.departmentId, l.projectId);
      budgetBy.set(k, (budgetBy.get(k) ?? new Decimal(0)).plus(sum(l.amounts.map((a) => dec(a)))));
    }
    const ledger = await this.db.ledger.aggregate<{ _id: { d: Id | null; p: Id | null }; debit: unknown; credit: unknown }>([
      { $match: { organisationId: user.organisationId, entityId: entity._id, accountClass: { $in: SPEND }, date: { $gte: fy.startDate, $lte: fy.endDate } } },
      { $group: { _id: { d: '$departmentId', p: '$projectId' }, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
    const actualBy = new Map<string, Decimal>();
    for (const g of ledger) {
      const k = owner(g._id.d, g._id.p);
      actualBy.set(k, (actualBy.get(k) ?? new Decimal(0)).plus(dec(g.debit as never).minus(dec(g.credit as never))));
    }
    const line = (p: Programme, children: Programme[]) => {
      const keys = [p._id.toHexString(), ...children.map((c) => c._id.toHexString())];
      const b = sum(keys.map((k) => budgetBy.get(k) ?? 0));
      const a = sum(keys.map((k) => actualBy.get(k) ?? 0));
      return {
        id: p._id,
        code: p.code,
        name: p.name,
        objective: p.objective,
        outcome: p.outcome,
        budget: b,
        actual: a,
        balance: b.minus(a),
        absorptionPercent: b.isZero() ? null : a.div(b).times(100).toDecimalPlaces(1),
        kpis: p.kpis.map((k) => {
          const mine = k.actuals.filter((x) => x.fiscalYearId.equals(fy._id)).sort((x, y) => x.quarter - y.quarter);
          return { id: k._id, indicator: k.indicator, unit: k.unit, baseline: k.baseline, target: k.target, quarters: mine.map((x) => ({ quarter: x.quarter, value: x.value, note: x.note })), latest: mine.at(-1)?.value ?? null };
        }),
      };
    };
    const top = programmes.filter((p) => !p.parentId);
    const rows = top.map((p) => {
      const children = programmes.filter((c) => c.parentId?.equals(p._id));
      return { ...line(p, children), subProgrammes: children.map((c) => line(c, [])) };
    });
    const unallocated = { budget: budgetBy.get('none') ?? new Decimal(0), actual: actualBy.get('none') ?? new Decimal(0) };
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      fiscalYear: { id: fy._id, name: fy.name },
      budget: budget && { id: budget._id, name: budget.name },
      rows,
      unallocated,
      totals: { budget: sum([...budgetBy.values()]), actual: sum([...actualBy.values()]) },
    };
  }
}
