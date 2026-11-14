import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { Types } from 'mongoose';
import { openPortal } from '@/platform/common/branding';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@/platform/common/errors';
import { normalisePhone } from '@/platform/common/validation';
import { SmsService } from '@/platform/services/sms.service';
import { WaterDb as Db, waterSettings } from '../db';
import { TICKET_CATEGORIES } from '../service-schemas';
import { NoticesService } from './notices.service';
import { TicketsService } from './tickets.service';

export const PORTAL_COOKIE = 'fs_customer';
export const PORTAL_SESSION_SECONDS = 24 * 60 * 60;
const CODE_MINUTES = 10;

export interface PortalCustomer {
  organisationId: Types.ObjectId;
  customerId: Types.ObjectId;
}

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(value);
}

const hashCode = (customerId: Types.ObjectId, code: string) => createHmac('sha256', secret()).update(`${customerId.toHexString()}:${code}`).digest('hex');

/**
 * The customer self-service portal (/portal/<organisation code>): customers sign in with their account
 * number and a code texted to the phone on the account, then see their balance, bills, statement and
 * payments as they stand now, report problems and follow their tickets, and read notices.
 */
export class PortalService {
  constructor(
    private readonly db: Db,
    private readonly sms: SmsService,
    private readonly tickets: TicketsService,
    private readonly notices: NoticesService,
  ) {}

  private async org(code: string) {
    const org = await this.db.organisations.findOne({ code: code.toUpperCase(), modules: 'water' }, { name: 1, phone: 1, email: 1 }).lean();
    if (!org) throw new NotFoundException('Unknown water service provider');
    const settings = await waterSettings(this.db, org._id);
    if (settings.service?.portalEnabled === false) throw new NotFoundException('The customer portal is switched off');
    const branding = await openPortal(this.db.connection, org._id, 'customers');
    return { org, settings, branding };
  }

  async info(code: string) {
    const { org, settings, branding } = await this.org(code);
    return { branding, name: org.name, phone: org.phone, email: org.email, paybill: settings.billing?.paybill ?? null, notices: (await this.notices.current(org._id)).map((n) => ({ title: n.title, message: n.message, type: n.type, startsAt: n.startsAt, endsAt: n.endsAt })) };
  }

