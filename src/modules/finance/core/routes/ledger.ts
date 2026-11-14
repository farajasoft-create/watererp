import { Types } from 'mongoose';
import { z } from 'zod';
import { AuthUser } from '../common/auth';
import { BadRequestException, NotFoundException } from '../common/errors';
import { PERMISSIONS } from '../common/permissions';
import { parseId, zBool, zCurrency, zDate, zDecimal, zId } from '../common/validation';
import { Db } from '../database/db.service';
import { Account, ACCOUNT_CLASSES, ACCOUNT_TYPES, ALL_ACCOUNT_TYPES, JOURNAL_STATUSES, PERIOD_STATUSES } from '../database/schemas';
import { route } from '../http/router';
import { CurrenciesService } from '../modules/currencies/currencies.service';

// ---------------------------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------------------------

const AccountBody = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9.-]+$/, 'Account codes may contain letters, digits, . and - only'),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  accountClass: z.enum(ACCOUNT_CLASSES),
  accountType: z.enum(ALL_ACCOUNT_TYPES as [string, ...string[]]),
  parentId: zId.nullable().optional(),
  isPostable: z.boolean().optional(),
  isControl: z.boolean().optional(),
  allowManualPosting: z.boolean().optional(),
  currency: zCurrency.nullable().optional(),
  requiresDepartment: z.boolean().optional(),
  requiresCostCentre: z.boolean().optional(),
  requiresProject: z.boolean().optional(),
  entityIds: z.array(zId).optional(),
  isActive: z.boolean().optional(),
});
type AccountInput = z.infer<typeof AccountBody>;

async function validateAccount(db: Db, currencies: CurrenciesService, user: AuthUser, body: AccountInput, existing: Account | null) {
  if (!ACCOUNT_TYPES[body.accountClass].includes(body.accountType)) {
    throw new BadRequestException(`Account type ${body.accountType} is not valid for class ${body.accountClass}`);
  }
  if (body.currency) await currencies.ensureActive(user, body.currency);
  if (body.parentId) {
    const parent = await db.accounts.findOne({ _id: body.parentId, organisationId: user.organisationId }).lean();
    if (!parent) throw new BadRequestException('Parent account not found');
    if (parent.isPostable) throw new BadRequestException('The parent must be a header (non-postable) account');
    if (parent.accountClass !== body.accountClass) throw new BadRequestException('An account must have the same class as its parent');
    if (existing) {
      let cursor: Types.ObjectId | null = parent._id;
      for (let depth = 0; cursor && depth < 50; depth++) {
        if (cursor.equals(existing._id)) throw new BadRequestException('An account cannot be nested under itself');
        const next: Account | null = await db.accounts.findOne({ _id: cursor, organisationId: user.organisationId }).lean();
        cursor = next?.parentId ?? null;
      }
    }
  }
  if (existing && body.isPostable !== false) {
    const hasChildren = await db.accounts.exists({ organisationId: user.organisationId, parentId: existing._id });
    if (hasChildren) throw new BadRequestException('An account with sub-accounts must remain a header account');
  }
  if (body.entityIds?.length) {
    const count = await db.entities.countDocuments({ organisationId: user.organisationId, _id: { $in: body.entityIds } });
    if (count !== new Set(body.entityIds.map(String)).size) throw new BadRequestException('Unknown entity in entityIds');
  }
}

