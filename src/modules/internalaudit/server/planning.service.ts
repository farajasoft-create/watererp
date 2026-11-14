import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { NotificationsService } from '@/platform/services/notifications.service';
import { iaSettings, InternalauditDb as Db } from './db';
import { CYCLE_MONTHS, Rating, ratingOf, RATINGS } from './schemas';

type Id = Types.ObjectId;
const MONTH = 30.44 * 86_400_000;

export interface UniverseInput { code: string; name: string; kind: 'DEPARTMENT' | 'PROCESS' | 'SYSTEM' | 'PROJECT' | 'BRANCH' | 'OTHER'; owner?: string; ownerId?: Id | null; description?: string; impact: number; likelihood: number; lastAuditedAt?: Date | null; active?: boolean }
export interface RiskInput {
  code: string;
  title: string;
  category: 'STRATEGIC' | 'OPERATIONAL' | 'FINANCIAL' | 'COMPLIANCE' | 'ICT' | 'FRAUD' | 'REPUTATIONAL';
  universeId?: Id | null;
  owner?: string;
  cause?: string;
  consequence?: string;
  impact: number;
  likelihood: number;
  controls?: string;
  residualImpact: number;
  residualLikelihood: number;
  treatment: 'ACCEPT' | 'REDUCE' | 'TRANSFER' | 'AVOID';
  reviewDate?: Date | null;
  status?: 'OPEN' | 'CLOSED';
}
export interface PlanItemInput { universeId?: Id | null; title: string; kind: string; quarter: number; start?: Date | null; end?: Date | null; hours: number; cost?: Decimal; leadId?: Id | null }

const dup = (err: unknown, what: string) => {
  if ((err as { code?: number }).code === 11000) throw new ConflictException(`${what} is already used`);
  throw err;
};

/**
 * The risk-based planning side of internal audit: the audit universe, the risk register with inherent
 * and residual scores and heat maps, audit programmes, the annual plan with its approval, and the
 * audit calendar.
 */
