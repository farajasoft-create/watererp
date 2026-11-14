import { Connection, Types } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';

/** The internal audit module's collections, all prefixed internalaudit_. */
export function internalauditModels(conn: Connection) {
  return {
    iaSettings: defineModel(conn, 'IaSettings', S.iaSettingsSchema, 'internalaudit_settings'),
    universe: defineModel(conn, 'IaUniverse', S.universeSchema, 'internalaudit_universe'),
    risks: defineModel(conn, 'IaRisk', S.riskSchema, 'internalaudit_risks'),
    programmes: defineModel(conn, 'IaProgramme', S.programmeSchema, 'internalaudit_programmes'),
    plans: defineModel(conn, 'IaPlan', S.planSchema, 'internalaudit_plans'),
    engagements: defineModel(conn, 'IaEngagement', S.engagementSchema, 'internalaudit_engagements'),
    workpapers: defineModel(conn, 'IaWorkpaper', S.workpaperSchema, 'internalaudit_workpapers'),
    findings: defineModel(conn, 'IaFinding', S.findingSchema, 'internalaudit_findings'),
    time: defineModel(conn, 'IaTime', S.timeSchema, 'internalaudit_time'),
    costs: defineModel(conn, 'IaCost', S.costSchema, 'internalaudit_costs'),
  };
}

export type InternalauditModels = ReturnType<typeof internalauditModels>;
export type InternalauditDb = Db & InternalauditModels;

export async function iaSettings(db: InternalauditDb, organisationId: Types.ObjectId) {
  return (await db.iaSettings.findOneAndUpdate({ organisationId }, { $setOnInsert: { organisationId } }, { upsert: true, new: true }).lean())!;
}
