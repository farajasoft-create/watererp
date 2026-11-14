import { defineModule } from '@/platform/module';
import { estatesManifest } from './manifest';
import { buildEstatesServices, EstatesServices } from './server/container';
import { estatesModels, EstatesModels } from './server/db';
import { estatesRoutes } from './server/routes';

export const estatesModule = defineModule<EstatesServices, EstatesModels>({
  manifest: estatesManifest,
  models: estatesModels,
  services: ({ db, core }) => buildEstatesServices(db, core),
  routes: estatesRoutes,
});