export class PlanningService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  settings(user: AuthUser) {
    return iaSettings(this.db, user.organisationId);
  }

  async saveSettings(user: AuthUser, input: { hourlyRate: Decimal; remindDays: number; escalateDays: number }) {
    await iaSettings(this.db, user.organisationId);
    await this.db.iaSettings.updateOne({ organisationId: user.organisationId }, { hourlyRate: toD128(input.hourlyRate), remindDays: input.remindDays, escalateDays: input.escalateDays });
    await this.audit.record(user, 'internalaudit.settings.update', 'iaSettings', null, { hourlyRate: input.hourlyRate.toFixed(2) });
    return this.settings(user);
  }

  // Universe and risks -----------------------------------------------------------------------------

  /** Each auditable area with its risk (the worst residual risk in the register, or its own rating) and when it is next due. */
  async universe(user: AuthUser) {
    const [areas, risks] = await Promise.all([
      this.db.universe.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean(),
      this.db.risks.find({ organisationId: user.organisationId, status: 'OPEN', universeId: { $ne: null } }, { universeId: 1, residualImpact: 1, residualLikelihood: 1 }).lean(),
    ]);
    const now = Date.now();
    return areas
      .map((a) => {
        const own = risks.filter((r) => r.universeId!.equals(a._id)).map((r) => r.residualImpact * r.residualLikelihood);
        const score = own.length ? Math.max(...own) : a.impact * a.likelihood;
        const rating = ratingOf(score);
        const dueAt = a.lastAuditedAt ? new Date(a.lastAuditedAt.getTime() + CYCLE_MONTHS[rating] * MONTH) : null;
        return { ...a, score, rating, risks: own.length, dueAt, overdue: !dueAt || dueAt.getTime() < now };
      })
      .sort((x, y) => y.score - x.score || x.code.localeCompare(y.code));
  }

  async saveArea(user: AuthUser, id: Id | null, input: UniverseInput) {
    const fields = { ...input, code: input.code.toUpperCase() };
    try {
      const doc = id ? await this.db.universe.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.universe.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Area not found');
      await this.audit.record(user, id ? 'internalaudit.universe.update' : 'internalaudit.universe.create', 'iaUniverse', doc._id, { code: fields.code });
      return doc;
    } catch (err) {
      return dup(err, `Code ${fields.code}`);
    }
  }

  async risks(user: AuthUser, q: { universeId?: Id; status?: string }) {
    const rows = await this.db.risks.find({ organisationId: user.organisationId, ...(q.universeId && { universeId: q.universeId }), ...(q.status && { status: q.status }) }).sort({ code: 1 }).lean();
    return rows.map((r) => ({ ...r, inherentScore: r.impact * r.likelihood, inherentRating: ratingOf(r.impact * r.likelihood), residualScore: r.residualImpact * r.residualLikelihood, residualRating: ratingOf(r.residualImpact * r.residualLikelihood) })).sort((a, b) => b.residualScore - a.residualScore);
  }

  async saveRisk(user: AuthUser, id: Id | null, input: RiskInput) {
    if (input.residualImpact * input.residualLikelihood > input.impact * input.likelihood) throw new BadRequestException('The residual risk cannot be higher than the inherent risk');
    if (input.universeId && !(await this.db.universe.exists({ _id: input.universeId, organisationId: user.organisationId }))) throw new BadRequestException('Area not found');
    const fields = { ...input, code: input.code.toUpperCase() };
    try {
      const doc = id ? await this.db.risks.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.risks.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Risk not found');
      await this.audit.record(user, id ? 'internalaudit.risk.update' : 'internalaudit.risk.create', 'iaRisk', doc._id, { code: fields.code, inherent: input.impact * input.likelihood, residual: input.residualImpact * input.residualLikelihood });
      return doc;
    } catch (err) {
      return dup(err, `Risk code ${fields.code}`);
    }
  }

  /** The 5×5 heat map: how many open risks sit in each impact/likelihood cell, inherent and residual. */
  async heatMap(user: AuthUser) {
    const risks = await this.db.risks.find({ organisationId: user.organisationId, status: 'OPEN' }, { code: 1, title: 1, impact: 1, likelihood: 1, residualImpact: 1, residualLikelihood: 1 }).lean();
    const grid = (i: (r: (typeof risks)[number]) => number, l: (r: (typeof risks)[number]) => number) =>
      [5, 4, 3, 2, 1].map((impact) => [1, 2, 3, 4, 5].map((likelihood) => {
        const here = risks.filter((r) => i(r) === impact && l(r) === likelihood);
        return { impact, likelihood, score: impact * likelihood, rating: ratingOf(impact * likelihood), count: here.length, codes: here.map((r) => r.code) };
      }));
    const byRating = (score: (r: (typeof risks)[number]) => number) => Object.fromEntries(RATINGS.map((x) => [x, risks.filter((r) => ratingOf(score(r)) === x).length])) as Record<Rating, number>;
    return {
      total: risks.length,
      inherent: grid((r) => r.impact, (r) => r.likelihood),
      residual: grid((r) => r.residualImpact, (r) => r.residualLikelihood),
      inherentByRating: byRating((r) => r.impact * r.likelihood),
      residualByRating: byRating((r) => r.residualImpact * r.residualLikelihood),
    };
  }

  // Programmes -------------------------------------------------------------------------------------

  programmes(user: AuthUser) {
    return this.db.programmes.find({ organisationId: user.organisationId }).sort({ name: 1 }).lean();
  }

  async saveProgramme(user: AuthUser, id: Id | null, input: { name: string; area?: string; objective?: string; procedures: { ref: string; title: string; steps?: string }[]; active?: boolean }) {
    const refs = input.procedures.map((p) => p.ref.toUpperCase());
    if (new Set(refs).size !== refs.length) throw new BadRequestException('Each procedure needs its own reference');
    const fields = { ...input, procedures: input.procedures.map((p) => ({ ...p, ref: p.ref.toUpperCase() })) };
    const doc = id ? await this.db.programmes.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.programmes.create({ ...fields, organisationId: user.organisationId })).toObject();
    if (!doc) throw new NotFoundException('Programme not found');
    await this.audit.record(user, id ? 'internalaudit.programme.update' : 'internalaudit.programme.create', 'iaProgramme', doc._id, { name: input.name, procedures: refs.length });
    return doc;
  }

  // Annual plan ------------------------------------------------------------------------------------

  async plans(user: AuthUser) {
    const plans = await this.db.plans.find({ organisationId: user.organisationId }).sort({ year: -1, version: -1 }).lean();
    return plans.map((p) => ({ ...p, items: undefined, itemCount: p.items.length, hours: p.items.reduce((t, i) => t + (i.hours ?? 0), 0), cost: p.items.reduce((t, i) => t.plus(dec(i.cost?.toString())), new Decimal(0)) }));
  }

  async plan(user: AuthUser, id: Id) {
    const p = await this.db.plans.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Plan not found');
    const [areas, engagements, leads] = await Promise.all([
      this.db.universe.find({ _id: { $in: p.items.map((i) => i.universeId).filter(Boolean) } }, { code: 1, name: 1 }).lean(),
      this.db.engagements.find({ _id: { $in: p.items.map((i) => i.engagementId).filter(Boolean) } }, { number: 1, status: 1 }).lean(),
      this.db.users.find({ _id: { $in: p.items.map((i) => i.leadId).filter(Boolean) } }, { name: 1 }).lean(),
    ]);
    const hours = p.items.reduce((t, i) => t + (i.hours ?? 0), 0);
    return {
      ...p,
      hours,
      cost: p.items.reduce((t, i) => t.plus(dec(i.cost?.toString())), new Decimal(0)),
      overCapacity: p.availableHours > 0 && hours > p.availableHours,
      items: p.items.map((i) => ({
        ...i,
        area: areas.find((a) => i.universeId && a._id.equals(i.universeId)) ?? null,
        engagement: engagements.find((e) => i.engagementId && e._id.equals(i.engagementId)) ?? null,
        lead: leads.find((u) => i.leadId && u._id.equals(i.leadId))?.name ?? null,
      })),
    };
  }

  /**
   * A draft plan for a year. With `fromUniverse`, the areas that are high risk or due for audit in the
   * year are put in, riskiest first, spread over the quarters.
   */
  async createPlan(user: AuthUser, input: { year: string; title: string; availableHours: number; fromUniverse: boolean }) {
    const latest = await this.db.plans.findOne({ organisationId: user.organisationId, year: input.year }).sort({ version: -1 }).lean();
    if (latest && latest.status !== 'REJECTED' && latest.status !== 'APPROVED') throw new ConflictException(`There is already a ${latest.status.toLowerCase()} plan for ${input.year}`);
    const items: PlanItemInput[] & { rating?: string }[] = [];
    if (input.fromUniverse) {
      const areas = (await this.universe(user)).filter((a) => a.active && (a.overdue || a.rating === 'CRITICAL' || a.rating === 'HIGH'));
      areas.forEach((a, n) => items.push({ universeId: a._id, title: `Audit of ${a.name}`, kind: 'ASSURANCE', quarter: (n % 4) + 1, hours: a.rating === 'CRITICAL' ? 200 : a.rating === 'HIGH' ? 160 : 120, rating: a.rating } as PlanItemInput & { rating: string }));
    }
    const [plan] = await this.db.plans.create([{ organisationId: user.organisationId, year: input.year, title: input.title, availableHours: input.availableHours, items: items.map((i) => ({ ...i, cost: toD128(i.cost ?? 0) })), preparedBy: user.id, version: (latest?.version ?? 0) + 1 }]);
    await this.audit.record(user, 'internalaudit.plan.create', 'iaPlan', plan._id, { year: input.year, items: items.length, version: plan.version });
    return this.plan(user, plan._id);
  }

  private async draft(user: AuthUser, id: Id) {
    const p = await this.db.plans.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Plan not found');
    if (p.status !== 'DRAFT') throw new BadRequestException('Only a draft plan can be changed; start a revised version');
    return p;
  }

  async saveItems(user: AuthUser, id: Id, input: { title?: string; availableHours?: number; items: (PlanItemInput & { id?: Id })[] }) {
    const p = await this.draft(user, id);
    const settings = await iaSettings(this.db, user.organisationId);
    const rate = dec(settings.hourlyRate?.toString());
    const areas = await this.db.universe.find({ organisationId: user.organisationId, _id: { $in: input.items.map((i) => i.universeId).filter(Boolean) } }).lean();
    const risks = await this.universe(user);
    const items = input.items.map((i) => {
      if (i.universeId && !areas.some((a) => a._id.equals(i.universeId!))) throw new BadRequestException('Area not found');
      if (i.start && i.end && i.end < i.start) throw new BadRequestException(`${i.title}: the end is before the start`);
      const old = i.id ? p.items.find((x) => x._id.equals(i.id!)) : null;
      return {
        ...(i.id && { _id: i.id }),
        universeId: i.universeId ?? null,
        title: i.title,
        kind: i.kind,
        quarter: i.quarter,
        start: i.start ?? null,
        end: i.end ?? null,
        hours: i.hours,
        cost: toD128(i.cost ?? rate.times(i.hours)),
        leadId: i.leadId ?? null,
        rating: i.universeId ? risks.find((r) => r._id.equals(i.universeId!))?.rating : undefined,
        engagementId: old?.engagementId ?? null,
      };
    });
    await this.db.plans.updateOne({ _id: id }, { items, ...(input.title && { title: input.title }), ...(input.availableHours !== undefined && { availableHours: input.availableHours }) });
    await this.audit.record(user, 'internalaudit.plan.items', 'iaPlan', id, { items: items.length });
    return this.plan(user, id);
  }

  async submitPlan(user: AuthUser, id: Id) {
    const p = await this.draft(user, id);
    if (!p.items.length) throw new BadRequestException('The plan has no audits in it');
    await this.db.plans.updateOne({ _id: id, status: 'DRAFT' }, { status: 'SUBMITTED', submittedAt: new Date(), preparedBy: user.id });
    await this.audit.record(user, 'internalaudit.plan.submit', 'iaPlan', id, {});
    const approvers = await this.db.users.find({ organisationId: user.organisationId, active: { $ne: false }, _id: { $ne: user.id }, access: { $elemMatch: { module: 'internalaudit', role: { $in: ['COMMITTEE', 'HEAD'] } } } }, { _id: 1 }).lean();
    await this.notifications.notify(user.organisationId, approvers.map((a) => a._id), { title: `Audit plan ${p.year} for approval`, body: `${p.items.length} audits, ${p.items.reduce((t, i) => t + (i.hours ?? 0), 0)} hours`, link: `/internalaudit/plans/${id.toHexString()}`, module: 'internalaudit' });
    return this.plan(user, id);
  }

  /** The audit committee approves the plan, or sends it back; never the person who prepared it. */
  async decidePlan(user: AuthUser, id: Id, input: { approve: boolean; note?: string }) {
    const p = await this.db.plans.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Plan not found');
    if (p.status !== 'SUBMITTED') throw new BadRequestException('The plan is not waiting for approval');
    if (p.preparedBy?.equals(user.id)) throw new ForbiddenException('Someone other than the preparer must approve the plan');
    if (!input.approve && !input.note) throw new BadRequestException('Say why the plan is sent back');
    await this.db.plans.updateOne({ _id: id, status: 'SUBMITTED' }, { status: input.approve ? 'APPROVED' : 'REJECTED', decidedBy: user.id, decidedAt: new Date(), decisionNote: input.note });
    await this.audit.record(user, input.approve ? 'internalaudit.plan.approve' : 'internalaudit.plan.reject', 'iaPlan', id, { note: input.note });
    if (p.preparedBy) await this.notifications.notify(user.organisationId, [p.preparedBy], { title: `Audit plan ${p.year} ${input.approve ? 'approved' : 'sent back'}`, body: input.note, link: `/internalaudit/plans/${id.toHexString()}`, module: 'internalaudit' });
    return this.plan(user, id);
  }

  /** The audit calendar: planned audits and engagements by month for a year. */
  async calendar(user: AuthUser, year: number) {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year + 1, 0, 1));
    const [engagements, plans] = await Promise.all([
      this.db.engagements.find({ organisationId: user.organisationId, status: { $ne: 'CANCELLED' }, start: { $lt: to }, $or: [{ end: { $gte: from } }, { end: null }] }, { number: 1, title: 1, start: 1, end: 1, status: 1, restricted: 1, leadId: 1, team: 1 }).lean(),
      this.db.plans.find({ organisationId: user.organisationId, status: 'APPROVED' }, { year: 1, items: 1 }).lean(),
    ]);
    const visible = engagements.filter((e) => !e.restricted || e.leadId.equals(user.id) || e.team.some((t) => t.equals(user.id)) || user.permissions.includes('internalaudit.engagement.manage'));
    const planned = plans
      .flatMap((p) => p.items.map((i) => ({ ...i, year: p.year })))
      .filter((i) => !i.engagementId)
      .map((i) => ({ title: i.title, start: i.start ?? new Date(Date.UTC(year, ((i.quarter ?? 1) - 1) * 3, 1)), end: i.end ?? new Date(Date.UTC(year, (i.quarter ?? 1) * 3, 0)), quarter: i.quarter }))
      .filter((i) => i.start < to && i.end >= from);
    return {
      year,
      months: Array.from({ length: 12 }, (_, m) => {
        const ms = new Date(Date.UTC(year, m, 1));
        const me = new Date(Date.UTC(year, m + 1, 1));
        return {
          month: m + 1,
          engagements: visible.filter((e) => e.start! < me && (!e.end || e.end >= ms)).map((e) => ({ id: e._id, number: e.number, title: e.title, status: e.status })),
          planned: planned.filter((i) => i.start < me && i.end >= ms).map((i) => ({ title: i.title })),
        };
      }),
    };
  }
}
