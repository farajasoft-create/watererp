import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException } from '../../common/errors';
import { Db } from '../../database/db.service';
import { SMS_CATEGORIES, SmsMessage } from '../../database/communication.schemas';
import { AuditService } from '../audit/audit.service';

const BACKOFF_MINUTES = [1, 5, 30, 120];
/** Two standard SMS parts; longer texts cost more and are cut by some handsets. */
const MAX_LENGTH = 306;

/** International format (+2547XXXXXXXX). Kenyan local numbers are accepted; others need their country code. */
export function normaliseMsisdn(input: string): string | null {
  const raw = input.trim();
  let d = raw.replace(/[^\d]/g, '');
  if (!d) return null;
  if (raw.startsWith('+') || raw.startsWith('00')) {
    if (raw.startsWith('00')) d = d.slice(2);
    return /^[1-9]\d{8,14}$/.test(d) ? `+${d}` : null;
  }
  if (d.startsWith('0') && d.length === 10) d = `254${d.slice(1)}`;
  if (d.length === 9 && /^[17]/.test(d)) d = `254${d}`;
  return /^254[17]\d{8}$/.test(d) ? `+${d}` : null;
}

interface Driver {
  name: string;
  send(m: SmsMessage): Promise<{ id: string | null; cost: string | null }>;
}

