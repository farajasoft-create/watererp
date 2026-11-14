import { Types } from 'mongoose';
import { decryptSecret } from '../common/secrets';
import { normalisePhone } from '../common/validation';
import { Db } from '../db';

/** Text messages through an outbox: queued with the change that caused them, sent afterwards. */
export class SmsService {
  constructor(
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async queue(organisationId: Types.ObjectId, to: string | null | undefined, message: string, purpose: string, sourceId?: Types.ObjectId) {
    const phone = to ? normalisePhone(to) : null;
    if (!phone) return null;
    const [sms] = await this.db.sms.create([{ organisationId, to: `+${phone}`, message: message.slice(0, 459), purpose, sourceId }]);
    return sms;
  }

  /** Sends queued messages. Without a configured gateway they are marked skipped, not lost silently. */
  async deliverDue(organisationId: Types.ObjectId, limit = 100) {
    const org = await this.db.organisations.findById(organisationId, { sms: 1 }).lean();
    const due = await this.db.sms.find({ organisationId, status: 'QUEUED', attempts: { $lt: 5 } }).sort({ createdAt: 1 }).limit(limit).lean();
    if (!due.length) return { sent: 0, failed: 0, skipped: 0 };
    const cfg = org?.sms;
    if (!cfg || cfg.provider !== 'AFRICASTALKING' || !cfg.username || !cfg.apiKeySealed) {
      await this.db.sms.updateMany({ _id: { $in: due.map((m) => m._id) } }, { status: 'SKIPPED', error: 'No SMS gateway configured' });
      return { sent: 0, failed: 0, skipped: due.length };
    }
    const apiKey = decryptSecret(cfg.apiKeySealed);
    const url = cfg.username === 'sandbox' ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';
    let sent = 0;
    let failed = 0;
    for (const m of due) {
      try {
        const body = new URLSearchParams({ username: cfg.username, to: m.to, message: m.message, ...(cfg.senderId && { from: cfg.senderId }) });
        const res = await this.fetchImpl(url, { method: 'POST', headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
        const data = (await res.json().catch(() => null)) as { SMSMessageData?: { Recipients?: { status: string; messageId: string }[]; Message?: string } } | null;
        const recipient = data?.SMSMessageData?.Recipients?.[0];
        if (!res.ok || !recipient || recipient.status !== 'Success') throw new Error(recipient?.status ?? data?.SMSMessageData?.Message ?? `HTTP ${res.status}`);
        await this.db.sms.updateOne({ _id: m._id }, { status: 'SENT', providerId: recipient.messageId, sentAt: new Date(), $inc: { attempts: 1 } });
        sent++;
      } catch (err) {
        const attempts = m.attempts + 1;
        await this.db.sms.updateOne({ _id: m._id }, { status: attempts >= 5 ? 'FAILED' : 'QUEUED', error: err instanceof Error ? err.message : String(err), $inc: { attempts: 1 } });
        failed++;
      }
    }
    return { sent, failed, skipped: 0 };
  }

  list(organisationId: Types.ObjectId, status?: string) {
    return this.db.sms
      .find({ organisationId, ...(status && { status }) })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
  }
}