const accounts = [
  route({
    method: 'GET',
    path: '/accounts',
    query: z.object({ entityId: zId.optional(), activeOnly: zBool.optional(), postableOnly: zBool.optional() }),
    handler: ({ s, user, query: q }) => {
      const filter: Record<string, unknown> = { organisationId: user.organisationId };
      if (q.activeOnly) filter.isActive = true;
      if (q.postableOnly) filter.isPostable = true;
      if (q.entityId) filter.$or = [{ entityIds: { $size: 0 } }, { entityIds: q.entityId }];
      return s.db.accounts.find(filter).sort({ code: 1 }).lean();
    },
  }),

  route({
    method: 'GET',
    path: '/accounts/:id',
    handler: async ({ s, user, params }) => {
      const account = await s.db.accounts.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!account) throw new NotFoundException('Account not found');
      return account;
    },
  }),

  route({
    method: 'POST',
    path: '/accounts',
    permissions: [PERMISSIONS.COA_MANAGE],
    body: AccountBody,
    handler: async ({ s, user, body }) => {
      await validateAccount(s.db, s.currencies, user, body, null);
      const [account] = await s.db.accounts.create([{ ...body, organisationId: user.organisationId }]);
      await s.audit.log(user, { action: 'account.create', recordType: 'Account', recordId: account._id, summary: `Created account ${account.code} ${account.name}`, after: account });
      return account;
    },
  }),

  route({
    method: 'PATCH',
    path: '/accounts/:id',
    permissions: [PERMISSIONS.COA_MANAGE],
    body: AccountBody.partial(),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.accounts.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Account not found');
      const merged = { ...before, ...body } as AccountInput;
      await validateAccount(s.db, s.currencies, user, merged, before);
      const hasPostings = await s.db.ledger.exists({ organisationId: user.organisationId, accountId: before._id });
      if (hasPostings) {
        if (merged.accountClass !== before.accountClass) throw new BadRequestException('The class of an account with posted transactions cannot change');
        if (merged.isPostable === false) throw new BadRequestException('An account with posted transactions cannot become a header account');
        if ((merged.currency ?? null) !== (before.currency ?? null)) throw new BadRequestException('The currency of an account with posted transactions cannot change');
      }
      const after = await s.db.accounts.findByIdAndUpdate(before._id, body, { new: true }).lean();
      await s.audit.log(user, { action: 'account.update', recordType: 'Account', recordId: before._id, summary: `Updated account ${before.code}`, before, after });
      return after;
    },
  }),
];

// ---------------------------------------------------------------------------------------------
// Fiscal years & periods
// ---------------------------------------------------------------------------------------------

const periods = [
  route({
    method: 'GET',
    path: '/fiscal-years',
    query: z.object({ entityId: zId.optional() }),
    handler: async ({ s, user, query: q }) => {
      const filter: Record<string, unknown> = { organisationId: user.organisationId };
      if (q.entityId) filter.entityId = q.entityId;
      const years = await s.db.fiscalYears.find(filter).sort({ startDate: -1 }).lean();
      const all = await s.db.periods
        .find({ organisationId: user.organisationId, fiscalYearId: { $in: years.map((y) => y._id) } })
        .sort({ startDate: 1 })
        .lean();
      return years.map((y) => ({ ...y, periods: all.filter((p) => p.fiscalYearId.equals(y._id)) }));
    },
  }),

  route({
    method: 'POST',
    path: '/fiscal-years',
    permissions: [PERMISSIONS.PERIOD_MANAGE],
    body: z.object({ entityId: zId, startDate: zDate }),
    handler: ({ s, user, body }) => s.periods.createFiscalYear(user, body.entityId, body.startDate),
  }),

  route({
    method: 'POST',
    path: '/periods/:id/status',
    body: z.object({ status: z.enum(PERIOD_STATUSES), reason: z.string().max(500).optional() }),
    handler: ({ s, user, body, params }) => s.periods.changeStatus(user, parseId(params.id), body.status, body.reason),
  }),
];

// ---------------------------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------------------------

const LineBody = z.object({
  accountId: zId,
  branchId: zId.nullable().optional(),
  departmentId: zId.nullable().optional(),
  costCentreId: zId.nullable().optional(),
  projectId: zId.nullable().optional(),
  fundId: zId.nullable().optional(),
  intercompanyEntityId: zId.nullable().optional(),
  description: z.string().trim().max(500).optional(),
  currency: zCurrency.optional(),
  exchangeRate: zDecimal.nullable().optional(),
  debit: zDecimal.nullable().optional(),
  credit: zDecimal.nullable().optional(),
});

