import { defineModule } from '@/platform/module';
import { tendersManifest } from './manifest';
import { buildTendersServices, TendersServices } from './server/container';
import { tendersModels, TendersModels } from './server/db';
import { tendersRoutes } from './server/routes';

export const tendersModule = defineModule<TendersServices, TendersModels>({
  manifest: tendersManifest,
  models: tendersModels,
  services: ({ db, core }) => buildTendersServices(db, core),
  routes: tendersRoutes,
  // start: ({ core, services }) => { core.events.on('water.payment.posted', ...) },
  // seed: async ({ services, organisationId, demo }) => { ... },
});
