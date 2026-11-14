import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { PERMISSIONS } from '../../common/permissions';
import { assertApprovalLimit, assertSegregation, escapeRegex, transition } from '../../common/workflow';
import { DOCUMENT_STATUSES, Payment, PAYMENT_METHODS, PaymentKind, TaxCode } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { assertSupplierUsable } from '../procurement/supplier-management.service';
import { PartyType } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { partyModel, requirePermission } from '../documents/documents.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { PeriodsService } from '../periods/periods.service';
import { SettlementService, SIDES } from '../settlement/settlement.service';
import { TaxService } from '../tax/tax.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

export interface PaymentInput {
  entityId: Types.ObjectId;
  branchId?: Types.ObjectId | null;
  kind: PaymentKind;
  partyId: Types.ObjectId;
  date: Date;
  bankAccountId: Types.ObjectId;
  method?: (typeof PAYMENT_METHODS)[number];
  reference?: string;
  description?: string;
  amount: Decimal;
  exchangeRate?: Decimal | null;
  withholdingTaxCodeId?: Types.ObjectId | null;
  /** Receipts: tax codes the customer withheld under (income tax and/or VAT withholding). */
  withholdingTaxCodeIds?: Types.ObjectId[];
  allocations: { documentId: Types.ObjectId; amount: Decimal }[];
}

export interface PaymentListQuery {
  kind: PaymentKind;
  entityId?: Types.ObjectId;
  partyId?: Types.ObjectId;
  bankAccountId?: Types.ObjectId;
  status?: (typeof DOCUMENT_STATUSES)[number];
  from?: Date;
  to?: Date;
  search?: string;
  page: number;
  pageSize: number;
}

export const PARTY_OF_PAYMENT: Record<PaymentKind, PartyType> = { RECEIPT: 'CUSTOMER', PAYMENT: 'SUPPLIER' };
const PREFIX: Record<PaymentKind, string> = { RECEIPT: 'RCT', PAYMENT: 'PAY' };
const LABEL: Record<PaymentKind, string> = { RECEIPT: 'receipt', PAYMENT: 'payment' };