  /** Texts a sign-in code when the phone matches the account. The answer never says which part was wrong. */
  async requestCode(code: string, input: { accountNo: string; phone: string }) {
    const { org } = await this.org(code);
    const phone = normalisePhone(input.phone);
    const customer = await this.db.customers.findOne({ organisationId: org._id, accountNo: input.accountNo.trim().toUpperCase(), status: { $nin: ['REJECTED'] } }, { phone: 1, altPhone: 1 }).lean();
    if (customer && phone && (customer.phone === phone || customer.altPhone === phone)) {
      const recent = await this.db.portalCodes.countDocuments({ customerId: customer._id, createdAt: { $gt: new Date(Date.now() - 60 * 60_000) } });
      if (recent < 5) {
        const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
        await this.db.portalCodes.create([{ organisationId: org._id, customerId: customer._id, codeHash: hashCode(customer._id, value), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) }]);
        await this.sms.queue(org._id, phone, `${org.name}: your sign-in code is ${value}. It expires in ${CODE_MINUTES} minutes. Do not share it.`, 'water:portal-code', customer._id);
        await this.sms.deliverDue(org._id);
      }
    }
    return { sent: true, message: 'If the phone number is on the account, a code is on its way.' };
  }

  async verify(code: string, input: { accountNo: string; code: string }) {
    const { org } = await this.org(code);
    const customer = await this.db.customers.findOne({ organisationId: org._id, accountNo: input.accountNo.trim().toUpperCase() }, { _id: 1 }).lean();
    const fail = () => new UnauthorizedException('The code is wrong or has expired');
    if (!customer) throw fail();
    const pending = await this.db.portalCodes.findOne({ customerId: customer._id, expiresAt: { $gt: new Date() }, attempts: { $lt: 5 } }).sort({ createdAt: -1 });
    if (!pending) throw fail();
    const expected = Buffer.from(pending.codeHash, 'hex');
    const given = Buffer.from(hashCode(customer._id, input.code.trim()), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      pending.attempts += 1;
      await pending.save();
      throw fail();
    }
    await this.db.portalCodes.deleteMany({ customerId: customer._id });
    const token = await new SignJWT({ org: org._id.toHexString(), kind: 'water-customer' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(customer._id.toHexString())
      .setIssuedAt()
      .setExpirationTime(`${PORTAL_SESSION_SECONDS}s`)
      .sign(secret());
    return { token };
  }

  /** The signed-in customer, from the portal cookie. */
  async authenticate(req: Request, code: string): Promise<PortalCustomer> {
    const cookie = req.headers.get('cookie') ?? '';
    const raw = cookie
      .split(';')
      .map((p) => p.trim().split('='))
      .find(([name]) => name === PORTAL_COOKIE)?.[1];
    if (!raw) throw new UnauthorizedException('Sign in with your account number');
    let payload: { sub?: string; org?: unknown; kind?: unknown };
    try {
      ({ payload } = await jwtVerify(decodeURIComponent(raw), secret(), { algorithms: ['HS256'] }));
    } catch {
      throw new UnauthorizedException('Your session has expired; sign in again');
    }
    const { org } = await this.org(code);
    if (payload.kind !== 'water-customer' || payload.org !== org._id.toHexString() || !payload.sub) throw new UnauthorizedException();
    return { organisationId: org._id, customerId: new Types.ObjectId(payload.sub) };
  }

  async me(who: PortalCustomer) {
    const c = await this.db.customers.findOne({ _id: who.customerId, organisationId: who.organisationId }, { accountNo: 1, name: 1, category: 1, status: 1, balance: 1, phone: 1, email: 1, location: 1, plotNo: 1, zoneId: 1, oldestUnpaidDueDate: 1 }).lean();
    if (!c) throw new UnauthorizedException();
    const [bills, statement, payments, tickets, notices, plan] = await Promise.all([
      this.db.bills.find({ organisationId: who.organisationId, customerId: c._id, status: 'ISSUED' }, { lines: 0, readingIds: 0 }).sort({ billDate: -1 }).limit(12).lean(),
      this.db.ledger.find({ organisationId: who.organisationId, customerId: c._id }).sort({ createdAt: -1, _id: -1 }).limit(50).lean(),
      this.db.payments.find({ organisationId: who.organisationId, customerId: c._id, status: { $in: ['POSTED', 'REVERSED'] } }, { raw: 0 }).sort({ paidAt: -1 }).limit(20).lean(),
      this.db.tickets.find({ organisationId: who.organisationId, customerId: c._id }, { history: 0 }).sort({ createdAt: -1 }).limit(20).lean(),
      this.notices.current(who.organisationId, c.zoneId),
      this.db.paymentPlans.findOne({ organisationId: who.organisationId, customerId: c._id, status: 'ACTIVE' }).lean(),
    ]);
    return { customer: c, bills, statement: statement.reverse(), payments, tickets, notices, plan, asOf: new Date() };
  }

  async bill(who: PortalCustomer, id: Types.ObjectId) {
    const bill = await this.db.bills.findOne({ _id: id, organisationId: who.organisationId, customerId: who.customerId, status: 'ISSUED' }).lean();
    if (!bill) throw new NotFoundException('Bill not found');
    return bill;
  }

  async report(who: PortalCustomer, input: { category: (typeof TICKET_CATEGORIES)[number]; subject: string; description?: string; location?: string; gps?: { lat: number; lng: number } | null }) {
    return this.tickets.create({ organisationId: who.organisationId }, { ...input, channel: 'PORTAL', customerId: who.customerId });
  }

  async feedback(who: PortalCustomer, ticketId: Types.ObjectId, input: { confirmed: boolean; satisfaction?: number | null; recommend?: number | null; note?: string }) {
    const t = await this.db.tickets.exists({ _id: ticketId, organisationId: who.organisationId, customerId: who.customerId });
    if (!t) throw new BadRequestException('Ticket not found');
    return this.tickets.customerFeedback(who.organisationId, ticketId, input);
  }
}
