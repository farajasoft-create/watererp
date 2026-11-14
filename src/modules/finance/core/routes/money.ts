import { z } from 'zod';
import { BadRequestException } from '../common/errors';
import { Decimal } from '../common/money';
import { PERMISSIONS as P } from '../common/permissions';
import { parseId, zDate, zDecimal, zId } from '../common/validation';
import { route } from '../http/router';

/**
 * Phase 18 (money out and in): customer refunds, salary runs, card payments on the portal and bank feeds.
 */

const RefundBody = z.object({
  entityId: zId,
  branchId: zId.nullable().optional(),
  partyId: zId,
  date: zDate,
  bankAccountId: zId,
  method: z.enum(['BANK_TRANSFER', 'CHEQUE', 'CASH', 'MOBILE_MONEY', 'CARD', 'OTHER']).optional(),
  payeePhone: z.string().trim().max(20).optional(),
  reference: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  exchangeRate: zDecimal.nullable().optional(),
  sources: z.array(z.object({ type: z.enum(['PAYMENT', 'CREDIT_NOTE']), id: zId, amount: zDecimal })).min(1).max(100),
});

const SalaryRunBody = z.object({
  entityId: zId,
  branchId: zId.nullable().optional(),
  period: z.string().trim().regex(/^\d{4}-\d{2}$/, 'The period is a month, YYYY-MM'),
  date: zDate,
  description: z.string().trim().max(300).optional(),
  bankAccountId: zId,
  payableAccountId: zId.nullable().optional(),
  lines: z
    .array(
      z.object({
        employeeNumber: z.string().trim().max(30).optional(),
        employeeName: z.string().trim().min(1).max(200),
        phone: z.string().trim().max(20).optional(),
        amount: zDecimal,
        departmentId: zId.nullable().optional(),
      }),
    )
    .min(1)
    .max(2000),
});

const voidBody = z.object({ date: zDate, reason: z.string().trim().min(3).max(500) });

