import { defineModule } from '@/platform/module';
import { createServices, Services } from './core/container';
import { Db, registerFinanceModels } from './core/database/db.service';
import { FinanceLedger } from './ledger';
import { financeManifest } from './manifest';

export type FinanceServices = Services & { ready: () => Promise<void> };

/**
 * The finance module: FarajaSoft Accounting running inside the platform, on the platform's connection
 * (collections prefixed finance_), signed in through the platform, and serving its own API under
 * /api/v1/finance. It becomes the platform ledger, so other modules' journals land in it directly.
 */
export const financeModule = defineModule<FinanceServices, Record<string, never>>({
  manifest: financeManifest,
  models: (conn) => {
    registerFinanceModels(conn);
    return {};
  },
  services: ({ db }) => {
    const s = createServices(new Db(db.connection)) as FinanceServices;
    let readying: Promise<void> | null = null;
    // Collections and indexes, then data migrations: once per process, before the first finance request.
    s.ready = () =>
      (readying ??= (async () => {
        if (process.env.DB_SETUP_ON_START !== 'false') await s.db.ensureSchema();
        await s.provisioning.ensureReferenceData();
        await s.migrations.run(() => undefined);
      })().catch((err) => {
        readying = null;
        throw err;
      }));
    return s;
  },
  routes: [],
  mount: async () => (await import('./core/routes')).handleApi,
  start: ({ core, services }) => core.ledger.use(new FinanceLedger(core, services)),
});
