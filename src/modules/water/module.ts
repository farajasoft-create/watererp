import { defineModule } from '@/platform/module';
import { waterManifest } from './manifest';
import { buildWaterServices, WaterServices } from './server/container';
import { waterModels, WaterModels } from './server/db';
import { customerRoutes } from './server/routes/customers';
import { operationsRoutes } from './server/routes/operations';
import { setupRoutes } from './server/routes/setup';
import { serviceRoutes } from './server/routes/service';
import { opsRoutes } from './server/routes/ops';
import { seedWater } from './server/seed';

export const waterModule = defineModule<WaterServices, WaterModels>({
  manifest: waterManifest,
  models: waterModels,
  services: ({ db, core }) => buildWaterServices(db, core),
  routes: [...setupRoutes, ...customerRoutes, ...operationsRoutes, ...serviceRoutes, ...opsRoutes],
  seed: seedWater,
});
