import { Connection } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';

/** The portals module's collections, all prefixed portals_. */
export function portalsModels(conn: Connection) {
  return {
    settings: defineModel(conn, 'PortalSettings', S.portalSettingsSchema, 'portals_settings'),
    library: defineModel(conn, 'PortalLibraryItem', S.libraryItemSchema, 'portals_library'),
    msmes: defineModel(conn, 'PortalMsme', S.msmeSchema, 'portals_msmes'),
  };
}

export type PortalsModels = ReturnType<typeof portalsModels>;
export type PortalsDb = Db & PortalsModels;
