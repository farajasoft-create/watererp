import { z } from 'zod';
import { allowedBranches } from '../common/access';
import { hasPermission } from '../common/auth';
import { BadRequestException, NotFoundException } from '../common/errors';
import { Decimal, toD128 } from '../common/money';
import { PERMISSIONS } from '../common/permissions';
import { parseId, zBool, zCurrency, zDate, zDecimal, zId } from '../common/validation';
import { DIMENSION_TYPES, RATE_STATUSES, RATE_TYPES } from '../database/schemas';
import { route } from '../http/router';

const code = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9_-]+$/, 'Codes may contain letters, digits, - and _ only');

// ---------------------------------------------------------------------------------------------
// Legal entities, branches & dimensions
// ---------------------------------------------------------------------------------------------

const EntityBody = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).optional(),
  registrationNumber: z.string().trim().max(100).optional(),
  taxId: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  functionalCurrency: zCurrency,
  /** Contact details and payment instructions printed on invoices. */
  address: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().email().max(200).or(z.literal('')).optional(),
  website: z.string().trim().max(200).optional(),
  paymentInstructions: z.string().trim().max(1000).optional(),
  /** Group ownership (%); below 100 a non-controlling interest is shown on consolidation. */
  ownershipPercent: zDecimal.refine((d) => d.gt(0) && d.lte(100), 'Between 0 and 100').nullable().optional(),
  isActive: z.boolean().optional(),
});
const entityDoc = <T extends { ownershipPercent?: Decimal | null }>({ ownershipPercent, ...rest }: T) => ({
  ...rest,
  ...(ownershipPercent !== undefined && { ownershipPercent: ownershipPercent ? toD128(ownershipPercent) : null }),
});

const BranchBody = z.object({
  entityId: zId,
  code,
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.union([z.string().trim().email(), z.literal('')]).optional(),
  taxRegistrationNumber: z.string().trim().max(100).optional(),
  currency: zCurrency.optional(),
  managerUserId: zId.nullable().optional(),
  isActive: z.boolean().optional(),
});

const DimensionBody = z.object({
  type: z.enum(DIMENSION_TYPES),
  code,
  name: z.string().trim().min(1).max(200),
  entityId: zId.nullable().optional(),
  headUserId: zId.nullable().optional(),
  isActive: z.boolean().optional(),
  project: z
    .object({
      customerId: zId.nullable().optional(),
      managerUserId: zId.nullable().optional(),
      contractValue: zDecimal.nullable().optional(),
      budgetCost: zDecimal.nullable().optional(),
      startDate: zDate.nullable().optional(),
      endDate: zDate.nullable().optional(),
      status: z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED']).optional(),
    })
    .optional(),
});

/** Project details are stored with Decimal128 amounts; other dimension types ignore them. */
const dimensionDoc = <T extends { project?: Record<string, unknown> }>(body: T) => {
  const { project, ...rest } = body;
  if (!project) return rest;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(project)) {
    if (v === undefined) continue;
    out[`project.${k}`] = (k === 'contractValue' || k === 'budgetCost') && v ? toD128(v as never) : v;
  }
  return { ...rest, ...out };
};

const manage = [PERMISSIONS.STRUCTURE_MANAGE];

