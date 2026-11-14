import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../auth';
import { Db } from '../db';

export class AuditService {
  constructor(private readonly db: Db) {}

  async record(user: Pick<AuthUser, 'id' | 'organisationId' | 'ip'> | { organisationId: Types.ObjectId; id?: undefined; ip?: null }, action: string, entity: string, entityId: Types.ObjectId | null, data?: unknown, session?: ClientSession) {
    await this.db.audit.create([{ organisationId: user.organisationId, userId: user.id ?? null, action, entity, entityId, data, ip: user.ip ?? null }], { session });
  }

  list(organisationId: Types.ObjectId, filter: { entity?: string; entityId?: Types.ObjectId; page: number; pageSize: number }) {
    const q: Record<string, unknown> = { organisationId };
    if (filter.entity) q.entity = filter.entity;
    if (filter.entityId) q.entityId = filter.entityId;
    return this.db.audit
      .find(q)
      .sort({ createdAt: -1 })
      .skip((filter.page - 1) * filter.pageSize)
      .limit(filter.pageSize)
      .lean();
  }
}
