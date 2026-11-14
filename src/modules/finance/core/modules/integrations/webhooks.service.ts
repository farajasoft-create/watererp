import { createHmac, randomBytes } from 'node:crypto';
import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Db } from '../../database/db.service';
import { WebhookDelivery, WebhookEndpoint } from '../../database/platform.schemas';

/** Retry schedule after a failed attempt; after the last one the delivery is marked FAILED. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720, 1440];
const DISABLE_AFTER_FAILURES = 15;
const TIMEOUT_MS = 10_000;

/** Audit actions that are not business events. */
const NOT_EVENTS = /^(auth\.|view$)/;

/**
 * Event catalogue published to subscribers. Events are thin: they say what happened to which record,
 * and receivers fetch the record through the API (so payloads never go stale or leak more than the
 * API key may read).
 */
export const WEBHOOK_EVENTS: { type: string; description: string }[] = [
  ['journal.post', 'A journal (manual or system) was posted to the ledger'],
  ['journal.reverse', 'A posted journal was reversed'],
  ['document.create', 'An invoice, credit note, bill or supplier credit was created'],
  ['document.submit', 'A document was submitted for approval'],
  ['document.approve', 'A document was approved and posted'],
  ['document.reject', 'A document was rejected'],
  ['document.void', 'A posted document was voided'],
  ['payment.create', 'A receipt or payment was recorded'],
  ['payment.post', 'A receipt or payment was posted'],
  ['payment.void', 'A receipt or payment was voided'],
  ['allocation.create', 'A payment was allocated to documents'],
  ['purchase_order.approve', 'A purchase order was approved'],
  ['goods_receipt.create', 'Goods were received against a purchase order'],
  ['bank_statement.import', 'A bank statement was imported'],
  ['bank.reconcile', 'A bank reconciliation was completed'],
  ['customer.create', 'A customer was created'],
  ['customer.update', 'A customer was changed'],
  ['supplier.create', 'A supplier was created'],
  ['supplier.update', 'A supplier was changed'],
  ['item.create', 'An item was created'],
  ['stock.document.post', 'A stock adjustment or transfer was posted'],
  ['asset.create', 'A fixed asset was registered'],
  ['asset.depreciate', 'A depreciation run was posted'],
  ['asset.dispose', 'A fixed asset was disposed of'],
  ['expense.approve', 'An expense claim was approved'],
  ['expense.pay', 'An expense claim was reimbursed'],
  ['budget.approve', 'A budget or forecast was approved'],
  ['fx.rate.create', 'An exchange rate was entered'],
  ['fx.revaluation.post', 'An FX revaluation was posted'],
  ['period.soft_closed', 'A fiscal period was soft-closed'],
  ['period.hard_closed', 'A fiscal period was closed'],
  ['period.reopen', 'A closed fiscal period was reopened'],
  ['workflow.step', 'An approval step was completed'],
  ['workflow.escalate', 'An overdue approval was escalated'],
  ['webhook.test', 'A test event sent from the developer settings'],
].map(([type, description]) => ({ type, description }));

export function matchesEvent(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}

/** Signature header value: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

function assertUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('Enter a valid URL');
  }
  const production = process.env.NODE_ENV === 'production' && process.env.WEBHOOKS_ALLOW_HTTP !== 'true';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) throw new BadRequestException('Webhook URLs must use https');
  if (production) {
    const host = url.hostname;
    const privateHost =
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.startsWith('[');
    if (privateHost) throw new BadRequestException('Webhook URLs must point to a public host');
  }
  if (url.username || url.password) throw new BadRequestException('Do not put credentials in the URL; verify the signature instead');
}

/**
 * Webhooks with a transactional outbox: events are written in the same transaction as the business
 * change (via the audit log), then delivered with signatures, retries and exponential back-off.
 */
export class WebhooksService {
  constructor(private readonly db: Db) {}

  /** Called by the audit log for every action; queues deliveries for matching active endpoints. */
  async record(
    organisationId: Types.ObjectId,
    event: { type: string; recordType: string; recordId?: Types.ObjectId | null; summary?: string; actor?: string },
    session?: ClientSession,
  ) {
    if (NOT_EVENTS.test(event.type)) return;
    const endpoints = await this.db.webhookEndpoints.find({ organisationId, isActive: true }, { events: 1 }).session(session ?? null).lean();
    const targets = endpoints.filter((e) => matchesEvent(e.events, event.type));
    if (!targets.length) return;
    const now = new Date();
    const [row] = await this.db.webhookEvents.create(
      [{ organisationId, type: event.type, recordType: event.recordType, recordId: event.recordId ?? null, summary: event.summary ?? '', actor: event.actor ?? '', occurredAt: now }],
      { session },
    );
    await this.db.webhookDeliveries.insertMany(
      targets.map((t) => ({ organisationId, endpointId: t._id, eventId: row._id, eventType: event.type, nextAttemptAt: now })),
      { session },
    );
  }

