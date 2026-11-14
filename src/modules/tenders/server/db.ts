import { Connection } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';

/** The tenders module's collections, all prefixed tenders_. */
export function tendersModels(conn: Connection) {
  return {
    tenders: defineModel(conn, 'Tender', S.tenderSchema, 'tenders_tenders'),
    bids: defineModel(conn, 'TenderBid', S.bidSchema, 'tenders_bids'),
    settings: defineModel(conn, 'TenderSettings', S.tenderSettingsSchema, 'tenders_settings'),
  };
}

export type TendersModels = ReturnType<typeof tendersModels>;
export type TendersDb = Db & TendersModels;
