import { Types } from 'mongoose';
import { AuthUser, hasPermission, toAuthUser } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { ModuleManifest } from '@/platform/manifest';
import { AuditService } from '@/platform/services/audit.service';
import { EmailService } from '@/platform/services/email.service';
import { PERMISSIONS as P } from '../manifest';
import { BiDb as Db } from './db';
import { catalogue, drillSpec, QueryResult, QuerySpec, runQuery } from './engine';
import { exportResult, ExportFormat, htmlReport } from './exports';
import { CHARTS, FREQUENCIES, ReportDoc } from './schemas';

type Id = Types.ObjectId;
type Chart = (typeof CHARTS)[number];
const isAdmin = (u: AuthUser) => u.isAdmin || hasPermission(u, P.ADMIN);

export interface ReportInput { name: string; description?: string; folder?: string; spec: QuerySpec; chart: Chart; note?: string }

/** A one-line description of a report's filters, printed on exports. */
export function describeFilters(spec: QuerySpec) {
  return (spec.filters ?? []).map((f) => `${f.field} ${f.op}${f.value !== undefined ? ` ${Array.isArray(f.value) ? f.value.join('/') : String(f.value).slice(0, 10)}` : ''}${f.to ? `–${String(f.to).slice(0, 10)}` : ''}`).join('; ');
}

/** When a schedule next runs, at `hour` East Africa time (UTC+3). */
export function nextRun(frequency: (typeof FREQUENCIES)[number], hour: number, after = new Date()) {
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), hour - 3, 0, 0));
  const step = () => {
    if (frequency === 'DAILY') d.setUTCDate(d.getUTCDate() + 1);
    else if (frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
  };
  if (frequency === 'WEEKLY') while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  if (frequency === 'MONTHLY') d.setUTCDate(1);
  while (d <= after) step();
  return d;
}

/**
 * Saved reports: built once over any dataset the author may see, shared with named people or
 * everyone, versioned on every change with rollback, exported to Excel, PDF, Word and CSV, emailed on
 * a schedule, and every opening, run and export recorded.
 */
