import { defineModule } from '@/platform/module';
import { hrManifest } from './manifest';
import { buildHrServices, HrServices } from './server/container';
import { hrModels, HrModels } from './server/db';
import { employeeRoutes } from './server/routes/employees';
import { payrollRoutes } from './server/routes/payroll';
import { leaveRoutes, selfRoutes } from './server/routes/leave';
import { setupRoutes } from './server/routes/setup';
import { structureRoutes } from './server/routes/structure';
import { recruitmentRoutes } from './server/routes/recruitment';
import { relationsRoutes } from './server/routes/relations';
import { performanceRoutes } from './server/routes/performance';
import { fleetRoutes } from './server/routes/fleet';
import { seedHr } from './server/seed';

export const hrModule = defineModule<HrServices, HrModels>({
  manifest: hrManifest,
  models: hrModels,
  services: ({ db, core }) => buildHrServices(db, core),
  routes: [...setupRoutes, ...structureRoutes, ...recruitmentRoutes, ...relationsRoutes, ...performanceRoutes, ...fleetRoutes, ...employeeRoutes, ...payrollRoutes, ...leaveRoutes, ...selfRoutes],
  seed: seedHr,
});