const JournalBody = z.object({
  entityId: zId,
  branchId: zId,
  journalDate: zDate,
  description: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(100).optional(),
  type: z.enum(['STANDARD', 'ACCRUAL', 'OPENING']).optional(),
  autoReverseDate: zDate.nullable().optional(),
  lines: z.array(LineBody).min(2).max(1000),
});

const JournalQuery = z.object({
  entityId: zId.optional(),
  branchId: zId.optional(),
  accountId: zId.optional(),
  status: z.enum(JOURNAL_STATUSES).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const P = PERMISSIONS;
const journals = [
  route({ method: 'GET', path: '/journals', permissions: [P.JOURNAL_VIEW], query: JournalQuery, handler: ({ s, user, query }) => s.journals.list(user, query) }),
  route({ method: 'GET', path: '/journals/:id', permissions: [P.JOURNAL_VIEW], handler: ({ s, user, params }) => s.journals.get(user, parseId(params.id)) }),

  /** Supply an Idempotency-Key header to make retries from integrations safe. */
  route({
    method: 'POST',
    path: '/journals',
    permissions: [P.JOURNAL_CREATE],
    body: JournalBody,
    handler: ({ s, user, body, headers }) => {
      const idempotencyKey = headers.get('idempotency-key') ?? undefined;
      return s.journals.create(user, body, { source: user.apiKeyId || idempotencyKey ? 'API' : 'MANUAL', idempotencyKey });
    },
  }),
  route({ method: 'PATCH', path: '/journals/:id', permissions: [P.JOURNAL_CREATE], body: JournalBody, handler: ({ s, user, params, body }) => s.journals.update(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/journals/:id', permissions: [P.JOURNAL_CREATE], handler: ({ s, user, params }) => s.journals.remove(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/journals/:id/submit', permissions: [P.JOURNAL_CREATE], handler: ({ s, user, params }) => s.journals.submit(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/journals/:id/approve',
    permissions: [P.JOURNAL_APPROVE],
    body: z.object({ post: z.boolean().optional(), comment: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.journals.approve(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/journals/:id/reject',
    permissions: [P.JOURNAL_APPROVE],
    body: z.object({ reason: z.string().trim().min(1, 'A reason is required').max(500) }),
    handler: ({ s, user, params, body }) => s.journals.reject(user, parseId(params.id), body.reason),
  }),
  route({ method: 'POST', path: '/journals/:id/post', permissions: [P.JOURNAL_POST], handler: ({ s, user, params }) => s.journals.post(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/journals/:id/reverse',
    permissions: [P.JOURNAL_REVERSE],
    body: z.object({ date: zDate, reason: z.string().trim().min(1, 'A reason is required').max(500) }),
    handler: ({ s, user, params, body }) => s.journals.reverse(user, parseId(params.id), body.date, body.reason),
  }),
];

// ---------------------------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------------------------

const audit = [
  route({
    method: 'GET',
    path: '/audit-events',
    permissions: [P.AUDIT_VIEW],
    query: z.object({
      recordType: z.string().optional(),
      recordId: zId.optional(),
      userId: zId.optional(),
      action: z.string().optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
    handler: async ({ s, user, query: q }) => {
      const filter: Record<string, unknown> = { organisationId: user.organisationId };
      if (q.recordType) filter.recordType = q.recordType;
      if (q.recordId) filter.recordId = q.recordId;
      if (q.userId) filter.userId = q.userId;
      if (q.action) filter.action = q.action;
      if (q.from || q.to) {
        const end = q.to ? new Date(q.to.getTime() + 86_400_000) : undefined;
        filter.createdAt = { ...(q.from && { $gte: q.from }), ...(end && { $lt: end }) };
      }
      const [items, total] = await Promise.all([
        s.db.auditEvents.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
        s.db.auditEvents.countDocuments(filter),
      ]);
      return { items, total, page: q.page, pageSize: q.pageSize };
    },
  }),
];

export const ledgerRoutes = [...accounts, ...periods, ...journals, ...audit];