  // ----- Endpoint management --------------------------------------------------------------------

  list(user: AuthUser) {
    return this.db.webhookEndpoints.find({ organisationId: user.organisationId }, { secret: 0 }).sort({ createdAt: -1 }).lean();
  }

  async create(user: AuthUser, input: { url: string; description?: string; events: string[] }) {
    assertUrl(input.url);
    this.assertEvents(input.events);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const [endpoint] = await this.db.webhookEndpoints.create([{ organisationId: user.organisationId, url: input.url, description: input.description ?? '', events: input.events, secret, createdBy: user.id }]);
    return { ...endpoint.toObject(), secret };
  }

  async update(user: AuthUser, id: Types.ObjectId, input: { url?: string; description?: string; events?: string[]; isActive?: boolean }) {
    if (input.url) assertUrl(input.url);
    if (input.events) this.assertEvents(input.events);
    const update: Record<string, unknown> = { ...input };
    if (input.isActive) Object.assign(update, { consecutiveFailures: 0, disabledReason: '' });
    const after = await this.db.webhookEndpoints.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, update, { new: true, projection: { secret: 0 } }).lean();
    if (!after) throw new NotFoundException('Webhook endpoint not found');
    return after;
  }

  async rotateSecret(user: AuthUser, id: Types.ObjectId) {
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const after = await this.db.webhookEndpoints.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, { secret }, { new: true }).lean();
    if (!after) throw new NotFoundException('Webhook endpoint not found');
    return { id: after._id, secret };
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    const deleted = await this.db.webhookEndpoints.findOneAndDelete({ _id: id, organisationId: user.organisationId }).lean();
    if (!deleted) throw new NotFoundException('Webhook endpoint not found');
    await this.db.webhookDeliveries.updateMany({ endpointId: id, status: 'PENDING' }, { status: 'FAILED', lastError: 'Endpoint deleted' });
    return { deleted: true };
  }

  /** Sends a `webhook.test` event to one endpoint right away. */
  async test(user: AuthUser, id: Types.ObjectId) {
    const endpoint = await this.db.webhookEndpoints.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    const [event] = await this.db.webhookEvents.create([{ organisationId: user.organisationId, type: 'webhook.test', recordType: 'WebhookEndpoint', recordId: endpoint._id, summary: 'Test event', actor: user.name, occurredAt: new Date() }]);
    const [delivery] = await this.db.webhookDeliveries.create([{ organisationId: user.organisationId, endpointId: endpoint._id, eventId: event._id, eventType: 'webhook.test', nextAttemptAt: new Date() }]);
    return this.attempt(delivery.toObject() as WebhookDelivery, endpoint);
  }

  async deliveries(user: AuthUser, q: { endpointId?: Types.ObjectId; status?: string; limit: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.endpointId) filter.endpointId = q.endpointId;
    if (q.status) filter.status = q.status;
    const rows = await this.db.webhookDeliveries.find(filter).sort({ createdAt: -1 }).limit(q.limit).lean();
    const events = await this.db.webhookEvents.find({ _id: { $in: rows.map((r) => r.eventId) } }).lean();
    return rows.map((r) => ({ ...r, event: events.find((e) => e._id.equals(r.eventId)) ?? null }));
  }

  /** Puts a delivery back in the queue for an immediate attempt. */
  async redeliver(user: AuthUser, id: Types.ObjectId) {
    const after = await this.db.webhookDeliveries.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, { status: 'PENDING', nextAttemptAt: new Date(), lockedUntil: null }, { new: true }).lean();
    if (!after) throw new NotFoundException('Delivery not found');
    const endpoint = await this.db.webhookEndpoints.findById(after.endpointId).lean();
    if (!endpoint) throw new BadRequestException('The endpoint no longer exists');
    return this.attempt(after, endpoint);
  }

  // ----- Delivery -------------------------------------------------------------------------------

  /** Sends every delivery that is due (all tenants, or one). Safe to run concurrently. */
  async deliverDue(opts: { organisationId?: Types.ObjectId; limit?: number } = {}) {
    let sent = 0;
    let failed = 0;
    const limit = opts.limit ?? 100;
    for (let i = 0; i < limit; i++) {
      const now = new Date();
      const claimed = await this.db.webhookDeliveries
        .findOneAndUpdate(
          {
            status: 'PENDING',
            nextAttemptAt: { $lte: now },
            $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
            ...(opts.organisationId && { organisationId: opts.organisationId }),
          },
          { lockedUntil: new Date(now.getTime() + 60_000) },
          { new: true, sort: { nextAttemptAt: 1 } },
        )
        .lean();
      if (!claimed) break;
      const endpoint = await this.db.webhookEndpoints.findById(claimed.endpointId).lean();
      if (!endpoint || !endpoint.isActive) {
        await this.db.webhookDeliveries.updateOne({ _id: claimed._id }, { status: 'FAILED', lastError: endpoint ? 'Endpoint disabled' : 'Endpoint deleted', lockedUntil: null });
        failed++;
        continue;
      }
      const result = await this.attempt(claimed, endpoint);
      if (result.status === 'SUCCEEDED') sent++;
      else failed++;
    }
    return { sent, failed };
  }

  /** The JSON body sent for an event. */
  payload(event: { _id: Types.ObjectId; type: string; recordType: string; recordId?: Types.ObjectId | null; summary: string; actor: string; occurredAt: Date; organisationId: Types.ObjectId }, deliveryId: Types.ObjectId) {
    return {
      id: event._id.toHexString(),
      type: event.type,
      createdAt: event.occurredAt.toISOString(),
      organisationId: event.organisationId.toHexString(),
      deliveryId: deliveryId.toHexString(),
      data: { recordType: event.recordType, recordId: event.recordId?.toHexString() ?? null, summary: event.summary, actor: event.actor },
    };
  }

  private async attempt(delivery: WebhookDelivery, endpoint: WebhookEndpoint) {
    const event = await this.db.webhookEvents.findById(delivery.eventId).lean();
    if (!event) {
      await this.db.webhookDeliveries.updateOne({ _id: delivery._id }, { status: 'FAILED', lastError: 'Event not found', lockedUntil: null });
      return { status: 'FAILED' as const, statusCode: null, error: 'Event not found' };
    }
    const body = JSON.stringify(this.payload(event, delivery._id));
    const timestamp = Math.floor(Date.now() / 1000);
    let statusCode: number | null = null;
    let error = '';
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'FarajaSoft-Webhooks/1',
          'x-farajasoft-event': event.type,
          'x-farajasoft-delivery': delivery._id.toHexString(),
          'x-farajasoft-signature': signPayload(endpoint.secret, body, timestamp),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      statusCode = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      error = err instanceof Error ? (err.name === 'TimeoutError' ? 'Timed out' : err.message) : 'Request failed';
    }
    const attempts = delivery.attempts + 1;
    const now = new Date();
    if (!error) {
      await this.db.webhookDeliveries.updateOne({ _id: delivery._id }, { status: 'SUCCEEDED', attempts, lastAttemptAt: now, lastStatusCode: statusCode, lastError: '', deliveredAt: now, lockedUntil: null });
      await this.db.webhookEndpoints.updateOne({ _id: endpoint._id }, { consecutiveFailures: 0 });
      return { status: 'SUCCEEDED' as const, statusCode, error: '' };
    }
    const backoff = BACKOFF_MINUTES[attempts - 1];
    await this.db.webhookDeliveries.updateOne(
      { _id: delivery._id },
      {
        status: backoff === undefined ? 'FAILED' : 'PENDING',
        attempts,
        lastAttemptAt: now,
        lastStatusCode: statusCode,
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(now.getTime() + (backoff ?? 0) * 60_000),
        lockedUntil: null,
      },
    );
    const updated = await this.db.webhookEndpoints.findOneAndUpdate({ _id: endpoint._id }, { $inc: { consecutiveFailures: 1 } }, { new: true }).lean();
    if (updated && updated.consecutiveFailures >= DISABLE_AFTER_FAILURES && updated.isActive) {
      await this.db.webhookEndpoints.updateOne({ _id: endpoint._id }, { isActive: false, disabledReason: `Disabled after ${DISABLE_AFTER_FAILURES} consecutive failed deliveries` });
    }
    return { status: backoff === undefined ? ('FAILED' as const) : ('RETRYING' as const), statusCode, error };
  }

  private assertEvents(events: string[]) {
    if (!events.length) throw new BadRequestException('Subscribe to at least one event');
    const known = new Set(WEBHOOK_EVENTS.map((e) => e.type));
    for (const e of events) {
      if (e === '*' || e.endsWith('.*') || known.has(e)) continue;
      throw new BadRequestException(`Unknown event type ${e}`);
    }
  }
}