const structure = [
  route({
    method: 'GET',
    path: '/entities',
    handler: ({ s, user }) => s.db.entities.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean(),
  }),

  route({
    method: 'POST',
    path: '/entities',
    permissions: manage,
    body: EntityBody,
    handler: async ({ s, user, body }) => {
      await s.currencies.ensureActive(user, body.functionalCurrency);
      const [entity] = await s.db.entities.create([{ ...entityDoc(body), organisationId: user.organisationId }]);
      await s.audit.log(user, { action: 'entity.create', recordType: 'LegalEntity', recordId: entity._id, summary: `Created entity ${entity.code}`, after: entity });
      return entity;
    },
  }),

  route({
    method: 'PATCH',
    path: '/entities/:id',
    permissions: manage,
    body: EntityBody.partial(),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.entities.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Entity not found');
      if (body.functionalCurrency && body.functionalCurrency !== before.functionalCurrency) {
        const used = await s.db.journals.exists({ organisationId: user.organisationId, entityId: before._id });
        if (used) throw new BadRequestException('Functional currency cannot change once the entity has journals');
        await s.currencies.ensureActive(user, body.functionalCurrency);
      }
      const after = await s.db.entities.findByIdAndUpdate(before._id, entityDoc(body), { new: true }).lean();
      await s.audit.log(user, { action: 'entity.update', recordType: 'LegalEntity', recordId: before._id, summary: `Updated entity ${before.code}`, before, after });
      return after;
    },
  }),

  route({
    method: 'GET',
    path: '/branches',
    query: z.object({ entityId: zId.optional(), activeOnly: zBool.optional() }),
    handler: ({ s, user, query: q }) => {
      const filter: Record<string, unknown> = { organisationId: user.organisationId };
      if (q.entityId) filter.entityId = q.entityId;
      if (q.activeOnly) filter.isActive = true;
      const restricted = allowedBranches(user);
      if (restricted) filter._id = { $in: restricted };
      return s.db.branches.find(filter).sort({ code: 1 }).lean();
    },
  }),

  route({
    method: 'POST',
    path: '/branches',
    permissions: manage,
    body: BranchBody,
    handler: async ({ s, user, body }) => {
      const entity = await s.db.entities.findOne({ _id: body.entityId, organisationId: user.organisationId }).lean();
      if (!entity) throw new BadRequestException('Entity not found');
      const currency = body.currency ?? entity.functionalCurrency;
      await s.currencies.ensureActive(user, currency);
      const [branch] = await s.db.branches.create([{ ...body, currency, organisationId: user.organisationId }]);
      await s.audit.log(user, { action: 'branch.create', recordType: 'Branch', recordId: branch._id, summary: `Created branch ${branch.code}`, after: branch });
      return branch;
    },
  }),

  route({
    method: 'PATCH',
    path: '/branches/:id',
    permissions: manage,
    body: BranchBody.partial(),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.branches.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Branch not found');
      if (body.entityId && !body.entityId.equals(before.entityId)) {
        const used = await s.db.ledger.exists({ organisationId: user.organisationId, branchId: before._id });
        if (used) throw new BadRequestException('A branch with posted transactions cannot move to another entity');
      }
      if (body.currency) await s.currencies.ensureActive(user, body.currency);
      const after = await s.db.branches.findByIdAndUpdate(before._id, body, { new: true }).lean();
      await s.audit.log(user, { action: 'branch.update', recordType: 'Branch', recordId: before._id, summary: `Updated branch ${before.code}`, before, after });
      return after;
    },
  }),

  route({
    method: 'GET',
    path: '/dimensions',
    query: z.object({ type: z.enum(DIMENSION_TYPES).optional() }),
    handler: ({ s, user, query: q }) => {
      const filter: Record<string, unknown> = { organisationId: user.organisationId };
      if (q.type) filter.type = q.type;
      return s.db.dimensions.find(filter).sort({ type: 1, code: 1 }).lean();
    },
  }),

  route({
    method: 'POST',
    path: '/dimensions',
    permissions: manage,
    body: DimensionBody,
    handler: async ({ s, user, body }) => {
      const { project, ...rest } = body;
      const [dim] = await s.db.dimensions.create([
        {
          ...rest,
          organisationId: user.organisationId,
          ...(project && body.type === 'PROJECT' && { project: { ...project, contractValue: project.contractValue ? toD128(project.contractValue) : null, budgetCost: project.budgetCost ? toD128(project.budgetCost) : null } }),
        },
      ]);
      await s.audit.log(user, { action: 'dimension.create', recordType: 'DimensionValue', recordId: dim._id, summary: `Created ${dim.type} ${dim.code}`, after: dim });
      return dim;
    },
  }),

  route({
    method: 'PATCH',
    path: '/dimensions/:id',
    permissions: manage,
    body: DimensionBody.omit({ type: true }).partial(),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.dimensions.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Dimension not found');
      const after = await s.db.dimensions.findByIdAndUpdate(before._id, before.type === 'PROJECT' ? dimensionDoc(body) : dimensionDoc({ ...body, project: undefined }), { new: true }).lean();
      await s.audit.log(user, { action: 'dimension.update', recordType: 'DimensionValue', recordId: before._id, summary: `Updated ${before.type} ${before.code}`, before, after });
      return after;
    },
  }),
];

// ---------------------------------------------------------------------------------------------
// Currencies & exchange rates
// ---------------------------------------------------------------------------------------------

const RateBody = z
  .object({
    fromCurrency: zCurrency,
    toCurrency: zCurrency,
    rateType: z.enum(RATE_TYPES).default('SPOT'),
    rate: zDecimal.refine((d) => d.gt(0), 'Rate must be positive'),
    effectiveDate: zDate,
    source: z.string().trim().max(100).default('MANUAL'),
  })
  .refine((b) => b.fromCurrency !== b.toCurrency, 'From and to currencies must differ');