export class PaymentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly periods: PeriodsService,
    private readonly settlement: SettlementService,
    private readonly tax: TaxService,
    private readonly workflow: WorkflowService,
  ) {}

  /** Validates a receipt or payment and works out withholding tax on the documents it settles. */
  async build(user: AuthUser, input: PaymentInput, session?: ClientSession) {
    const org = user.organisationId;
    const s = session ?? null;
    const partyType = PARTY_OF_PAYMENT[input.kind];
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(s).lean();
    if (!entity?.isActive) throw new BadRequestException('Entity not found or inactive');
    const party = await partyModel(this.db, partyType).findOne({ _id: input.partyId, organisationId: org }).session(s).lean();
    if (!party) throw new BadRequestException(`${partyType === 'CUSTOMER' ? 'Customer' : 'Supplier'} not found`);
    if (!party.isActive) throw new BadRequestException(`${party.name} is inactive`);
    if (partyType === 'SUPPLIER') assertSupplierUsable(party, 'PAY');
    const bank = await this.db.bankAccounts.findOne({ _id: input.bankAccountId, organisationId: org }).session(s).lean();
    if (!bank || !bank.entityId.equals(entity._id)) throw new BadRequestException('Bank account not found in this entity');
    if (!bank.isActive) throw new BadRequestException(`${bank.name} is inactive`);
    if (bank.currency !== party.currency) {
      throw new BadRequestException(`${party.name} trades in ${party.currency}; use a ${party.currency} bank or cash account (${bank.name} is ${bank.currency})`);
    }
    const branchId = input.branchId ?? bank.branchId;
    const branch = await this.db.branches.findOne({ _id: branchId, organisationId: org }).session(s).lean();
    if (!branch || !branch.entityId.equals(entity._id) || !branch.isActive) throw new BadRequestException('Branch not found or not active in this entity');
    assertBranchAccess(user, [branchId]);

    const period = await this.periods.periodFor(org, entity._id, input.date, session);
    if (!period || period.status === 'HARD_CLOSED') throw new BadRequestException(`No open accounting period covers ${input.date.toISOString().slice(0, 10)}`);

    const currency = party.currency;
    const functional = entity.functionalCurrency;
    let rate = new Decimal(1);
    if (currency !== functional) {
      if (input.exchangeRate) rate = dec(input.exchangeRate);
      else {
        const found = await this.currencies.findRate(org, currency, functional, input.date, 'SPOT', session);
        if (!found) throw new BadRequestException(`No approved ${currency}/${functional} rate on or before ${input.date.toISOString().slice(0, 10)}`);
        rate = found.rate;
      }
      if (rate.lte(0)) throw new BadRequestException('Exchange rate must be positive');
    } else if (input.exchangeRate && !dec(input.exchangeRate).eq(1)) {
      throw new BadRequestException('The exchange rate for the functional currency must be 1');
    }
    const tp = await this.currencies.precision(currency);
    if (input.amount.isNeg()) throw new BadRequestException('The amount cannot be negative');
    if (input.amount.decimalPlaces() > tp) throw new BadRequestException(`${currency} allows at most ${tp} decimal places`);

    // Documents being settled.
    const side = SIDES[partyType];
    const ids = input.allocations.map((a) => a.documentId);
    if (new Set(ids.map(String)).size !== ids.length) throw new BadRequestException('Each document can be allocated once per payment');
    const docs = ids.length ? await this.db.invoices.find({ organisationId: org, _id: { $in: ids } }).session(s).lean() : [];
    for (const a of input.allocations) {
      const doc = docs.find((d) => d._id.equals(a.documentId));
      if (!doc || doc.kind !== side.document || !doc.partyId.equals(party._id)) throw new BadRequestException(`Allocation: ${side.label} not found for ${party.name}`);
      if (doc.status !== 'POSTED') throw new BadRequestException(`${doc.number} is not posted`);
      if (!doc.entityId.equals(entity._id)) throw new BadRequestException(`${doc.number} belongs to another entity`);
      if (a.amount.lte(0)) throw new BadRequestException(`Allocation to ${doc.number} must be positive`);
      if (a.amount.decimalPlaces() > tp) throw new BadRequestException(`${currency} allows at most ${tp} decimal places`);
    }

    // Withholding tax applies to the net (pre-VAT) share of each supplier bill being paid.
    let withholding = new Decimal(0);
    let withholdingBase = new Decimal(0);
    let whtCode = null;
    // Customers who are withholding agents deduct tax from what they pay; it settles the invoice too.
    const customerWithholdings: { code: TaxCode; rate: Decimal; base: Decimal; amount: Decimal }[] = [];
    const customerCodes = input.withholdingTaxCodeIds ?? [];
    if (customerCodes.length) {
      if (input.kind !== 'RECEIPT') throw new BadRequestException('Use the withholding tax field for supplier payments');
      if (new Set(customerCodes.map(String)).size !== customerCodes.length) throw new BadRequestException('Each withholding tax can be applied once');
      if (!input.allocations.length) throw new BadRequestException('Tax withheld is calculated on the invoices being paid; allocate the receipt');
      const codes = await this.tax.codes(org, customerCodes, session);
      for (const id of customerCodes) {
        const code = this.tax.assertUsable(codes.get(id.toHexString()), entity.country, 'WITHHOLDING', 'Withholding tax');
        if (!code.inputAccountId) throw new BadRequestException(`Set the recoverable account on tax code ${code.code} before recording tax withheld by customers`);
        const ratePercent = this.tax.rateOn(code, input.date);
        let base = new Decimal(0);
        let amount = new Decimal(0);
        for (const a of input.allocations) {
          const doc = docs.find((d) => d._id.equals(a.documentId))!;
          const share = round(a.amount.times(dec(doc.subtotal)).div(dec(doc.total)), tp);
          base = base.plus(share);
          amount = amount.plus(round(share.times(ratePercent).div(100), tp));
        }
        customerWithholdings.push({ code, rate: ratePercent, base, amount });
        withholding = withholding.plus(amount);
      }
    }
    if (input.withholdingTaxCodeId) {
      if (input.kind !== 'PAYMENT') throw new BadRequestException('Withholding tax applies to supplier payments only');
      const codes = await this.tax.codes(org, [input.withholdingTaxCodeId], session);
      whtCode = this.tax.assertUsable(codes.get(input.withholdingTaxCodeId.toHexString()), entity.country, 'WITHHOLDING', 'Withholding tax');
      const ratePercent = this.tax.rateOn(whtCode, input.date);
      if (!input.allocations.length) throw new BadRequestException('Withholding tax is calculated on the bills being paid; allocate the payment');
      for (const a of input.allocations) {
        const doc = docs.find((d) => d._id.equals(a.documentId))!;
        const base = round(a.amount.times(dec(doc.subtotal)).div(dec(doc.total)), tp);
        withholdingBase = withholdingBase.plus(base);
        withholding = withholding.plus(round(base.times(ratePercent).div(100), tp));
      }
    }
    const settlementValue = input.amount.plus(withholding);
    const allocated = sum(input.allocations.map((a) => a.amount));
    if (settlementValue.lte(0)) throw new BadRequestException('The amount must be greater than zero');
    if (allocated.gt(settlementValue)) {
      throw new BadRequestException(
        `Allocations (${allocated.toFixed()}) exceed the ${LABEL[input.kind]} amount${withholding.gt(0) ? ` plus withholding tax (${settlementValue.toFixed()})` : ` (${settlementValue.toFixed()})`}`,
      );
    }
    const fp = await this.currencies.precision(functional);

    return {
      entity,
      party,
      bank,
      whtCode,
      withholdingBase,
      customerWithholdings,
      fields: {
        entityId: entity._id,
        branchId,
        kind: input.kind,
        partyType,
        partyId: party._id,
        partyName: party.name,
        date: input.date,
        bankAccountId: bank._id,
        method: input.method ?? 'BANK_TRANSFER',
        reference: input.reference ?? '',
        description: input.description ?? '',
        currency,
        exchangeRate: toD128(rate),
        functionalCurrency: functional,
        amount: toD128(input.amount),
        amountFunctional: toD128(round(input.amount.times(rate), fp)),
        withholdingTaxCodeId: input.withholdingTaxCodeId ?? null,
        withholdingAmount: toD128(withholding),
        withholdingAmountFunctional: toD128(customerWithholdings.length ? customerWithholdings.reduce((t, w) => t.plus(round(w.amount.times(rate), fp)), new Decimal(0)) : round(withholding.times(rate), fp)),
        withholdingTaxCodeIds: customerCodes,
        customerWithholdings: customerWithholdings.map((w) => ({
          taxCodeId: w.code._id,
          taxCode: w.code.code,
          rate: toD128(w.rate),
          base: toD128(w.base),
          amount: toD128(w.amount),
          amountFunctional: toD128(round(w.amount.times(rate), fp)),
        })),
        unallocated: toD128(settlementValue),
        unallocatedFunctional: toD128(round(input.amount.times(rate), fp).plus(round(withholding.times(rate), fp))),
        plannedAllocations: input.allocations.map((a) => ({ documentId: a.documentId, amount: toD128(a.amount) })),
      },
    };
  }

  private inputOf(p: Payment): PaymentInput {
    return {
      entityId: p.entityId,
      branchId: p.branchId,
      kind: p.kind as PaymentKind,
      partyId: p.partyId,
      date: p.date,
      bankAccountId: p.bankAccountId,
      method: p.method as PaymentInput['method'],
      reference: p.reference,
      description: p.description,
      amount: dec(p.amount),
      exchangeRate: dec(p.exchangeRate),
      withholdingTaxCodeId: p.withholdingTaxCodeId,
      withholdingTaxCodeIds: p.withholdingTaxCodeIds ?? [],
      allocations: p.plannedAllocations.map((a) => ({ documentId: a.documentId, amount: dec(a.amount) })),
    };
  }

  // ------------------------------------------------------------------------------------------

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  async list(user: AuthUser, q: PaymentListQuery) {
    requirePermission(user, PARTY_OF_PAYMENT[q.kind], 'view');
    const filter: Record<string, unknown> = { ...this.scope(user), kind: q.kind };
    if (q.entityId) filter.entityId = q.entityId;
    if (q.partyId) filter.partyId = q.partyId;
    if (q.bankAccountId) filter.bankAccountId = q.bankAccountId;
    if (q.status) filter.status = q.status;
    if (q.from || q.to) filter.date = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ number: rx }, { partyName: rx }, { reference: rx }];
    }
    const [items, total] = await Promise.all([
      this.db.payments.find(filter).sort({ date: -1, number: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      this.db.payments.countDocuments(filter),
    ]);
    const banks = await this.db.bankAccounts.find({ _id: { $in: items.map((p) => p.bankAccountId) } }, { name: 1 }).lean();
    return {
      items: items.map((p) => ({ ...p, bankAccountName: banks.find((b) => b._id.equals(p.bankAccountId))?.name ?? '' })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  private async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession) {
    const p = await this.db.payments.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!p) throw new NotFoundException('Payment not found');
    return p;
  }

  /**
   * Receipts where the customer withheld tax: the certificate (KRA withholding certificate) is what lets
   * us claim the credit, so missing ones are followed up.
   */
  async withholdingCertificates(user: AuthUser, q: { entityId?: Types.ObjectId; status: 'MISSING' | 'RECEIVED' | 'ALL'; from?: Date; to?: Date }) {
    requirePermission(user, 'CUSTOMER', 'view');
    const filter: Record<string, unknown> = { ...this.scope(user), kind: 'RECEIPT', status: 'POSTED', 'customerWithholdings.0': { $exists: true } };
    if (q.entityId) filter.entityId = q.entityId;
    if (q.from || q.to) filter.date = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    const receipts = await this.db.payments.find(filter, { number: 1, date: 1, partyId: 1, partyName: 1, currency: 1, customerWithholdings: 1 }).sort({ date: 1 }).limit(2000).lean();
    const customers = await this.db.customers.find({ _id: { $in: receipts.map((r) => r.partyId) } }, { taxId: 1, email: 1 }).lean();
    const today = Date.now();
    const rows = receipts.flatMap((r) =>
      r.customerWithholdings
        .filter((w) => q.status === 'ALL' || (q.status === 'MISSING' ? !w.certificateNumber : !!w.certificateNumber))
        .map((w) => ({
          paymentId: r._id,
          number: r.number,
          date: r.date,
          customerId: r.partyId,
          customerName: r.partyName,
          customerTaxId: customers.find((c) => c._id.equals(r.partyId))?.taxId ?? '',
          currency: r.currency,
          taxCodeId: w.taxCodeId,
          taxCode: w.taxCode,
          base: w.base,
          amount: w.amount,
          amountFunctional: w.amountFunctional,
          certificateNumber: w.certificateNumber,
          certificateDate: w.certificateDate,
          daysOutstanding: w.certificateNumber ? null : Math.floor((today - r.date.getTime()) / 86_400_000),
        })),
    );
    const outstanding = rows.filter((r) => !r.certificateNumber).reduce((t, r) => t.plus(dec(r.amountFunctional)), new Decimal(0));
    return { items: rows, outstandingFunctional: outstanding };
  }

  async recordCertificate(user: AuthUser, id: Types.ObjectId, input: { taxCodeId: Types.ObjectId; certificateNumber: string; certificateDate: Date }) {
    requirePermission(user, 'CUSTOMER', 'manage');
    const p = await this.load(user, id);
    if (p.kind !== 'RECEIPT' || p.status !== 'POSTED') throw new BadRequestException('Certificates are recorded on posted receipts');
    const w = p.customerWithholdings.find((x) => x.taxCodeId.equals(input.taxCodeId));
    if (!w) throw new BadRequestException(`No tax was withheld under that code on ${p.number}`);
    if (input.certificateDate < p.date) throw new BadRequestException('The certificate cannot be dated before the receipt');
    const clash = await this.db.payments.exists({ organisationId: user.organisationId, partyId: p.partyId, _id: { $ne: p._id }, customerWithholdings: { $elemMatch: { taxCodeId: input.taxCodeId, certificateNumber: input.certificateNumber } } });
    if (clash) throw new BadRequestException(`Certificate ${input.certificateNumber} is already recorded on another receipt from ${p.partyName}`);
    await this.db.payments.updateOne(
      { _id: p._id, 'customerWithholdings.taxCodeId': input.taxCodeId },
      { $set: { 'customerWithholdings.$.certificateNumber': input.certificateNumber, 'customerWithholdings.$.certificateDate': input.certificateDate, 'customerWithholdings.$.certificateRecordedBy': user.id } },
    );
    await this.audit.log(user, {
      action: 'payment.withholding_certificate',
      recordType: 'Payment',
      recordId: p._id,
      summary: `Recorded ${w.taxCode} certificate ${input.certificateNumber} for ${dec(w.amount).toFixed()} ${p.currency} withheld by ${p.partyName} on ${p.number}${w.certificateNumber ? ` (replacing ${w.certificateNumber})` : ''}`,
    });
    return this.db.payments.findById(p._id, { customerWithholdings: 1 }).lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const p = await this.load(user, id);
    requirePermission(user, PARTY_OF_PAYMENT[p.kind as PaymentKind], 'view');
    const [bank, allocations, journals, planned, wht] = await Promise.all([
      this.db.bankAccounts.findById(p.bankAccountId, { mpesa: 0 }).lean(),
      this.settlement.history(user.organisationId, p._id),
      this.db.journals.find({ _id: { $in: [p.journalId, p.voidJournalId].filter(Boolean) } }, { number: 1 }).lean(),
      this.db.invoices
        .find({ _id: { $in: p.plannedAllocations.map((a) => a.documentId) } }, { number: 1, date: 1, dueDate: 1, total: 1, amountDue: 1, subtotal: 1, supplierInvoiceNumber: 1 })
        .lean(),
      p.withholdingTaxCodeId ? this.db.taxCodes.findById(p.withholdingTaxCodeId, { code: 1, name: 1 }).lean() : null,
    ]);
    return {
      ...(await withTrail(this.db, p)),
      bankAccount: bank && { id: bank._id, name: bank.name, accountNumber: bank.accountNumber, currency: bank.currency },
      allocations,
      plannedDocuments: planned,
      withholdingTaxCode: wht,
      journalNumber: journals.find((j) => j._id.equals(p.journalId ?? undefined))?.number ?? null,
      voidJournalNumber: journals.find((j) => j._id.equals(p.voidJournalId ?? undefined))?.number ?? null,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle. Receipts are posted by the person recording them; supplier payments need approval.
  // ------------------------------------------------------------------------------------------

  async create(user: AuthUser, input: PaymentInput, opts: { post?: boolean; idempotencyKey?: string; batchId?: Types.ObjectId } = {}) {
    requirePermission(user, PARTY_OF_PAYMENT[input.kind], 'manage');
    if (opts.idempotencyKey) {
      const existing = await this.db.payments.findOne({ organisationId: user.organisationId, idempotencyKey: opts.idempotencyKey }).lean();
      if (existing) return existing;
    }
    if (opts.post && input.kind !== 'RECEIPT') throw new BadRequestException('Supplier payments must be submitted and approved before release');
    return this.db.transaction(async (session) => {
      const created = await this.createIn(user, input, opts, session);
      return opts.post ? this.postIn(user, created, session) : created;
    });
  }

  async createIn(user: AuthUser, input: PaymentInput, opts: { idempotencyKey?: string; batchId?: Types.ObjectId }, session: ClientSession) {
    const { entity, fields } = await this.build(user, input, session);
    const number = await this.db.nextNumber(user.organisationId, entity, PREFIX[input.kind], session);
    const [p] = await this.db.payments.create(
      [{ ...fields, organisationId: user.organisationId, number, status: 'DRAFT', idempotencyKey: opts.idempotencyKey, batchId: opts.batchId ?? null, createdBy: user.id }],
      { session },
    );
    await this.audit.log(
      user,
      { action: 'payment.create', recordType: 'Payment', recordId: p._id, summary: `Created ${LABEL[input.kind]} ${number}: ${fields.partyName}`, after: p },
      session,
    );
    return p.toObject();
  }

  async update(user: AuthUser, id: Types.ObjectId, input: PaymentInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      requirePermission(user, PARTY_OF_PAYMENT[before.kind as PaymentKind], 'manage');
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') throw new BadRequestException(`A ${before.status.toLowerCase()} payment cannot be edited`);
      if (input.kind !== before.kind || !input.entityId.equals(before.entityId)) throw new BadRequestException('The type and entity of a payment cannot change');
      const { fields } = await this.build(user, input, session);
      const after = await transition(this.db.payments, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT', rejectedBy: null, rejectedAt: null, rejectionReason: '' }, session);
      await this.audit.log(user, { action: 'payment.update', recordType: 'Payment', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      requirePermission(user, PARTY_OF_PAYMENT[before.kind as PaymentKind], 'manage');
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') throw new BadRequestException('Only draft or rejected payments can be deleted; void posted ones');
      await this.db.payments.deleteOne({ _id: id, status: before.status }, { session });
      await this.workflow.close(user, 'SUPPLIER_PAYMENT', id, 'CANCELLED', 'Deleted', session);
      await this.audit.log(user, { action: 'payment.delete', recordType: 'Payment', recordId: id, summary: `Deleted ${before.number}`, before }, session);
      return { id, deleted: true };
    });
  }

  async submit(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      requirePermission(user, PARTY_OF_PAYMENT[before.kind as PaymentKind], 'manage');
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') throw new BadRequestException(`A ${before.status.toLowerCase()} payment cannot be submitted`);
      await this.build(user, this.inputOf(before), session);
      const after = await transition(this.db.payments, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: new Date() }, session);
      await this.audit.log(user, { action: 'payment.submit', recordType: 'Payment', recordId: id, summary: `Submitted ${before.number} for approval` }, session);
      if (after.kind === 'PAYMENT') await this.workflow.open(user, subjectOf('SUPPLIER_PAYMENT', after), session);
      return after;
    });
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      this.requireApprover(user, before.kind as PaymentKind);
      if (before.status !== 'SUBMITTED') throw new BadRequestException('Only submitted payments can be rejected');
      const after = await transition(this.db.payments, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: new Date(), rejectionReason: reason }, session);
      await this.audit.log(user, { action: 'payment.reject', recordType: 'Payment', recordId: id, summary: `Rejected ${before.number}: ${reason}` }, session);
      await this.workflow.close(user, 'SUPPLIER_PAYMENT', id, 'REJECTED', reason, session);
      return after;
    });
  }

  private requireApprover(user: AuthUser, kind: PaymentKind) {
    if (kind === 'PAYMENT' && !hasPermission(user, PERMISSIONS.PAYMENTS_APPROVE)) throw new ForbiddenException('Missing permission: payments.approve');
    if (kind === 'RECEIPT') requirePermission(user, 'CUSTOMER', 'manage');
  }

  /** Approves (supplier payments) or posts (receipts) a payment. */
  async approve(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const p = await this.load(user, id, session);
      const kind = p.kind as PaymentKind;
      this.requireApprover(user, kind);
      const org = await this.db.organisations.findById(user.organisationId).session(session).lean();
      const requireApproval = kind === 'PAYMENT' && org?.settings?.requireJournalApproval !== false;
      const allowed = requireApproval ? ['SUBMITTED'] : ['DRAFT', 'SUBMITTED', 'REJECTED'];
      if (!allowed.includes(p.status)) {
        throw new BadRequestException(p.status === 'POSTED' ? 'Payment is already posted' : 'Payment must be submitted before it can be approved');
      }
      if (requireApproval) {
        assertSegregation(user, p, 'a payment');
        const gate = await this.workflow.gate(user, subjectOf('SUPPLIER_PAYMENT', p), undefined, session);
        if (!gate.final) return { ...p, approval: this.workflow.view(gate.request) };
        assertApprovalLimit(user, dec(p.amountFunctional), p.functionalCurrency, 'The payment');
      }
      return this.postIn(user, p, session, allowed);
    });
  }

  /** Posts the bank and control-account journal, records withholding tax and applies planned allocations. */
  private async postIn(user: AuthUser, p: Payment, session: ClientSession, from: string[] = ['DRAFT']) {
    const kind = p.kind as PaymentKind;
    const { bank, whtCode, withholdingBase, customerWithholdings, fields } = await this.build(user, this.inputOf(p), session);
    const partyType = PARTY_OF_PAYMENT[kind];
    const control = await this.settlement.controlAccount(user.organisationId, partyType, session);
    const rate = dec(fields.exchangeRate);
    const amount = dec(fields.amount);
    const amountF = dec(fields.amountFunctional);
    const wht = dec(fields.withholdingAmount);
    const whtF = dec(fields.withholdingAmountFunctional);
    const receipt = kind === 'RECEIPT';
    const line = (accountId: Types.ObjectId, debit: boolean, tx: Decimal, functional: Decimal, extra: Partial<LineInput> = {}): LineInput => ({
      accountId,
      currency: p.currency,
      exchangeRate: rate,
      debit: debit ? tx : null,
      credit: debit ? null : tx,
      functionalDebit: debit ? functional : new Decimal(0),
      functionalCredit: debit ? new Decimal(0) : functional,
      ...extra,
    });
    const party = { partyType, partyId: p.partyId, description: `${p.number} · ${p.partyName}` };
    const lines: LineInput[] = [];
    if (amount.gt(0)) lines.push(line(bank.glAccountId, receipt, amount, amountF, { description: `${p.number} · ${p.partyName}` }));
    if (wht.gt(0) && whtCode) lines.push(line(whtCode.outputAccountId, false, wht, whtF, { description: `Withholding tax on ${p.number}` }));
    for (const w of fields.customerWithholdings) {
      lines.push(line(customerWithholdings.find((c) => c.code._id.equals(w.taxCodeId))!.code.inputAccountId!, true, dec(w.amount), dec(w.amountFunctional), { description: `${w.taxCode} withheld by ${p.partyName} on ${p.number}` }));
    }
    lines.push(line(control, !receipt, amount.plus(wht), amountF.plus(whtF), party));

    const journal = await this.journals.postSystemJournal(
      user,
      {
        entityId: p.entityId,
        branchId: p.branchId,
        journalDate: p.date,
        description: `${receipt ? 'Receipt from' : 'Payment to'} ${p.partyName}${p.reference ? ` (${p.reference})` : ''}`,
        reference: p.reference,
        lines,
      },
      { sourceType: 'Payment', sourceId: p._id, sourceNumber: p.number },
      session,
    );
    const now = new Date();
    await transition(
      this.db.payments,
      p._id,
      from,
      {
        status: 'POSTED',
        approvedBy: user.id,
        approvedAt: now,
        ...(!p.submittedBy && { submittedBy: user.id, submittedAt: now }),
        journalId: journal._id,
        amountFunctional: fields.amountFunctional,
        withholdingAmountFunctional: fields.withholdingAmountFunctional,
        customerWithholdings: fields.customerWithholdings,
        unallocated: fields.unallocated,
        unallocatedFunctional: fields.unallocatedFunctional,
      },
      session,
    );
    if (whtCode && wht.gt(0)) {
      const party = await this.db.suppliers.findById(p.partyId).session(session).lean();
      await this.tax.record(
        [
          {
            organisationId: p.organisationId,
            entityId: p.entityId,
            branchId: p.branchId,
            date: p.date,
            direction: 'WITHHOLDING',
            sourceType: 'Payment',
            sourceId: p._id,
            documentNumber: p.number,
            partyType,
            partyId: p.partyId,
            partyName: p.partyName,
            partyTaxId: party?.taxId ?? '',
            taxCodeId: whtCode._id,
            taxCode: whtCode.code,
            rate: toD128(this.tax.rateOn(whtCode, p.date)),
            currency: p.currency,
            exchangeRate: fields.exchangeRate,
            taxableAmountTx: toD128(withholdingBase),
            taxAmountTx: toD128(wht),
            taxableAmount: toD128(round(withholdingBase.times(rate), await this.currencies.precision(p.functionalCurrency))),
            taxAmount: toD128(whtF),
            journalId: journal._id,
          },
        ],
        session,
      );
    }
    if (customerWithholdings.length) {
      const customer = await this.db.customers.findById(p.partyId, { taxId: 1 }).session(session).lean();
      const fp = await this.currencies.precision(p.functionalCurrency);
      await this.tax.record(
        customerWithholdings.map((w) => ({
          organisationId: p.organisationId,
          entityId: p.entityId,
          branchId: p.branchId,
          date: p.date,
          direction: 'WITHHELD' as const,
          sourceType: 'Payment',
          sourceId: p._id,
          documentNumber: p.number,
          partyType,
          partyId: p.partyId,
          partyName: p.partyName,
          partyTaxId: customer?.taxId ?? '',
          taxCodeId: w.code._id,
          taxCode: w.code.code,
          rate: toD128(w.rate),
          currency: p.currency,
          exchangeRate: fields.exchangeRate,
          taxableAmountTx: toD128(w.base),
          taxAmountTx: toD128(w.amount),
          taxableAmount: toD128(round(w.base.times(rate), fp)),
          taxAmount: toD128(round(w.amount.times(rate), fp)),
          journalId: journal._id,
        })),
        session,
      );
    }
    await this.audit.log(
      user,
      { action: 'payment.post', recordType: 'Payment', recordId: p._id, summary: `${receipt ? 'Posted' : 'Approved and released'} ${p.number} (${journal.number})` },
      session,
    );
    if (p.plannedAllocations.length) {
      await this.settlement.allocate(
        user,
        {
          partyType,
          partyId: p.partyId,
          date: p.date,
          journalBranchId: p.branchId,
          requests: p.plannedAllocations.map((a) => ({ documentId: a.documentId, source: { type: 'PAYMENT' as const, id: p._id }, amount: dec(a.amount) })),
        },
        session,
      );
    }
    return this.db.payments.findById(p._id).session(session).lean();
  }

  /** Voids a posted payment: its allocations are reversed, then its journal and any withholding tax. */
  async void(user: AuthUser, id: Types.ObjectId, date: Date, reason: string) {
    return this.db.transaction(async (session) => {
      const p = await this.load(user, id, session);
      const kind = p.kind as PaymentKind;
      this.requireApprover(user, kind);
      if (p.status !== 'POSTED') throw new BadRequestException('Only posted payments can be voided');
      if (date < p.date) throw new BadRequestException('The void date cannot be before the payment date');
      const entries = await this.db.ledger.find({ journalId: p.journalId }, { _id: 1 }).session(session).lean();
      const matched = await this.db.bankMatches.exists({ ledgerEntryIds: { $in: entries.map((e) => e._id) } }).session(session);
      if (matched) throw new BadRequestException(`${p.number} is matched to a bank statement line; unmatch it first`);
      const refund = await this.db.refunds.findOne({ 'sources.id': p._id, status: 'POSTED' }, { number: 1 }).session(session).lean();
      if (refund) throw new BadRequestException(`${p.number} was refunded on ${refund.number}; void the refund first`);

      const allocations = await this.db.allocations.find({ organisationId: user.organisationId, sourceId: p._id, status: 'ACTIVE' }).session(session).lean();
      for (const a of allocations) await this.settlement.reverse(user, a._id, date, session);
      const reversal = await this.journals.reverseSystemJournal(user, p.journalId!, date, `Void of ${p.number}: ${reason}`, session);
      await this.tax.reverse(user.organisationId, p._id, reversal.journalDate, reversal._id, session);
      const after = await transition(
        this.db.payments,
        id,
        ['POSTED'],
        { status: 'VOID', voidedBy: user.id, voidedAt: new Date(), voidReason: reason, voidJournalId: reversal._id, unallocated: toD128(0), unallocatedFunctional: toD128(0) },
        session,
      );
      await this.audit.log(user, { action: 'payment.void', recordType: 'Payment', recordId: id, summary: `Voided ${p.number} with ${reversal.number}: ${reason}` }, session);
      return after;
    });
  }

  // ------------------------------------------------------------------------------------------
  // Payment runs: propose due bills, then create one draft payment per supplier
  // ------------------------------------------------------------------------------------------

  async proposal(user: AuthUser, q: { entityId: Types.ObjectId; bankAccountId: Types.ObjectId; dueBy: Date }) {
    requirePermission(user, 'SUPPLIER', 'manage');
    const bank = await this.db.bankAccounts.findOne({ _id: q.bankAccountId, organisationId: user.organisationId, entityId: q.entityId }).lean();
    if (!bank) throw new NotFoundException('Bank account not found');
    const filter: Record<string, unknown> = {
      ...this.scope(user),
      entityId: q.entityId,
      kind: 'PURCHASE_BILL',
      status: 'POSTED',
      paymentStatus: { $ne: 'PAID' },
      currency: bank.currency,
      dueDate: { $lte: q.dueBy },
    };
    const bills = await this.db.invoices.find(filter, { lines: 0 }).sort({ dueDate: 1 }).limit(1000).lean();
    // Bills already sitting on unposted payments are excluded so nothing is paid twice.
    const pending = await this.db.payments
      .find({ organisationId: user.organisationId, kind: 'PAYMENT', status: { $in: ['DRAFT', 'SUBMITTED', 'REJECTED'] } }, { plannedAllocations: 1, number: 1 })
      .lean();
    const onPayment = new Map(pending.flatMap((p) => p.plannedAllocations.map((a) => [a.documentId.toHexString(), p.number])));
    const suppliers = await this.db.suppliers.find({ _id: { $in: bills.map((b) => b.partyId) } }, { withholdingTaxCodeId: 1, bankName: 1, bankAccountNumber: 1 }).lean();
    return {
      bankAccount: { id: bank._id, name: bank.name, currency: bank.currency },
      bills: bills.map((b) => {
        const s = suppliers.find((x) => x._id.equals(b.partyId));
        return {
          ...b,
          pendingPaymentNumber: onPayment.get(b._id.toHexString()) ?? null,
          withholdingTaxCodeId: s?.withholdingTaxCodeId ?? null,
          supplierBank: s ? [s.bankName, s.bankAccountNumber].filter(Boolean).join(' ') : '',
        };
      }),
    };
  }

  async createRun(
    user: AuthUser,
    input: { entityId: Types.ObjectId; bankAccountId: Types.ObjectId; date: Date; method?: PaymentInput['method']; submit?: boolean; items: { documentId: Types.ObjectId; amount: Decimal }[] },
  ) {
    requirePermission(user, 'SUPPLIER', 'manage');
    if (!input.items.length) throw new BadRequestException('Select at least one bill');
    return this.db.transaction(async (session) => {
      const bills = await this.db.invoices.find({ organisationId: user.organisationId, _id: { $in: input.items.map((i) => i.documentId) } }).session(session).lean();
      const bySupplier = new Map<string, { documentId: Types.ObjectId; amount: Decimal }[]>();
      for (const item of input.items) {
        const bill = bills.find((b) => b._id.equals(item.documentId));
        if (!bill) throw new BadRequestException('Bill not found');
        const key = bill.partyId.toHexString();
        bySupplier.set(key, [...(bySupplier.get(key) ?? []), item]);
      }
      const batchId = new Types.ObjectId();
      const created: { _id: Types.ObjectId; number: string }[] = [];
      for (const [supplierId, items] of bySupplier) {
        const supplier = await this.db.suppliers.findById(supplierId).session(session).lean();
        const settle = sum(items.map((i) => i.amount));
        // Cash is the settled amount less any withholding tax on it.
        const probe = await this.build(
          user,
          { entityId: input.entityId, kind: 'PAYMENT', partyId: supplier!._id, date: input.date, bankAccountId: input.bankAccountId, amount: settle, withholdingTaxCodeId: supplier!.withholdingTaxCodeId, allocations: items },
          session,
        );
        const cash = settle.minus(dec(probe.fields.withholdingAmount));
        const payment = await this.createIn(
          user,
          {
            entityId: input.entityId,
            kind: 'PAYMENT',
            partyId: supplier!._id,
            date: input.date,
            bankAccountId: input.bankAccountId,
            method: input.method,
            description: 'Payment run',
            amount: cash,
            withholdingTaxCodeId: supplier!.withholdingTaxCodeId,
            allocations: items,
          },
          { batchId },
          session,
        );
        if (input.submit) {
          const submitted = await transition(this.db.payments, payment._id, ['DRAFT'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: new Date() }, session);
          await this.workflow.open(user, subjectOf('SUPPLIER_PAYMENT', submitted), session);
        }
        created.push(payment);
      }
      await this.audit.log(
        user,
        { action: 'payment.run', recordType: 'Payment', summary: `Payment run created ${created.length} payment(s): ${created.map((p) => p.number).join(', ')}` },
        session,
      );
      return { batchId, payments: created };
    });
  }

  /** Open items for a party: documents awaiting settlement and credits available to apply. */
  async openItems(user: AuthUser, partyType: PartyType, partyId: Types.ObjectId, entityId?: Types.ObjectId) {
    requirePermission(user, partyType, 'view');
    const side = SIDES[partyType];
    const base: Record<string, unknown> = { ...this.scope(user), partyId, status: 'POSTED' };
    if (entityId) base.entityId = entityId;
    const [documents, creditNotes, payments] = await Promise.all([
      this.db.invoices.find({ ...base, kind: side.document, paymentStatus: { $ne: 'PAID' } }, { lines: 0 }).sort({ dueDate: 1 }).lean(),
      this.db.invoices.find({ ...base, kind: side.credit, paymentStatus: { $ne: 'PAID' } }, { lines: 0 }).sort({ date: 1 }).lean(),
      this.db.payments.find({ ...base, partyType, unallocated: { $gt: toD128(0) } }).sort({ date: 1 }).lean(),
    ]);
    return {
      documents,
      credits: [
        ...creditNotes.map((c) => ({ type: 'CREDIT_NOTE' as const, id: c._id, number: c.number, date: c.date, currency: c.currency, available: c.amountDue, reference: c.reference })),
        ...payments.map((p) => ({ type: 'PAYMENT' as const, id: p._id, number: p.number, date: p.date, currency: p.currency, available: p.unallocated, reference: p.reference })),
      ],
    };
  }
}
