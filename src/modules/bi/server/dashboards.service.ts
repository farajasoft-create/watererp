import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../manifest';
import { BiDb as Db } from './db';
import { QuerySpec, runQuery } from './engine';
import { htmlReport, safeName, workbook } from './exports';
import { CHARTS, DashboardDoc } from './schemas';

type Id = Types.ObjectId;
const isAdmin = (u: AuthUser) => u.isAdmin || hasPermission(u, P.ADMIN);

export interface DashboardInput {
  name: string;
  description?: string;
  featured?: boolean;
  refreshSeconds: number;
  tiles: { reportId: Id; title?: string; chart?: (typeof CHARTS)[number] | null; width: number }[];
}

/**
 * Configurable dashboards: tiles of saved reports (KPI figures, charts, tables), refreshed on a timer
 * from the live data, shared like reports, and exported whole to Excel or Word.
 */
export class DashboardsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private canSee(user: AuthUser, d: Pick<DashboardDoc, 'ownerId' | 'everyone' | 'sharedWith'>) {
    return isAdmin(user) || d.ownerId.equals(user.id) || d.everyone || (d.sharedWith ?? []).some((x) => x.equals(user.id));
  }

  private async load(user: AuthUser, id: Id) {
    const d = await this.db.dashboards.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!d || !this.canSee(user, d)) throw new NotFoundException('Dashboard not found');
    return d;
  }

  async list(user: AuthUser) {
    const rows = await this.db.dashboards.find({ organisationId: user.organisationId, ...(!isAdmin(user) && { $or: [{ ownerId: user.id }, { everyone: true }, { sharedWith: user.id }] }) }).sort({ featured: -1, name: 1 }).lean();
    return rows.map((d) => ({ ...d, mine: d.ownerId.equals(user.id) }));
  }

  private async checkTiles(user: AuthUser, tiles: DashboardInput['tiles']) {
    const reports = await this.db.reports.find({ organisationId: user.organisationId, _id: { $in: tiles.map((t) => t.reportId) } }, { ownerId: 1, everyone: 1, sharedWith: 1 }).lean();
    for (const t of tiles) {
      const r = reports.find((x) => x._id.equals(t.reportId));
      if (!r || !(isAdmin(user) || r.ownerId.equals(user.id) || r.everyone || r.sharedWith.some((s) => s.equals(user.id)))) throw new BadRequestException('A tile uses a report you cannot open');
    }
  }

  async save(user: AuthUser, id: Id | null, input: DashboardInput) {
    if (input.featured && !isAdmin(user)) throw new ForbiddenException('Only a BI administrator features dashboards');
    await this.checkTiles(user, input.tiles);
    if (id) {
      const d = await this.load(user, id);
      if (!d.ownerId.equals(user.id) && !isAdmin(user)) throw new ForbiddenException('Only the owner changes this dashboard');
      await this.db.dashboards.updateOne({ _id: id }, input);
    } else {
      const [d] = await this.db.dashboards.create([{ ...input, organisationId: user.organisationId, ownerId: user.id, ownerName: user.name }]);
      id = d._id;
    }
    await this.audit.record(user, 'bi.dashboard.save', 'biDashboard', id, { name: input.name, tiles: input.tiles.length });
    return this.db.dashboards.findById(id).lean();
  }

  async share(user: AuthUser, id: Id, input: { everyone: boolean; sharedWith: Id[] }) {
    const d = await this.load(user, id);
    if (!d.ownerId.equals(user.id) && !isAdmin(user)) throw new ForbiddenException('Only the owner shares this dashboard');
    if (input.everyone && !isAdmin(user)) throw new ForbiddenException('Only a BI administrator shares with everyone');
    await this.db.dashboards.updateOne({ _id: id }, input);
    // People who can see the dashboard can see its tiles' reports.
    await this.db.reports.updateMany({ _id: { $in: d.tiles.map((t) => t.reportId) }, organisationId: user.organisationId }, input.everyone ? { everyone: true } : { $addToSet: { sharedWith: { $each: input.sharedWith } } });
    await this.audit.record(user, 'bi.dashboard.share', 'biDashboard', id, { everyone: input.everyone, people: input.sharedWith.length });
    return this.db.dashboards.findById(id).lean();
  }

  async remove(user: AuthUser, id: Id) {
    const d = await this.load(user, id);
    if (!d.ownerId.equals(user.id) && !isAdmin(user)) throw new ForbiddenException('Only the owner deletes this dashboard');
    await this.db.dashboards.deleteOne({ _id: id });
    await this.audit.record(user, 'bi.dashboard.delete', 'biDashboard', id, { name: d.name });
    return { ok: true };
  }

  /** Every tile worked out now, with the viewer's own data permissions; a tile that fails says why. */
  async run(user: AuthUser, id: Id) {
    const d = await this.load(user, id);
    const reports = await this.db.reports.find({ organisationId: user.organisationId, _id: { $in: d.tiles.map((t) => t.reportId) } }).lean();
    const tiles = await Promise.all(
      d.tiles.map(async (t) => {
        const r = reports.find((x) => x._id.equals(t.reportId));
        if (!r) return { id: t._id, title: t.title ?? 'Removed report', width: t.width, error: 'The report was removed' };
        try {
          const result = await runQuery(this.db, user, r.spec as QuerySpec);
          return { id: t._id, reportId: r._id, title: t.title || r.name, chart: t.chart || r.chart, width: t.width, spec: r.spec, result };
        } catch (err) {
          return { id: t._id, reportId: r._id, title: t.title || r.name, width: t.width, error: (err as Error).message };
        }
      }),
    );
    await this.audit.record(user, 'bi.dashboard.view', 'biDashboard', id, {});
    return { dashboard: { ...d, mine: d.ownerId.equals(user.id) }, tiles, ranAt: new Date() };
  }

  async export(user: AuthUser, id: Id, format: 'xls' | 'doc') {
    const { dashboard, tiles } = await this.run(user, id);
    const ok = tiles.filter((t): t is typeof t & { result: NonNullable<(typeof t)['result']> } => 'result' in t && Boolean(t.result));
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    await this.audit.record(user, 'bi.dashboard.export', 'biDashboard', id, { format });
    const name = safeName(dashboard.name);
    if (format === 'xls') return new Response(workbook(ok.map((t) => ({ name: t.title, result: t.result }))), { headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': `attachment; filename="${name}.xls"` } });
    return new Response(htmlReport(dashboard.name, org?.name ?? '', ok.map((t) => ({ heading: t.title, result: t.result }))), { headers: { 'content-type': 'application/msword', 'content-disposition': `attachment; filename="${name}.doc"` } });
  }
}