const currencies = [
  /** ISO reference list, public so the sign-up form can offer functional currencies. */
  route({
    method: 'GET',
    path: '/currencies/reference',
    public: true,
    handler: async ({ s }) => {
      if (!(await s.db.currencies.estimatedDocumentCount())) await s.provisioning.ensureReferenceData();
      return s.db.currencies.find({}, { _id: 0, code: 1, name: 1, precision: 1 }).sort({ code: 1 }).lean();
    },
  }),

  route({
    method: 'GET',
    path: '/currencies',
    handler: async ({ s, user }) => {
      const [all, org] = await Promise.all([s.db.currencies.find().sort({ code: 1 }).lean(), s.db.organisations.findById(user.organisationId).lean()]);
      const active = new Set(org?.activeCurrencies ?? []);
      return all.map((c) => ({ ...c, isActive: active.has(c.code) }));
    },
  }),

  route({
    method: 'POST',
    path: '/currencies/:code/activate',
    permissions: [PERMISSIONS.CURRENCY_MANAGE],
    handler: async ({ s, user, params }) => {
      const c = params.code.toUpperCase();
      await s.currencies.ensureActive(user, c);
      await s.audit.log(user, { action: 'currency.activate', recordType: 'Currency', summary: `Activated ${c}` });
      return { code: c, isActive: true };
    },
  }),

  route({
    method: 'POST',
    path: '/currencies/:code/deactivate',
    permissions: [PERMISSIONS.CURRENCY_MANAGE],
    handler: async ({ s, user, params }) => {
      const c = params.code.toUpperCase();
      const org = await s.db.organisations.findById(user.organisationId).lean();
      if (org?.reportingCurrency === c) throw new BadRequestException('The reporting currency cannot be deactivated');
      if (await s.db.entities.exists({ organisationId: user.organisationId, functionalCurrency: c })) {
        throw new BadRequestException('Currency is the functional currency of an entity');
      }
      await s.db.organisations.updateOne({ _id: user.organisationId }, { $pull: { activeCurrencies: c } });
      await s.audit.log(user, { action: 'currency.deactivate', recordType: 'Currency', summary: `Deactivated ${c}` });
      return { code: c, isActive: false };
    },
  }),

  route({
    method: 'GET',
    path: '/exchange-rates',
    query: z.object({
      fromCurrency: zCurrency.optional(),
      toCurrency: zCurrency.optional(),
      rateType: z.enum(RATE_TYPES).optional(),
      status: z.enum(RATE_STATUSES).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
    handler: async ({ s, user, query: q }) => {
      const filter: Record<string, unknown> = { organisationId: user.organisationId };
      if (q.fromCurrency) filter.fromCurrency = q.fromCurrency;
      if (q.toCurrency) filter.toCurrency = q.toCurrency;
      if (q.rateType) filter.rateType = q.rateType;
      if (q.status) filter.status = q.status;
      const [items, total] = await Promise.all([
        s.db.exchangeRates.find(filter).sort({ effectiveDate: -1, createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
        s.db.exchangeRates.countDocuments(filter),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  }),

  route({
    method: 'GET',
    path: '/exchange-rates/lookup',
    query: z.object({ from: zCurrency, to: zCurrency, date: zDate, rateType: z.enum(RATE_TYPES).default('SPOT') }),
    handler: async ({ s, user, query: q }) => {
      const found = await s.currencies.findRate(user.organisationId, q.from, q.to, q.date, q.rateType);
      if (!found) throw new NotFoundException(`No approved ${q.rateType} rate for ${q.from}/${q.to} on or before that date`);
      return { from: q.from, to: q.to, rateType: q.rateType, ...found, rate: found.rate.toFixed() };
    },
  }),

  /** Rates captured by a user who can approve rates are approved immediately; others await approval. */
  route({
    method: 'POST',
    path: '/exchange-rates',
    permissions: [PERMISSIONS.RATES_MANAGE],
    body: RateBody,
    handler: async ({ s, user, body }) => {
      for (const c of [body.fromCurrency, body.toCurrency]) {
        if (!(await s.db.currencies.exists({ code: c }))) throw new BadRequestException(`Unknown currency ${c}`);
      }
      const autoApprove = hasPermission(user, PERMISSIONS.RATES_APPROVE);
      const [rate] = await s.db.exchangeRates.create([
        {
          ...body,
          rate: toD128(body.rate),
          organisationId: user.organisationId,
          createdBy: user.id,
          status: autoApprove ? 'APPROVED' : 'PENDING',
          approvedBy: autoApprove ? user.id : null,
          approvedAt: autoApprove ? new Date() : null,
        },
      ]);
      await s.audit.log(user, {
        action: 'fx.rate.create',
        recordType: 'ExchangeRate',
        recordId: rate._id,
        summary: `${body.fromCurrency}/${body.toCurrency} ${body.rateType} ${body.rate.toFixed()} (${rate.status})`,
        after: rate,
      });
      return rate;
    },
  }),

  ...(['APPROVED', 'REJECTED'] as const).map((status) =>
    route({
      method: 'POST',
      path: `/exchange-rates/:id/${status === 'APPROVED' ? 'approve' : 'reject'}`,
      permissions: [PERMISSIONS.RATES_APPROVE],
      handler: async ({ s, user, params }) => {
        const before = await s.db.exchangeRates.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
        if (!before) throw new NotFoundException('Exchange rate not found');
        if (before.status !== 'PENDING') throw new BadRequestException(`Rate is already ${before.status}`);
        if (before.createdBy.equals(user.id)) throw new BadRequestException('You cannot approve a rate you captured');
        const after = await s.db.exchangeRates.findByIdAndUpdate(before._id, { status, approvedBy: user.id, approvedAt: new Date() }, { new: true }).lean();
        await s.audit.log(user, {
          action: status === 'APPROVED' ? 'fx.rate.approve' : 'fx.rate.reject',
          recordType: 'ExchangeRate',
          recordId: before._id,
          summary: `${status === 'APPROVED' ? 'Approved' : 'Rejected'} ${before.fromCurrency}/${before.toCurrency} rate`,
          before,
          after,
        });
        return after;
      },
    }),
  ),
];

export const setupRoutes = [...structure, ...currencies];
