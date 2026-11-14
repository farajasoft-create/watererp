import type { CoreServices } from '@/platform/container';
import { OfficeAssetsService } from './assets.service';
import { CircularsService } from './circulars.service';
import { IctDb } from './db';
import { HelpdeskService } from './helpdesk.service';

/** The ICT & Administration module's services: the IT help desk and office assets. */
export function buildIctServices(db: IctDb, core: CoreServices) {
  return {
    db,
    helpdesk: new HelpdeskService(db, core.audit, core.notifications),
    assets: new OfficeAssetsService(db, core.audit, core.notifications),
    circulars: new CircularsService(db, core.audit, core.notifications),
  };
}

export type IctServices = ReturnType<typeof buildIctServices>;