export class ReportsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly manifests: readonly ModuleManifest[],
  ) {}

  catalogue(user: AuthUser) {
    return catalogue(user);
  }

  query(user: AuthUser, spec: QuerySpec) {
    return runQuery(this.db, user, spec);
  }

  drill(user: AuthUser, spec: QuerySpec, values: Record<string, unknown>) {
    return runQuery(this.db, user, drillSpec(spec, values));
  }

  private canSee(user: AuthUser, r: Pick<ReportDoc, 'ownerId' | 'everyone' | 'sharedWith'>) {
    return isAdmin(user) || r.ownerId.equals(user.id) || r.everyone || (r.sharedWith ?? []).some((x) => x.equals(user.id));
  }

  private async load(user: AuthUser, id: Id) {
    const r = await this.db.reports.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r || !this.canSee(user, r)) throw new NotFoundException('Report not found');
    return r;
  }

  private async own(user: AuthUser, id: Id) {
    const r = await this.load(user, id);
    if (!r.ownerId.equals(user.id) && !isAdmin(user)) throw new ForbiddenException('Only the owner changes this report; save a copy instead');
    return r;
  }

  async list(user: AuthUser) {
    const filter = isAdmin(user) ? { organisationId: user.organisationId, archived: { $ne: true } } : { organisationId: user.organisationId, archived: { $ne: true }, $or: [{ ownerId: user.id }, { everyone: true }, { sharedWith: user.id }] };
    const rows = await this.db.reports.find(filter, { versions: 0 }).sort({ folder: 1, name: 1 }).lean();
    return rows.map((r) => ({ ...r, mine: r.ownerId.equals(user.id), scheduled: Boolean(r.schedule?.frequency) }));
  }

  async get(user: AuthUser, id: Id) {
    const r = await this.load(user, id);
    await this.audit.record(user, 'bi.report.view', 'biReport', id, { name: r.name });
    return { ...r, versions: (r.versions ?? []).map(({ spec: _s, ...v }) => v), mine: r.ownerId.equals(user.id) };
  }

  async create(user: AuthUser, input: ReportInput) {
    await runQuery(this.db, user, { ...input.spec, limit: 1 });
    const [r] = await this.db.reports.create([{ organisationId: user.organisationId, name: input.name, description: input.description, folder: input.folder || 'General', spec: input.spec, chart: input.chart, ownerId: user.id, ownerName: user.name }]);
    await this.audit.record(user, 'bi.report.create', 'biReport', r._id, { name: input.name, dataset: input.spec.dataset });
    return r.toObject();
  }

  /** Saving keeps the previous definition as a version. */
  async update(user: AuthUser, id: Id, input: ReportInput) {
    const r = await this.own(user, id);
    await runQuery(this.db, user, { ...input.spec, limit: 1 });
    await this.db.reports.updateOne(
      { _id: id, version: r.version },
      { name: input.name, description: input.description, folder: input.folder || 'General', spec: input.spec, chart: input.chart, version: r.version + 1, $push: { versions: { version: r.version, name: r.name, spec: r.spec, chart: r.chart, savedBy: user.id, savedByName: user.name, at: new Date(), note: input.note } } },
    );
    await this.audit.record(user, 'bi.report.update', 'biReport', id, { version: r.version + 1, note: input.note });
    return this.get(user, id);
  }

  /** Puts an earlier version back; the current one is kept as a version too, so nothing is lost. */
  async rollback(user: AuthUser, id: Id, version: number) {
    const r = await this.own(user, id);
    const v = (r.versions ?? []).find((x) => x.version === version);
    if (!v) throw new NotFoundException(`Version ${version} not found`);
    return this.update(user, id, { name: v.name ?? r.name, description: r.description ?? undefined, folder: r.folder ?? undefined, spec: v.spec as QuerySpec, chart: (v.chart as Chart) ?? r.chart, note: `Rolled back to version ${version}` });
  }

  async versionSpec(user: AuthUser, id: Id, version: number) {
    const r = await this.load(user, id);
    const v = (r.versions ?? []).find((x) => x.version === version);
    if (!v) throw new NotFoundException(`Version ${version} not found`);
    return v;
  }

  async share(user: AuthUser, id: Id, input: { everyone: boolean; sharedWith: Id[] }) {
    await this.own(user, id);
    if (input.everyone && !isAdmin(user)) throw new ForbiddenException('Only a BI administrator shares reports with everyone');
    await this.db.reports.updateOne({ _id: id }, { everyone: input.everyone, sharedWith: input.sharedWith });
    await this.audit.record(user, 'bi.report.share', 'biReport', id, { everyone: input.everyone, people: input.sharedWith.length });
    return this.get(user, id);
  }

  async archive(user: AuthUser, id: Id) {
    await this.own(user, id);
    await this.db.reports.updateOne({ _id: id }, { archived: true, 'schedule.frequency': null, 'schedule.nextRunAt': null });
    await this.audit.record(user, 'bi.report.archive', 'biReport', id, {});
    return { ok: true };
  }

  /** Runs a saved report, optionally with extra filters (a period chosen on the page). */
  async run(user: AuthUser, id: Id, extra: QuerySpec['filters'] = []) {
    const r = await this.load(user, id);
    const spec = r.spec as QuerySpec;
    const result = await runQuery(this.db, user, { ...spec, filters: [...(spec.filters ?? []), ...extra] });
    await this.audit.record(user, 'bi.report.run', 'biReport', id, { rows: result.rows.length });
    return { report: { id: r._id, name: r.name, chart: r.chart, spec }, result };
  }

  async export(user: AuthUser, id: Id, format: ExportFormat, extra: QuerySpec['filters'] = []) {
    const { report, result } = await this.run(user, id, extra);
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    await this.audit.record(user, 'bi.report.export', 'biReport', id, { format });
    return exportResult(result, report.name, org?.name ?? '', format, describeFilters({ ...report.spec, filters: [...(report.spec.filters ?? []), ...extra] }) || undefined);
  }

  async exportAdhoc(user: AuthUser, spec: QuerySpec, format: ExportFormat, title: string) {
    const result = await runQuery(this.db, user, spec);
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    await this.audit.record(user, 'bi.query.export', 'biReport', null, { dataset: spec.dataset, format });
    return exportResult(result, title, org?.name ?? '', format, describeFilters(spec) || undefined);
  }

  /** Who opened, ran, exported or changed the report. */
  async accessLog(user: AuthUser, id: Id) {
    const r = await this.load(user, id);
    if (!r.ownerId.equals(user.id) && !isAdmin(user)) throw new ForbiddenException('The owner and BI administrators see the access log');
    const rows = await this.db.audit.find({ organisationId: user.organisationId, entity: 'biReport', entityId: id }).sort({ createdAt: -1 }).limit(1000).lean();
    const users = await this.db.users.find({ _id: { $in: rows.map((x) => x.userId).filter(Boolean) } }, { name: 1 }).lean();
    return rows.map((x) => ({ at: x.createdAt, who: users.find((u) => x.userId && u._id.equals(x.userId))?.name ?? 'Schedule', action: x.action.replace('bi.report.', ''), detail: x.data ?? {}, ip: x.ip ?? '' }));
  }

  async schedule(user: AuthUser, id: Id, input: { frequency: (typeof FREQUENCIES)[number] | null; hour: number; recipients: Id[]; emails: string[] }) {
    await this.own(user, id);
    if (input.frequency && !input.recipients.length && !input.emails.length) throw new BadRequestException('Say who receives it');
    const people = await this.db.users.countDocuments({ organisationId: user.organisationId, _id: { $in: input.recipients } });
    if (people !== input.recipients.length) throw new BadRequestException('Recipient not found');
    await this.db.reports.updateOne({ _id: id }, { schedule: { frequency: input.frequency, hour: input.hour, recipients: input.recipients, emails: input.emails, nextRunAt: input.frequency ? nextRun(input.frequency, input.hour) : null } });
    await this.audit.record(user, 'bi.report.schedule', 'biReport', id, { frequency: input.frequency, recipients: input.recipients.length + input.emails.length });
    return this.get(user, id);
  }

  /**
   * Sends scheduled reports that are due, run as their owner (so nobody receives data the owner cannot
   * see), as an email with the table and a link. Run it every few minutes.
   */
  async deliverDue(organisationId: Id, now = new Date()) {
    const due = await this.db.reports.find({ organisationId, archived: { $ne: true }, 'schedule.frequency': { $ne: null }, 'schedule.nextRunAt': { $lte: now } }).lean();
    const org = await this.db.organisations.findById(organisationId, { name: 1, modules: 1 }).lean();
    let sent = 0;
    let failed = 0;
    for (const r of due) {
      const s = r.schedule!;
      const next = nextRun(s.frequency as (typeof FREQUENCIES)[number], s.hour ?? 7, now);
      try {
        const owner = await this.db.users.findOne({ _id: r.ownerId, active: { $ne: false } }).lean();
        if (!owner) throw new Error('The owner no longer has an account');
        const asOwner = toAuthUser(owner, org?.modules ?? [], null, this.manifests);
        const result: QueryResult = await runQuery(this.db, asOwner, { ...(r.spec as QuerySpec), limit: 200 });
        const html = htmlReport(r.name, org?.name ?? '', [{ heading: r.description || result.dataset.label, result, note: describeFilters(r.spec as QuerySpec) || undefined }]);
        const people = await this.db.users.find({ _id: { $in: s.recipients ?? [] }, active: { $ne: false } }, { email: 1 }).lean();
        const to = [...new Set([...people.map((p) => p.email), ...(s.emails ?? [])])];
        for (const addr of to) await this.email.queue(organisationId, addr, `${r.name} (${s.frequency!.toLowerCase()} report)`, `${r.name}: ${result.rows.length} rows. Open: /bi/reports/${r._id.toHexString()}`, 'bi:scheduled-report', r._id, html);
        await this.db.reports.updateOne({ _id: r._id }, { 'schedule.lastRunAt': now, 'schedule.nextRunAt': next, 'schedule.lastStatus': `Sent to ${to.length}` });
        await this.audit.record({ organisationId }, 'bi.report.scheduled', 'biReport', r._id, { recipients: to.length, rows: result.rows.length });
        sent++;
      } catch (err) {
        await this.db.reports.updateOne({ _id: r._id }, { 'schedule.lastRunAt': now, 'schedule.nextRunAt': next, 'schedule.lastStatus': `Failed: ${(err as Error).message}` });
        failed++;
      }
    }
    if (sent) await this.email.deliverDue(organisationId);
    return { sent, failed };
  }
}
