import { Types } from 'mongoose';
import { z } from 'zod';
import { AuthUser } from '../common/auth';
import { BadRequestException, NotFoundException } from '../common/errors';
import { toD128 } from '../common/money';
import { PERMISSIONS } from '../common/permissions';
import { parseId, zBool, zCurrency, zDate, zDecimal, zId, zLots } from '../common/validation';
import { escapeRegex } from '../common/workflow';
import { normalisePhone } from '../modules/payments/daraja';
import { DOCUMENT_KINDS, DOCUMENT_STATUSES, PAYMENT_KINDS, PAYMENT_METHODS, PROCUREMENT_CATEGORIES, PROCUREMENT_METHODS, SUPPLIER_COMPLIANCE_TYPES, TAX_KINDS } from '../database/commercial.schemas';
import { INVESTMENT_STATUSES, INVESTMENT_TYPES } from '../database/operational.schemas';
import { PARTY_TYPES, PartyType } from '../database/schemas';
import { route } from '../http/router';
import { pdf } from './getting-paid';
import { Services } from '../container';
import { partyModel, requirePermission } from '../modules/documents/documents.service';

const P = PERMISSIONS;
const page = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};
const reason = z.object({ reason: z.string().trim().min(1, 'A reason is required').max(500) });
const voidBody = reason.extend({ date: zDate });
const code = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9_-]+$/, 'Codes may contain letters, digits, - and _ only');

// ---------------------------------------------------------------------------------------------
// Tax codes
// ---------------------------------------------------------------------------------------------

const TaxCodeBody = z.object({
  code,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  kind: z.enum(TAX_KINDS),
  country: z.string().trim().max(100).optional(),
  rates: z
    .array(z.object({ rate: zDecimal.refine((r) => r.gte(0) && r.lte(100), 'Rate must be between 0 and 100'), effectiveFrom: zDate }))
    .min(1, 'At least one rate is required')
    .max(50),
  outputAccountId: zId,
  inputAccountId: zId.nullable().optional(),
  etimsTaxType: z.enum(['A', 'B', 'C', 'D', 'E']).nullable().optional(),
  isActive: z.boolean().optional(),
});
type TaxCodeInput = z.infer<typeof TaxCodeBody>;

async function validateTaxCode(s: Services, user: AuthUser, body: Partial<TaxCodeInput>) {
  const check = async (id: Types.ObjectId | null | undefined, cls: string, label: string) => {
    if (!id) return;
    const account = await s.db.accounts.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!account || !account.isPostable || account.accountClass !== cls) throw new BadRequestException(`${label} must be a postable ${cls.toLowerCase()} account`);
  };
  await check(body.outputAccountId, 'LIABILITY', 'The output / withholding tax account');
  await check(body.inputAccountId, 'ASSET', 'The input tax account');
  if (body.rates) {
    const dates = body.rates.map((r) => r.effectiveFrom.getTime());
    if (new Set(dates).size !== dates.length) throw new BadRequestException('Two rates cannot share an effective date');
  }
}

const taxDoc = ({ rates, code, ...rest }: Partial<TaxCodeInput>) => ({
  ...rest,
  ...(code && { code: code.toUpperCase() }),
  ...(rates && { rates: rates.map((r) => ({ rate: toD128(r.rate), effectiveFrom: r.effectiveFrom })) }),
});

const tax = [
  route({
    method: 'GET',
    path: '/tax-codes',
    handler: ({ s, user }) => s.db.taxCodes.find({ organisationId: user.organisationId }).sort({ kind: 1, code: 1 }).lean(),
  }),
  route({
    method: 'POST',
    path: '/tax-codes',
    permissions: [P.TAX_MANAGE],
    body: TaxCodeBody,
    handler: async ({ s, user, body }) => {
      await validateTaxCode(s, user, body);
      const [created] = await s.db.taxCodes.create([{ ...taxDoc(body), organisationId: user.organisationId }]);
      await s.audit.log(user, { action: 'tax_code.create', recordType: 'TaxCode', recordId: created._id, summary: `Created tax code ${created.code}`, after: created });
      return created;
    },
  }),
  route({
    method: 'PATCH',
    path: '/tax-codes/:id',
    permissions: [P.TAX_MANAGE],
    body: TaxCodeBody.partial(),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.taxCodes.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Tax code not found');
      if (body.kind && body.kind !== before.kind && (await s.db.taxTransactions.exists({ organisationId: user.organisationId, taxCodeId: before._id }))) {
        throw new BadRequestException('The kind of a tax code cannot change once it has been used');
      }
      await validateTaxCode(s, user, body);
      const after = await s.db.taxCodes.findByIdAndUpdate(before._id, taxDoc(body), { new: true }).lean();
      await s.audit.log(user, { action: 'tax_code.update', recordType: 'TaxCode', recordId: before._id, summary: `Updated tax code ${before.code}`, before, after });
      return after;
    },
  }),
];

// ---------------------------------------------------------------------------------------------
// Customers & suppliers
// ---------------------------------------------------------------------------------------------

const PartyBody = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  taxId: z.string().trim().max(100).optional(),
  currency: zCurrency,
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  defaultAccountId: zId.nullable().optional(),
  defaultTaxCodeId: zId.nullable().optional(),
  creditLimit: zDecimal.nullable().optional(),
  onHold: z.boolean().optional(),
  bankName: z.string().trim().max(100).optional(),
  bankAccountName: z.string().trim().max(200).optional(),
  bankAccountNumber: z.string().trim().max(50).optional(),
  bankBranch: z.string().trim().max(100).optional(),
  withholdingTaxCodeId: zId.nullable().optional(),
  /** Customers who are withholding agents: the taxes they usually deduct (suggested on receipts). */
  withholdingTaxCodeIds: z.array(zId).max(3).optional(),
  /** Suppliers paid through M-Pesa. */
  mpesaPayee: z
    .object({ type: z.enum(['PHONE', 'PAYBILL', 'TILL']), number: z.string().trim().max(20), accountReference: z.string().trim().max(13).default('') })
    .nullable()
    .optional(),
  intercompanyEntityId: zId.nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
  categoryIds: z.array(zId).max(10).optional(),
});
type PartyInput = z.infer<typeof PartyBody>;

