import { z } from 'zod';
import { PERMISSIONS as P } from '../common/permissions';
import { Decimal } from '../common/money';
import { parseId, zId } from '../common/validation';
import { route } from '../http/router';

const html = (body: string) =>
  new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      // The page is self-contained: inline styles, an optional inline print script, nothing else.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'self'; base-uri 'none'",
    },
  });

/** A PDF response (inline in the browser, with a sensible file name for saving). */
export const pdf = ({ data, filename }: { data: Buffer; filename: string }, download: boolean) =>
  new Response(new Uint8Array(data), {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(data.length),
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const amount = z
  .union([z.string(), z.number()])
  .transform((v) => new Decimal(String(v)))
  .refine((d) => d.isFinite() && d.gt(0), 'Enter a positive amount');

const mpesaSettings = z.object({
  enabled: z.boolean(),
  environment: z.enum(['sandbox', 'production']),
  shortCode: z.string().trim().max(10),
  shortCodeType: z.enum(['PAYBILL', 'TILL']),
  partyB: z.string().trim().max(10).optional(),
  consumerKey: z.string().trim().max(200).optional(),
  consumerSecret: z.string().trim().max(200).optional(),
  passkey: z.string().trim().max(200).optional(),
  postAsUserId: zId.nullable().optional(),
});

export const gettingPaidRoutes = [
  // ----- Invoice documents ----------------------------------------------------------------------
  route({
    method: 'GET',
    path: '/invoices/:id/document',
    query: z.object({ print: z.enum(['1', '0']).optional() }),
    handler: async ({ s, user, params, query }) => html(await s.billing.document(user, parseId(params.id), { autoPrint: query.print === '1' })),
  }),
  route({
    method: 'GET',
    path: '/invoices/:id/pdf',
    rateLimit: 60,
    query: z.object({ download: z.enum(['1', '0']).optional() }),
    handler: async ({ s, user, params, query }) => pdf(await s.billing.pdfFor(user, parseId(params.id)), query.download === '1'),
  }),
  route({
    method: 'POST',
    path: '/invoices/:id/email',
    permissions: [P.AR_MANAGE],
    rateLimit: 30,
    body: z.object({ to: z.array(z.string().trim().email().max(200)).max(10).optional(), message: z.string().trim().max(2000).optional() }),
    handler: async ({ s, user, params, body }) => {
      const res = await s.portal.emailDocument(user, parseId(params.id), body);
      await s.email.deliverDue({ organisationId: user.organisationId, limit: 5 });
      return res;
    },
  }),
  route({
    method: 'POST',
    path: '/invoices/:id/mpesa-request',
    permissions: [P.AR_MANAGE],
    rateLimit: 20,
    body: z.object({ phone: z.string().trim().min(9).max(20), amount: amount.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.mpesa.requestPayment({ organisationId: user.organisationId, invoiceId: parseId(params.id), phone: body.phone, amount: body.amount ?? null, requestedBy: user.id, via: 'app' }),
  }),

  // ----- Customer portal links (staff) ----------------------------------------------------------
  route({ method: 'GET', path: '/customers/:id/portal-links', permissions: [P.AR_VIEW], handler: ({ s, user, params }) => s.portal.links(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/customers/:id/portal-links',
    permissions: [P.AR_MANAGE],
    body: z.object({ entityId: zId, days: z.number().int().min(1).max(365).default(90) }),
    handler: ({ s, user, params, body }) => s.portal.createLink(user, parseId(params.id), body.entityId, body.days),
  }),
  route({ method: 'POST', path: '/portal-links/:id/revoke', permissions: [P.AR_MANAGE], status: 200, handler: ({ s, user, params }) => s.portal.revoke(user, parseId(params.id)) }),

  // ----- M-Pesa (staff) -------------------------------------------------------------------------
  route({ method: 'GET', path: '/bank-accounts/:id/mpesa', permissions: [P.BANKING_VIEW], handler: ({ s, user, params }) => s.mpesa.settings(user, parseId(params.id)) }),
  route({ method: 'PATCH', path: '/bank-accounts/:id/mpesa', permissions: [P.BANKING_MANAGE, P.ORG_MANAGE], body: mpesaSettings, handler: ({ s, user, params, body }) => s.mpesa.configure(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/bank-accounts/:id/mpesa/register', permissions: [P.BANKING_MANAGE, P.ORG_MANAGE], status: 200, rateLimit: 10, handler: ({ s, user, params }) => s.mpesa.register(user, parseId(params.id)) }),
  route({
    method: 'PATCH',
    path: '/bank-accounts/:id/mpesa/payouts',
    permissions: [P.BANKING_MANAGE, P.ORG_MANAGE],
    body: z.object({
      enabled: z.boolean(),
      shortCode: z.string().trim().max(10),
      initiatorName: z.string().trim().max(100),
      securityCredential: z.string().trim().max(2000).optional(),
      dailyLimit: amount.nullable().optional(),
      lowBalanceAlert: amount.nullable().optional(),
      tariff: z
        .array(z.object({ upTo: amount, charge: z.union([z.string(), z.number()]).transform((v) => new Decimal(String(v))) }))
        .max(50)
        .optional(),
      chargesAccountId: zId.nullable().optional(),
    }),
    handler: ({ s, user, params, body }) => s.mpesa.configurePayouts(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/mpesa/payouts',
    permissions: [P.BANKING_VIEW],
    query: z.object({ status: z.enum(['QUEUED', 'SENT', 'COMPLETED', 'FAILED', 'CHECK', 'CANCELLED']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    handler: ({ s, user, query }) => s.payouts.list(user, query),
  }),
  route({ method: 'POST', path: '/bank-accounts/:id/mpesa/balance', permissions: [P.BANKING_VIEW], status: 200, rateLimit: 10, handler: ({ s, user, params }) => s.payouts.balanceNow(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/mpesa/payouts/:id/check', status: 200, rateLimit: 20, handler: ({ s, user, params }) => s.payouts.checkNow(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/mpesa/payouts/by-source/:id', handler: ({ s, user, params }) => s.payouts.forSource(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/mpesa/payouts/:id/retry',
    status: 200,
    rateLimit: 20,
    body: z.object({ confirmNotPaid: z.boolean().default(false) }),
    handler: ({ s, user, params, body }) => s.payouts.retry(user, parseId(params.id), body.confirmNotPaid),
  }),
  route({
    method: 'POST',
    path: '/mpesa/payouts/:id/cancel',
    status: 200,
    body: z.object({ confirmNotPaid: z.boolean().default(false), reason: z.string().trim().min(3).max(300) }),
    handler: ({ s, user, params, body }) => s.payouts.cancel(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/mpesa/transactions',
    permissions: [P.BANKING_VIEW],
    query: z.object({ status: z.enum(['PENDING', 'FAILED', 'UNMATCHED', 'RECEIPTED', 'IGNORED']).optional(), bankAccountId: zId.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    handler: ({ s, user, query }) => s.mpesa.list(user, query),
  }),
  route({
    method: 'POST',
    path: '/mpesa/transactions/:id/assign',
    permissions: [P.AR_MANAGE],
    status: 200,
    body: z.object({ customerId: zId, invoiceId: zId.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.mpesa.assign(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/mpesa/transactions/:id/ignore',
    permissions: [P.BANKING_MANAGE],
    status: 200,
    body: z.object({ note: z.string().trim().min(3).max(500) }),
    handler: ({ s, user, params, body }) => s.mpesa.ignore(user, parseId(params.id), body.note),
  }),
  route({ method: 'GET', path: '/mpesa/transactions/:id/status', permissions: [P.AR_VIEW], handler: ({ s, user, params }) => s.mpesa.status(user.organisationId, parseId(params.id)) }),

  // ----- Safaricom callbacks (the secret in the path identifies the account) ---------------------
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/stk', public: true, status: 200, handler: ({ s, params, body }) => s.mpesa.stkCallback(params.secret, body) }),
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/confirmation', public: true, status: 200, handler: ({ s, params, body }) => s.mpesa.c2bConfirmation(params.secret, (body ?? {}) as Record<string, unknown>) }),
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/payout-result', public: true, status: 200, handler: ({ s, params, body }) => s.payouts.result(params.secret, body) }),
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/status-result/:id', public: true, status: 200, handler: ({ s, params, body }) => s.payouts.statusResult(params.secret, params.id, body) }),
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/balance-result', public: true, status: 200, handler: ({ s, params, body }) => s.payouts.balanceResult(params.secret, body) }),
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/query-timeout', public: true, status: 200, handler: () => ({ ResultCode: 0, ResultDesc: 'Accepted' }) }),
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/payout-timeout', public: true, status: 200, handler: ({ s, params, body }) => s.payouts.timeout(params.secret, body) }),
  // With ResponseType "Completed" Safaricom completes payments itself; when validation is enabled, accept them all.
  route({ method: 'POST', path: '/mpesa/callbacks/:secret/validation', public: true, status: 200, handler: () => ({ ResultCode: 0, ResultDesc: 'Accepted' }) }),

  // ----- Vendor portal: links (staff), invoices sent in, and the supplier's own view (token) -------
  route({ method: 'GET', path: '/suppliers/:id/portal-links', permissions: [P.AP_VIEW], handler: ({ s, user, params }) => s.supplierPortal.links(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/suppliers/:id/portal-links', permissions: [P.AP_VIEW], body: z.object({ days: z.number().int().min(1).max(730).optional() }), handler: ({ s, user, params, body }) => s.supplierPortal.createLink(user, parseId(params.id), body.days) }),
  route({ method: 'POST', path: '/supplier-portal-links/:id/revoke', permissions: [P.AP_VIEW], status: 200, handler: ({ s, user, params }) => s.supplierPortal.revoke(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/supplier-invoices', permissions: [P.AP_VIEW], query: z.object({ status: z.enum(['SUBMITTED', 'ENTERED', 'REJECTED']).optional() }), handler: ({ s, user, query }) => s.supplierPortal.submissions(user, query.status) }),
  route({ method: 'POST', path: '/supplier-invoices/:id/decide', permissions: [P.AP_MANAGE], status: 200, body: z.object({ status: z.enum(['ENTERED', 'REJECTED']), billId: zId.nullable().optional(), reason: z.string().trim().max(500).optional() }), handler: ({ s, user, params, body }) => s.supplierPortal.decide(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/vendor-portal/:token', public: true, rateLimit: 60, handler: ({ s, params }) => s.supplierPortal.view(params.token) }),
  route({
    method: 'POST',
    path: '/vendor-portal/:token/invoices',
    public: true,
    rateLimit: 10,
    body: z.object({ invoiceNumber: z.string().trim().min(1).max(60), invoiceDate: z.coerce.date(), amount, purchaseOrderId: zId.nullable().optional(), etimsNumber: z.string().trim().max(60).optional(), note: z.string().trim().max(1000).optional() }),
    handler: ({ s, params, body }) => s.supplierPortal.submitInvoice(params.token, { ...body, amount: body.amount as Decimal }),
  }),

  // ----- Customer portal (public; the token is the authority) -----------------------------------
  route({ method: 'GET', path: '/portal/:token', public: true, rateLimit: 60, handler: ({ s, params }) => s.portal.view(params.token) }),
  route({ method: 'GET', path: '/portal/:token/invoices/:id/document', public: true, rateLimit: 60, handler: async ({ s, params }) => html(await s.portal.document(params.token, parseId(params.id))) }),
  route({ method: 'GET', path: '/portal/:token/invoices/:id/pdf', public: true, rateLimit: 30, handler: async ({ s, params }) => pdf(await s.portal.pdf(params.token, parseId(params.id)), true) }),
  route({
    method: 'POST',
    path: '/portal/:token/invoices/:id/pay',
    public: true,
    rateLimit: 10,
    body: z.object({ phone: z.string().trim().min(9).max(20), amount: amount.nullable().optional() }),
    handler: ({ s, params, body }) => s.portal.pay(params.token, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/portal/:token/payments/:id', public: true, rateLimit: 120, handler: ({ s, params }) => s.portal.payStatus(params.token, parseId(params.id)) }),
];
