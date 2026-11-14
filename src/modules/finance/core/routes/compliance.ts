import { z } from 'zod';
import { PERMISSIONS as P } from '../common/permissions';
import { parseId, zDate, zId } from '../common/validation';
import { route } from '../http/router';

const taxType = z.enum(['A', 'B', 'C', 'D', 'E']);

export const complianceRoutes = [
  // ----- KRA eTIMS ------------------------------------------------------------------------------
  route({ method: 'GET', path: '/etims/devices', permissions: [P.AR_VIEW], handler: ({ s, user }) => s.etims.devices(user) }),
  route({
    method: 'PATCH',
    path: '/etims/devices',
    permissions: [P.COMPLIANCE_MANAGE],
    body: z.object({
      branchId: zId,
      enabled: z.boolean(),
      environment: z.enum(['sandbox', 'production']),
      tin: z.string().trim().max(20),
      bhfId: z.string().trim().max(2).default('00'),
      dvcSrlNo: z.string().trim().min(3).max(60),
      defaultItemClassCode: z.string().trim().max(10).default(''),
      defaultTaxType: taxType.default('D'),
    }),
    handler: ({ s, user, body }) => s.etims.configure(user, body),
  }),
  route({ method: 'POST', path: '/etims/devices/:id/initialise', permissions: [P.COMPLIANCE_MANAGE], status: 200, rateLimit: 10, handler: ({ s, user, params }) => s.etims.initialise(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/etims/devices/:id/retry', permissions: [P.COMPLIANCE_MANAGE], status: 200, rateLimit: 20, handler: ({ s, user, params }) => s.etims.retry(user, parseId(params.id)) }),
  // ----- Purchases (supplier invoices registered against our PIN) ----------------------------------
  route({
    method: 'GET',
    path: '/etims/purchases',
    permissions: [P.AP_VIEW],
    query: z.object({ status: z.enum(['RECEIVED', 'MATCHED', 'ACCEPTED', 'REJECTED']).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    handler: ({ s, user, query }) => s.etimsPurchases.inbox(user, query),
  }),
  route({ method: 'POST', path: '/etims/purchases/fetch', permissions: [P.AP_MANAGE], status: 200, rateLimit: 6, handler: ({ s, user }) => s.etimsPurchases.fetchNow(user) }),
  route({
    method: 'POST',
    path: '/etims/purchases/:id/link',
    permissions: [P.AP_MANAGE],
    status: 200,
    body: z.object({ billId: zId }),
    handler: ({ s, user, params, body }) => s.etimsPurchases.link(user, parseId(params.id), body.billId),
  }),
  route({
    method: 'POST',
    path: '/etims/purchases/:id/bill',
    permissions: [P.AP_MANAGE],
    body: z.object({ accountId: zId.nullable().optional() }),
    handler: async ({ s, user, params, body }) => {
      const id = parseId(params.id);
      const draft = await s.etimsPurchases.billDraft(user, id, body);
      const bill = await s.documents.create(user, draft);
      return s.etimsPurchases.afterBillCreated(user, id, bill._id);
    },
  }),
  route({
    method: 'POST',
    path: '/etims/purchases/:id/reject',
    permissions: [P.AP_MANAGE],
    status: 200,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
    handler: ({ s, user, params, body }) => s.etimsPurchases.reject(user, parseId(params.id), body.reason),
  }),
  route({ method: 'GET', path: '/etims/purchases/by-bill/:id', permissions: [P.AP_VIEW], handler: ({ s, user, params }) => s.etimsPurchases.forBill(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/etims/unregistered-bills',
    permissions: [P.AP_VIEW],
    query: z.object({ entityId: zId, from: zDate, to: zDate }),
    handler: ({ s, user, query }) => s.etimsPurchases.unregistered(user, query),
  }),
  // ----- Imports (customs-declared items) ---------------------------------------------------------
  route({
    method: 'GET',
    path: '/etims/imports',
    query: z.object({ status: z.enum(['RECEIVED', 'APPROVED', 'REJECTED']).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
    handler: ({ s, user, query }) => s.etimsImports.list(user, query),
  }),
  route({ method: 'POST', path: '/etims/imports/fetch', status: 200, rateLimit: 6, handler: ({ s, user }) => s.etimsImports.fetchNow(user) }),
  route({
    method: 'POST',
    path: '/etims/imports/:id/approve',
    status: 200,
    body: z.object({ itemId: zId, billId: zId.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.etimsImports.approve(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/etims/imports/:id/reject',
    status: 200,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
    handler: ({ s, user, params, body }) => s.etimsImports.reject(user, parseId(params.id), body.reason),
  }),

  // ----- Stock movements ------------------------------------------------------------------------------
  route({
    method: 'GET',
    path: '/etims/stock-reports',
    permissions: [P.INVENTORY_VIEW],
    query: z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    handler: ({ s, user, query }) => s.etimsStock.list(user, query),
  }),
  route({ method: 'POST', path: '/etims/devices/:id/stock/retry', permissions: [P.COMPLIANCE_MANAGE], status: 200, rateLimit: 20, handler: ({ s, user, params }) => s.etimsStock.retry(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/etims/submissions',
    permissions: [P.AR_VIEW],
    query: z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED', 'CANCELLED']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    handler: ({ s, user, query }) => s.etims.submissions(user, query),
  }),
];
