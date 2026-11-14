import { Connection } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';

/** The estates module's collections, all prefixed estates_. */
export function estatesModels(conn: Connection) {
  return {
    properties: defineModel(conn, 'EstatesProperty', S.propertySchema, 'estates_properties'),
    tenants: defineModel(conn, 'EstatesTenant', S.tenantSchema, 'estates_tenants'),
    leases: defineModel(conn, 'EstatesLease', S.leaseSchema, 'estates_leases'),
    maintenance: defineModel(conn, 'EstatesMaintenance', S.maintenanceSchema, 'estates_maintenance'),
  };
}

export type EstatesModels = ReturnType<typeof estatesModels>;
export type EstatesDb = Db & EstatesModels;
