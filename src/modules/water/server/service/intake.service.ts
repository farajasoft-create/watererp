import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AuthUser } from '@/platform/auth';
import { NotFoundException } from '@/platform/common/errors';
import { dec } from '@/platform/common/money';
import { normalisePhone } from '@/platform/common/validation';
import { AuditService } from '@/platform/services/audit.service';
import { SmsService } from '@/platform/services/sms.service';
import { WaterDb as Db, waterSettings } from '../db';
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from '../service-schemas';
import { NoticesService } from './notices.service';
import { guessCategory, TicketsService } from './tickets.service';

export const CallCentreTicket = z.object({
  externalRef: z.string().trim().min(1).max(80),
  category: z.enum(TICKET_CATEGORIES).default('OTHER'),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  accountNo: z.string().trim().max(30).optional(),
  phone: z.string().trim().max(20).optional(),
  name: z.string().trim().max(150).optional(),
  location: z.string().trim().max(200).optional(),
});

/** USSD menu choice → complaint category. */
const USSD_PROBLEMS: [string, (typeof TICKET_CATEGORIES)[number]][] = [
  ['No water', 'NO_WATER'],
  ['Leak or burst pipe', 'LEAK'],
  ['Bill query', 'BILLING'],
  ['Meter problem', 'METER'],
  ['Dirty water', 'WATER_QUALITY'],
  ['Sewer blockage', 'SEWER'],
];

const text = (body: string) => new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * Channels outside the office, all behind the intake token from Water settings: the call centre's
 * system (JSON), an Africa's Talking SMS shortcode (BAL for balance, anything else becomes a ticket)
 * and an Africa's Talking USSD code (balance, last bill, report a problem, notices).
 */
