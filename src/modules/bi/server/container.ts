import type { CoreServices } from '@/platform/container';
import { AnalyticsService } from './analytics.service';
import { DashboardsService } from './dashboards.service';
import { BiDb } from './db';
import { ReportsService } from './reports.service';

/** Reports & Analytics: the report builder and saved reports, dashboards, and organisation-wide analytics. */
export function buildBiServices(db: BiDb, core: CoreServices) {
  return {
    db,
    reports: new ReportsService(db, core.audit, core.email, core.manifests),
    dashboards: new DashboardsService(db, core.audit),
    analytics: new AnalyticsService(db),
  };
}

export type BiServices = ReturnType<typeof buildBiServices>;
