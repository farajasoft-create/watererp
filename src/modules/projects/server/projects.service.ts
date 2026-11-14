import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { exportResult, htmlReport, workbook } from '@/modules/bi/server/exports';
import type { QueryResult } from '@/modules/bi/server/engine';
import { AuthUser } from '@/platform/auth';
import { openPortal } from '@/platform/common/branding';
import { BadRequestException, ConflictException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { ProjectsDb as Db } from './db';
import { DONOR_TYPES } from './schemas';

type Id = Types.ObjectId;
const ZERO = new Decimal(0);
const DAY = 86_400_000;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const n = (v: unknown) => dec((v as { toString(): string } | null | undefined)?.toString() ?? '0');
const pct = (a: Decimal, b: Decimal) => (b.gt(0) ? Math.round(a.dividedBy(b).times(1000).toNumber()) / 10 : null);
/** Accounts holding cash and receivables are not spending even when tagged to a project. */
const NOT_SPEND = ['BANK', 'CASH', 'MOBILE_MONEY', 'ACCOUNTS_RECEIVABLE', 'RECEIVABLE', 'PETTY_CASH'];

export interface GrantInput {
  donorId: Id;
  code: string;
  title: string;
  agreementRef?: string;
  currency: string;
  amount: Decimal;
  startDate?: Date | null;
  endDate?: Date | null;
  fundCode?: string;
  status: 'PIPELINE' | 'ACTIVE' | 'CLOSED';
  conditions?: string;
  reportingFrequency: 'MONTHLY' | 'QUARTERLY' | 'BIANNUAL' | 'ANNUAL';
  budgetLines: { code: string; name: string; amount: Decimal; accountPrefixes: string[] }[];
}
export interface ProjectInput {
  code: string;
  name: string;
  description?: string;
  kind: 'CAPEX' | 'OPEX' | 'MIXED';
  financeCode: string;
  grantIds: Id[];
  budget: Decimal;
  startDate?: Date | null;
  endDate?: Date | null;
  location?: string;
  managerId?: Id | null;
  status: 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
}

interface SpendLine { accountId: Id; code: string; name: string; accountClass: string; accountType: string; amount: Decimal }

/**
 * Donor-funded and capital projects. Spending is never typed in twice: it is read live from the
 * finance ledger by the project and fund each posting is tagged with, so grant balances, budget
 * variances, CAPEX, work in progress and burn rates are always current. Donors get dashboards, reports
 * in Excel, PDF and Word, and an optional read-only portal link.
 */
export class ProjectsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // Ledger ------------------------------------------------------------------------------------------

  private async dimensionId(organisationId: Id, type: 'PROJECT' | 'FUND', code?: string | null) {
    if (!code) return null;
    const d = await this.db.connection.collection('finance_dimensionvalues').findOne({ organisationId, type, code: code.toUpperCase() }, { projection: { _id: 1 } });
    return (d?._id as Id | undefined) ?? null;
  }

  /** Spending by account (debits less credits) for one project or fund dimension. */
  private async spending(organisationId: Id, field: 'projectId' | 'fundId', dimensionId: Id | null, to?: Date): Promise<SpendLine[]> {
    if (!dimensionId) return [];
    const rows = await this.db.connection
      .collection('finance_ledgerentries')
      .aggregate<{ _id: Id; amount: number }>([
        { $match: { organisationId, [field]: dimensionId, accountClass: { $in: ['EXPENSE', 'COST_OF_SALES', 'ASSET'] }, ...(to && { date: { $lt: to } }) } },
        { $group: { _id: '$accountId', amount: { $sum: { $subtract: [{ $toDecimal: '$debit' }, { $toDecimal: '$credit' }] } } } },
      ])
      .toArray();
    const accounts = await this.db.connection.collection('finance_accounts').find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { code: 1, name: 1, accountClass: 1, accountType: 1 } }).toArray();
    return rows
      .map((r) => {
        const a = accounts.find((x) => (x._id as Id).equals(r._id));
        return { accountId: r._id, code: String(a?.code ?? ''), name: String(a?.name ?? ''), accountClass: String(a?.accountClass ?? ''), accountType: String(a?.accountType ?? ''), amount: n(r.amount) };
      })
      .filter((l) => !(l.accountClass === 'ASSET' && NOT_SPEND.includes(l.accountType)));
  }

  private async monthly(organisationId: Id, field: 'projectId' | 'fundId', dimensionId: Id | null) {
    if (!dimensionId) return [];
    const accounts = await this.db.connection.collection('finance_accounts').find({ organisationId, accountType: { $in: NOT_SPEND } }, { projection: { _id: 1 } }).toArray();
    const rows = await this.db.connection
      .collection('finance_ledgerentries')
      .aggregate<{ _id: string; amount: number }>([
        { $match: { organisationId, [field]: dimensionId, accountClass: { $in: ['EXPENSE', 'COST_OF_SALES', 'ASSET'] }, accountId: { $nin: accounts.map((a) => a._id) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, amount: { $sum: { $subtract: [{ $toDouble: '$debit' }, { $toDouble: '$credit' }] } } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return rows.map((r) => ({ month: r._id, amount: Math.round(r.amount * 100) / 100 }));
  }

  // Donors ------------------------------------------------------------------------------------------

  donors(user: AuthUser) {
    return this.db.donors.find({ organisationId: user.organisationId }, { portalTokenHash: 0 }).sort({ name: 1 }).lean();
  }

  async saveDonor(user: AuthUser, id: Id | null, input: { name: string; type: (typeof DONOR_TYPES)[number]; contactName?: string; email?: string; phone?: string; active?: boolean }) {
    const doc = id ? await this.db.donors.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, input, { new: true, projection: { portalTokenHash: 0 } }).lean() : (await this.db.donors.create({ ...input, organisationId: user.organisationId })).toObject();
    if (!doc) throw new NotFoundException('Donor not found');
    await this.audit.record(user, id ? 'projects.donor.update' : 'projects.donor.create', 'projectsDonor', doc._id, { name: input.name });
    return { ...doc, portalTokenHash: undefined };
  }

  /** A new read-only portal link for the donor; any earlier link stops working. Shown once. */
  async donorPortalLink(user: AuthUser, id: Id, enable: boolean) {
    const d = await this.db.donors.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!d) throw new NotFoundException('Donor not found');
    const token = enable ? randomBytes(24).toString('base64url') : null;
    await this.db.donors.updateOne({ _id: id }, { portalEnabled: enable, portalTokenHash: token ? hash(token) : null });
    await this.audit.record(user, enable ? 'projects.donor.portal' : 'projects.donor.portal-off', 'projectsDonor', id, {});
    return { enabled: enable, path: token ? `/donors/${token}` : null };
  }

  // Grants ------------------------------------------------------------------------------------------

  async saveGrant(user: AuthUser, id: Id | null, input: GrantInput) {
    if (!(await this.db.donors.exists({ _id: input.donorId, organisationId: user.organisationId }))) throw new BadRequestException('Donor not found');
    const lines = input.budgetLines.reduce((t, l) => t.plus(l.amount), ZERO);
    if (input.budgetLines.length && lines.gt(input.amount)) throw new BadRequestException(`The budget lines (${lines.toFixed(2)}) come to more than the grant (${input.amount.toFixed(2)})`);
    const fields = { ...input, code: input.code.toUpperCase(), fundCode: input.fundCode?.toUpperCase(), amount: toD128(input.amount), budgetLines: input.budgetLines.map((l) => ({ ...l, code: l.code.toUpperCase(), amount: toD128(l.amount) })) };
    try {
      const doc = id ? await this.db.grants.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.grants.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Grant not found');
      await this.audit.record(user, id ? 'projects.grant.update' : 'projects.grant.create', 'projectsGrant', doc._id, { code: fields.code, amount: input.amount.toFixed(2) });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Grant code ${fields.code} is already used`);
      throw err;
    }
  }

  async disburse(user: AuthUser, id: Id, input: { date: Date; amount: Decimal; reference?: string; note?: string }) {
    const g = await this.db.grants.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!g) throw new NotFoundException('Grant not found');
    const received = (g.disbursements ?? []).reduce((t, x) => t.plus(n(x.amount)), ZERO);
    if (received.plus(input.amount).gt(n(g.amount))) throw new BadRequestException(`That takes receipts past the grant amount of ${n(g.amount).toFixed(2)}`);
    await this.db.grants.updateOne({ _id: id }, { $push: { disbursements: { ...input, amount: toD128(input.amount), by: user.id } } });
    await this.audit.record(user, 'projects.grant.disbursement', 'projectsGrant', id, { amount: input.amount.toFixed(2), reference: input.reference });
    return this.grant(user, id);
  }

  /** A grant's position now: received, spent, balance, each budget line against its spending, burn. */
  private async grantStatus(organisationId: Id, g: { _id: Id; amount?: unknown; fundCode?: string | null; startDate?: Date | null; endDate?: Date | null; budgetLines?: { code: string; name: string; amount?: unknown; accountPrefixes?: string[] }[]; disbursements?: { amount?: unknown }[] }) {
    const fundId = await this.dimensionId(organisationId, 'FUND', g.fundCode);
    const lines = await this.spending(organisationId, 'fundId', fundId);
    const spent = lines.reduce((t, l) => t.plus(l.amount), ZERO);
    const received = (g.disbursements ?? []).reduce((t, x) => t.plus(n(x.amount)), ZERO);
    const amount = n(g.amount);
    const budget = (g.budgetLines ?? []).map((b) => {
      const mine = lines.filter((l) => (b.accountPrefixes ?? []).some((p) => l.code.startsWith(p)));
      const used = mine.reduce((t, l) => t.plus(l.amount), ZERO);
      return { code: b.code, name: b.name, budget: n(b.amount), spent: used, remaining: n(b.amount).minus(used), usedPct: pct(used, n(b.amount)), overspent: used.gt(n(b.amount)) };
    });
    const unallocated = spent.minus(budget.reduce((t, b) => t.plus(b.spent), ZERO));
    const now = Date.now();
    const timePct = g.startDate && g.endDate && g.endDate > g.startDate ? Math.min(100, Math.max(0, Math.round(((now - g.startDate.getTime()) / (g.endDate.getTime() - g.startDate.getTime())) * 1000) / 10)) : null;
    const months = g.startDate ? Math.max(1, (now - g.startDate.getTime()) / (30.44 * DAY)) : null;
    return {
      fundLinked: Boolean(fundId),
      amount,
      received,
      spent,
      cashBalance: received.minus(spent),
      undrawn: amount.minus(received),
      remaining: amount.minus(spent),
      absorptionPct: pct(spent, amount),
      timeElapsedPct: timePct,
      monthlyBurn: months ? spent.dividedBy(months).toDecimalPlaces(2) : null,
      /** Behind when far less has been spent than the time used would suggest. */
      pace: timePct !== null && pct(spent, amount) !== null ? (pct(spent, amount)! + 15 < timePct ? 'BEHIND' : pct(spent, amount)! > timePct + 15 ? 'AHEAD' : 'ON_TRACK') : null,
      budget,
      unallocated,
      monthly: await this.monthly(organisationId, 'fundId', fundId),
    };
  }

  async grants(user: AuthUser) {
    const [rows, donors] = await Promise.all([this.db.grants.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean(), this.db.donors.find({ organisationId: user.organisationId }, { name: 1 }).lean()]);
    return Promise.all(rows.map(async (g) => ({ ...g, donor: donors.find((d) => d._id.equals(g.donorId))?.name ?? '', status: g.status, position: await this.grantStatus(user.organisationId, g) })));
  }

  async grant(user: AuthUser, id: Id) {
    const g = await this.db.grants.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!g) throw new NotFoundException('Grant not found');
    const [donor, projects] = await Promise.all([this.db.donors.findById(g.donorId, { name: 1, type: 1 }).lean(), this.db.projects.find({ organisationId: user.organisationId, grantIds: g._id }, { code: 1, name: 1, status: 1 }).lean()]);
    return { ...g, donor, projects, position: await this.grantStatus(user.organisationId, g) };
  }

  /** Drill-through: the ledger postings behind a grant (or one budget line of it). */
  async grantTransactions(user: AuthUser, id: Id, lineCode?: string) {
    const g = await this.db.grants.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!g) throw new NotFoundException('Grant not found');
    const fundId = await this.dimensionId(user.organisationId, 'FUND', g.fundCode);
    if (!fundId) return [];
    const line = lineCode ? g.budgetLines.find((b) => b.code === lineCode.toUpperCase()) : null;
    if (lineCode && !line) throw new NotFoundException('Budget line not found');
    const accounts = await this.db.connection.collection('finance_accounts').find({ organisationId: user.organisationId, ...(line && { $or: line.accountPrefixes.map((p) => ({ code: { $regex: `^${p.replace(/[^\w-]/g, '')}` } })) }) }, { projection: { code: 1, name: 1, accountType: 1 } }).toArray();
    const spendable = accounts.filter((a) => !NOT_SPEND.includes(String(a.accountType)));
    const rows = await this.db.connection.collection('finance_ledgerentries').find({ organisationId: user.organisationId, fundId, accountId: { $in: spendable.map((a) => a._id) }, accountClass: { $in: ['EXPENSE', 'COST_OF_SALES', 'ASSET'] } }, { projection: { date: 1, journalNumber: 1, description: 1, accountId: 1, debit: 1, credit: 1 } }).sort({ date: -1 }).limit(2000).toArray();
    return rows.map((r) => {
      const a = spendable.find((x) => (x._id as Id).equals(r.accountId as Id));
      return { date: r.date, journal: r.journalNumber, description: r.description, account: `${a?.code ?? ''} ${a?.name ?? ''}`.trim(), amount: n(r.debit).minus(n(r.credit)) };
    });
  }

  // Projects ----------------------------------------------------------------------------------------

  async saveProject(user: AuthUser, id: Id | null, input: ProjectInput) {
    if (input.grantIds.length && (await this.db.grants.countDocuments({ organisationId: user.organisationId, _id: { $in: input.grantIds } })) !== input.grantIds.length) throw new BadRequestException('Grant not found');
    if (input.startDate && input.endDate && input.endDate < input.startDate) throw new BadRequestException('The end is before the start');
    const fields = { ...input, code: input.code.toUpperCase(), financeCode: input.financeCode.toUpperCase(), budget: toD128(input.budget) };
    try {
      const doc = id ? await this.db.projects.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.projects.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Project not found');
      await this.audit.record(user, id ? 'projects.project.update' : 'projects.project.create', 'projectsProject', doc._id, { code: fields.code });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Project code ${fields.code} is already used`);
      throw err;
    }
  }

  private async load(user: AuthUser, id: Id) {
    const p = await this.db.projects.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  async setMilestones(user: AuthUser, id: Id, milestones: { id?: Id; name: string; due?: Date | null; weight: number; percentComplete: number; note?: string }[]) {
    const p = await this.load(user, id);
    const now = new Date();
    const next = milestones.map((m) => {
      const old = m.id ? p.milestones.find((x) => x._id.equals(m.id!)) : null;
      return { ...(m.id && { _id: m.id }), name: m.name, due: m.due ?? null, weight: m.weight, percentComplete: m.percentComplete, note: m.note, completedAt: m.percentComplete >= 100 ? (old?.completedAt ?? now) : null };
    });
    await this.db.projects.updateOne({ _id: id }, { milestones: next });
    await this.audit.record(user, 'projects.project.milestones', 'projectsProject', id, { milestones: next.length });
    return this.project(user, id);
  }

  async saveKpi(user: AuthUser, id: Id, input: { kpiId?: Id; name: string; unit?: string; baseline: number; target: number; direction: 'UP' | 'DOWN' }) {
    await this.load(user, id);
    if (input.kpiId) await this.db.projects.updateOne({ _id: id, 'kpis._id': input.kpiId }, { $set: { 'kpis.$.name': input.name, 'kpis.$.unit': input.unit, 'kpis.$.baseline': input.baseline, 'kpis.$.target': input.target, 'kpis.$.direction': input.direction } });
    else await this.db.projects.updateOne({ _id: id }, { $push: { kpis: { name: input.name, unit: input.unit, baseline: input.baseline, target: input.target, direction: input.direction } } });
    await this.audit.record(user, 'projects.kpi.save', 'projectsProject', id, { name: input.name, target: input.target });
    return this.project(user, id);
  }

  async recordKpi(user: AuthUser, id: Id, kpiId: Id, input: { value: number; note?: string }) {
    const res = await this.db.projects.updateOne({ _id: id, organisationId: user.organisationId, 'kpis._id': kpiId }, { $set: { 'kpis.$.actual': input.value }, $push: { 'kpis.$.updates': { at: new Date(), value: input.value, note: input.note, by: user.id } } });
    if (!res.matchedCount) throw new NotFoundException('KPI not found');
    await this.audit.record(user, 'projects.kpi.record', 'projectsProject', id, { kpiId, value: input.value });
    return this.project(user, id);
  }

  /** Moves completed works out of work in progress; no more than the capital spending not yet moved. */
  async capitalise(user: AuthUser, id: Id, input: { date: Date; amount: Decimal; assetRef?: string; note?: string }) {
    const p = await this.load(user, id);
    const status = await this.projectStatus(user.organisationId, p);
    if (input.amount.gt(status.wip)) throw new BadRequestException(`Only ${status.wip.toFixed(2)} is in work in progress`);
    await this.db.projects.updateOne({ _id: id }, { $push: { capitalisations: { ...input, amount: toD128(input.amount), by: user.id } } });
    await this.audit.record(user, 'projects.project.capitalise', 'projectsProject', id, { amount: input.amount.toFixed(2), assetRef: input.assetRef });
    return this.project(user, id);
  }

  private async projectStatus(organisationId: Id, p: { financeCode: string; budget?: unknown; startDate?: Date | null; endDate?: Date | null; milestones?: { weight?: number | null; percentComplete?: number | null }[]; kpis?: { baseline?: number | null; target: number; actual?: number | null; direction?: string | null }[]; capitalisations?: { amount?: unknown }[] }) {
    const projectId = await this.dimensionId(organisationId, 'PROJECT', p.financeCode);
    const lines = await this.spending(organisationId, 'projectId', projectId);
    const capex = lines.filter((l) => l.accountClass === 'ASSET').reduce((t, l) => t.plus(l.amount), ZERO);
    const opex = lines.filter((l) => l.accountClass !== 'ASSET').reduce((t, l) => t.plus(l.amount), ZERO);
    const spent = capex.plus(opex);
    const capitalised = (p.capitalisations ?? []).reduce((t, c) => t.plus(n(c.amount)), ZERO);
    const budget = n(p.budget);
    const weights = (p.milestones ?? []).reduce((t, m) => t + (m.weight ?? 1), 0);
    const physicalPct = weights ? Math.round(((p.milestones ?? []).reduce((t, m) => t + (m.weight ?? 1) * (m.percentComplete ?? 0), 0) / weights) * 10) / 10 : null;
    const now = Date.now();
    const timePct = p.startDate && p.endDate && p.endDate > p.startDate ? Math.min(100, Math.max(0, Math.round(((now - p.startDate.getTime()) / (p.endDate.getTime() - p.startDate.getTime())) * 1000) / 10)) : null;
    const kpis = (p.kpis ?? []).map((k) => {
      const span = k.target - (k.baseline ?? 0);
      const got = (k.actual ?? k.baseline ?? 0) - (k.baseline ?? 0);
      return Math.max(0, Math.min(100, span ? (got / span) * 100 : 0));
    });
    return {
      financeLinked: Boolean(projectId),
      budget,
      spent,
      capex,
      opex,
      capitalised,
      wip: Decimal.max(capex.minus(capitalised), 0),
      remaining: budget.minus(spent),
      spentPct: pct(spent, budget),
      physicalPct,
      timeElapsedPct: timePct,
      kpiAttainmentPct: kpis.length ? Math.round((kpis.reduce((a, b) => a + b, 0) / kpis.length) * 10) / 10 : null,
      /** Earned value: the share of the budget the physical progress has earned, against what was spent. */
      costPerformance: physicalPct !== null && spent.gt(0) ? Math.round(budget.times(physicalPct / 100).dividedBy(spent).toNumber() * 100) / 100 : null,
      byAccount: lines.map((l) => ({ code: l.code, name: l.name, accountClass: l.accountClass, amount: l.amount })).sort((a, b) => b.amount.comparedTo(a.amount)),
      monthly: await this.monthly(organisationId, 'projectId', projectId),
    };
  }

  async projects(user: AuthUser) {
    const rows = await this.db.projects.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean();
    return Promise.all(rows.map(async (p) => {
      const s = await this.projectStatus(user.organisationId, p);
      return { ...p, position: { ...s, byAccount: undefined, monthly: undefined } };
    }));
  }

  async project(user: AuthUser, id: Id) {
    const p = await this.load(user, id);
    const [grants, manager] = await Promise.all([this.db.grants.find({ _id: { $in: p.grantIds } }, { code: 1, title: 1, donorId: 1 }).lean(), p.managerId ? this.db.users.findById(p.managerId, { name: 1 }).lean() : null]);
    return { ...p, grants, manager: manager?.name ?? null, position: await this.projectStatus(user.organisationId, p) };
  }

  /** The whole portfolio: grants and projects, for the donor and management dashboard. */
  async dashboard(user: AuthUser) {
    const [grants, projects] = await Promise.all([this.grants(user), this.projects(user)]);
    const sum = <T,>(xs: T[], f: (x: T) => Decimal) => xs.reduce((t, x) => t.plus(f(x)), ZERO);
    const active = projects.filter((p) => p.status === 'ACTIVE');
    return {
      grants: { count: grants.length, committed: sum(grants, (g) => g.position.amount), received: sum(grants, (g) => g.position.received), spent: sum(grants, (g) => g.position.spent), behind: grants.filter((g) => g.position.pace === 'BEHIND').map((g) => g.code) },
      projects: { count: projects.length, active: active.length, budget: sum(projects, (p) => p.position.budget), spent: sum(projects, (p) => p.position.spent), capex: sum(projects, (p) => p.position.capex), wip: sum(projects, (p) => p.position.wip), overBudget: projects.filter((p) => p.position.spent.gt(p.position.budget) && p.position.budget.gt(0)).map((p) => p.code) },
      byDonor: Object.values(
        grants.reduce<Record<string, { donor: string; committed: Decimal; received: Decimal; spent: Decimal }>>((acc, g) => {
          const k = g.donor || 'Unknown';
          acc[k] ??= { donor: k, committed: ZERO, received: ZERO, spent: ZERO };
          acc[k].committed = acc[k].committed.plus(g.position.amount);
          acc[k].received = acc[k].received.plus(g.position.received);
          acc[k].spent = acc[k].spent.plus(g.position.spent);
          return acc;
        }, {}),
      ),
    };
  }

  // Donor reporting ---------------------------------------------------------------------------------

  private table(label: string, columns: QueryResult['columns'], rows: Record<string, unknown>[]): QueryResult {
    return { dataset: { key: 'projects', label }, columns, rows, truncated: false, ranAt: new Date() };
  }

  /** The donor report for a grant: summary, receipts, budget against actual, and the projects it funds. */
  async donorReportTables(organisationId: Id, id: Id) {
    const g = await this.db.grants.findOne({ _id: id, organisationId }).lean();
    if (!g) throw new NotFoundException('Grant not found');
    const [donor, s, projects] = await Promise.all([this.db.donors.findById(g.donorId, { name: 1 }).lean(), this.grantStatus(organisationId, g), this.db.projects.find({ organisationId, grantIds: g._id }).lean()]);
    const m = (d: Decimal) => Math.round(d.toNumber() * 100) / 100;
    const projectRows = await Promise.all(projects.map(async (p) => ({ p, s: await this.projectStatus(organisationId, p) })));
    return {
      grant: g,
      donor: donor?.name ?? '',
      tables: [
        this.table('Summary', [{ key: 'item', label: 'Item', type: 'text' }, { key: 'value', label: g.currency, type: 'money' }], [
          { item: 'Grant amount', value: m(s.amount) },
          { item: 'Received to date', value: m(s.received) },
          { item: 'Spent to date', value: m(s.spent) },
          { item: 'Cash held (received less spent)', value: m(s.cashBalance) },
          { item: 'Still to be received', value: m(s.undrawn) },
        ]),
        this.table('Budget against actual', [{ key: 'code', label: 'Line', type: 'text' }, { key: 'name', label: 'Budget line', type: 'text' }, { key: 'budget', label: 'Budget', type: 'money' }, { key: 'spent', label: 'Spent', type: 'money' }, { key: 'remaining', label: 'Remaining', type: 'money' }, { key: 'usedPct', label: '% used', type: 'number' }], [
          ...s.budget.map((b) => ({ code: b.code, name: b.name, budget: m(b.budget), spent: m(b.spent), remaining: m(b.remaining), usedPct: b.usedPct })),
          ...(s.unallocated.isZero() ? [] : [{ code: '', name: 'Not in any budget line', budget: 0, spent: m(s.unallocated), remaining: m(s.unallocated.neg()), usedPct: null }]),
        ]),
        this.table('Receipts from the donor', [{ key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Reference', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' }], (g.disbursements ?? []).map((d) => ({ date: d.date, reference: d.reference ?? '', amount: m(n(d.amount)) }))),
        this.table('Projects funded', [{ key: 'code', label: 'Project', type: 'text' }, { key: 'name', label: 'Name', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'spent', label: 'Spent', type: 'money' }, { key: 'physicalPct', label: 'Physical progress %', type: 'number' }, { key: 'kpiPct', label: 'KPI attainment %', type: 'number' }], projectRows.map(({ p, s: ps }) => ({ code: p.code, name: p.name, status: p.status, spent: m(ps.spent), physicalPct: ps.physicalPct, kpiPct: ps.kpiAttainmentPct }))),
        this.table('Project KPIs', [{ key: 'project', label: 'Project', type: 'text' }, { key: 'kpi', label: 'Indicator', type: 'text' }, { key: 'baseline', label: 'Baseline', type: 'number' }, { key: 'target', label: 'Target', type: 'number' }, { key: 'actual', label: 'Actual', type: 'number' }, { key: 'unit', label: 'Unit', type: 'text' }], projects.flatMap((p) => p.kpis.map((k) => ({ project: p.code, kpi: k.name, baseline: k.baseline, target: k.target, actual: k.actual, unit: k.unit ?? '' })))),
      ],
    };
  }

  async donorReport(user: AuthUser, id: Id, format: 'xls' | 'pdf' | 'doc' | 'csv') {
    const r = await this.donorReportTables(user.organisationId, id);
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    await this.audit.record(user, 'projects.grant.report', 'projectsGrant', id, { format });
    const title = `${r.grant.code} donor report`;
    if (format === 'xls') return new Response(workbook(r.tables.map((t) => ({ name: t.dataset.label, result: t }))), { headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': `attachment; filename="${r.grant.code}-donor-report.xls"` } });
    if (format === 'doc') return new Response(htmlReport(`${r.grant.title} (${r.donor})`, org?.name ?? '', r.tables.map((t) => ({ heading: t.dataset.label, result: t }))), { headers: { 'content-type': 'application/msword', 'content-disposition': `attachment; filename="${r.grant.code}-donor-report.doc"` } });
    // PDF and CSV carry the budget against actual, the heart of the report.
    return exportResult(r.tables[1], title, org?.name ?? '', format, `${r.donor}; ${r.grant.title}`);
  }

  /** The donor's read-only view through their portal link: their grants, positions and projects. */
  async donorPortal(token: string) {
    if (!token || token.length < 20) throw new NotFoundException('This link is not valid');
    const donor = await this.db.donors.findOne({ portalTokenHash: hash(token), portalEnabled: true }).lean();
    if (!donor) throw new NotFoundException('This link is not valid');
    const org = await this.db.organisations.findById(donor.organisationId, { name: 1, modules: 1 }).lean();
    if (!org?.modules?.includes('projects')) throw new NotFoundException('This link is not valid');
    const branding = await openPortal(this.db.connection, donor.organisationId, 'donors');
    const grants = await this.db.grants.find({ organisationId: donor.organisationId, donorId: donor._id, status: { $ne: 'PIPELINE' } }).lean();
    const out = [];
    for (const g of grants) {
      const r = await this.donorReportTables(donor.organisationId, g._id);
      const s = await this.grantStatus(donor.organisationId, g);
      out.push({ code: g.code, title: g.title, currency: g.currency, startDate: g.startDate, endDate: g.endDate, position: { ...s, monthly: s.monthly }, tables: r.tables.map((t) => ({ label: t.dataset.label, columns: t.columns, rows: t.rows })) });
    }
    return { organisation: org.name, branding, donor: donor.name, grants: out, at: new Date() };
  }
}
