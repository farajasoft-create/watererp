import { defineModule } from '@/platform/module';
import { biManifest } from './manifest';
import { BiServices, buildBiServices } from './server/container';
import { biModels, BiModels } from './server/db';
import { biRoutes } from './server/routes';

export const biModule = defineModule<BiServices, BiModels>({
  manifest: biManifest,
  models: biModels,
  services: ({ db, core }) => buildBiServices(db, core),
  routes: biRoutes,
});
