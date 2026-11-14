import { defineModule } from '@/platform/module';
import { portalsManifest } from './manifest';
import { buildPortalsServices, PortalsServices } from './server/container';
import { portalsModels, PortalsModels } from './server/db';
import { portalsRoutes } from './server/routes';

export const portalsModule = defineModule<PortalsServices, PortalsModels>({
  manifest: portalsManifest,
  models: portalsModels,
  services: ({ db, core }) => buildPortalsServices(db, core),
  routes: portalsRoutes,
});
