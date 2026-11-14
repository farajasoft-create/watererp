import type { CoreServices } from '@/platform/container';
import { DashboardService } from './dashboard.service';
import { InternalauditDb } from './db';
import { EngagementsService } from './engagements.service';
import { FindingsService } from './findings.service';
import { PlanningService } from './planning.service';

/** Internal audit: planning (universe, risks, plans), engagements, findings and the dashboard. */
export function buildInternalauditServices(db: InternalauditDb, core: CoreServices) {
  const engagements = new EngagementsService(db, core.audit, core.notifications);
  return {
    db,
    planning: new PlanningService(db, core.audit, core.notifications),
    engagements,
    findings: new FindingsService(db, core.audit, core.notifications, engagements),
    dashboard: new DashboardService(db),
  };
}

export type InternalauditServices = ReturnType<typeof buildInternalauditServices>;
