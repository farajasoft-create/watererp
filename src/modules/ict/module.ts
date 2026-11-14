import { defineModule } from '@/platform/module';
import { ictManifest } from './manifest';
import { buildIctServices, IctServices } from './server/container';
import { ensureCategories, ictModels, IctModels, ictSettings } from './server/db';
import { ictRoutes } from './server/routes';

export const ictModule = defineModule<IctServices, IctModels>({
  manifest: ictManifest,
  models: ictModels,
  services: ({ db, core }) => buildIctServices(db, core),
  routes: ictRoutes,
  seed: async ({ services, organisationId }) => {
    await ictSettings(services.db, organisationId);
    await ensureCategories(services.db, organisationId);
  },
});