async function validateParty(s: Services, user: AuthUser, type: PartyType, body: Partial<PartyInput>) {
  if (body.currency) await s.currencies.ensureActive(user, body.currency);
  if (body.defaultAccountId) {
    const a = await s.db.accounts.findOne({ _id: body.defaultAccountId, organisationId: user.organisationId }).lean();
    if (!a || !a.isPostable || a.isControl || !a.allowManualPosting) throw new BadRequestException('The default account must be a postable, non-control account');
  }
  const checkTax = async (id: Types.ObjectId | null | undefined, kind: string, label: string) => {
    if (!id) return;
    const t = await s.db.taxCodes.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!t || t.kind !== kind) throw new BadRequestException(`${label} must be a ${kind.toLowerCase()} tax code`);
  };
  await checkTax(body.defaultTaxCodeId, 'VAT', 'The default tax code');
  await checkTax(body.withholdingTaxCodeId, 'WITHHOLDING', 'The withholding tax code');
  if (type === 'CUSTOMER' && body.withholdingTaxCodeId) throw new BadRequestException('Use "taxes the customer withholds" for customers');
  if (type === 'SUPPLIER' && body.withholdingTaxCodeIds?.length) throw new BadRequestException('Taxes withheld by the party apply to customers');
  for (const id of body.withholdingTaxCodeIds ?? []) await checkTax(id, 'WITHHOLDING', 'Each tax the customer withholds');
  if (body.mpesaPayee) {
    if (type === 'CUSTOMER') throw new BadRequestException('M-Pesa payment details apply to suppliers');
    const payee = body.mpesaPayee;
    if (payee.type === 'PHONE') {
      const phone = normalisePhone(payee.number);
      if (!phone) throw new BadRequestException('Enter a Safaricom number such as 0712 345 678');
      payee.number = phone;
    } else if (!/^\d{5,7}$/.test(payee.number)) throw new BadRequestException(`Enter the ${payee.type === 'TILL' ? 'till' : 'paybill'} number`);
    if (payee.type === 'PAYBILL' && !payee.accountReference) throw new BadRequestException('Enter the account number to pay the paybill against');
  }
  if (type === 'SUPPLIER' && (body.creditLimit || body.onHold)) throw new BadRequestException('Credit limits and holds apply to customers');
  if (type === 'CUSTOMER' && body.categoryIds?.length) throw new BadRequestException('Categories apply to suppliers');
  if (type === 'SUPPLIER' && body.categoryIds) {
    const account = await s.supplierManagement.categoryAccount(user.organisationId, body.categoryIds);
    // A supplier without its own default account takes its category's.
    if (account && body.defaultAccountId === undefined) body.defaultAccountId = account;
  }
  if (body.creditLimit && body.creditLimit.isNeg()) throw new BadRequestException('The credit limit cannot be negative');
  if (body.intercompanyEntityId && !(await s.db.entities.exists({ _id: body.intercompanyEntityId, organisationId: user.organisationId }))) {
    throw new BadRequestException('The intercompany entity was not found in this organisation');
  }
}

const partyDoc = ({ creditLimit, code, ...rest }: Partial<PartyInput>) => ({
  ...rest,
  ...(code && { code: code.toUpperCase() }),
  ...(creditLimit !== undefined && { creditLimit: creditLimit ? toD128(creditLimit) : null }),
});

