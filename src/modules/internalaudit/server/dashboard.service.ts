import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { Decimal, dec } from '@/platform/common/money';
import { isManager, onTeam } from './access';
import { iaSettings, InternalauditDb as Db } from './db';
import { AGEING_BANDS, ageing } from './findings.service';
import { RATINGS } from './schemas';

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/**
 * The internal audit dashboard for a year: plan delivery, engagements by stage, findings by rating,
 * recommendation implementation and ageing, auditor productivity (hours, engagements, papers,
 * findings) and engagement hours and costs against budget.
 */
export class DashboardService {
  constructor(private readonly db: Db) {}

  async dashboard(user: AuthUser, year: number) {
    const org = user.organisationId;
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Date.UTC(year + 1, 0, 1));
    const [settings, plan, allEngagements, time, costs, staff] = await Promise.all([
      iaSettings(this.db, org),
      this.db.plans.findOne({ organisationId: org, status: 'APPROVED', year: { $regex: String(year) } }).sort({ version: -1 }).lean(),
      this.db.engagements.find({ organisationId: org, $or: [{ start: { $gte: from, $lt: to } }, { start: null, createdAt: { $gte: from, $lt: to } }] }, { tasks: 0 }).lean(),
      this.db.time.find({ organisationId: org, date: { $gte: from, $lt: to } }).lean(),
      this.db.costs.find({ organisationId: org, date: { $gte: from, $lt: to } }).lean(),
      this.db.users.find({ organisationId: org, access: { $elemMatch: { module: 'internalaudit', role: { $in: ['HEAD', 'MANAGER', 'AUDITOR'] } } } }, { name: 1 }).lean(),
    ]);
    const engagements = allEngagements.filter((e) => isManager(user) || !e.restricted || onTeam(user, e));
    const ids = engagements.map((e) => e._id);
    const [findings, papers] = await Promise.all([
      this.db.findings.find({ organisationId: org, engagementId: { $in: ids } }, { updates: 0 }).lean(),
      this.db.workpapers.find({ organisationId: org, engagementId: { $in: ids } }, { preparedBy: 1, reviewedBy: 1, status: 1 }).lean(),
    ]);
    const rate = dec(settings.hourlyRate?.toString());
    const open = findings.filter((f) => ['AGREED', 'IN_PROGRESS', 'IMPLEMENTED'].includes(f.status));
    const tracked = findings.filter((f) => !['DRAFT', 'NOT_ACCEPTED'].includes(f.status));
    const done = tracked.filter((f) => f.status === 'VERIFIED');
    const overdue = findings.filter((f) => ['AGREED', 'IN_PROGRESS'].includes(f.status) && f.dueDate && f.dueDate < new Date());
    const items = plan?.items ?? [];
    const delivered = engagements.filter((e) => e.planId && ['ISSUED', 'CLOSED'].includes(e.status));
    const byId = (id: Types.ObjectId) => engagements.find((e) => e._id.equals(id));
    return {
      year,
      plan: plan
        ? { id: plan._id, title: plan.title, audits: items.length, started: items.filter((i) => i.engagementId).length, completed: items.filter((i) => i.engagementId && ['ISSUED', 'CLOSED'].includes(byId(i.engagementId)?.status ?? '')).length, plannedHours: items.reduce((t, i) => t + (i.hours ?? 0), 0), completionPct: pct(delivered.length, items.length) }
        : null,
      engagements: { total: engagements.length, byStatus: Object.fromEntries(['PLANNING', 'FIELDWORK', 'REPORTING', 'ISSUED', 'CLOSED', 'CANCELLED'].map((s) => [s, engagements.filter((e) => e.status === s).length])) },
      findings: { total: findings.filter((f) => f.status !== 'DRAFT').length, byRating: Object.fromEntries(RATINGS.map((r) => [r, findings.filter((f) => f.status !== 'DRAFT' && f.rating === r).length])) },
      recommendations: {
        tracked: tracked.length,
        open: open.length,
        verified: done.length,
        implementationPct: pct(done.length, tracked.length),
        overdue: overdue.length,
        ageing: AGEING_BANDS.map((b) => ({ band: b, count: open.filter((f) => ageing(f.status === 'IMPLEMENTED' ? null : f.dueDate).band === b).length })),
      },
      productivity: staff
        .map((u) => {
          const mine = time.filter((t) => t.userId.equals(u._id));
          return {
            id: u._id,
            name: u.name,
            hours: mine.reduce((t, x) => t + x.hours, 0),
            engagements: engagements.filter((e) => onTeam({ id: u._id } as AuthUser, e)).length,
            led: engagements.filter((e) => e.leadId.equals(u._id)).length,
            papersPrepared: papers.filter((p) => p.preparedBy?.equals(u._id)).length,
            papersReviewed: papers.filter((p) => p.reviewedBy?.equals(u._id)).length,
            findings: findings.filter((f) => f.createdBy?.equals(u._id)).length,
          };
        })
        .sort((a, b) => b.hours - a.hours),
      hoursByActivity: ['PLANNING', 'FIELDWORK', 'REVIEW', 'REPORTING', 'FOLLOW_UP', 'TRAVEL'].map((a) => ({ activity: a, hours: time.filter((t) => t.activity === a).reduce((s, t) => s + t.hours, 0) })),
      budget: engagements
        .map((e) => {
          const hours = time.filter((t) => t.engagementId.equals(e._id)).reduce((s, t) => s + t.hours, 0);
          const other = costs.filter((c) => c.engagementId.equals(e._id)).reduce((s, c) => s.plus(dec(c.amount?.toString())), new Decimal(0));
          return { id: e._id, number: e.number, title: e.title, status: e.status, budgetHours: e.budgetHours ?? 0, hours, variancePct: e.budgetHours ? Math.round(((hours - e.budgetHours) / e.budgetHours) * 1000) / 10 : null, cost: rate.times(hours).plus(other) };
        })
        .sort((a, b) => a.number.localeCompare(b.number)),
      totals: { hours: time.reduce((s, t) => s + t.hours, 0), cost: rate.times(time.reduce((s, t) => s + t.hours, 0)).plus(costs.reduce((s, c) => s.plus(dec(c.amount?.toString())), new Decimal(0))) },
    };
  }
}
