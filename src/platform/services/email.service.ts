import nodemailer from 'nodemailer';
import { Types } from 'mongoose';
import { decryptSecret } from '../common/secrets';
import { Db } from '../db';

export interface MailTransport {
  sendMail(m: { from: string; to: string; subject: string; text: string; html?: string }): Promise<{ messageId?: string }>;
}

type TransportFactory = (cfg: { host: string; port: number; secure: boolean; username?: string | null; password?: string | null }) => MailTransport;

/** Host "json" builds each message without sending it: for trying the system out and for the tests. */
const smtp: TransportFactory = (cfg) =>
  cfg.host === 'json' ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? '' } : undefined, connectionTimeout: 15_000 });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Emails through an outbox: queued with the change that caused them and sent afterwards through the
 * organisation's mail server (Settings → Email). Without one they are marked skipped, not lost.
 */
export class EmailService {
  constructor(
    private readonly db: Db,
    private readonly transportFor: TransportFactory = smtp,
  ) {}

  async queue(organisationId: Types.ObjectId, to: string | null | undefined, subject: string, text: string, purpose: string, sourceId?: Types.ObjectId, html?: string) {
    const address = to?.trim().toLowerCase();
    if (!address || !EMAIL.test(address)) return null;
    const [m] = await this.db.emails.create([{ organisationId, to: address, subject: subject.slice(0, 200), text, html, purpose, sourceId }]);
    return m;
  }

  private async transport(organisationId: Types.ObjectId) {
    const org = await this.db.organisations.findById(organisationId, { mail: 1, name: 1 }).lean();
    const c = org?.mail;
    if (!c?.enabled || !c.host || !c.from) return null;
    return { from: c.from.includes('<') ? c.from : `${org!.name} <${c.from}>`, t: this.transportFor({ host: c.host, port: c.port ?? 587, secure: Boolean(c.secure), username: c.username, password: c.passwordSealed ? decryptSecret(c.passwordSealed) : null }) };
  }

  async deliverDue(organisationId: Types.ObjectId, limit = 100) {
    const due = await this.db.emails.find({ organisationId, status: 'QUEUED', attempts: { $lt: 5 } }).sort({ createdAt: 1 }).limit(limit).lean();
    if (!due.length) return { sent: 0, failed: 0, skipped: 0 };
    const mail = await this.transport(organisationId);
    if (!mail) {
      await this.db.emails.updateMany({ _id: { $in: due.map((m) => m._id) } }, { status: 'SKIPPED', error: 'No mail server configured' });
      return { sent: 0, failed: 0, skipped: due.length };
    }
    let sent = 0;
    let failed = 0;
    for (const m of due) {
      try {
        const info = await mail.t.sendMail({ from: mail.from, to: m.to, subject: m.subject, text: m.text, ...(m.html && { html: m.html }) });
        await this.db.emails.updateOne({ _id: m._id }, { status: 'SENT', providerId: info.messageId, sentAt: new Date(), $inc: { attempts: 1 } });
        sent++;
      } catch (err) {
        const attempts = m.attempts + 1;
        await this.db.emails.updateOne({ _id: m._id }, { status: attempts >= 5 ? 'FAILED' : 'QUEUED', error: err instanceof Error ? err.message : String(err), $inc: { attempts: 1 } });
        failed++;
      }
    }
    return { sent, failed, skipped: 0 };
  }

  /** Queues and sends at once (settings test, sign-in notices). */
  async send(organisationId: Types.ObjectId, to: string, subject: string, text: string, purpose: string) {
    const m = await this.queue(organisationId, to, subject, text, purpose);
    if (!m) return { sent: 0, failed: 1, skipped: 0 };
    return this.deliverDue(organisationId, 1);
  }

  list(organisationId: Types.ObjectId, status?: string) {
    return this.db.emails
      .find({ organisationId, ...(status && { status }) }, { html: 0 })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
  }
}
