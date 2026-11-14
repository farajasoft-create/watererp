import type { CoreServices } from '@/platform/container';
import { ProjectsDb } from './db';
import { ProjectsService } from './projects.service';

/** Projects & Donors: grants, projects, ledger-based spending, donor reporting and the donor portal. */
export function buildProjectsServices(db: ProjectsDb, core: CoreServices) {
  return {
    db,
    projects: new ProjectsService(db, core.audit),
  };
}

export type ProjectsServices = ReturnType<typeof buildProjectsServices>;
