import { ClientSession, mongo, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { escapeRegex } from '@/platform/common/validation';
import { WaterDb as Db } from '@/modules/water/server/db';
import { PAYMENT_CHANNELS, PAYMENT_STATUSES, PaymentDoc } from '@/modules/water/server/schemas';
import { AuditService } from '@/platform/services/audit.service';
import { StatementService } from '../customers/statement.service';
import { accountCandidates, C2B_ACCEPT, C2B_REJECT_ACCOUNT, C2BPayload, parseTransTime, payerName } from './mpesa';

type Channel = (typeof PAYMENT_CHANNELS)[number];

export interface SplitInput {
  /** An unmatched payment to split; otherwise a new receipt is recorded with the details below. */
  paymentId?: Types.ObjectId;
  channel?: Channel;
  reference?: string;
  paidAt?: Date;
  payerName?: string;
  payerPhone?: string;
  chequeNo?: string;
  drawerBank?: string;
  parts: { customerId: Types.ObjectId; amount: Decimal }[];
}

export interface PaymentHooks {
  /** A payment reached a customer's account (sync to accounting, reconnection checks, receipts by SMS). */
  afterPosted(organisationId: Types.ObjectId, paymentId: Types.ObjectId): Promise<void>;
  afterReversed(organisationId: Types.ObjectId, paymentId: Types.ObjectId): Promise<void>;
}

export class PaymentsService {
  hooks: PaymentHooks = { afterPosted: async () => undefined, afterReversed: async () => undefined };

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly statement: StatementService,
  ) {}

  private async receiptNo(organisationId: Types.ObjectId, session: ClientSession) {
    return `RCT-${String(await this.db.next(organisationId, 'receipt', session)).padStart(7, '0')}`;
  }

  private async credit(payment: PaymentDoc, session: ClientSession) {
    await this.statement.post(
      {
        organisationId: payment.organisationId,
        customerId: payment.customerId!,
        date: payment.paidAt,
        type: 'PAYMENT',
        reference: payment.receiptNo,
        description: payment.channel === 'CHEQUE' ? `Payment cheque ${payment.chequeNo ?? ''} ${payment.reference}`.replace(/\s+/g, ' ') : `Payment ${payment.channel === 'MPESA' ? 'M-Pesa' : payment.channel.toLowerCase()} ${payment.reference}`,
        credit: dec(payment.amount),
        sourceId: payment._id,
      },
      session,
    );
  }

  async list(user: AuthUser, q: { status?: (typeof PAYMENT_STATUSES)[number]; channel?: Channel; search?: string; from?: Date; to?: Date; customerId?: Types.ObjectId; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    if (q.channel) filter.channel = q.channel;
    if (q.customerId) filter.customerId = q.customerId;
    if (q.from || q.to) filter.paidAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lt: new Date(q.to.getTime() + 86_400_000) }) };
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ receiptNo: rx }, { reference: rx }, { accountNo: rx }, { accountRef: rx }, { payerName: rx }, { payerPhone: rx }];
    }
    const [items, total, sum] = await Promise.all([
      this.db.payments
        .find(filter, { raw: 0 })
        .sort({ paidAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.payments.countDocuments(filter),
      this.db.payments.aggregate<{ total: Types.Decimal128 }>([{ $match: { ...filter, status: filter.status ?? { $ne: 'REVERSED' } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize, amount: sum[0]?.total ?? toD128(0) };
  }

  /** A receipt keyed in by a cashier (cash office) or from a bank deposit slip. */
  async record(user: AuthUser, input: { customerId: Types.ObjectId; amount: Decimal; channel: Channel; reference: string; paidAt: Date; payerName?: string; payerPhone?: string; chequeNo?: string; drawerBank?: string }) {
    if (input.channel === 'CHEQUE' && !input.chequeNo) throw new BadRequestException('Enter the cheque number');
    if (input.amount.lte(0)) throw new BadRequestException('The amount must be above zero');
    const customer = await this.db.customers.findOne({ _id: input.customerId, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    const payment = await this.db.transaction(async (session) => {
      const [p] = await this.db.payments.create(
        [
          {
            organisationId: user.organisationId,
            receiptNo: await this.receiptNo(user.organisationId, session),
            channel: input.channel,
            reference: input.reference.trim().toUpperCase(),
            amount: toD128(input.amount),
            paidAt: input.paidAt,
            customerId: customer._id,
            accountNo: customer.accountNo,
            payerName: input.payerName ?? customer.name,
            payerPhone: input.payerPhone,
            chequeNo: input.chequeNo,
            drawerBank: input.drawerBank,
            status: 'POSTED',
            recordedBy: user.id,
          },
        ],
        { session },
      );
      await this.credit(p.toObject() as PaymentDoc, session);
      await this.audit.record(user, 'payment.record', 'payment', p._id, { amount: input.amount.toFixed(2), accountNo: customer.accountNo }, session);
      return p;
    });
    await this.hooks.afterPosted(user.organisationId, payment._id);
    return payment;
  }

  private async orgByToken(token: string) {
    if (!token || token.length < 16) return null;
    const settings = await this.db.waterSettings.findOne({ 'mpesa.callbackToken': token }, { organisationId: 1, mpesa: 1 }).lean();
    if (!settings) return null;
    // The paybill stops posting once the organisation switches the water module off.
    const enabled = await this.db.organisations.exists({ _id: settings.organisationId, modules: 'water' });
    return enabled ? { _id: settings.organisationId, mpesa: settings.mpesa } : null;
  }

  private async customerFor(organisationId: Types.ObjectId, ref: string) {
    for (const accountNo of accountCandidates(ref)) {
      const c = await this.db.customers.findOne({ organisationId, accountNo, status: { $nin: ['REJECTED'] } }, { _id: 1, accountNo: 1 }).lean();
      if (c) return c;
    }
    return null;
  }

  /** Safaricom asks before taking the money; an unknown account number is refused so the customer can retry. */
  async mpesaValidate(token: string, body: unknown) {
    const org = await this.orgByToken(token);
    const parsed = C2BPayload.safeParse(body);
    if (!org || !parsed.success) return C2B_REJECT_ACCOUNT;
    return (await this.customerFor(org._id, parsed.data.BillRefNumber)) ? C2B_ACCEPT : C2B_REJECT_ACCOUNT;
  }

  /**
   * Safaricom confirms a completed paybill payment. Stored once per M-Pesa transaction id; a payment
   * whose account number matches nobody waits as UNMATCHED for a cashier to allocate it.
   */
  async mpesaConfirm(token: string, body: unknown) {
    const org = await this.orgByToken(token);
    if (!org) return C2B_ACCEPT; // Never make Safaricom retry forever; an unknown token is logged and dropped.
    const parsed = C2BPayload.safeParse(body);
    if (!parsed.success) {
      console.error('Invalid M-Pesa C2B confirmation', parsed.error.issues);
      return C2B_ACCEPT;
    }
    const p = parsed.data;
    if (org.mpesa?.shortcode && org.mpesa.shortcode !== p.BusinessShortCode) {
      console.error(`M-Pesa confirmation for shortcode ${p.BusinessShortCode} does not match ${org.mpesa.shortcode}`);
      return C2B_ACCEPT;
    }
    const customer = await this.customerFor(org._id, p.BillRefNumber);
    let paymentId: Types.ObjectId | null = null;
    try {
      paymentId = await this.db.transaction(async (session) => {
        const [payment] = await this.db.payments.create(
          [
            {
              organisationId: org._id,
              receiptNo: await this.receiptNo(org._id, session),
              channel: 'MPESA',
              reference: p.TransID.toUpperCase(),
              amount: toD128(p.TransAmount),
              paidAt: parseTransTime(p.TransTime),
              customerId: customer?._id ?? null,
              accountNo: customer?.accountNo,
              accountRef: p.BillRefNumber,
              payerName: payerName(p),
              payerPhone: p.MSISDN,
              status: customer ? 'POSTED' : 'UNMATCHED',
              raw: p,
            },
          ],
          { session },
        );
        if (customer) await this.credit(payment.toObject() as PaymentDoc, session);
        return customer ? payment._id : null;
      });
    } catch (err) {
      // A repeated confirmation of the same transaction.
      if (err instanceof mongo.MongoServerError && err.code === 11000) return C2B_ACCEPT;
      throw err;
    }
    if (paymentId) await this.hooks.afterPosted(org._id, paymentId);
    return C2B_ACCEPT;
  }

  /** Puts an unmatched payment on the account it was meant for. */
  async allocate(user: AuthUser, id: Types.ObjectId, customerId: Types.ObjectId) {
    const customer = await this.db.customers.findOne({ _id: customerId, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    await this.db.transaction(async (session) => {
      const payment = await this.db.payments.findOneAndUpdate(
        { _id: id, organisationId: user.organisationId, status: 'UNMATCHED' },
        { status: 'POSTED', customerId: customer._id, accountNo: customer.accountNo, recordedBy: user.id },
        { new: true, session },
      );
      if (!payment) throw new BadRequestException('Only an unmatched payment can be allocated');
      await this.credit(payment.toObject() as PaymentDoc, session);
      await this.audit.record(user, 'payment.allocate', 'payment', id, { accountNo: customer.accountNo }, session);
    });
    await this.hooks.afterPosted(user.organisationId, id);
    return this.db.payments.findById(id, { raw: 0 }).lean();
  }

  /**
   * One receipt shared between several accounts (a landlord paying for tenants, a school with several
   * connections). Either a new receipt is keyed in with its parts, or an unmatched M-Pesa/bank payment is
   * split: the original is kept as SPLIT for the audit trail and each part is posted to its account.
   */
  async split(user: AuthUser, input: SplitInput) {
    if (input.parts.length < 2) throw new BadRequestException('Split between at least two accounts');
    const total = input.parts.reduce((s, p) => s.plus(p.amount), new Decimal(0));
    if (input.parts.some((p) => p.amount.lte(0))) throw new BadRequestException('Each part must be above zero');
    const ids = input.parts.map((p) => p.customerId.toHexString());
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each account can appear only once');
    const customers = await this.db.customers.find({ _id: { $in: input.parts.map((p) => p.customerId) }, organisationId: user.organisationId }, { accountNo: 1, name: 1 }).lean();
    if (customers.length !== input.parts.length) throw new NotFoundException('One of the accounts was not found');
    const byId = new Map(customers.map((c) => [c._id.toHexString(), c]));

    const created = await this.db.transaction(async (session) => {
      let base: { channel: Channel; reference: string; paidAt: Date; payerName?: string | null; payerPhone?: string | null; chequeNo?: string | null; drawerBank?: string | null };
      let splitFrom: Types.ObjectId | null = null;
      if (input.paymentId) {
        const original = await this.db.payments.findOne({ _id: input.paymentId, organisationId: user.organisationId, status: 'UNMATCHED' }).session(session);
        if (!original) throw new BadRequestException('Only an unmatched payment can be split');
        if (!dec(original.amount).eq(total)) throw new BadRequestException(`The parts add up to ${total.toFixed(2)}; the payment is ${dec(original.amount).toFixed(2)}`);
        original.status = 'SPLIT';
        original.recordedBy = user.id;
        await original.save({ session });
        base = { channel: original.channel as Channel, reference: original.reference, paidAt: original.paidAt, payerName: original.payerName, payerPhone: original.payerPhone };
        splitFrom = original._id;
      } else {
        if (!input.channel || !input.reference || !input.paidAt) throw new BadRequestException('Give the channel, reference and date of the receipt');
        if (input.channel === 'CHEQUE' && !input.chequeNo) throw new BadRequestException('Enter the cheque number');
        base = { channel: input.channel, reference: input.reference.trim().toUpperCase(), paidAt: input.paidAt, payerName: input.payerName, payerPhone: input.payerPhone, chequeNo: input.chequeNo, drawerBank: input.drawerBank };
      }
      const parts = [];
      for (const [i, part] of input.parts.entries()) {
        const c = byId.get(part.customerId.toHexString())!;
        const [p] = await this.db.payments.create(
          [
            {
              organisationId: user.organisationId,
              receiptNo: await this.receiptNo(user.organisationId, session),
              channel: base.channel,
              reference: `${base.reference}/${i + 1}`,
              amount: toD128(part.amount),
              paidAt: base.paidAt,
              customerId: c._id,
              accountNo: c.accountNo,
              payerName: base.payerName ?? c.name,
              payerPhone: base.payerPhone,
              chequeNo: base.chequeNo,
              drawerBank: base.drawerBank,
              splitFrom,
              status: 'POSTED',
              recordedBy: user.id,
            },
          ],
          { session },
        );
        await this.credit(p.toObject() as PaymentDoc, session);
        parts.push(p._id);
      }
      await this.audit.record(user, 'payment.split', 'payment', splitFrom, { reference: base.reference, total: total.toFixed(2), parts: input.parts.map((p) => ({ accountNo: byId.get(p.customerId.toHexString())?.accountNo, amount: p.amount.toFixed(2) })) }, session);
      return parts;
    });
    for (const id of created) await this.hooks.afterPosted(user.organisationId, id);
    return this.db.payments.find({ _id: { $in: created } }, { raw: 0 }).sort({ receiptNo: 1 }).lean();
  }

  /** Reverses a payment entered in error or bounced by the bank; the customer is charged back. */
  async reverse(user: AuthUser, id: Types.ObjectId, reason: string) {
    await this.db.transaction(async (session) => {
      const payment = await this.db.payments.findOneAndUpdate(
        { _id: id, organisationId: user.organisationId, status: 'POSTED' },
        { status: 'REVERSED', reversedBy: user.id, reversalReason: reason },
        { new: true, session },
      );
      if (!payment) throw new BadRequestException('Only a posted payment can be reversed');
      await this.statement.post(
        {
          organisationId: user.organisationId,
          customerId: payment.customerId!,
          date: new Date(),
          type: 'REVERSAL',
          reference: payment.receiptNo,
          description: `Reversal of ${payment.receiptNo}: ${reason}`,
          debit: dec(payment.amount),
          sourceId: payment._id,
        },
        session,
      );
      await this.audit.record(user, 'payment.reverse', 'payment', id, { reason }, session);
    });
    await this.hooks.afterReversed(user.organisationId, id);
    return this.db.payments.findById(id, { raw: 0 }).lean();
  }

  /** Total collected (excluding reversals) between two dates. */
  async collected(organisationId: Types.ObjectId, from: Date, to: Date): Promise<Decimal> {
    const [row] = await this.db.payments.aggregate<{ total: Types.Decimal128 }>([
      { $match: { organisationId, status: 'POSTED', paidAt: { $gte: from, $lt: to } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return dec(row?.total?.toString());
  }
}