const refunds = [
  route({
    method: 'GET',
    path: '/refunds',
    permissions: [P.AR_VIEW],
    query: z.object({ entityId: zId.optional(), partyId: zId.optional(), status: z.enum(['DRAFT', 'POSTED', 'VOID']).optional() }),
    handler: ({ s, user, query }) => s.refunds.list(user, query),
  }),
  route({
    method: 'GET',
    path: '/refunds/credits',
    permissions: [P.AR_VIEW],
    query: z.object({ customerId: zId, entityId: zId }),
    handler: ({ s, user, query }) => s.refunds.credits(user, query.customerId, query.entityId),
  }),
  route({ method: 'GET', path: '/refunds/:id', permissions: [P.AR_VIEW], handler: ({ s, user, params }) => s.refunds.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/refunds', permissions: [P.AR_MANAGE], body: RefundBody, handler: ({ s, user, body }) => s.refunds.create(user, body) }),
  route({ method: 'PATCH', path: '/refunds/:id', permissions: [P.AR_MANAGE], body: RefundBody, handler: ({ s, user, params, body }) => s.refunds.update(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/refunds/:id', permissions: [P.AR_MANAGE], handler: ({ s, user, params }) => s.refunds.remove(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/refunds/:id/approve', permissions: [P.PAYMENTS_APPROVE], handler: ({ s, user, params }) => s.refunds.approve(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/refunds/:id/void', permissions: [P.PAYMENTS_APPROVE], body: voidBody, handler: ({ s, user, params, body }) => s.refunds.void(user, parseId(params.id), body.date, body.reason) }),
];

const salaries = [
  route({ method: 'GET', path: '/salary-runs', permissions: [P.BANKING_MANAGE], query: z.object({ entityId: zId.optional() }), handler: ({ s, user, query }) => s.salaryRuns.list(user, query.entityId) }),
  route({ method: 'GET', path: '/salary-runs/:id', permissions: [P.BANKING_MANAGE], handler: ({ s, user, params }) => s.salaryRuns.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/salary-runs', permissions: [P.BANKING_MANAGE], body: SalaryRunBody, handler: ({ s, user, body }) => s.salaryRuns.create(user, body) }),
  route({ method: 'PATCH', path: '/salary-runs/:id', permissions: [P.BANKING_MANAGE], body: SalaryRunBody, handler: ({ s, user, params, body }) => s.salaryRuns.update(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/salary-runs/:id', permissions: [P.BANKING_MANAGE], handler: ({ s, user, params }) => s.salaryRuns.remove(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/salary-runs/:id/approve', permissions: [P.PAYMENTS_APPROVE], handler: ({ s, user, params }) => s.salaryRuns.approve(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/salary-runs/:id/void', permissions: [P.PAYMENTS_APPROVE], body: voidBody, handler: ({ s, user, params, body }) => s.salaryRuns.void(user, parseId(params.id), body.date, body.reason) }),
];

const cards = [
  route({ method: 'GET', path: '/bank-accounts/:id/cards', permissions: [P.BANKING_MANAGE], handler: ({ s, user, params }) => s.cards.settings(user, parseId(params.id)) }),
  route({
    method: 'PATCH',
    path: '/bank-accounts/:id/cards',
    permissions: [P.BANKING_MANAGE, P.ORG_MANAGE],
    body: z.object({ enabled: z.boolean(), secretKey: z.string().trim().max(300).optional(), webhookSecret: z.string().trim().max(300).optional(), postAsUserId: zId.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.cards.configure(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/card-payments',
    permissions: [P.BANKING_VIEW],
    query: z.object({ status: z.enum(['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'UNMATCHED']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    handler: ({ s, user, query }) => s.cards.list(user, query),
  }),
  route({
    method: 'POST',
    path: '/cards/webhooks/:secret',
    public: true,
    raw: true,
    status: 200,
    rateLimit: 600,
    handler: async ({ s, params, req }) => s.cards.webhook(params.secret, await req.text(), req.headers.get('stripe-signature')),
  }),
  route({
    method: 'POST',
    path: '/portal/:token/invoices/:id/card',
    public: true,
    status: 200,
    rateLimit: 20,
    body: z.object({ amount: zDecimal.nullable().optional() }),
    handler: ({ s, params, body }) => s.portal.payByCard(params.token, parseId(params.id), body.amount ?? null),
  }),
];

const FeedTransactions = z.object({
  transactions: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        date: zDate,
        amount: z.union([z.string(), z.number()]).transform((v, ctx) => {
          const d = new Decimal(String(v));
          if (!d.isFinite()) ctx.addIssue({ code: 'custom', message: 'Invalid amount' });
          return d;
        }),
        description: z.string().max(500).optional(),
        reference: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

const feeds = [
  route({ method: 'GET', path: '/bank-accounts/:id/feed', permissions: [P.BANKING_MANAGE], handler: ({ s, user, params }) => s.feeds.settings(user, parseId(params.id)) }),
  route({
    method: 'PATCH',
    path: '/bank-accounts/:id/feed',
    permissions: [P.BANKING_MANAGE, P.ORG_MANAGE],
    body: z.object({
      enabled: z.boolean(),
      provider: z.enum(['MONO', 'PUSH']),
      externalAccountId: z.string().trim().max(100).optional(),
      secretKey: z.string().trim().max(300).optional(),
      syncFrom: zDate.nullable().optional(),
      rotateToken: z.boolean().optional(),
      postAsUserId: zId.nullable().optional(),
    }),
    handler: ({ s, user, params, body }) => s.feeds.configure(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/bank-accounts/:id/feed/sync', permissions: [P.BANKING_MANAGE], status: 200, rateLimit: 10, handler: ({ s, user, params }) => s.feeds.syncNow(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/bank-feeds/:bankId/transactions',
    public: true,
    status: 200,
    rateLimit: 120,
    body: FeedTransactions,
    handler: ({ s, params, body, req }) => {
      if (!params.bankId) throw new BadRequestException('Unknown feed');
      return s.feeds.push(params.bankId, req.headers.get('authorization'), body.transactions);
    },
  }),
];

export const moneyRoutes = [...refunds, ...salaries, ...cards, ...feeds];
