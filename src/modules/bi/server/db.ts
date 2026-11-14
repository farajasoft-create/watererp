import { Connection } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';

/** The BI module's collections, all prefixed bi_. */
export function biModels(conn: Connection) {
  return {
    reports: defineModel(conn, 'BiReport', S.reportSchema, 'bi_reports'),
    dashboards: defineModel(conn, 'BiDashboard', S.dashboardSchema, 'bi_dashboards'),
  };
}

export type BiModels = ReturnType<typeof biModels>;
export type BiDb = Db & BiModels;
