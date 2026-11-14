import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { serialize } from '../../common/serialize';
import { Db } from '../../database/db.service';

export interface AuditInput {
  action: string;
  recordType: string;
  recordId?: Types.ObjectId | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

const NOISE = new Set(['createdAt', 'updatedAt', 'lines']);

/** Never copied into the trail: credentials, keys and their hashes. A change shows as "[redacted]". */
export const SECRET_FIELDS = new Set(['passwordHash', 'secret', 'pendingSecret', 'recoveryCodes', 'tokenHash', 'hash', 'cmcKey', 'consumerKey', 'consumerSecret', 'passkey', 'securityCredential', 'clientSecret', 'callbackSecret', 'secretKey', 'webhookSecret', 'pushTokenHash']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object' || value instanceof Date || value instanceof Types.ObjectId) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!SECRET_FIELDS.has(k)) out[k] = redact(v);
    else if (!(v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length))) out[k] = '[redacted]';
  }
  return out;
}

/** Keeps only the fields that actually changed, so the trail shows clear before/after values. */
function diff(before: unknown, after: unknown): { before: unknown; after: unknown } {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return { before, after };
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const outB: Record<string, unknown> = {};
  const outA: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (NOISE.has(key)) continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      outB[key] = b[key];
      outA[key] = a[key];
    }
  }
  return { before: outB, after: outA };
}

/** Receives every audited action inside its transaction (the webhook outbox). */
export type AuditListener = (
  organisationId: Types.ObjectId,
  event: { type: string; recordType: string; recordId?: Types.ObjectId | null; summary?: string; actor?: string },
  session?: ClientSession,
) => Promise<void>;

export class AuditService {
  private listeners: AuditListener[] = [];

  constructor(private readonly db: Db) {}

  subscribe(listener: AuditListener) {
    this.listeners.push(listener);
  }

  async log(
    actor: AuthUser | { organisationId: Types.ObjectId; id?: null; name?: string },
    input: AuditInput,
    session?: ClientSession,
  ) {
    const serialized = diff(redact(serialize(input.before)), redact(serialize(input.after)));
    const user = 'email' in actor ? actor : null;
    await this.db.auditEvents.create(
      [
        {
          organisationId: actor.organisationId,
          userId: user?.id ?? null,
          userName: user?.name ?? actor.name ?? 'system',
          action: input.action,
          recordType: input.recordType,
          recordId: input.recordId ?? null,
          summary: input.summary ?? '',
          before: serialized.before ?? null,
          after: serialized.after ?? null,
          ipAddress: user?.ip ?? null,
          userAgent: user?.userAgent ?? null,
        },
      ],
      { session },
    );
    for (const listener of this.listeners) {
      await listener(actor.organisationId, { type: input.action, recordType: input.recordType, recordId: input.recordId ?? null, summary: input.summary, actor: user?.name ?? actor.name ?? 'system' }, session);
    }
  }
}