function partyRoutes(path: string, type: PartyType) {
  const label = type === 'CUSTOMER' ? 'Customer' : 'Supplier';
  const recordType = label;
  return [
    route({
      method: 'GET',
      path,
      query: z.object({ search: z.string().trim().max(100).optional(), activeOnly: zBool.optional(), entityId: zId.optional() }),
      handler: async ({ s, user, query: q }) => {
        requirePermission(user, type, 'view');
        const filter: Record<string, unknown> = { organisationId: user.organisationId };
        if (q.activeOnly) filter.isActive = true;
        if (q.search) {
          const rx = new RegExp(escapeRegex(q.search), 'i');
          filter.$or = [{ code: rx }, { name: rx }, { email: rx }, { taxId: rx }];
        }
        const parties = await partyModel(s.db, type).find(filter).sort({ name: 1 }).limit(2000).lean();
        const balances = await s.settlement.balances(user.organisationId, type, parties.map((p) => p._id), q.entityId);
        return parties.map((p) => {
          const b = balances.get(p._id.toHexString());
          return { ...p, outstanding: b?.outstanding ?? '0', overdue: b?.overdue ?? '0', unappliedCredits: b?.credits ?? '0' };
        });
      },
    }),
    route({
      method: 'GET',
      path: `${path}/:id`,
      handler: async ({ s, user, params }) => {
        requirePermission(user, type, 'view');
        const party = await partyModel(s.db, type).findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
        if (!party) throw new NotFoundException(`${label} not found`);
        const b = (await s.settlement.balances(user.organisationId, type, [party._id])).get(party._id.toHexString());
        return { ...party, outstanding: b?.outstanding ?? '0', overdue: b?.overdue ?? '0', unappliedCredits: b?.credits ?? '0' };
      },
    }),
    route({
      method: 'POST',
      path,
      body: PartyBody,
      handler: async ({ s, user, body }) => {
        requirePermission(user, type, 'manage');
        await validateParty(s, user, type, body);
        const pending = type === 'SUPPLIER' && (await s.supplierManagement.onboardingRequired(user.organisationId));
        const onboarding = pending ? { status: 'PENDING', onboarding: { submittedBy: user.id, submittedAt: new Date() } } : {};
        const [party] = await partyModel(s.db, type).create([{ ...partyDoc(body), ...onboarding, organisationId: user.organisationId, createdBy: user.id }]);
        await s.audit.log(user, { action: `${type.toLowerCase()}.create`, recordType, recordId: party._id, summary: `Created ${type.toLowerCase()} ${party.code} · ${party.name}`, after: party });
        return party;
      },
    }),
    route({
      method: 'PATCH',
      path: `${path}/:id`,
      body: PartyBody.partial(),
      handler: async ({ s, user, body, params }) => {
        requirePermission(user, type, 'manage');
        const model = partyModel(s.db, type);
        const before = await model.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
        if (!before) throw new NotFoundException(`${label} not found`);
        if (body.currency && body.currency !== before.currency) {
          const org = user.organisationId;
          const used =
            (await s.db.invoices.exists({ organisationId: org, partyId: before._id })) ||
            (await s.db.payments.exists({ organisationId: org, partyId: before._id })) ||
            (await s.db.purchaseOrders.exists({ organisationId: org, supplierId: before._id }));
          if (used) throw new BadRequestException('The currency cannot change once documents exist; create a new account for the other currency');
        }
        await validateParty(s, user, type, body);
        const after = await model.findByIdAndUpdate(before._id, partyDoc(body), { new: true }).lean();
        await s.audit.log(user, { action: `${type.toLowerCase()}.update`, recordType, recordId: before._id, summary: `Updated ${type.toLowerCase()} ${before.code}`, before, after });
        return after;
      },
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Sales & purchase documents (permissions depend on the document kind; checked in the service)
// ---------------------------------------------------------------------------------------------

const DocumentLineBody = z.object({
  description: z.string().trim().min(1, 'Each line needs a description').max(500),
  accountId: zId.nullable().optional(),
  quantity: zDecimal,
  unitPrice: zDecimal,
  discountPercent: zDecimal.nullable().optional(),
  taxCodeId: zId.nullable().optional(),
  departmentId: zId.nullable().optional(),
  costCentreId: zId.nullable().optional(),
  projectId: zId.nullable().optional(),
  poLineNo: z.number().int().positive().nullable().optional(),
  itemId: zId.nullable().optional(),
  warehouseId: zId.nullable().optional(),
  lots: zLots,
});

const DocumentBody = z.object({
  entityId: zId,
  branchId: zId,
  kind: z.enum(DOCUMENT_KINDS),
  partyId: zId,
  date: zDate,
  dueDate: zDate.nullable().optional(),
  reference: z.string().trim().max(100).optional(),
  supplierInvoiceNumber: z.string().trim().max(100).optional(),
  purchaseOrderId: zId.nullable().optional(),
  appliesToId: zId.nullable().optional(),
  exchangeRate: zDecimal.nullable().optional(),
  priceIncludesTax: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(DocumentLineBody).min(1).max(500),
});

const documents = [
  route({
    method: 'GET',
    path: '/invoices',
    query: z.object({
      kind: z
        .string()
        .transform((v) => v.split(',').filter(Boolean))
        .pipe(z.array(z.enum(DOCUMENT_KINDS)).min(1)),
      entityId: zId.optional(),
      partyId: zId.optional(),
      status: z.enum(DOCUMENT_STATUSES).optional(),
      open: zBool.optional(),
      overdue: zBool.optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      search: z.string().trim().max(100).optional(),
      ...page,
    }),
    handler: ({ s, user, query: q }) => s.documents.list(user, { ...q, kinds: q.kind }),
  }),
  route({ method: 'GET', path: '/invoices/:id', handler: ({ s, user, params }) => s.documents.get(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/invoices',
    body: DocumentBody,
    handler: ({ s, user, body, headers }) => s.documents.create(user, body, headers.get('idempotency-key') ?? undefined),
  }),
  route({ method: 'PATCH', path: '/invoices/:id', body: DocumentBody, handler: ({ s, user, params, body }) => s.documents.update(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/invoices/:id', handler: ({ s, user, params }) => s.documents.remove(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/invoices/:id/submit', handler: ({ s, user, params }) => s.documents.submit(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/invoices/:id/approve',
    body: z.object({ overrideMatch: z.boolean().optional(), comment: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.documents.approve(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/invoices/:id/reject', body: reason, handler: ({ s, user, params, body }) => s.documents.reject(user, parseId(params.id), body.reason) }),
  route({ method: 'POST', path: '/invoices/:id/void', body: voidBody, handler: ({ s, user, params, body }) => s.documents.void(user, parseId(params.id), body.date, body.reason) }),
];

// ---------------------------------------------------------------------------------------------
// Receipts, payments, payment runs & allocations
// ---------------------------------------------------------------------------------------------

const PaymentBody = z.object({
  entityId: zId,
  branchId: zId.nullable().optional(),
  kind: z.enum(PAYMENT_KINDS),
  partyId: zId,
  date: zDate,
  bankAccountId: zId,
  method: z.enum(PAYMENT_METHODS).optional(),
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  amount: zDecimal,
  exchangeRate: zDecimal.nullable().optional(),
  withholdingTaxCodeId: zId.nullable().optional(),
  withholdingTaxCodeIds: z.array(zId).max(3).optional(),
  allocations: z.array(z.object({ documentId: zId, amount: zDecimal })).max(500).default([]),
});

const payments = [
  route({
    method: 'GET',
    path: '/payments',
    query: z.object({
      kind: z.enum(PAYMENT_KINDS),
      entityId: zId.optional(),
      partyId: zId.optional(),
      bankAccountId: zId.optional(),
      status: z.enum(DOCUMENT_STATUSES).optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      search: z.string().trim().max(100).optional(),
      ...page,
    }),
    handler: ({ s, user, query }) => s.payments.list(user, query),
  }),
  route({
    method: 'GET',
    path: '/payments/proposal',
    query: z.object({ entityId: zId, bankAccountId: zId, dueBy: zDate }),
    handler: ({ s, user, query }) => s.payments.proposal(user, query),
  }),
  route({
    method: 'POST',
    path: '/payments/runs',
    body: z.object({
      entityId: zId,
      bankAccountId: zId,
      date: zDate,
      method: z.enum(PAYMENT_METHODS).optional(),
      submit: z.boolean().optional(),
      items: z.array(z.object({ documentId: zId, amount: zDecimal })).min(1).max(1000),
    }),
    handler: ({ s, user, body }) => s.payments.createRun(user, body),
  }),
  route({
    method: 'GET',
    path: '/payments/withholding-certificates',
    permissions: [PERMISSIONS.AR_VIEW],
    query: z.object({ entityId: zId.optional(), status: z.enum(['MISSING', 'RECEIVED', 'ALL']).default('MISSING'), from: zDate.optional(), to: zDate.optional() }),
    handler: ({ s, user, query }) => s.payments.withholdingCertificates(user, query),
  }),
  route({ method: 'GET', path: '/payments/:id', handler: ({ s, user, params }) => s.payments.get(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/payments/:id/voucher',
    rateLimit: 60,
    query: z.object({ download: z.enum(['1', '0']).optional() }),
    handler: async ({ s, user, params, query }) => pdf(await s.vouchers.payment(user, parseId(params.id)), query.download === '1'),
  }),
  route({ method: 'GET', path: '/payments/:id/cheque-signatures', handler: ({ s, user, params }) => s.chequeSigning.status(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/payments/:id/cheque-sign', status: 200, handler: ({ s, user, params }) => s.chequeSigning.sign(user, parseId(params.id)) }),
  route({
    method: 'PATCH',
    path: '/bank-accounts/:id/cheque-signatories',
    permissions: [PERMISSIONS.BANKING_MANAGE],
    body: z.object({ userIds: z.array(zId).max(20), required: z.number().int().min(0).max(20) }),
    handler: ({ s, user, params, body }) => s.chequeSigning.setSignatories(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/payments/:id/cheque', rateLimit: 30, handler: async ({ s, user, params }) => { requirePermission(user, 'SUPPLIER', 'manage'); return pdf(await s.vouchers.cheque(user, parseId(params.id)), false); } }),
  route({
    method: 'POST',
    path: '/payments/:id/withholding-certificates',
    permissions: [PERMISSIONS.AR_MANAGE],
    status: 200,
    body: z.object({ taxCodeId: zId, certificateNumber: z.string().trim().min(3).max(60), certificateDate: zDate }),
    handler: ({ s, user, params, body }) => s.payments.recordCertificate(user, parseId(params.id), body),
  }),
  /** Receipts can be posted on creation with `post: true`; supplier payments go through approval. */
  route({
    method: 'POST',
    path: '/payments',
    body: PaymentBody.extend({ post: z.boolean().optional() }),
    handler: ({ s, user, body: { post, ...input }, headers }) => s.payments.create(user, input, { post, idempotencyKey: headers.get('idempotency-key') ?? undefined }),
  }),
  route({ method: 'PATCH', path: '/payments/:id', body: PaymentBody, handler: ({ s, user, params, body }) => s.payments.update(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/payments/:id', handler: ({ s, user, params }) => s.payments.remove(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/payments/:id/submit', handler: ({ s, user, params }) => s.payments.submit(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/payments/:id/approve',
    handler: async ({ s, user, params }) => {
      const out = await s.payments.approve(user, parseId(params.id));
      // The supplier is sent a remittance advice once the payment posts; a failure here never undoes the payment.
      await s.remittance.send(user, parseId(params.id), { auto: true }).catch(() => null);
      return out;
    },
  }),
  route({
    method: 'POST',
    path: '/payments/:id/remittance',
    status: 200,
    body: z.object({ to: z.string().trim().email().max(200).optional() }),
    handler: ({ s, user, params, body }) => {
      requirePermission(user, 'SUPPLIER', 'manage');
      return s.remittance.send(user, parseId(params.id), { to: body.to });
    },
  }),
  route({ method: 'POST', path: '/payments/:id/reject', body: reason, handler: ({ s, user, params, body }) => s.payments.reject(user, parseId(params.id), body.reason) }),
  route({ method: 'POST', path: '/payments/:id/void', body: voidBody, handler: ({ s, user, params, body }) => s.payments.void(user, parseId(params.id), body.date, body.reason) }),

  route({
    method: 'GET',
    path: '/allocations/open-items',
    query: z.object({ partyType: z.enum(PARTY_TYPES), partyId: zId, entityId: zId.optional() }),
    handler: ({ s, user, query: q }) => s.payments.openItems(user, q.partyType, q.partyId, q.entityId),
  }),
  route({
    method: 'POST',
    path: '/allocations',
    body: z.object({
      partyType: z.enum(PARTY_TYPES),
      partyId: zId,
      date: zDate,
      items: z
        .array(z.object({ documentId: zId, sourceType: z.enum(['PAYMENT', 'CREDIT_NOTE']), sourceId: zId, amount: zDecimal }))
        .min(1)
        .max(200),
    }),
    handler: ({ s, user, body }) => {
      requirePermission(user, body.partyType, 'manage');
      return s.db.transaction((session) =>
        s.settlement.allocate(
          user,
          {
            partyType: body.partyType,
            partyId: body.partyId,
            date: body.date,
            requests: body.items.map((i) => ({ documentId: i.documentId, source: { type: i.sourceType, id: i.sourceId }, amount: i.amount })),
          },
          session,
        ),
      );
    },
  }),
  route({
    method: 'POST',
    path: '/allocations/:id/reverse',
    body: z.object({ date: zDate }),
    handler: async ({ s, user, params, body }) => {
      const id = parseId(params.id);
      const allocation = await s.db.allocations.findOne({ _id: id, organisationId: user.organisationId }).lean();
      if (!allocation) throw new NotFoundException('Allocation not found');
      requirePermission(user, allocation.partyType as PartyType, 'manage');
      await s.db.transaction((session) => s.settlement.reverse(user, id, body.date, session));
      return { id, reversed: true };
    },
  }),
];

// ---------------------------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------------------------

const BankAccountBody = z.object({
  entityId: zId,
  branchId: zId,
  name: z.string().trim().min(1).max(100),
  type: z.enum(['BANK', 'CASH', 'MOBILE_MONEY', 'PETTY_CASH']).optional(),
  bankName: z.string().trim().max(100).optional(),
  accountNumber: z.string().trim().max(50).optional(),
  glAccountId: zId,
  reconcileFrom: zDate.nullable().optional(),
  isActive: z.boolean().optional(),
});

const InvestmentBody = z.object({
  entityId: zId,
  type: z.enum(INVESTMENT_TYPES),
  institution: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  principal: zDecimal,
  ratePercent: zDecimal,
  dayCount: z.enum(['ACT_365', 'ACT_360']).default('ACT_365'),
  startDate: zDate,
  maturityDate: zDate,
  withholdingPercent: zDecimal.default('0'),
  bankAccountId: zId,
  investmentAccountId: zId,
  interestIncomeAccountId: zId,
  interestReceivableAccountId: zId,
  withholdingAccountId: zId.nullable().optional(),
});

const treasury = [
  route({
    method: 'GET',
    path: '/investments',
    permissions: [P.BANKING_VIEW],
    query: z.object({ entityId: zId, status: z.enum(INVESTMENT_STATUSES).optional() }),
    handler: ({ s, user, query }) => s.investments.list(user, query),
  }),
  route({
    method: 'GET',
    path: '/treasury/report',
    permissions: [P.BANKING_VIEW],
    query: z.object({ entityId: zId, from: zDate, to: zDate, horizonDays: z.coerce.number().int().min(1).max(366).optional() }),
    handler: ({ s, user, query }) => s.investments.report(user, query),
  }),
  route({
    method: 'POST',
    path: '/investments/accrue',
    permissions: [P.BANKING_MANAGE],
    body: z.object({ entityId: zId, asOf: zDate }),
    handler: ({ s, user, body }) => s.investments.accrue(user, body),
  }),
  route({ method: 'GET', path: '/investments/:id', permissions: [P.BANKING_VIEW], handler: ({ s, user, params }) => s.investments.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/investments', permissions: [P.BANKING_MANAGE], body: InvestmentBody, handler: ({ s, user, body }) => s.investments.save(user, null, body) }),
  route({ method: 'PATCH', path: '/investments/:id', permissions: [P.BANKING_MANAGE], body: InvestmentBody, handler: ({ s, user, params, body }) => s.investments.save(user, parseId(params.id), body) }),
  ...(['submit', 'approve', 'reject', 'cancel'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/investments/:id/${action}`,
      permissions: [action === 'approve' || action === 'reject' ? P.PAYMENTS_APPROVE : P.BANKING_MANAGE],
      body: z.object({ reason: z.string().trim().max(500).optional() }),
      handler: ({ s, user, params, body }) => s.investments.act(user, parseId(params.id), action, body.reason),
    }),
  ),
  route({
    method: 'POST',
    path: '/investments/:id/settle',
    permissions: [P.BANKING_MANAGE],
    body: z.object({
      date: zDate,
      bankAccountId: zId.optional(),
      interest: zDecimal.optional(),
      rollover: z.object({ maturityDate: zDate, ratePercent: zDecimal.optional(), reinvestInterest: z.boolean().default(false) }).nullable().optional(),
    }),
    handler: ({ s, user, params, body }) => s.investments.settle(user, parseId(params.id), body),
  }),
];

const banking = [
  ...treasury,
  route({
    method: 'GET',
    path: '/bank-accounts',
    permissions: [P.BANKING_VIEW],
    query: z.object({ entityId: zId.optional() }),
    handler: ({ s, user, query }) => s.banking.list(user, query.entityId),
  }),
  route({ method: 'POST', path: '/bank-accounts', permissions: [P.BANKING_MANAGE], body: BankAccountBody, handler: ({ s, user, body }) => s.banking.create(user, body) }),
  route({
    method: 'PATCH',
    path: '/bank-accounts/:id',
    permissions: [P.BANKING_MANAGE],
    body: BankAccountBody.partial(),
    handler: ({ s, user, params, body }) => s.banking.update(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/bank-transfers',
    permissions: [P.BANKING_VIEW],
    query: z.object({ entityId: zId.optional() }),
    handler: ({ s, user, query }) => s.banking.transfers(user, query.entityId),
  }),
  route({
    method: 'POST',
    path: '/bank-transfers',
    permissions: [P.BANKING_MANAGE],
    body: z.object({
      entityId: zId,
      fromBankAccountId: zId,
      toBankAccountId: zId,
      date: zDate,
      amount: zDecimal,
      toAmount: zDecimal.nullable().optional(),
      reference: z.string().trim().max(100).optional(),
      description: z.string().trim().max(500).optional(),
    }),
    handler: ({ s, user, body }) => s.banking.transfer(user, body),
  }),
  route({
    method: 'POST',
    path: '/bank-accounts/:id/statements',
    permissions: [P.BANKING_MANAGE],
    body: z.object({
      name: z.string().trim().max(200).optional(),
      closingBalance: zDecimal.nullable().optional(),
      lines: z
        .array(z.object({ date: zDate, description: z.string().trim().max(500).optional(), reference: z.string().trim().max(100).optional(), amount: zDecimal }))
        .min(1)
        .max(5000),
    }),
    handler: ({ s, user, params, body }) => s.banking.importStatement(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/bank-accounts/:id/reconciliation',
    permissions: [P.BANKING_VIEW],
    query: z.object({ asOf: zDate, statementBalance: zDecimal.optional() }),
    handler: ({ s, user, params, query }) => s.banking.workspace(user, parseId(params.id), query.asOf, query.statementBalance),
  }),
  route({ method: 'POST', path: '/bank-accounts/:id/auto-match', permissions: [P.BANKING_RECONCILE], handler: ({ s, user, params }) => s.banking.autoMatch(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/bank-accounts/:id/matches',
    permissions: [P.BANKING_RECONCILE],
    body: z.object({ statementLineIds: z.array(zId).min(1).max(200), ledgerEntryIds: z.array(zId).min(1).max(200) }),
    handler: ({ s, user, params, body }) => s.banking.match(user, parseId(params.id), body.statementLineIds, body.ledgerEntryIds),
  }),
  route({ method: 'DELETE', path: '/bank-matches/:id', permissions: [P.BANKING_RECONCILE], handler: ({ s, user, params }) => s.banking.unmatch(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/bank-accounts/:id/adjustments',
    permissions: [P.BANKING_RECONCILE],
    body: z.object({ statementLineId: zId, accountId: zId, description: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.banking.adjust(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/bank-accounts/:id/reconciliations',
    permissions: [P.BANKING_VIEW],
    handler: ({ s, user, params }) => s.banking.reconciliations(user, parseId(params.id)),
  }),
  route({
    method: 'POST',
    path: '/bank-accounts/:id/reconciliations',
    permissions: [P.BANKING_RECONCILE],
    body: z.object({ statementDate: zDate, statementBalance: zDecimal, notes: z.string().trim().max(1000).optional() }),
    handler: ({ s, user, params, body }) => s.banking.complete(user, parseId(params.id), body),
  }),
];

// ---------------------------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------------------------

const dims = { departmentId: zId.nullable().optional(), costCentreId: zId.nullable().optional(), projectId: zId.nullable().optional() };

const PlanBody = z.object({
  entityId: zId,
  fiscalYearId: zId,
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  items: z
    .array(
      z.object({
        id: zId.nullable().optional(),
        description: z.string().trim().min(1).max(500),
        category: z.enum(PROCUREMENT_CATEGORIES),
        method: z.enum(PROCUREMENT_METHODS),
        departmentId: zId.nullable().optional(),
        accountId: zId,
        quantity: zDecimal,
        unit: z.string().trim().max(40).optional(),
        estimatedCost: zDecimal,
        quarter: z.number().int().min(1).max(4),
        sourceOfFunds: z.string().trim().max(200).optional(),
        agpo: z.boolean().optional(),
      }),
    )
    .max(1000),
});

const procurementPlans = [
  route({
    method: 'GET',
    path: '/procurement-plans',
    permissions: [P.AP_VIEW],
    query: z.object({ entityId: zId, fiscalYearId: zId.optional() }),
    handler: ({ s, user, query }) => s.procurementPlans.list(user, query),
  }),
  route({
    method: 'GET',
    path: '/procurement-plans/items',
    permissions: [P.PROCUREMENT_REQUEST],
    query: z.object({ entityId: zId, date: zDate }),
    handler: ({ s, user, query }) => s.procurementPlans.items(user, query),
  }),
  route({ method: 'GET', path: '/procurement-plans/:id', permissions: [P.AP_VIEW], handler: ({ s, user, params }) => s.procurementPlans.get(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/procurement-plans/:id/execution', permissions: [P.AP_VIEW], handler: ({ s, user, params }) => s.procurementPlans.execution(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/procurement-plans', permissions: [P.PROCUREMENT_MANAGE], body: PlanBody, handler: ({ s, user, body }) => s.procurementPlans.save(user, null, body) }),
  route({ method: 'PATCH', path: '/procurement-plans/:id', permissions: [P.PROCUREMENT_MANAGE], body: PlanBody, handler: ({ s, user, params, body }) => s.procurementPlans.save(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/procurement-plans/:id/revise', permissions: [P.PROCUREMENT_MANAGE], handler: ({ s, user, params }) => s.procurementPlans.revise(user, parseId(params.id)) }),
  ...(['submit', 'approve', 'reject'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/procurement-plans/:id/${action}`,
      permissions: [action === 'submit' ? P.PROCUREMENT_MANAGE : P.PROCUREMENT_APPROVE],
      body: z.object({ reason: z.string().trim().max(500).optional() }),
      handler: ({ s, user, params, body }) => s.procurementPlans.act(user, parseId(params.id), action, body.reason),
    }),
  ),
];

const RequisitionBody = z.object({
  entityId: zId,
  branchId: zId,
  date: zDate,
  requiredBy: zDate.nullable().optional(),
  description: z.string().trim().min(1).max(500),
  lines: z
    .array(z.object({ description: z.string().trim().min(1).max(500), accountId: zId.nullable().optional(), quantity: zDecimal, estimatedUnitPrice: zDecimal, planItemId: zId.nullable().optional(), ...dims }))
    .min(1)
    .max(200),
});

const OrderBody = z.object({
  entityId: zId,
  branchId: zId,
  supplierId: zId,
  date: zDate,
  expectedDate: zDate.nullable().optional(),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  requisitionId: zId.nullable().optional(),
  exchangeRate: zDecimal.nullable().optional(),
  priceIncludesTax: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(500),
        accountId: zId,
        quantity: zDecimal,
        unitPrice: zDecimal,
        taxCodeId: zId.nullable().optional(),
        itemId: zId.nullable().optional(),
        warehouseId: zId.nullable().optional(),
        planItemId: zId.nullable().optional(),
        ...dims,
      }),
    )
    .min(1)
    .max(500),
});

const RfqBody = z.object({
  entityId: zId,
  branchId: zId,
  title: z.string().trim().min(1).max(200),
  date: zDate,
  dueDate: zDate,
  notes: z.string().trim().max(2000).optional(),
  deliveryAddress: z.string().trim().max(500).optional(),
  requisitionId: zId.nullable().optional(),
  supplierIds: z.array(zId).min(1).max(50),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(500),
        quantity: zDecimal,
        accountId: zId.nullable().optional(),
        itemId: zId.nullable().optional(),
        warehouseId: zId.nullable().optional(),
        taxCodeId: zId.nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

const ListQuery = z.object({ entityId: zId.optional(), supplierId: zId.optional(), status: z.string().max(30).optional(), search: z.string().trim().max(100).optional(), ...page });
const optionalReason = z.object({ reason: z.string().trim().max(500).optional() });

const requisitionAction = (action: 'submit' | 'approve' | 'reject' | 'cancel') =>
  route({
    method: 'POST',
    path: `/requisitions/:id/${action}`,
    permissions: [action === 'approve' || action === 'reject' ? P.PROCUREMENT_APPROVE : P.PROCUREMENT_REQUEST],
    body: optionalReason,
    handler: ({ s, user, params, body }) => s.procurement.requisitionAction(user, parseId(params.id), action, body.reason),
  });

const orderAction = (action: 'submit' | 'approve' | 'reject' | 'cancel' | 'close') =>
  route({
    method: 'POST',
    path: `/purchase-orders/:id/${action}`,
    permissions: [action === 'approve' || action === 'reject' ? P.PROCUREMENT_APPROVE : P.PROCUREMENT_MANAGE],
    body: optionalReason,
    handler: ({ s, user, params, body }) => s.procurement.orderAction(user, parseId(params.id), action, body.reason),
  });

const procurement = [
  route({ method: 'GET', path: '/requisitions', permissions: [P.AP_VIEW], query: ListQuery, handler: ({ s, user, query }) => s.procurement.listRequisitions(user, query) }),
  route({ method: 'GET', path: '/requisitions/:id', permissions: [P.AP_VIEW], handler: ({ s, user, params }) => s.procurement.getRequisition(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/requisitions', permissions: [P.PROCUREMENT_REQUEST], body: RequisitionBody, handler: ({ s, user, body }) => s.procurement.createRequisition(user, body) }),
  route({
    method: 'PATCH',
    path: '/requisitions/:id',
    permissions: [P.PROCUREMENT_REQUEST],
    body: RequisitionBody,
    handler: ({ s, user, params, body }) => s.procurement.updateRequisition(user, parseId(params.id), body),
  }),
  ...(['submit', 'approve', 'reject', 'cancel'] as const).map(requisitionAction),

  route({ method: 'GET', path: '/purchase-orders', permissions: [P.AP_VIEW], query: ListQuery, handler: ({ s, user, query }) => s.procurement.listOrders(user, query) }),
  route({ method: 'GET', path: '/purchase-orders/:id', permissions: [P.AP_VIEW], handler: ({ s, user, params }) => s.procurement.getOrder(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/purchase-orders/:id/amendment',
    permissions: [P.PROCUREMENT_MANAGE],
    body: OrderBody.pick({ lines: true }).extend({ reason: z.string().trim().min(3, 'Give the reason for the amendment').max(500), expectedDate: zDate.nullable().optional(), deliveryAddress: z.string().trim().max(500).optional(), notes: z.string().trim().max(2000).optional() }),
    handler: ({ s, user, params, body }) => s.poAmendments.request(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/purchase-orders/:id/amendment/:decision',
    permissions: [P.PROCUREMENT_APPROVE],
    body: z.object({ reason: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => {
      if (!['approve', 'reject'].includes(params.decision)) throw new NotFoundException('Not found');
      return s.poAmendments.decide(user, parseId(params.id), params.decision === 'approve', body.reason);
    },
  }),
  route({
    method: 'GET',
    path: '/purchase-orders/:id/pdf',
    permissions: [P.AP_VIEW],
    handler: async ({ s, user, params }) => pdf(await s.poAmendments.pdf(user, parseId(params.id)), false),
  }),
  route({
    method: 'POST',
    path: '/purchase-orders/:id/email',
    permissions: [P.PROCUREMENT_MANAGE],
    body: z.object({ to: z.string().trim().email().optional() }),
    handler: ({ s, user, params, body }) => s.poAmendments.send(user, parseId(params.id), body.to),
  }),
  route({
    method: 'GET',
    path: '/inspections',
    permissions: [P.AP_VIEW],
    query: z.object({ entityId: zId, status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'UNASSIGNED']).optional() }),
    handler: ({ s, user, query }) => s.inspections.list(user, query),
  }),
  route({
    method: 'POST',
    path: '/goods-receipts/:id/inspection-committee',
    permissions: [P.PROCUREMENT_APPROVE],
    body: z.object({ memberIds: z.array(zId).min(1).max(15) }),
    handler: ({ s, user, params, body }) => s.inspections.appoint(user, parseId(params.id), body.memberIds),
  }),
  route({
    method: 'POST',
    path: '/goods-receipts/:id/inspection',
    body: z.object({ decision: z.enum(['ACCEPT', 'REJECT']), remarks: z.string().trim().max(1000).optional() }),
    handler: ({ s, user, params, body }) => s.inspections.decide(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/goods-receipts/:id/inspection-certificate',
    permissions: [P.AP_VIEW],
    handler: async ({ s, user, params }) => pdf(await s.inspections.certificate(user, parseId(params.id)), false),
  }),
  route({ method: 'GET', path: '/purchase-orders/:id/bill-draft', permissions: [P.AP_MANAGE], handler: ({ s, user, params }) => s.procurement.billDraft(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/purchase-orders', permissions: [P.PROCUREMENT_MANAGE], body: OrderBody, handler: ({ s, user, body }) => s.procurement.createOrder(user, body) }),
  route({
    method: 'PATCH',
    path: '/purchase-orders/:id',
    permissions: [P.PROCUREMENT_MANAGE],
    body: OrderBody,
    handler: ({ s, user, params, body }) => s.procurement.updateOrder(user, parseId(params.id), body),
  }),
  ...(['submit', 'approve', 'reject', 'cancel', 'close'] as const).map(orderAction),
  route({
    method: 'POST',
    path: '/purchase-orders/:id/receipts',
    permissions: [P.PROCUREMENT_MANAGE],
    body: z.object({
      date: zDate,
      reference: z.string().trim().max(100).optional(),
      notes: z.string().trim().max(1000).optional(),
      lines: z.array(z.object({ poLineNo: z.number().int().positive(), quantity: zDecimal, lots: zLots })).min(1),
    }),
    handler: ({ s, user, params, body }) => s.procurement.receive(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/goods-receipts/:id/reverse',
    permissions: [P.PROCUREMENT_MANAGE],
    body: z.object({ date: zDate, reason: z.string().trim().min(3).max(500) }),
    handler: ({ s, user, params, body }) => s.procurement.reverseReceipt(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/reports/received-not-invoiced',
    permissions: [P.AP_VIEW],
    query: z.object({ entityId: zId }),
    handler: ({ s, user, query }) => s.procurement.receivedNotInvoiced(user, query.entityId),
  }),
  route({
    method: 'GET',
    path: '/rfqs',
    permissions: [P.AP_VIEW],
    query: z.object({ entityId: zId.optional(), status: z.string().max(30).optional() }),
    handler: ({ s, user, query }) => s.rfqs.list(user, query),
  }),
  route({ method: 'GET', path: '/rfqs/:id', permissions: [P.AP_VIEW], handler: ({ s, user, params }) => s.rfqs.get(user, parseId(params.id)) }),
  ...(['POST', 'PATCH'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/rfqs' : '/rfqs/:id',
      permissions: [P.PROCUREMENT_MANAGE],
      body: RfqBody,
      handler: ({ s, user, body, params }) => (method === 'POST' ? s.rfqs.create(user, body) : s.rfqs.update(user, parseId(params.id), body)),
    }),
  ),
  route({ method: 'POST', path: '/rfqs/:id/send', permissions: [P.PROCUREMENT_MANAGE], handler: ({ s, user, params }) => s.rfqs.send(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/rfqs/:id/quotes',
    permissions: [P.PROCUREMENT_MANAGE],
    body: z.object({
      supplierId: zId,
      reference: z.string().trim().max(100).optional(),
      validUntil: zDate.nullable().optional(),
      declined: z.boolean().optional(),
      lines: z.array(z.object({ lineNo: z.number().int().positive(), unitPrice: zDecimal, leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(), notes: z.string().trim().max(500).optional() })).max(500),
    }),
    handler: ({ s, user, params, body }) => s.rfqs.recordQuote(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/rfqs/:id/committee',
    permissions: [P.PROCUREMENT_APPROVE],
    body: z.object({
      members: z.array(z.object({ userId: zId, role: z.enum(['CHAIR', 'SECRETARY', 'MEMBER']) })).min(1).max(15),
      criteria: z.array(z.object({ name: z.string().trim().min(1).max(120), weight: z.number().int().min(1).max(100) })).min(1).max(15),
      passMark: z.number().int().min(0).max(100).default(70),
      financialWeight: z.number().int().min(0).max(100).default(0),
    }),
    handler: ({ s, user, params, body }) => s.rfqEvaluation.appoint(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/rfqs/:id/evaluation', handler: ({ s, user, params }) => s.rfqEvaluation.view(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/rfqs/:id/evaluation/scores',
    body: z.object({ supplierId: zId, scores: z.array(z.object({ criterion: z.string().trim().min(1).max(120), score: z.number().min(0).max(100), comment: z.string().trim().max(500).optional() })).min(1).max(15) }),
    handler: ({ s, user, params, body }) => s.rfqEvaluation.score(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/rfqs/:id/evaluation/complete',
    body: z.object({ recommendation: z.string().trim().max(2000).optional() }),
    handler: ({ s, user, params, body }) => s.rfqEvaluation.complete(user, parseId(params.id), body.recommendation),
  }),
  route({ method: 'GET', path: '/rfqs/:id/evaluation/report', handler: async ({ s, user, params }) => pdf(await s.rfqEvaluation.report(user, parseId(params.id)), false) }),
  route({ method: 'POST', path: '/rfqs/:id/close', permissions: [P.PROCUREMENT_MANAGE], handler: ({ s, user, params }) => s.rfqs.close(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/rfqs/:id/cancel', permissions: [P.PROCUREMENT_MANAGE], body: optionalReason, handler: ({ s, user, params, body }) => s.rfqs.cancel(user, parseId(params.id), body.reason) }),
  route({
    method: 'POST',
    path: '/rfqs/:id/award',
    permissions: [P.PROCUREMENT_APPROVE],
    body: z.object({ date: zDate, lines: z.array(z.object({ lineNo: z.number().int().positive(), supplierId: zId, reason: z.string().trim().max(500).optional() })).min(1).max(500) }),
    handler: ({ s, user, params, body }) => s.rfqs.award(user, parseId(params.id), body),
  }),
];

// ---------------------------------------------------------------------------------------------
// Supplier management: categories, onboarding approval, status flags, compliance and ratings
// ---------------------------------------------------------------------------------------------

const SupplierCategoryBody = z.object({
  code,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  expenseAccountId: zId.nullable().optional(),
  isActive: z.boolean().optional(),
});

const supplierManagement = [
  route({
    method: 'GET',
    path: '/supplier-categories',
    handler: ({ s, user }) => (requirePermission(user, 'SUPPLIER', 'view'), s.supplierManagement.categories(user)),
  }),
  route({
    method: 'POST',
    path: '/supplier-categories',
    body: SupplierCategoryBody,
    handler: ({ s, user, body }) => (requirePermission(user, 'SUPPLIER', 'manage'), s.supplierManagement.saveCategory(user, null, body)),
  }),
  route({
    method: 'PATCH',
    path: '/supplier-categories/:id',
    body: SupplierCategoryBody.partial(),
    handler: ({ s, user, params, body }) => (requirePermission(user, 'SUPPLIER', 'manage'), s.supplierManagement.saveCategory(user, parseId(params.id), body)),
  }),
  route({ method: 'GET', path: '/supplier-scorecards', handler: ({ s, user }) => (requirePermission(user, 'SUPPLIER', 'view'), s.supplierManagement.scorecards(user)) }),
  route({
    method: 'GET',
    path: '/supplier-compliance',
    query: z.object({ days: z.coerce.number().int().min(0).max(366).default(30) }),
    handler: ({ s, user, query }) => (requirePermission(user, 'SUPPLIER', 'view'), s.supplierManagement.expiringCompliance(user, query.days)),
  }),
  route({
    method: 'POST',
    path: '/suppliers/:id/approve',
    body: z.object({ comment: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.supplierManagement.approve(user, parseId(params.id), body.comment),
  }),
  route({
    method: 'POST',
    path: '/suppliers/:id/reject',
    body: z.object({ reason: z.string().trim().min(1, 'Give the reason').max(500) }),
    handler: ({ s, user, params, body }) => s.supplierManagement.reject(user, parseId(params.id), body.reason),
  }),
  route({
    method: 'POST',
    path: '/suppliers/:id/resubmit',
    handler: ({ s, user, params }) => (requirePermission(user, 'SUPPLIER', 'manage'), s.supplierManagement.resubmit(user, parseId(params.id))),
  }),
  route({
    method: 'POST',
    path: '/suppliers/:id/status',
    body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'BLACKLISTED']), reason: z.string().trim().max(500).optional(), until: zDate.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.supplierManagement.setStatus(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/suppliers/:id/compliance',
    body: z.object({
      documents: z
        .array(z.object({ type: z.enum(SUPPLIER_COMPLIANCE_TYPES), number: z.string().trim().min(1).max(100), issuedOn: zDate.nullable().optional(), expiresOn: zDate.nullable().optional(), note: z.string().trim().max(300).optional() }))
        .max(20),
    }),
    handler: ({ s, user, params, body }) => (requirePermission(user, 'SUPPLIER', 'manage'), s.supplierManagement.saveCompliance(user, parseId(params.id), body.documents)),
  }),
  route({
    method: 'POST',
    path: '/suppliers/:id/ratings',
    body: z.object({
      purchaseOrderId: zId.nullable().optional(),
      date: zDate,
      quality: z.number().int().min(1).max(5),
      delivery: z.number().int().min(1).max(5),
      price: z.number().int().min(1).max(5),
      service: z.number().int().min(1).max(5),
      comment: z.string().trim().max(1000).optional(),
    }),
    handler: ({ s, user, params, body }) => s.supplierManagement.rate(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/suppliers/:id/performance', handler: ({ s, user, params }) => (requirePermission(user, 'SUPPLIER', 'view'), s.supplierManagement.performance(user, parseId(params.id))) }),
];

export const commercialRoutes = [...procurementPlans, ...tax, ...partyRoutes('/customers', 'CUSTOMER'), ...supplierManagement, ...partyRoutes('/suppliers', 'SUPPLIER'), ...documents, ...payments, ...banking, ...procurement];
