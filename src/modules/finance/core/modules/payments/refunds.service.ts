import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { assertApprovalLimit, assertSegregation } from '../../common/workflow';
import { Db } from '../../database/db.service';
import { Refund } from '../../database/payments.schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { PeriodsService } from '../periods/periods.service';
import { carryingPortion, paymentStatus, SettlementService } from '../settlement/settlement.service';
import { normalisePhone } from './daraja';

export interface RefundInput {
  entityId: Types.ObjectId;
  branchId?: Types.ObjectId | null;
  partyId: Types.ObjectId;
  date: Date;
  bankAccountId: Types.ObjectId;
  method?: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH' | 'MOBILE_MONEY' | 'CARD' | 'OTHER';
  payeePhone?: string;
  reference?: string;
  description?: string;
  exchangeRate?: Decimal | null;
  sources: { type: 'PAYMENT' | 'CREDIT_NOTE'; id: Types.ObjectId; amount: Decimal }[];
}

/**
 * Customer refunds: money paid back out of a customer's credit (receipts held on account and unused
 * credit notes). Approval posts Dr receivables (clearing the credits at their carrying value), Cr bank,
 * with any exchange difference realised; an M-Pesa payout follows when the bank account pays out by M-Pesa.
 */
export class RefundsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly periods: PeriodsService,
    private readonly settlement: SettlementService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  private async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession) {
    const r = await this.db.refunds.findOne({ _id: id, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!r) throw new NotFoundException('Refund not found');
    assertBranchAccess(user, [r.branchId]);
    return r;
  }

  async list(user: AuthUser, q: { entityId?: Types.ObjectId; partyId?: Types.ObjectId; status?: string }) {
    return this.db.refunds
      .find({ ...this.scope(user), ...(q.entityId && { entityId: q.entityId }), ...(q.partyId && { partyId: q.partyId }), ...(q.status && { status: q.status }) })
      .sort({ date: -1, number: -1 })
      .limit(500)
      .lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const r = await this.load(user, id);
    const payout = await this.db.payouts.findOne({ sourceId: r._id }, { status: 1, transactionId: 1, resultDescription: 1, payeeNumber: 1 }).lean();
    return { ...(await withTrail(this.db, r)), payout };
  }

  /** What the customer can be refunded: receipts on account and unused credit notes. */
  async credits(user: AuthUser, customerId: Types.ObjectId, entityId: Types.ObjectId) {
    const restricted = allowedBranches(user);
    const branches = restricted ? { branchId: { $in: restricted } } : {};
    const [payments, notes] = await Promise.all([
      this.db.payments.find({ organisationId: user.organisationId, entityId, partyType: 'CUSTOMER', partyId: customerId, status: 'POSTED', unallocated: { $gt: toD128(0) }, ...branches }).sort({ date: 1 }).lean(),
      this.db.invoices.find({ organisationId: user.organisationId, entityId, kind: 'SALES_CREDIT', partyId: customerId, status: 'POSTED', amountDue: { $gt: toD128(0) }, ...branches }).sort({ date: 1 }).lean(),
    ]);
    return [
      ...payments.map((p) => ({ type: 'PAYMENT' as const, id: p._id, number: p.number, date: p.date, currency: p.currency, available: dec(p.unallocated), description: p.description || p.reference })),
      ...notes.map((n) => ({ type: 'CREDIT_NOTE' as const, id: n._id, number: n.number, date: n.date, currency: n.currency, available: dec(n.amountDue), description: n.reference })),
    ];
  }

  private async loadSource(user: AuthUser, s: { type: 'PAYMENT' | 'CREDIT_NOTE'; id: Types.ObjectId }, session?: ClientSession) {
    if (s.type === 'PAYMENT') {
      const p = await this.db.payments.findOne({ _id: s.id, organisationId: user.organisationId }).session(session ?? null).lean();
      if (!p || p.partyType !== 'CUSTOMER') throw new BadRequestException('Receipt not found');
      return { doc: p, open: dec(p.unallocated), openF: dec(p.unallocatedFunctional) };
    }
    const n = await this.db.invoices.findOne({ _id: s.id, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!n || n.kind !== 'SALES_CREDIT') throw new BadRequestException('Credit note not found');
    return { doc: n, open: dec(n.amountDue), openF: dec(n.amountDueFunctional) };
  }

  private async build(user: AuthUser, input: RefundInput, session: ClientSession) {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(session).lean();
    if (!entity?.isActive) throw new BadRequestException('Entity not found or inactive');
    const customer = await this.db.customers.findOne({ _id: input.partyId, organisationId: org }).session(session).lean();
    if (!customer) throw new BadRequestException('Customer not found');
    const bank = await this.db.bankAccounts.findOne({ _id: input.bankAccountId, organisationId: org }).session(session).lean();
    if (!bank || !bank.entityId.equals(entity._id) || !bank.isActive) throw new BadRequestException('Bank account not found or inactive in this entity');
    if (bank.currency !== customer.currency) throw new BadRequestException(`${customer.name} trades in ${customer.currency}; refund from a ${customer.currency} account (${bank.name} is ${bank.currency})`);
    const branchId = input.branchId ?? bank.branchId;
    assertBranchAccess(user, [branchId]);
    if (!input.sources.length) throw new BadRequestException('Choose the receipts or credit notes to refund');
    const ids = input.sources.map((s) => s.id.toHexString());
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Each receipt or credit note can be refunded once per refund');
    const currency = customer.currency;
    const tp = await this.currencies.precision(currency);
    const sources = [];
    for (const s of input.sources) {
      if (!s.amount.gt(0)) throw new BadRequestException('Refund amounts must be positive');
      if (s.amount.decimalPlaces() > tp) throw new BadRequestException(`${currency} allows at most ${tp} decimal places`);
      const { doc, open } = await this.loadSource(user, s, session);
      assertBranchAccess(user, [doc.branchId]);
      if (!doc.partyId.equals(customer._id) || !doc.entityId.equals(entity._id)) throw new BadRequestException(`${doc.number} is not ${customer.name}'s in ${entity.code}`);
      if (doc.status !== 'POSTED') throw new BadRequestException(`${doc.number} is not posted`);
      if (doc.currency !== currency) throw new BadRequestException(`${doc.number} is in ${doc.currency}`);
      if (input.date < doc.date) throw new BadRequestException(`The refund cannot be dated before ${doc.number}`);
      if (s.amount.gt(open)) throw new BadRequestException(`${s.amount.toFixed()} exceeds the ${open.toFixed()} available on ${doc.number}`);
      sources.push({ type: s.type, id: doc._id, number: doc.number, branchId: doc.branchId, amount: toD128(s.amount), functional: null });
    }
    const amount = sum(input.sources.map((s) => s.amount));
    let rate = new Decimal(1);
    if (currency !== entity.functionalCurrency) {
      if (input.exchangeRate) rate = dec(input.exchangeRate);
      else {
        const found = await this.currencies.findRate(org, currency, entity.functionalCurrency, input.date, 'SPOT', session);
        if (!found) throw new BadRequestException(`No approved ${currency}/${entity.functionalCurrency} rate on or before ${input.date.toISOString().slice(0, 10)}`);
        rate = found.rate;
      }
    }
    const method = input.method ?? 'BANK_TRANSFER';
    const payeePhone = method === 'MOBILE_MONEY' ? normalisePhone(input.payeePhone || customer.phone || '') : '';
    if (method === 'MOBILE_MONEY' && !payeePhone) throw new BadRequestException(`Enter the Safaricom number to refund ${customer.name} to`);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    return {
      entity,
      fields: {
        entityId: entity._id,
        branchId,
        partyId: customer._id,
        partyName: customer.name,
        date: input.date,
        bankAccountId: bank._id,
        method,
        payeePhone: payeePhone ?? '',
        reference: input.reference ?? '',
        description: input.description ?? '',
        currency,
        exchangeRate: toD128(rate),
        functionalCurrency: entity.functionalCurrency,
        amount: toD128(amount),
        amountFunctional: toD128(round(amount.times(rate), fp)),
        sources,
      },
    };
  }

  async create(user: AuthUser, input: RefundInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.build(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, 'RF', session);
      const [r] = await this.db.refunds.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'refund.create', recordType: 'Refund', recordId: r._id, summary: `Created ${number}: refund of ${fields.amount.toString()} ${fields.currency} to ${fields.partyName}`, after: r }, session);
      return r.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: RefundInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'DRAFT') throw new BadRequestException('Only draft refunds can be edited');
      const { fields } = await this.build(user, input, session);
      await this.db.refunds.updateOne({ _id: id }, fields, { session });
      await this.audit.log(user, { action: 'refund.update', recordType: 'Refund', recordId: id, summary: `Edited ${before.number}`, before }, session);
      return this.db.refunds.findById(id).session(session).lean();
    });
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const r = await this.load(user, id, session);
      if (r.status !== 'DRAFT') throw new BadRequestException('Only draft refunds can be deleted');
      await this.db.refunds.deleteOne({ _id: id }, { session });
      await this.audit.log(user, { action: 'refund.delete', recordType: 'Refund', recordId: id, summary: `Deleted draft ${r.number}`, before: r }, session);
      return { deleted: true };
    });
  }

  /** Approves and posts: clears the credits from receivables and pays the money out of the bank account. */
  async approve(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const r = await this.load(user, id, session);
      if (r.status !== 'DRAFT') throw new BadRequestException(`${r.number} is ${r.status.toLowerCase()}`);
      assertSegregation(user, r, 'a refund');
      // The credits may have been used since the draft; check again.
      await this.build(user, this.inputOf(r), session);
      assertApprovalLimit(user, dec(r.amountFunctional), r.functionalCurrency, 'The refund');
      await this.periods.assertPostable(user, r.entityId, r.date, session);
      const fp = await this.currencies.precision(r.functionalCurrency);
      const control = await this.settlement.controlAccount(user.organisationId, 'CUSTOMER', session);
      const bank = (await this.db.bankAccounts.findById(r.bankAccountId).session(session).lean())!;
      const lines: LineInput[] = [];
      const sources = [];
      let cleared = new Decimal(0);
      for (const s of r.sources) {
        const { doc, open, openF } = await this.loadSource(user, { type: s.type as 'PAYMENT' | 'CREDIT_NOTE', id: s.id }, session);
        const amount = dec(s.amount);
        const functional = carryingPortion(open, openF, amount, fp);
        const updated =
          s.type === 'PAYMENT'
            ? await this.db.payments.updateOne({ _id: doc._id, unallocated: toD128(open) }, { unallocated: toD128(open.minus(amount)), unallocatedFunctional: toD128(openF.minus(functional)) }, { session })
            : await this.db.invoices.updateOne(
                { _id: doc._id, amountDue: toD128(open) },
                { amountDue: toD128(open.minus(amount)), amountDueFunctional: toD128(openF.minus(functional)), paymentStatus: paymentStatus(open.minus(amount), dec((doc as { total: unknown }).total as never)) },
                { session },
              );
        if (updated.modifiedCount !== 1) throw new BadRequestException(`${doc.number} changed while refunding; try again`);
        lines.push({ accountId: control, branchId: s.branchId, partyType: 'CUSTOMER', partyId: r.partyId, currency: r.currency, exchangeRate: dec(doc.exchangeRate), description: `Refund of ${doc.number}`, debit: amount, credit: null, functionalDebit: functional, functionalCredit: new Decimal(0) });
        sources.push({ ...s, functional: toD128(functional) });
        cleared = cleared.plus(functional);
      }
      const paid = dec(r.amountFunctional);
      lines.push({ accountId: bank.glAccountId, branchId: r.branchId, currency: r.currency, exchangeRate: dec(r.exchangeRate), description: `Refund to ${r.partyName}${r.reference ? ` (${r.reference})` : ''}`, debit: null, credit: dec(r.amount), functionalDebit: new Decimal(0), functionalCredit: paid });
      // Credits carried above what is paid now give a gain; below, a loss.
      const gain = cleared.minus(paid);
      if (!gain.isZero()) {
        const a = await this.settlement.accounts(user.organisationId, session);
        const fx = gain.gt(0) ? a.fxGain : a.fxLoss;
        if (!fx) throw new BadRequestException('Set the realised FX gain and loss accounts in organisation settings first');
        lines.push({ accountId: fx, branchId: r.branchId, currency: r.functionalCurrency, description: `Realised FX on refund ${r.number}`, debit: gain.lt(0) ? gain.abs() : null, credit: gain.gt(0) ? gain : null, functionalDebit: gain.lt(0) ? gain.abs() : new Decimal(0), functionalCredit: gain.gt(0) ? gain : new Decimal(0) });
      }
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: r.entityId, branchId: r.branchId, journalDate: r.date, description: `Refund ${r.number} · ${r.partyName}`, reference: r.reference, lines },
        { sourceType: 'Refund', sourceId: r._id, sourceNumber: r.number },
        session,
      );
      await this.db.refunds.updateOne({ _id: id, status: 'DRAFT' }, { status: 'POSTED', approvedBy: user.id, approvedAt: new Date(), journalId: journal._id, sources }, { session });
      await this.audit.log(user, { action: 'refund.post', recordType: 'Refund', recordId: id, summary: `Approved and paid ${r.number}: ${dec(r.amount).toFixed()} ${r.currency} to ${r.partyName} (${journal.number})` }, session);
      return this.db.refunds.findById(id).session(session).lean();
    });
  }

  /** Voids a posted refund: the journal is reversed and the credits are available again. */
  async void(user: AuthUser, id: Types.ObjectId, date: Date, reason: string) {
    return this.db.transaction(async (session) => {
      const r = await this.load(user, id, session);
      if (r.status !== 'POSTED') throw new BadRequestException('Only posted refunds can be voided');
      if (date < r.date) throw new BadRequestException('The void date cannot be before the refund');
      // An M-Pesa payout that may have gone blocks the void (the payout listener refuses it).
      await this.audit.log(user, { action: 'refund.void', recordType: 'Refund', recordId: id, summary: `Voided ${r.number}: ${reason}` }, session);
      const entries = await this.db.ledger.find({ journalId: r.journalId }, { _id: 1 }).session(session).lean();
      if (await this.db.bankMatches.exists({ ledgerEntryIds: { $in: entries.map((e) => e._id) } }).session(session)) throw new BadRequestException(`${r.number} is matched to a bank statement line; unmatch it first`);
      const reversal = await this.journals.reverseSystemJournal(user, r.journalId!, date, `Void of ${r.number}: ${reason}`, session);
      for (const s of r.sources) {
        const amount = dec(s.amount);
        const functional = dec(s.functional);
        if (s.type === 'PAYMENT') {
          const p = (await this.db.payments.findById(s.id).session(session).lean())!;
          await this.db.payments.updateOne({ _id: p._id }, { unallocated: toD128(dec(p.unallocated).plus(amount)), unallocatedFunctional: toD128(dec(p.unallocatedFunctional).plus(functional)) }, { session });
        } else {
          const n = (await this.db.invoices.findById(s.id).session(session).lean())!;
          const due = dec(n.amountDue).plus(amount);
          await this.db.invoices.updateOne({ _id: n._id }, { amountDue: toD128(due), amountDueFunctional: toD128(dec(n.amountDueFunctional).plus(functional)), paymentStatus: paymentStatus(due, dec(n.total)) }, { session });
        }
      }
      await this.db.refunds.updateOne({ _id: id }, { status: 'VOID', voidedBy: user.id, voidedAt: new Date(), voidReason: reason, voidJournalId: reversal._id }, { session });
      return this.db.refunds.findById(id).session(session).lean();
    });
  }

  private inputOf(r: Refund): RefundInput {
    return {
      entityId: r.entityId,
      branchId: r.branchId,
      partyId: r.partyId,
      date: r.date,
      bankAccountId: r.bankAccountId,
      method: r.method as RefundInput['method'],
      payeePhone: r.payeePhone,
      reference: r.reference,
      description: r.description,
      exchangeRate: dec(r.exchangeRate),
      sources: r.sources.map((s) => ({ type: s.type as 'PAYMENT' | 'CREDIT_NOTE', id: s.id, amount: dec(s.amount) })),
    };
  }
}
