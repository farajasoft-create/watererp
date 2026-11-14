import { z } from 'zod';
import { BadRequestException } from '../common/errors';
import { PERMISSIONS as P } from '../common/permissions';
import { parseId, zCurrency, zDate, zDecimal, zId } from '../common/validation';
import { COLLECTION_ACTIVITY_TYPES, RECURRENCE_FREQUENCIES } from '../database/automation.schemas';
import { route } from '../http/router';

const today = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const RecurringBody = z.object({
  entityId: zId,
  branchId: zId,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  reference: z.string().trim().max(100).optional(),
  type: z.enum(['STANDARD', 'ACCRUAL']).default('STANDARD'),
  autoReverse: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        accountId: zId,
        branchId: zId.nullable().optional(),
        departmentId: zId.nullable().optional(),
        costCentreId: zId.nullable().optional(),
        projectId: zId.nullable().optional(),
        fundId: zId.nullable().optional(),
        description: z.string().trim().max(500).optional(),
        currency: zCurrency.nullable().optional(),
        debit: zDecimal.nullable().optional(),
        credit: zDecimal.nullable().optional(),
      }),
    )
    .min(2)
    .max(200),
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  interval: z.number().int().min(1).max(12).default(1),
  dayOfMonth: z.number().int().min(1).max(31).default(1),
  startDate: zDate,
  endDate: zDate.nullable().optional(),
  maxOccurrences: z.number().int().min(1).max(1000).nullable().optional(),
  action: z.enum(['DRAFT', 'SUBMIT']).default('SUBMIT'),
  isActive: z.boolean().optional(),
});

const recurring = [
  route({ method: 'GET', path: '/recurring-journals', permissions: [P.JOURNAL_VIEW], query: z.object({ entityId: zId.optional() }), handler: ({ s, user, query }) => s.recurring.list(user, query.entityId) }),
  route({ method: 'GET', path: '/recurring-journals/:id', permissions: [P.JOURNAL_VIEW], handler: ({ s, user, params }) => s.recurring.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/recurring-journals', permissions: [P.JOURNAL_CREATE], body: RecurringBody, handler: ({ s, user, body }) => s.recurring.create(user, body) }),
  route({ method: 'PATCH', path: '/recurring-journals/:id', permissions: [P.JOURNAL_CREATE], body: RecurringBody, handler: ({ s, user, params, body }) => s.recurring.update(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/recurring-journals/:id/pause', status: 200, permissions: [P.JOURNAL_CREATE], handler: ({ s, user, params }) => s.recurring.setActive(user, parseId(params.id), false) }),
  route({ method: 'POST', path: '/recurring-journals/:id/resume', status: 200, permissions: [P.JOURNAL_CREATE], handler: ({ s, user, params }) => s.recurring.setActive(user, parseId(params.id), true) }),
  route({ method: 'POST', path: '/recurring-journals/:id/skip', status: 200, permissions: [P.JOURNAL_CREATE], handler: ({ s, user, params }) => s.recurring.skip(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/recurring-journals/:id/run', status: 200, permissions: [P.JOURNAL_CREATE], handler: ({ s, user, params }) => s.recurring.runNow(user, parseId(params.id)) }),
];

const collections = [
  route({
    method: 'GET',
    path: '/collections',
    permissions: [P.AR_VIEW],
    query: z.object({ entityId: zId, asOf: zDate.optional() }),
    handler: ({ s, user, query }) => s.collections.worklist(user, query.entityId, query.asOf ?? today()),
  }),
  route({
    method: 'GET',
    path: '/collections/:customerId/activities',
    permissions: [P.AR_VIEW],
    query: z.object({ entityId: zId }),
    handler: ({ s, user, params, query }) => s.collections.activities(user, query.entityId, parseId(params.customerId)),
  }),
  route({
    method: 'POST',
    path: '/collections/:customerId/activities',
    permissions: [P.AR_MANAGE],
    body: z.object({
      entityId: zId,
      type: z.enum(COLLECTION_ACTIVITY_TYPES),
      note: z.string().trim().max(2000).optional(),
      promiseDate: zDate.nullable().optional(),
      promiseAmount: zDecimal.nullable().optional(),
      followUpDate: zDate.nullable().optional(),
    }),
    handler: ({ s, user, params, body }) => s.collections.log(user, { ...body, customerId: parseId(params.customerId) }),
  }),
  route({
    method: 'GET',
    path: '/collections/:customerId/letter',
    permissions: [P.AR_VIEW],
    query: z.object({ entityId: zId, asOf: zDate.optional() }),
    handler: ({ s, user, params, query }) => s.collections.letter(user, query.entityId, parseId(params.customerId), query.asOf ?? today()),
  }),
];

const suggestions = [
  route({ method: 'GET', path: '/bank-accounts/:id/suggestions', permissions: [P.BANKING_VIEW], handler: ({ s, user, params }) => s.suggestions.bankMatches(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/suggestions/accounts',
    query: z.object({ side: z.enum(['purchase', 'sales']), partyId: zId.optional(), description: z.string().trim().max(500).optional() }),
    handler: ({ s, user, query }) => s.suggestions.coding(user, query),
  }),
];

const ai = [
  route({ method: 'GET', path: '/ai/status', handler: ({ s, user }) => s.ai.status(user) }),
  route({ method: 'GET', path: '/ai/usage', permissions: [P.ORG_MANAGE], query: z.object({ since: zDate.optional() }), handler: ({ s, user, query }) => s.ai.usage(user, query.since ?? new Date(Date.now() - 30 * 86_400_000)) }),
  /** Reads an invoice already attached to a record, or a file sent as the raw body (up to 4 MB through the API). */
  route({
    method: 'POST',
    path: '/ai/invoice-capture',
    status: 200,
    raw: true,
    rateLimit: 20,
    query: z.object({ entityId: zId, attachmentId: zId.optional(), contentType: z.string().max(100).optional() }),
    handler: async ({ s, user, query, req }) => {
      if (query.attachmentId) return s.ai.extractInvoice(user, { entityId: query.entityId, attachmentId: query.attachmentId });
      const data = Buffer.from(await req.arrayBuffer());
      if (!data.length) throw new BadRequestException('Send the invoice file as the request body, or an attachmentId');
      return s.ai.extractInvoice(user, { entityId: query.entityId, data, mimeType: query.contentType ?? req.headers.get('content-type') ?? '' });
    },
  }),
  route({
    method: 'POST',
    path: '/ai/ask',
    status: 200,
    rateLimit: 30,
    body: z.object({ entityId: zId, question: z.string().trim().min(3).max(1000), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(12).optional() }),
    handler: ({ s, user, body }) => s.ai.ask(user, body),
  }),
];

export const automationRoutes = [...recurring, ...collections, ...suggestions, ...ai];
