import { BadRequestException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { Decimal, dec, round, toD128 } from '../../common/money';
import { Allocation, DocumentKind, Invoice, Payment } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { PartyType } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { LineInput, JournalsService } from '../journals/journals.service';
import { PeriodsService } from '../periods/periods.service';

/** The document kind an allocation settles, and the credit-note kind that can settle it, per party type. */
export const SIDES: Record<PartyType, { document: DocumentKind; credit: DocumentKind; label: string }> = {
  CUSTOMER: { document: 'SALES_INVOICE', credit: 'SALES_CREDIT', label: 'invoice' },
  SUPPLIER: { document: 'PURCHASE_BILL', credit: 'PURCHASE_CREDIT', label: 'bill' },
};

export type CreditSource = { type: 'PAYMENT'; doc: Payment } | { type: 'CREDIT_NOTE'; doc: Invoice };

export interface AllocationRequest {
  documentId: Types.ObjectId;
  source: { type: 'PAYMENT' | 'CREDIT_NOTE'; id: Types.ObjectId };
  amount: Decimal;
}

export function paymentStatus(amountDue: Decimal, total: Decimal): 'UNPAID' | 'PARTIAL' | 'PAID' {
  if (amountDue.isZero()) return 'PAID';
  return amountDue.eq(total) ? 'UNPAID' : 'PARTIAL';
}

/** Share of an open item's carrying value for `amount`; settling the whole balance clears it exactly. */
export function carryingPortion(openTx: Decimal, openFunctional: Decimal, amount: Decimal, precision: number): Decimal {
  if (amount.eq(openTx)) return openFunctional;
  return round(amount.times(openFunctional).div(openTx), precision);
}

/**
 * Open-item settlement shared by receivables and payables. Allocating removes the settled amount
 * from both items at their own carrying values; any difference is realised FX gain or loss.
 */
export class SettlementService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly periods: PeriodsService,
  ) {}

  async accounts(organisationId: Types.ObjectId, session?: ClientSession) {
    const org = await this.db.organisations.findById(organisationId).session(session ?? null).lean();
    const s = org?.settings;
    return {
      receivables: s?.receivablesAccountId ?? null,
      payables: s?.payablesAccountId ?? null,
      fxGain: s?.fxGainAccountId ?? null,
      fxLoss: s?.fxLossAccountId ?? null,
      matchTolerancePercent: s?.matchTolerancePercent ? dec(s.matchTolerancePercent) : new Decimal(0),
    };
  }

  async controlAccount(organisationId: Types.ObjectId, partyType: PartyType, session?: ClientSession): Promise<Types.ObjectId> {
    const a = await this.accounts(organisationId, session);
    const id = partyType === 'CUSTOMER' ? a.receivables : a.payables;
    if (!id) throw new BadRequestException(`Set the ${partyType === 'CUSTOMER' ? 'receivables' : 'payables'} control account in organisation settings first`);
    return id;
  }

  /** Lines that move a realised FX difference between the control account and the gain/loss accounts. */
  async fxLines(
    organisationId: Types.ObjectId,
    p: { partyType: PartyType; partyId: Types.ObjectId; currency: string; rate: Decimal; functional: string; gain: Decimal; description: string },
    session?: ClientSession,
  ): Promise<LineInput[]> {
    if (p.gain.isZero()) return [];
    const a = await this.accounts(organisationId, session);
    const fxAccount = p.gain.gt(0) ? a.fxGain : a.fxLoss;
    if (!fxAccount) throw new BadRequestException('Set the realised FX gain and loss accounts in organisation settings first');
    const control = await this.controlAccount(organisationId, p.partyType, session);
    const amount = p.gain.abs();
    const debitControl = p.gain.gt(0);
    return [
      {
        accountId: control,
        partyType: p.partyType,
        partyId: p.partyId,
        currency: p.currency,
        exchangeRate: p.rate,
        description: p.description,
        functionalDebit: debitControl ? amount : new Decimal(0),
        functionalCredit: debitControl ? new Decimal(0) : amount,
      },
      {
        accountId: fxAccount,
        currency: p.functional,
        description: p.description,
        debit: debitControl ? null : amount,
        credit: debitControl ? amount : null,
        functionalDebit: debitControl ? new Decimal(0) : amount,
        functionalCredit: debitControl ? amount : new Decimal(0),
      },
    ];
  }

  /**
   * When a payment or credit at one branch settles a document raised at another, the settled balance
   * moves to the paying branch on the control account; inter-branch clearing then balances both branches.
   */
  async branchMoveLines(
    organisationId: Types.ObjectId,
    p: {
      partyType: PartyType;
      partyId: Types.ObjectId;
      documentBranchId: Types.ObjectId;
      sourceBranchId: Types.ObjectId;
      currency: string;
      rate: Decimal;
      amount: Decimal;
      functional: Decimal;
      description: string;
      reverse?: boolean;
    },
    session?: ClientSession,
  ): Promise<LineInput[]> {
    if (p.documentBranchId.equals(p.sourceBranchId) || p.amount.isZero()) return [];
    const control = await this.controlAccount(organisationId, p.partyType, session);
    // Receivable documents are debits, payable documents credits; settling clears them at their branch.
    const creditAtDocument = (p.partyType === 'CUSTOMER') !== !!p.reverse;
    const line = (branchId: Types.ObjectId, debit: boolean): LineInput => ({
      accountId: control,
      branchId,
      partyType: p.partyType,
      partyId: p.partyId,
      currency: p.currency,
      exchangeRate: p.rate,
      description: p.description,
      debit: debit ? p.amount : null,
      credit: debit ? null : p.amount,
      functionalDebit: debit ? p.functional : new Decimal(0),
      functionalCredit: debit ? new Decimal(0) : p.functional,
    });
    return [line(p.documentBranchId, !creditAtDocument), line(p.sourceBranchId, creditAtDocument)];
  }

  private async loadSource(organisationId: Types.ObjectId, source: AllocationRequest['source'], session: ClientSession): Promise<CreditSource> {
    if (source.type === 'PAYMENT') {
      const doc = await this.db.payments.findOne({ _id: source.id, organisationId }).session(session).lean();
      if (!doc) throw new NotFoundException('Payment not found');
      return { type: 'PAYMENT', doc };
    }
    const doc = await this.db.invoices.findOne({ _id: source.id, organisationId }).session(session).lean();
    if (!doc) throw new NotFoundException('Credit note not found');
    return { type: 'CREDIT_NOTE', doc };
  }

  /**
   * Applies credits (payments on account, credit notes) to open invoices or bills. Runs inside the
   * caller's transaction; posts one journal for any realised FX. Returns the allocations created.
   */
  async allocate(
    user: AuthUser,
    p: { partyType: PartyType; partyId: Types.ObjectId; date: Date; requests: AllocationRequest[]; journalBranchId?: Types.ObjectId },
    session: ClientSession,
  ): Promise<Allocation[]> {
    const org = user.organisationId;
    const side = SIDES[p.partyType];
    if (!p.requests.length) return [];
    const created: Allocation[] = [];
    const fx: LineInput[] = [];
    let entityId: Types.ObjectId | null = null;
    let branchId: Types.ObjectId | null = p.journalBranchId ?? null;
    let firstSource: CreditSource | null = null;

    for (const req of p.requests) {
      if (req.amount.lte(0)) throw new BadRequestException('Allocation amounts must be positive');
      const doc = await this.db.invoices.findOne({ _id: req.documentId, organisationId: org }).session(session).lean();
      if (!doc) throw new NotFoundException(`${side.label} not found`);
      const source = await this.loadSource(org, req.source, session);
      const s = source.doc;
      firstSource ??= source;

      if (doc.kind !== side.document) throw new BadRequestException(`${doc.number} is not a ${side.label}`);
      if (doc.status !== 'POSTED') throw new BadRequestException(`${doc.number} is not posted`);
      if (!doc.partyId.equals(p.partyId) || !s.partyId.equals(p.partyId)) throw new BadRequestException('Allocations must be within one customer or supplier');
      if (s.status !== 'POSTED') throw new BadRequestException(`${s.number} is not posted`);
      if (source.type === 'CREDIT_NOTE' && source.doc.kind !== side.credit) throw new BadRequestException(`${s.number} cannot settle a ${side.label}`);
      if (source.type === 'PAYMENT' && source.doc.partyType !== p.partyType) throw new BadRequestException(`${s.number} cannot settle a ${side.label}`);
      if (!doc.entityId.equals(s.entityId)) throw new BadRequestException('Allocations must be within one entity');
      if (doc.currency !== s.currency) throw new BadRequestException(`${doc.number} and ${s.number} are in different currencies`);
      if (p.date < doc.date || p.date < s.date) throw new BadRequestException('The allocation date cannot be before either document');
      assertBranchAccess(user, [doc.branchId, s.branchId]);

      const fp = await this.currencies.precision(doc.functionalCurrency);
      const docOpen = dec(doc.amountDue);
      if (req.amount.gt(docOpen)) throw new BadRequestException(`${req.amount.toFixed()} exceeds the ${docOpen.toFixed()} due on ${doc.number}`);
      const srcOpen = source.type === 'PAYMENT' ? dec(source.doc.unallocated) : dec(source.doc.amountDue);
      const srcOpenF = source.type === 'PAYMENT' ? dec(source.doc.unallocatedFunctional) : dec(source.doc.amountDueFunctional);
      if (req.amount.gt(srcOpen)) throw new BadRequestException(`${req.amount.toFixed()} exceeds the ${srcOpen.toFixed()} available on ${s.number}`);

      const docF = carryingPortion(docOpen, dec(doc.amountDueFunctional), req.amount, fp);
      const srcF = carryingPortion(srcOpen, srcOpenF, req.amount, fp);
      // Receivables: credit carried above the invoice is a gain. Payables: a bill carried above the payment is a gain.
      const gain = p.partyType === 'CUSTOMER' ? srcF.minus(docF) : docF.minus(srcF);

      const newDue = docOpen.minus(req.amount);
      const docUpdated = await this.db.invoices.updateOne(
        { _id: doc._id, amountDue: doc.amountDue },
        {
          amountDue: toD128(newDue),
          amountDueFunctional: toD128(dec(doc.amountDueFunctional).minus(docF)),
          paymentStatus: paymentStatus(newDue, dec(doc.total)),
        },
        { session },
      );
      const srcFilter = source.type === 'PAYMENT' ? { _id: s._id, unallocated: source.doc.unallocated } : { _id: s._id, amountDue: source.doc.amountDue };
      const srcUpdate =
        source.type === 'PAYMENT'
          ? { unallocated: toD128(srcOpen.minus(req.amount)), unallocatedFunctional: toD128(srcOpenF.minus(srcF)) }
          : {
              amountDue: toD128(srcOpen.minus(req.amount)),
              amountDueFunctional: toD128(srcOpenF.minus(srcF)),
              paymentStatus: paymentStatus(srcOpen.minus(req.amount), dec(source.doc.total)),
            };
      const srcUpdated =
        source.type === 'PAYMENT'
          ? await this.db.payments.updateOne(srcFilter, srcUpdate, { session })
          : await this.db.invoices.updateOne(srcFilter, srcUpdate, { session });
      if (docUpdated.modifiedCount !== 1 || srcUpdated.modifiedCount !== 1) {
        throw new BadRequestException('A balance changed while allocating; reload and try again');
      }

      const [allocation] = await this.db.allocations.create(
        [
          {
            organisationId: org,
            entityId: doc.entityId,
            partyType: p.partyType,
            partyId: p.partyId,
            date: p.date,
            documentId: doc._id,
            documentNumber: doc.number,
            sourceType: source.type,
            sourceId: s._id,
            sourceNumber: s.number,
            currency: doc.currency,
            amount: toD128(req.amount),
            documentFunctional: toD128(docF),
            sourceFunctional: toD128(srcF),
            fxAmount: toD128(gain),
            createdBy: user.id,
          },
        ],
        { session },
      );
      created.push(allocation.toObject());
      entityId ??= doc.entityId;
      branchId ??= s.branchId;
      fx.push(
        ...(await this.branchMoveLines(
          org,
          {
            partyType: p.partyType,
            partyId: p.partyId,
            documentBranchId: doc.branchId,
            sourceBranchId: s.branchId,
            currency: doc.currency,
            rate: dec(doc.exchangeRate),
            amount: req.amount,
            functional: docF,
            description: `Branch settlement: ${s.number} → ${doc.number}`,
          },
          session,
        )),
      );
      fx.push(
        ...(await this.fxLines(
          org,
          {
            partyType: p.partyType,
            partyId: p.partyId,
            currency: doc.currency,
            rate: dec(s.exchangeRate),
            functional: doc.functionalCurrency,
            gain,
            description: `Realised FX: ${s.number} → ${doc.number}`,
          },
          session,
        )),
      );
    }

    await this.periods.assertPostable(user, entityId!, p.date, session);
    if (fx.length) {
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: entityId!, branchId: branchId!, journalDate: p.date, description: `Settlement of ${firstSource!.doc.number}: realised FX and branch transfer`, lines: fx },
        { sourceType: firstSource!.type === 'PAYMENT' ? 'Payment' : 'Invoice', sourceId: firstSource!.doc._id, sourceNumber: firstSource!.doc.number },
        session,
      );
      await this.db.allocations.updateMany({ _id: { $in: created.map((a) => a._id) } }, { journalId: journal._id }, { session });
      created.forEach((a) => (a.journalId = journal._id));
    }
    for (const a of created) {
      await this.audit.log(
        user,
        {
          action: 'allocation.create',
          recordType: 'Allocation',
          recordId: a._id,
          summary: `Allocated ${dec(a.amount).toFixed()} ${a.currency} from ${a.sourceNumber} to ${a.documentNumber}`,
        },
        session,
      );
    }
    return created;
  }

  /** Undoes an allocation: both balances are restored at the carrying values removed, and FX is reversed. */
  async reverse(user: AuthUser, allocationId: Types.ObjectId, date: Date, session: ClientSession) {
    const a = await this.db.allocations.findOne({ _id: allocationId, organisationId: user.organisationId }).session(session).lean();
    if (!a) throw new NotFoundException('Allocation not found');
    if (a.status !== 'ACTIVE') throw new BadRequestException('Allocation has already been reversed');
    if (date < a.date) date = a.date;
    const doc = (await this.db.invoices.findById(a.documentId).session(session).lean())!;
    assertBranchAccess(user, [doc.branchId]);
    if (doc.status !== 'POSTED') throw new BadRequestException(`${doc.number} is ${doc.status.toLowerCase()}`);
    const amount = dec(a.amount);

    const newDue = dec(doc.amountDue).plus(amount);
    await this.db.invoices.updateOne(
      { _id: doc._id },
      {
        amountDue: toD128(newDue),
        amountDueFunctional: toD128(dec(doc.amountDueFunctional).plus(dec(a.documentFunctional))),
        paymentStatus: paymentStatus(newDue, dec(doc.total)),
      },
      { session },
    );
    let sourceDoc: { branchId: Types.ObjectId; exchangeRate: Types.Decimal128; functionalCurrency: string };
    if (a.sourceType === 'PAYMENT') {
      const pay = (await this.db.payments.findById(a.sourceId).session(session).lean())!;
      await this.db.payments.updateOne(
        { _id: pay._id },
        {
          unallocated: toD128(dec(pay.unallocated).plus(amount)),
          unallocatedFunctional: toD128(dec(pay.unallocatedFunctional).plus(dec(a.sourceFunctional))),
        },
        { session },
      );
      sourceDoc = pay;
    } else {
      const cn = (await this.db.invoices.findById(a.sourceId).session(session).lean())!;
      const due = dec(cn.amountDue).plus(amount);
      await this.db.invoices.updateOne(
        { _id: cn._id },
        {
          amountDue: toD128(due),
          amountDueFunctional: toD128(dec(cn.amountDueFunctional).plus(dec(a.sourceFunctional))),
          paymentStatus: paymentStatus(due, dec(cn.total)),
        },
        { session },
      );
      sourceDoc = cn;
    }

    await this.periods.assertPostable(user, a.entityId, date, session);
    const lines = await this.fxLines(
      user.organisationId,
      {
        partyType: a.partyType as PartyType,
        partyId: a.partyId,
        currency: a.currency,
        rate: dec(sourceDoc.exchangeRate),
        functional: sourceDoc.functionalCurrency,
        gain: dec(a.fxAmount).neg(),
        description: `Reversal of realised FX: ${a.sourceNumber} → ${a.documentNumber}`,
      },
      session,
    );
    lines.push(
      ...(await this.branchMoveLines(
        user.organisationId,
        {
          partyType: a.partyType as PartyType,
          partyId: a.partyId,
          documentBranchId: doc.branchId,
          sourceBranchId: sourceDoc.branchId,
          currency: a.currency,
          rate: dec(doc.exchangeRate),
          amount,
          functional: dec(a.documentFunctional),
          description: `Branch settlement reversed: ${a.sourceNumber} → ${a.documentNumber}`,
          reverse: true,
        },
        session,
      )),
    );
    let reversalJournalId: Types.ObjectId | null = null;
    if (lines.length) {
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: a.entityId, branchId: sourceDoc.branchId, journalDate: date, description: `Allocation reversed: ${a.sourceNumber} → ${a.documentNumber}`, lines },
        { sourceType: a.sourceType === 'PAYMENT' ? 'Payment' : 'Invoice', sourceId: a.sourceId, sourceNumber: a.sourceNumber },
        session,
      );
      reversalJournalId = journal._id;
    }
    const marked = await this.db.allocations.updateOne(
      { _id: a._id, status: 'ACTIVE' },
      { status: 'REVERSED', reversedBy: user.id, reversedAt: new Date(), reversalJournalId },
      { session },
    );
    if (marked.modifiedCount !== 1) throw new BadRequestException('Allocation has already been reversed');
    await this.audit.log(
      user,
      {
        action: 'allocation.reverse',
        recordType: 'Allocation',
        recordId: a._id,
        summary: `Reversed allocation of ${amount.toFixed()} ${a.currency} from ${a.sourceNumber} to ${a.documentNumber}`,
      },
      session,
    );
  }

  /** Allocations touching a document or payment, newest first. */
  history(organisationId: Types.ObjectId, id: Types.ObjectId) {
    return this.db.allocations
      .find({ organisationId, $or: [{ documentId: id }, { sourceId: id }] })
      .sort({ date: -1, createdAt: -1 })
      .lean();
  }

  /** Outstanding balance per party in its currency: open documents less unapplied credits. */
  async balances(organisationId: Types.ObjectId, partyType: PartyType, partyIds?: Types.ObjectId[], entityId?: Types.ObjectId) {
    const side = SIDES[partyType];
    const base: Record<string, unknown> = { organisationId, status: 'POSTED' };
    if (partyIds) base.partyId = { $in: partyIds };
    if (entityId) base.entityId = entityId;
    const today = new Date();
    const [docs, payments] = await Promise.all([
      this.db.invoices.aggregate<{ _id: Types.ObjectId; due: unknown; credits: unknown; overdue: unknown; dueF: unknown; creditsF: unknown }>([
        { $match: { ...base, kind: { $in: [side.document, side.credit] } } },
        {
          $group: {
            _id: '$partyId',
            due: { $sum: { $cond: [{ $eq: ['$kind', side.document] }, '$amountDue', { $toDecimal: 0 }] } },
            dueF: { $sum: { $cond: [{ $eq: ['$kind', side.document] }, '$amountDueFunctional', { $toDecimal: 0 }] } },
            credits: { $sum: { $cond: [{ $eq: ['$kind', side.credit] }, '$amountDue', { $toDecimal: 0 }] } },
            creditsF: { $sum: { $cond: [{ $eq: ['$kind', side.credit] }, '$amountDueFunctional', { $toDecimal: 0 }] } },
            overdue: {
              $sum: { $cond: [{ $and: [{ $eq: ['$kind', side.document] }, { $lt: ['$dueDate', today] }] }, '$amountDue', { $toDecimal: 0 }] },
            },
          },
        },
      ]),
      this.db.payments.aggregate<{ _id: Types.ObjectId; unallocated: unknown; unallocatedF: unknown }>([
        { $match: { ...base, partyType } },
        { $group: { _id: '$partyId', unallocated: { $sum: '$unallocated' }, unallocatedF: { $sum: '$unallocatedFunctional' } } },
      ]),
    ]);
    const out = new Map<string, { outstanding: Decimal; overdue: Decimal; credits: Decimal; outstandingFunctional: Decimal }>();
    const get = (id: Types.ObjectId) => {
      const key = id.toHexString();
      const v = out.get(key) ?? { outstanding: new Decimal(0), overdue: new Decimal(0), credits: new Decimal(0), outstandingFunctional: new Decimal(0) };
      out.set(key, v);
      return v;
    };
    for (const d of docs) {
      const v = get(d._id);
      v.outstanding = v.outstanding.plus(dec(d.due as never)).minus(dec(d.credits as never));
      v.outstandingFunctional = v.outstandingFunctional.plus(dec(d.dueF as never)).minus(dec(d.creditsF as never));
      v.overdue = v.overdue.plus(dec(d.overdue as never));
      v.credits = v.credits.plus(dec(d.credits as never));
    }
    for (const p of payments) {
      const v = get(p._id);
      v.outstanding = v.outstanding.minus(dec(p.unallocated as never));
      v.outstandingFunctional = v.outstandingFunctional.minus(dec(p.unallocatedF as never));
      v.credits = v.credits.plus(dec(p.unallocated as never));
    }
    return out;
  }
}
