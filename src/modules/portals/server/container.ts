import type { CoreServices } from '@/platform/container';
import { PortalsDb } from './db';
import { PortalsService } from './portals.service';

/** Portals, library and MSMEs. */
export function buildPortalsServices(db: PortalsDb, core: CoreServices) {
  return {
    db,
    portals: new PortalsService(db, core.audit, core.sms),
  };
}

export type PortalsServices = ReturnType<typeof buildPortalsServices>;
