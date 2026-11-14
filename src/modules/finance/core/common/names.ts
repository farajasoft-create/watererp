import { Types } from 'mongoose';
import { Db } from '../database/db.service';

/** Resolves user ids to display names for approval trails. */
export async function userNames(db: Db, ids: (Types.ObjectId | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const users = unique.length ? await db.users.find({ _id: { $in: unique } }, { name: 1 }).lean() : [];
  const map = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  return (id: Types.ObjectId | null | undefined) => (id ? (map.get(id.toHexString()) ?? '') : null);
}

/** Workflow fields with names attached, for detail views. */
export async function withTrail<T extends { createdBy: Types.ObjectId; submittedBy?: Types.ObjectId | null; approvedBy?: Types.ObjectId | null; rejectedBy?: Types.ObjectId | null; voidedBy?: Types.ObjectId | null }>(
  db: Db,
  record: T,
) {
  const name = await userNames(db, [record.createdBy, record.submittedBy, record.approvedBy, record.rejectedBy, record.voidedBy]);
  return {
    ...record,
    createdByName: name(record.createdBy),
    submittedByName: name(record.submittedBy),
    approvedByName: name(record.approvedBy),
    rejectedByName: name(record.rejectedBy),
    voidedByName: name(record.voidedBy),
  };
}
