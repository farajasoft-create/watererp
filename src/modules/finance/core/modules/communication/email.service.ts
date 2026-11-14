import { ClientSession, Types } from 'mongoose';
import { Db } from '../../database/db.service';
import { EMAIL_CATEGORIES, EmailMessage } from '../../database/communication.schemas';

const BACKOFF_MINUTES = [1, 5, 30, 120, 480];

/** The public address of the app, for links in emails. */
export function appUrl(): string {
  const configured = process.env.APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');
  return configured.replace(/\/$/, '');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** One consistent, client-safe layout (tables and inline styles, as email clients require). */
export function layout(opts: { title: string; intro?: string; paragraphs?: string[]; html?: string; action?: { label: string; url: string }; footer?: string }) {
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#1b1c2b">${escapeHtml(t)}</p>`;
  const button = opts.action
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:18px 0"><tr><td style="background:#4a3cbb;border-radius:6px"><a href="${escapeHtml(opts.action.url)}" style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(opts.action.label)}</a></td></tr></table><p style="margin:0 0 14px;font-size:12px;color:#5e6075">If the button does not work, open this link: <br><a href="${escapeHtml(opts.action.url)}" style="color:#4a3cbb;word-break:break-all">${escapeHtml(opts.action.url)}</a></p>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#f6f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f6fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4ec;border-radius:10px">
<tr><td style="padding:18px 24px;border-bottom:1px solid #e4e4ec;font-size:15px;font-weight:700;color:#1f1a4f">FarajaSoft</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 14px;font-size:18px;color:#1b1c2b">${escapeHtml(opts.title)}</h1>
${opts.intro ? p(opts.intro) : ''}${(opts.paragraphs ?? []).map(p).join('')}${opts.html ?? ''}${button}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #e4e4ec;font-size:11px;color:#5e6075">${escapeHtml(opts.footer ?? 'You received this email from FarajaSoft Accounting.')}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [opts.title, '', opts.intro, ...(opts.paragraphs ?? []), opts.action ? `${opts.action.label}: ${opts.action.url}` : '', '', opts.footer ?? ''].filter((x) => x !== undefined).join('\n');
  return { html, text };
}

interface Driver {
  name: string;
  send(m: EmailMessage): Promise<{ id: string | null }>;
}

class ResendDriver implements Driver {
  readonly name = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  async send(m: EmailMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.replyTo && { reply_to: m.replyTo }),
        ...(m.attachments?.length && { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })) }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`Resend ${res.status}: ${body.message ?? res.statusText}`);
    return { id: body.id ?? null };
  }
}

/** Development and tests: nothing leaves the server; messages are kept in the email log. */
class CaptureDriver implements Driver {
  readonly name = 'capture';
  async send() {
    return { id: null };
  }
}

export interface OutgoingEmail {
  organisationId?: Types.ObjectId | null;
  to: string[];
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  category: (typeof EMAIL_CATEGORIES)[number];
  sensitive?: boolean;
  related?: { type: string; id: Types.ObjectId } | null;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

/**
 * Outgoing email through an outbox: messages are stored (in the caller's transaction where there is
 * one) and sent right after the request or by the cron job, with retries. Production sends through
 * Resend; without a key, messages are only captured in the email log.
 */
export class EmailService {
  private readonly driver: Driver;

  constructor(private readonly db: Db) {
    const key = process.env.RESEND_API_KEY;
    const driver = process.env.EMAIL_DRIVER ?? (key ? 'resend' : 'capture');
    this.driver = driver === 'resend' && key ? new ResendDriver(key, process.env.EMAIL_FROM ?? 'FarajaSoft <no-reply@farajasoft.app>') : new CaptureDriver();
  }

  get driverName() {
    return this.driver.name;
  }

  async enqueue(email: OutgoingEmail, session?: ClientSession) {
    const to = [...new Set(email.to.map((t) => t.trim().toLowerCase()).filter((t) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) && !t.endsWith('.invalid')))];
    if (!to.length) return null;
    const [doc] = await this.db.emails.create(
      [
        {
          organisationId: email.organisationId ?? null,
          to,
          replyTo: email.replyTo ?? null,
          subject: email.subject.slice(0, 250),
          html: email.html,
          text: email.text,
          category: email.category,
          priority: email.category === 'account' ? 0 : email.category === 'notification' ? 1 : 2,
          sensitive: !!email.sensitive,
          relatedType: email.related?.type ?? null,
          relatedId: email.related?.id ?? null,
          attachments: (email.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content.toString('base64') })),
        },
      ],
      { session },
    );
    return doc._id;
  }

  /** Sends what is due. Safe to run concurrently (each message is claimed before sending). */
  async deliverDue(opts: { organisationId?: Types.ObjectId; limit?: number } = {}) {
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < (opts.limit ?? 200); i++) {
      const now = new Date();
      const m = await this.db.emails
        .findOneAndUpdate(
          { status: 'PENDING', nextAttemptAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }], ...(opts.organisationId && { organisationId: opts.organisationId }) },
          { lockedUntil: new Date(now.getTime() + 60_000) },
          { new: true, sort: { priority: 1, nextAttemptAt: 1 } },
        )
        .lean();
      if (!m) break;
      const attempts = m.attempts + 1;
      try {
        const res = await this.driver.send(m);
        await this.db.emails.updateOne({ _id: m._id }, { status: 'SENT', attempts, sentAt: new Date(), provider: this.driver.name, providerId: res.id, lastError: '', lockedUntil: null });
        sent++;
      } catch (err) {
        const backoff = BACKOFF_MINUTES[attempts - 1];
        await this.db.emails.updateOne(
          { _id: m._id },
          { status: backoff === undefined ? 'FAILED' : 'PENDING', attempts, lastError: (err instanceof Error ? err.message : 'Send failed').slice(0, 500), nextAttemptAt: new Date(Date.now() + (backoff ?? 0) * 60_000), lockedUntil: null },
        );
        failed++;
      }
    }
    return { sent, failed };
  }

  /** The organisation's recent emails; bodies of account emails (reset links) are withheld. */
  async log(organisationId: Types.ObjectId, q: { status?: string; limit: number }) {
    const rows = await this.db.emails.find({ organisationId, ...(q.status && { status: q.status }) }, { 'attachments.content': 0 }).sort({ createdAt: -1 }).limit(q.limit).lean();
    return rows.map((m) => ({
      id: m._id,
      to: m.to,
      subject: m.subject,
      category: m.category,
      status: m.status,
      attempts: m.attempts,
      lastError: m.lastError,
      provider: m.provider,
      createdAt: (m as { createdAt?: Date }).createdAt,
      sentAt: m.sentAt,
      text: m.sensitive && this.driver.name !== 'capture' ? null : m.text,
    }));
  }
}