export class IntakeService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
    private readonly tickets: TicketsService,
    private readonly notices: NoticesService,
  ) {}

  /** Issues (or replaces) the token that goes into the intake URLs. */
  async rotateToken(user: AuthUser) {
    await waterSettings(this.db, user.organisationId);
    const token = randomBytes(24).toString('base64url');
    await this.db.waterSettings.updateOne({ organisationId: user.organisationId }, { 'service.intakeToken': token });
    await this.audit.record(user, 'water.settings.intake-token', 'organisation', user.organisationId, {});
    return { token };
  }

  private async orgFor(token: string) {
    if (!token || token.length < 16) throw new NotFoundException('Unknown intake address');
    const settings = await this.db.waterSettings.findOne({ 'service.intakeToken': token }, { organisationId: 1 }).lean();
    if (!settings || !(await this.db.organisations.exists({ _id: settings.organisationId, modules: 'water' }))) throw new NotFoundException('Unknown intake address');
    const org = await this.db.organisations.findById(settings.organisationId, { name: 1 }).lean();
    return { organisationId: settings.organisationId, name: org?.name ?? 'Water' };
  }

  private accountsByPhone(organisationId: Types.ObjectId, phone: string) {
    const p = normalisePhone(phone);
    if (!p) return Promise.resolve([]);
    return this.db.customers.find({ organisationId, $or: [{ phone: p }, { altPhone: p }], status: { $nin: ['REJECTED', 'CLOSED'] } }, { accountNo: 1, name: 1, balance: 1, zoneId: 1 }).sort({ accountNo: 1 }).limit(9).lean();
  }

  private async summary(organisationId: Types.ObjectId, accountNo: string, what: 'balance' | 'bill') {
    const c = await this.db.customers.findOne({ organisationId, accountNo: accountNo.trim().toUpperCase() }, { accountNo: 1, balance: 1 }).lean();
    if (!c) return 'No account with that number.';
    if (what === 'balance') {
      const b = dec(c.balance);
      return b.gt(0) ? `Account ${c.accountNo} owes KES ${b.toFixed(2)}.` : `Account ${c.accountNo} is paid up${b.lt(0) ? ` (credit KES ${b.abs().toFixed(2)})` : ''}.`;
    }
    const bill = await this.db.bills.findOne({ organisationId, customerId: c._id, status: 'ISSUED' }).sort({ billDate: -1 }).lean();
    if (!bill) return `No bill yet for ${c.accountNo}.`;
    return `${c.accountNo} ${bill.period}: ${dec(bill.units).toFixed()} m3, KES ${dec(bill.currentCharges).toFixed(2)}. Amount due KES ${dec(bill.amountDue).toFixed(2)} by ${bill.dueDate?.toISOString().slice(0, 10)}.`;
  }

  async callCentre(token: string, body: z.infer<typeof CallCentreTicket>) {
    const org = await this.orgFor(token);
    const t = await this.tickets.create({ organisationId: org.organisationId }, { ...body, channel: 'CALL_CENTRE', phone: body.phone ? (normalisePhone(body.phone) ?? body.phone) : undefined });
    return { number: t.number, status: t.status, slaDueAt: t.slaDueAt };
  }

  /** Africa's Talking incoming SMS callback (form fields from, to, text, id). */
  async inboundSms(token: string, form: Record<string, string>) {
    const org = await this.orgFor(token);
    const from = form.from ?? '';
    const message = (form.text ?? '').trim();
    let reply: string;
    const bal = /^(BAL|BALANCE|SALIO)\b\s*(.*)$/i.exec(message);
    if (bal) {
      if (bal[2]) reply = await this.summary(org.organisationId, bal[2], 'balance');
      else {
        const accounts = await this.accountsByPhone(org.organisationId, from);
        reply = accounts.length ? (await Promise.all(accounts.map((a) => this.summary(org.organisationId, a.accountNo, 'balance')))).join(' ') : 'This phone is not on any account. Send BAL followed by your account number.';
      }
    } else if (message) {
      const accounts = await this.accountsByPhone(org.organisationId, from);
      const t = await this.tickets.create({ organisationId: org.organisationId }, { category: guessCategory(message), channel: 'SMS', customerId: accounts.length === 1 ? accounts[0]._id : null, phone: normalisePhone(from) ?? from, subject: message.slice(0, 120), description: message, externalRef: form.id ? `sms:${form.id}` : undefined });
      return { ok: true, ticket: t.number };
    } else reply = 'Send BAL for your balance, or describe the problem to report it.';
    await this.sms.queue(org.organisationId, from, `${org.name}: ${reply}`, 'water:sms-reply');
    await this.sms.deliverDue(org.organisationId);
    return { ok: true };
  }

  /**
   * Complaints by email, from the mail provider's inbound webhook (SendGrid Inbound Parse, Mailgun
   * routes, or plain JSON {from, subject, text, messageId}). The customer is matched by the sender's
   * address or an account number in the subject or text; the category is guessed from the words.
   */
  async inboundEmail(token: string, form: Record<string, string>) {
    const org = await this.orgFor(token);
    const fromRaw = form.from ?? form.sender ?? form.From ?? '';
    const email = (/<([^>]+)>/.exec(fromRaw)?.[1] ?? fromRaw).trim().toLowerCase();
    const name = /^\s*"?([^"<]+?)"?\s*</.exec(fromRaw)?.[1]?.trim();
    const subject = (form.subject ?? form.Subject ?? '').trim();
    const body = (form['stripped-text'] ?? form['body-plain'] ?? form.text ?? form.html?.replace(/<[^>]+>/g, ' ') ?? '').trim();
    const messageId = form['Message-Id'] ?? form['message-id'] ?? form.messageId ?? form['Message-ID'];
    if (!email || !(subject || body)) return { ok: false, reason: 'No sender or message' };
    const words = `${subject} ${body}`.toUpperCase().match(/\b[A-Z0-9][A-Z0-9-]{3,19}\b/g) ?? [];
    const customer =
      (await this.db.customers.findOne({ organisationId: org.organisationId, email, status: { $nin: ['REJECTED', 'CLOSED'] } }, { _id: 1 }).lean()) ??
      (words.length ? await this.db.customers.findOne({ organisationId: org.organisationId, accountNo: { $in: words } }, { _id: 1 }).lean() : null);
    const t = await this.tickets.create(
      { organisationId: org.organisationId },
      { category: guessCategory(`${subject} ${body}`), channel: 'EMAIL', customerId: customer?._id ?? null, email, name, subject: (subject || body).slice(0, 200), description: body.slice(0, 2000), externalRef: messageId ? `email:${messageId}`.slice(0, 80) : undefined },
    );
    return { ok: true, ticket: t.number };
  }

  /** Africa's Talking USSD callback: text is the user's choices joined with "*"; reply CON (more) or END. */
  async ussd(token: string, form: Record<string, string>): Promise<Response> {
    let org: { organisationId: Types.ObjectId; name: string };
    try {
      org = await this.orgFor(token);
    } catch {
      return text('END This service is not available.');
    }
    const phone = form.phoneNumber ?? '';
    const parts = (form.text ?? '').split('*').filter((p, i, all) => !(p === '' && all.length === 1));
    const [first, ...rest] = parts;
    const accounts = await this.accountsByPhone(org.organisationId, phone);
    const pickAccount = async (what: 'balance' | 'bill') => {
      if (!rest.length) {
        if (accounts.length === 1) return text(`END ${await this.summary(org.organisationId, accounts[0].accountNo, what)}`);
        if (accounts.length > 1) return text(`CON Choose the account:\n${accounts.map((a, i) => `${i + 1}. ${a.accountNo}`).join('\n')}`);
        return text('CON Enter your account number:');
      }
      const choice = rest[0];
      const byIndex = accounts.length > 1 && /^\d$/.test(choice) ? accounts[Number(choice) - 1] : undefined;
      return text(`END ${await this.summary(org.organisationId, byIndex?.accountNo ?? choice, what)}`);
    };
    if (!first) return text(`CON ${org.name}\n1. My balance\n2. My last bill\n3. Report a problem\n4. Notices`);
    if (first === '1') return pickAccount('balance');
    if (first === '2') return pickAccount('bill');
    if (first === '3') {
      if (!rest.length) return text(`CON What is the problem?\n${USSD_PROBLEMS.map(([l], i) => `${i + 1}. ${l}`).join('\n')}`);
      const problem = USSD_PROBLEMS[Number(rest[0]) - 1];
      if (!problem) return text('END Invalid choice.');
      if (rest.length < 2) return text('CON Where? Give the village, landmark or plot:');
      const t = await this.tickets.create(
        { organisationId: org.organisationId },
        { category: problem[1], channel: 'USSD', customerId: accounts.length === 1 ? accounts[0]._id : null, zoneId: accounts.length === 1 ? accounts[0].zoneId : null, phone: normalisePhone(phone) ?? phone, subject: problem[0], location: rest.slice(1).join(' ').slice(0, 200), externalRef: form.sessionId ? `ussd:${form.sessionId}` : undefined },
      );
      return text(`END Received. Your reference is ${t.number}. We will update you by SMS.`);
    }
    if (first === '4') {
      const notices = await this.notices.current(org.organisationId, accounts[0]?.zoneId);
      return text(`END ${notices.length ? notices.slice(0, 2).map((n) => n.message).join('\n').slice(0, 170) : 'There are no notices at the moment.'}`);
    }
    return text('END Invalid choice.');
  }
}
