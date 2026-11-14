import type { CoreServices } from '@/platform/container';
import { TendersDb } from './db';
import { TendersService } from './tenders.service';

/** Tenders under the PPADA 2015: notices, sealed bids, opening, evaluation, opinion, award, standstill, appeals and contracts. */
export function buildTendersServices(db: TendersDb, core: CoreServices) {
  return {
    db,
    tenders: new TendersService(db, core.audit, core.sms, core.email),
  };
}

export type TendersServices = ReturnType<typeof buildTendersServices>;
