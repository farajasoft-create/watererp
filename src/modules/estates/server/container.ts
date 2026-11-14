import type { CoreServices } from '@/platform/container';
import { EstatesDb } from './db';
import { EstatesService } from './estates.service';

/** Estates & Tenants: properties, leases, rent, statements, maintenance and the tenant portal. */
export function buildEstatesServices(db: EstatesDb, core: CoreServices) {
  return {
    db,
    estates: new EstatesService(db, core.audit, core.sms),
  };
}

export type EstatesServices = ReturnType<typeof buildEstatesServices>;