/** Africa's Talking bulk SMS (https://developers.africastalking.com). */
class AfricasTalkingDriver implements Driver {
  readonly name = 'africastalking';
  private readonly url: string;
  constructor(
    private readonly username: string,
    private readonly apiKey: string,
    private readonly from: string | undefined,
  ) {
    const base = process.env.AT_BASE_URL ?? (username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com');
    this.url = `${base.replace(/\/$/, '')}/version1/messaging`;
  }
  async send(m: SmsMessage) {
    const form = new URLSearchParams({ username: this.username, to: m.to, message: m.message, ...(this.from && { from: this.from }) });
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { apiKey: this.apiKey, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Africa's Talking ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text || '{}') as { SMSMessageData?: { Message?: string; Recipients?: { status?: string; statusCode?: number; messageId?: string; cost?: string }[] } };
    const r = body.SMSMessageData?.Recipients?.[0];
    // 100 Processed, 101 Sent, 102 Queued; anything else is a failure for this number.
    if (!r || ![100, 101, 102].includes(Number(r.statusCode))) throw new Error(r?.status ?? body.SMSMessageData?.Message ?? 'Not accepted');
    return { id: r.messageId ?? null, cost: r.cost ?? null };
  }
}

/** Development and tests: nothing leaves the server; messages are kept in the SMS log. */
class CaptureDriver implements Driver {
  readonly name = 'capture';
  async send() {
    return { id: null, cost: null };
  }
}

/**
 * Text messages to customers through an outbox, like email: queued with their cause, sent right after
 * the request or by the cron job, with retries. Each organisation must turn SMS on (it costs money).
 */
export class SmsService {
  private readonly driver: Driver;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {
    const username = process.env.AT_USERNAME;
    const key = process.env.AT_API_KEY;
    this.driver = username && key && process.env.SMS_DRIVER !== 'capture' ? new AfricasTalkingDriver(username, key, process.env.AT_SENDER_ID || undefined) : new CaptureDriver();
  }

  get driverName() {
    return this.driver.name;
  }

  async settings(organisationId: Types.ObjectId) {
    const org = await this.db.organisations.findById(organisationId, { 'settings.sms': 1 }).lean();
    return { enabled: !!org?.settings?.sms?.enabled, paymentConfirmations: org?.settings?.sms?.paymentConfirmations !== false, approvalAlerts: !!org?.settings?.sms?.approvalAlerts, driver: this.driver.name };
  }

  async updateSettings(user: AuthUser, input: { enabled: boolean; paymentConfirmations: boolean; approvalAlerts?: boolean }) {
    await this.db.organisations.updateOne(
      { _id: user.organisationId },
      { 'settings.sms.enabled': input.enabled, 'settings.sms.paymentConfirmations': input.paymentConfirmations, ...(input.approvalAlerts !== undefined && { 'settings.sms.approvalAlerts': input.approvalAlerts }) },
    );
    await this.audit.log(user, { action: 'organisation.sms', recordType: 'Organisation', recordId: user.organisationId, summary: `${input.enabled ? 'Turned on' : 'Turned off'} text messages to customers${input.enabled ? `; M-Pesa payment confirmations ${input.paymentConfirmations ? 'on' : 'off'}` : ''}` });
    return this.settings(user.organisationId);
  }

  /**
   * Queues a message. With `optional`, nothing happens when SMS is off or the number is unusable (automatic
   * confirmations); otherwise those are errors the user sees.
   */
  async enqueue(input: { organisationId: Types.ObjectId; to: string; message: string; category: (typeof SMS_CATEGORIES)[number]; related?: { type: string; id: Types.ObjectId } | null }, opts: { optional?: boolean; session?: ClientSession } = {}) {
    const settings = await this.settings(input.organisationId);
    if (!settings.enabled) {
      if (opts.optional) return null;
      throw new BadRequestException('Text messages are turned off; an administrator can turn them on in Organisation settings');
    }
    const to = normaliseMsisdn(input.to);
    if (!to) {
      if (opts.optional) return null;
      throw new BadRequestException('Enter a mobile number such as 0712 345 678 or +256 772 123 456');
    }
    const message = input.message.replace(/\s+/g, ' ').trim();
    const [doc] = await this.db.sms.create([
      {
        organisationId: input.organisationId,
        to,
        message: message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH - 1)}…` : message,
        category: input.category,
        relatedType: input.related?.type ?? null,
        relatedId: input.related?.id ?? null,
      },
    ], { session: opts.session });
    return doc._id;
  }

  /** Sends what is due. Safe to run concurrently (each message is claimed before sending). */
  async deliverDue(opts: { organisationId?: Types.ObjectId; limit?: number } = {}) {
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < (opts.limit ?? 200); i++) {
      const now = new Date();
      const m = await this.db.sms
        .findOneAndUpdate(
          { status: 'PENDING', nextAttemptAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }], ...(opts.organisationId && { organisationId: opts.organisationId }) },
          { lockedUntil: new Date(now.getTime() + 60_000) },
          { new: true, sort: { nextAttemptAt: 1 } },
        )
        .lean();
      if (!m) break;
      const attempts = m.attempts + 1;
      try {
        const res = await this.driver.send(m);
        await this.db.sms.updateOne({ _id: m._id }, { status: 'SENT', attempts, sentAt: new Date(), provider: this.driver.name, providerId: res.id, cost: res.cost, lastError: '', lockedUntil: null });
        sent++;
      } catch (err) {
        const backoff = BACKOFF_MINUTES[attempts - 1];
        await this.db.sms.updateOne(
          { _id: m._id },
          { status: backoff === undefined ? 'FAILED' : 'PENDING', attempts, lastError: (err instanceof Error ? err.message : 'Send failed').slice(0, 500), nextAttemptAt: new Date(Date.now() + (backoff ?? 0) * 60_000), lockedUntil: null },
        );
        failed++;
      }
    }
    return { sent, failed };
  }

  async log(organisationId: Types.ObjectId, q: { status?: string; limit: number }) {
    const rows = await this.db.sms.find({ organisationId, ...(q.status && { status: q.status }) }).sort({ createdAt: -1 }).limit(q.limit).lean();
    return rows.map((m) => ({
      id: m._id,
      to: `${m.to.slice(0, 7)}•••${m.to.slice(-3)}`,
      message: m.message,
      category: m.category,
      status: m.status,
      attempts: m.attempts,
      lastError: m.lastError,
      provider: m.provider,
      cost: m.cost,
      createdAt: (m as { createdAt?: Date }).createdAt,
      sentAt: m.sentAt,
    }));
  }
}
