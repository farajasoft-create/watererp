import { ClientSession, Connection, Types } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import { circularSchema } from './circulars.service';
import * as S from './schemas';

/** The ict module's collections, all prefixed ict_. */
export function ictModels(conn: Connection) {
  return {
    ictSettings: defineModel(conn, 'IctSettings', S.ictSettingsSchema, 'ict_settings'),
    categories: defineModel(conn, 'IctCategory', S.categorySchema, 'ict_categories'),
    tickets: defineModel(conn, 'IctTicket', S.ticketSchema, 'ict_tickets'),
    officeAssets: defineModel(conn, 'IctOfficeAsset', S.officeAssetSchema, 'ict_office_assets'),
    consumables: defineModel(conn, 'IctConsumable', S.consumableSchema, 'ict_consumables'),
    consumableMoves: defineModel(conn, 'IctConsumableMove', S.consumableMoveSchema, 'ict_consumable_moves'),
    circulars: defineModel(conn, 'IctCircular', circularSchema, 'ict_circulars'),
  };
}

export type IctModels = ReturnType<typeof ictModels>;
export type IctDb = Db & IctModels;

/** The organisation's help desk settings, created with defaults on first use. */
export async function ictSettings(db: IctDb, organisationId: Types.ObjectId, session?: ClientSession) {
  const doc = await db.ictSettings.findOneAndUpdate({ organisationId }, { $setOnInsert: { organisationId } }, { upsert: true, new: true, session }).lean();
  return doc!;
}

/** Puts the standard help desk categories in place for an organisation that has none. */
export async function ensureCategories(db: IctDb, organisationId: Types.ObjectId) {
  if (await db.categories.exists({ organisationId })) return;
  await db.categories.insertMany(S.DEFAULT_CATEGORIES.map((c) => ({ ...c, organisationId })), { ordered: false }).catch(() => undefined);
}
