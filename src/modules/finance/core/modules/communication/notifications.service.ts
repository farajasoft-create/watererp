import { ClientSession, Types } from 'mongoose';
import { actorFor, AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { PackService } from '../reports/pack.service';
import { appUrl, EmailService, escapeHtml, layout } from './email.service';
import { SmsService } from './sms.service';

/** Notification kinds that are worth an email; the rest stay in the app. */
const EMAILED = new Set(['approval', 'escalation', 'approved', 'rejected', 'recurring', 'delegation']);
/** Kinds that are worth a text message: something is waiting for the user. */
const TEXTED = new Set(['approval', 'escalation']);
const DIGEST_EVERY_MS = 20 * 3_600_000;

const lastMonth = (now: Date) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * Email delivery of in-app notifications (immediately or as a daily digest, as each user prefers) and
 * the scheduled monthly management pack.
 */
export class NotificationEmailService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly pack: PackService,
    private readonly sms: SmsService,
  ) {}

  /** Called for every in-app notification, inside the same transaction. */
  async onNotify(organisationId: Types.ObjectId, userIds: Types.ObjectId[], n: { kind: string; title: string; body?: string; link?: string | null }, session?: ClientSession) {
    if (!EMAILED.has(n.kind) || !userIds.length) return;
    if (TEXTED.has(n.kind)) await this.text(organisationId, userIds, n, session);
    const users = await this.db.users
      .find({ _id: { $in: userIds }, organisationId, isActive: true, isServiceAccount: { $ne: true }, 'emailPreferences.approvals': { $nin: ['digest', 'off'] } }, { email: 1, name: 1 })
      .session(session ?? null)
      .lean();
    for (const u of users) {
      const body = layout({
        title: n.title,
        intro: `Hello ${u.name},`,
        paragraphs: [n.body ?? ''].filter(Boolean),
        action: n.link ? { label: 'Open in FarajaSoft', url: `${appUrl()}${n.link}` } : undefined,
        footer: 'Change how you receive these under Account security → Email notifications.',
      });
      await this.email.enqueue({ organisationId, to: [u.email], subject: n.title, ...body, category: 'notification' }, session);
    }
  }

  /** Text messages to approvers who opted in, when the organisation allows them (each costs money). */
  private async text(organisationId: Types.ObjectId, userIds: Types.ObjectId[], n: { title: string; link?: string | null }, session?: ClientSession) {
    const settings = await this.sms.settings(organisationId);
    if (!settings.enabled || !settings.approvalAlerts) return;
    const users = await this.db.users
      .find({ _id: { $in: userIds }, organisationId, isActive: true, isServiceAccount: { $ne: true }, 'smsPreferences.approvals': true, phone: { $nin: ['', null] } }, { phone: 1 })
      .session(session ?? null)
      .lean();
    for (const u of users) {
      const link = n.link ? ` ${appUrl()}${n.link}` : '';
      await this.sms.enqueue({ organisationId, to: u.phone, message: `FarajaSoft: ${n.title}.${link}`, category: 'approval', related: { type: 'User', id: u._id } }, { optional: true, session });
    }
  }

  /** One email per user who chose a digest, listing what arrived since the last one. */
  async sendDigests(now = new Date()) {
    const users = await this.db.users
      .find({ isActive: true, isServiceAccount: { $ne: true }, 'emailPreferences.approvals': 'digest', $or: [{ 'emailPreferences.lastDigestAt': null }, { 'emailPreferences.lastDigestAt': { $lt: new Date(now.getTime() - DIGEST_EVERY_MS) } }] }, { email: 1, name: 1, organisationId: 1, emailPreferences: 1 })
      .limit(1000)
      .lean();
    let sent = 0;
    for (const u of users) {
      const since = u.emailPreferences?.lastDigestAt ?? new Date(now.getTime() - 86_400_000);
      const items = await this.db.notifications.find({ userId: u._id, readAt: null, createdAt: { $gt: since }, kind: { $in: [...EMAILED] } }).sort({ createdAt: -1 }).limit(50).lean();
      await this.db.users.updateOne({ _id: u._id }, { 'emailPreferences.lastDigestAt': now });
      if (!items.length) continue;
      const list = `<ul style="margin:0 0 14px;padding-left:18px;font-size:14px;line-height:1.6;color:#1b1c2b">${items.map((i) => `<li>${i.link ? `<a href="${escapeHtml(appUrl() + i.link)}" style="color:#4a3cbb">${escapeHtml(i.title)}</a>` : escapeHtml(i.title)}${i.body ? `<br><span style="color:#5e6075;font-size:12px">${escapeHtml(i.body)}</span>` : ''}</li>`).join('')}</ul>`;
      const body = layout({ title: `${items.length} item${items.length === 1 ? '' : 's'} for you`, intro: `Hello ${u.name}, here is what needs your attention:`, html: list, action: { label: 'Open your approvals', url: `${appUrl()}/finance/approvals` }, footer: 'You receive a daily digest because of your email settings.' });
      await this.email.enqueue({ organisationId: u.organisationId, to: [u.email], subject: `FarajaSoft: ${items.length} item${items.length === 1 ? '' : 's'} waiting`, ...body, category: 'digest' });
      sent++;
    }
    return { digests: sent };
  }

  // ----- Report subscriptions --------------------------------------------------------------------

  list(user: AuthUser) {
    return this.db.reportSubscriptions.find({ organisationId: user.organisationId }).lean();
  }

  async upsert(user: AuthUser, input: { entityId: Types.ObjectId; userIds: Types.ObjectId[]; dayOfMonth: number; isActive: boolean }) {
    const entity = await this.db.entities.exists({ _id: input.entityId, organisationId: user.organisationId });
    if (!entity) throw new NotFoundException('Entity not found');
    const count = await this.db.users.countDocuments({ _id: { $in: input.userIds }, organisationId: user.organisationId, isActive: true, isServiceAccount: { $ne: true } });
    if (count !== new Set(input.userIds.map(String)).size) throw new BadRequestException('Choose active users of this organisation');
    const sub = await this.db.reportSubscriptions
      .findOneAndUpdate(
        { organisationId: user.organisationId, entityId: input.entityId },
        { userIds: input.userIds, dayOfMonth: input.dayOfMonth, isActive: input.isActive, $setOnInsert: { createdBy: user.id } },
        { upsert: true, new: true },
      )
      .lean();
    await this.audit.log(user, { action: 'report.subscription', recordType: 'ReportSubscription', recordId: sub!._id, summary: `Monthly management pack goes to ${input.userIds.length} people on day ${input.dayOfMonth}${input.isActive ? '' : ' (paused)'}` });
    return sub;
  }

  /** Emails last month's pack, built separately for each recipient with their own permissions. */
  async sendPacks(now = new Date(), opts: { force?: boolean } = {}) {
    const month = lastMonth(now);
    const due = await this.db.reportSubscriptions.find({ isActive: true, lastSentFor: { $ne: month }, ...(!opts.force && { dayOfMonth: { $lte: now.getUTCDate() } }) }).lean();
    let emails = 0;
    for (const sub of due) {
      // Claim the month first so concurrent runs do not double-send.
      const claimed = await this.db.reportSubscriptions.updateOne({ _id: sub._id, lastSentFor: sub.lastSentFor }, { lastSentFor: month });
      if (!claimed.modifiedCount) continue;
      for (const userId of sub.userIds) {
        const actor = await actorFor(this.db, userId);
        if (!actor) continue;
        try {
          const pack = await this.pack.build(actor, sub.entityId, month);
          const k = pack.kpis;
          const money = (v: unknown) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en', { maximumFractionDigits: 0 }));
          const kpis = k
            ? `<table role="presentation" cellspacing="0" cellpadding="6" style="width:100%;margin:0 0 14px;font-size:13px;border:1px solid #e4e4ec;border-radius:6px">${[
                ['Revenue (year to date)', money(k.revenue.ytd)],
                ['Gross margin', k.grossMargin.percent ? `${k.grossMargin.percent}%` : '—'],
                ['Net profit (year to date)', money(k.netProfit.ytd)],
                ['Cash and bank', money(k.cash.balance)],
                ['Receivables', money(k.receivables.balance)],
              ]
                .map(([a, b]) => `<tr><td style="color:#5e6075">${a}</td><td style="text-align:right;font-weight:600">${b} ${escapeHtml(pack.currency)}</td></tr>`)
                .join('')}</table>`
            : '';
          const commentary = pack.commentary.length ? `<ul style="margin:0 0 14px;padding-left:18px;font-size:14px;line-height:1.55;color:#1b1c2b">${pack.commentary.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : '';
          const monthName = new Date(`${month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
          const body = layout({
            title: `${pack.entity.name}: management pack for ${monthName}`,
            intro: `Hello ${actor.name}, here are the highlights. The full pack is in FarajaSoft.`,
            html: kpis + commentary,
            action: { label: 'Open the full pack', url: `${appUrl()}/reports/pack?month=${month}` },
            footer: 'You receive this monthly pack because an administrator subscribed you. Figures shown are limited to what your role can see.',
          });
          await this.email.enqueue({ organisationId: sub.organisationId, to: [actor.email], subject: `${pack.entity.name} — ${monthName} management pack`, ...body, category: 'report', related: { type: 'ReportSubscription', id: sub._id } });
          emails++;
        } catch {
          // A recipient without access to the pack is skipped.
        }
      }
    }
    return { packs: emails };
  }
}
