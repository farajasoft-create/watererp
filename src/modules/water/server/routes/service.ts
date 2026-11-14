import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/water/manifest';
import { parseId, zBool, zDate, zDecimal, zId, zPage } from '@/platform/common/validation';
import { CASE_STAGES, NOTICE_TYPES, PLAN_STATUSES, TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES } from '../service-schemas';
import { CallCentreTicket } from '../service/intake.service';
import { PORTAL_COOKIE, PORTAL_SESSION_SECONDS } from '../service/portal.service';
import { route } from '../route';

const optionalText = (max: number) => z.string().trim().max(max).optional();
const secure = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false';
const gps = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional();

const TicketBody = z.object({
  category: z.enum(TICKET_CATEGORIES),
  channel: z.enum(TICKET_CHANNELS).default('WALK_IN'),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  customerId: zId.nullable().optional(),
  accountNo: optionalText(30),
  name: optionalText(150),
  phone: optionalText(20),
  email: optionalText(120),
  subject: z.string().trim().min(3).max(200),
  description: optionalText(2000),
  zoneId: zId.nullable().optional(),
  location: optionalText(200),
  gps,
});

/** Forms posted by Africa's Talking (SMS and USSD callbacks) are URL-encoded, not JSON. */
async function formOf(req: Request): Promise<Record<string, string>> {
  const body = await req.text();
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      return JSON.parse(body) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

export const serviceRoutes = [
  // Customer service tickets ------------------------------------------------------------------
  route({
    method: 'GET',
    path: '/tickets',
    permissions: [P.SERVICE_VIEW],
    query: z.object({ status: z.enum(TICKET_STATUSES).optional(), open: zBool.optional(), category: z.enum(TICKET_CATEGORIES).optional(), assignedTo: zId.optional(), mine: zBool.optional(), overdue: zBool.optional(), customerId: zId.optional(), search: optionalText(60), ...zPage }),
    handler: ({ s, user, query }) => s.tickets.list(user, query),
  }),
  route({ method: 'GET', path: '/tickets/stats', permissions: [P.SERVICE_VIEW], query: z.object({ from: zDate, to: zDate }), handler: ({ s, user, query }) => s.tickets.stats(user, query.from, new Date(query.to.getTime() + 86_400_000)) }),
  route({ method: 'GET', path: '/tickets/:id', permissions: [P.SERVICE_VIEW], handler: ({ s, user, params }) => s.tickets.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/tickets', permissions: [P.SERVICE_VIEW], body: TicketBody, handler: ({ s, user, body }) => s.tickets.create(user, body) }),
  route({ method: 'POST', path: '/tickets/:id/assign', permissions: [P.SERVICE_MANAGE], status: 200, body: z.object({ assignedTo: zId, note: optionalText(300) }), handler: ({ s, user, params, body }) => s.tickets.assign(user, parseId(params.id), body.assignedTo, body.note) }),
  route({ method: 'POST', path: '/tickets/:id/start', permissions: [P.SERVICE_MANAGE], status: 200, body: z.object({ note: optionalText(300) }), handler: ({ s, user, params, body }) => s.tickets.start(user, parseId(params.id), body.note) }),
  route({ method: 'POST', path: '/tickets/:id/comment', permissions: [P.SERVICE_VIEW], status: 200, body: z.object({ note: z.string().trim().min(1).max(1000) }), handler: ({ s, user, params, body }) => s.tickets.comment(user, parseId(params.id), body.note) }),
  route({ method: 'POST', path: '/tickets/:id/resolve', permissions: [P.SERVICE_MANAGE], status: 200, body: z.object({ resolution: z.string().trim().min(3).max(1000) }), handler: ({ s, user, params, body }) => s.tickets.resolve(user, parseId(params.id), body.resolution) }),
  route({
    method: 'POST',
    path: '/tickets/:id/close',
    permissions: [P.SERVICE_MANAGE],
    status: 200,
    body: z.object({ customerConfirmed: z.boolean(), satisfaction: z.number().int().min(1).max(5).nullable().optional(), recommend: z.number().int().min(0).max(10).nullable().optional(), note: optionalText(300) }),
    handler: ({ s, user, params, body }) => s.tickets.close(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/tickets/:id/reopen', permissions: [P.SERVICE_MANAGE], status: 200, body: z.object({ note: z.string().trim().min(3).max(300) }), handler: ({ s, user, params, body }) => s.tickets.reopen(user, parseId(params.id), body.note) }),
  route({ method: 'POST', path: '/tickets/:id/work-order', permissions: [P.SERVICE_MANAGE], handler: ({ s, user, params }) => s.tickets.linkWorkOrder(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/tickets/housekeeping', permissions: [P.SERVICE_MANAGE], status: 200, handler: ({ s, user }) => s.tickets.housekeeping(user.organisationId) }),

  // Intake from outside systems (token from Water settings → Customer service) ----------------
  route({ method: 'POST', path: '/settings/intake-token', permissions: [P.SETTINGS_MANAGE], status: 200, handler: ({ s, user }) => s.intake.rotateToken(user) }),
  route({ method: 'POST', path: '/intake/:token/call-centre', public: true, rateLimit: 120, body: CallCentreTicket, handler: ({ s, params, body }) => s.intake.callCentre(params.token, body) }),
  route({ method: 'POST', path: '/intake/:token/sms', public: true, raw: true, rateLimit: 300, status: 200, handler: async ({ s, params, req }) => s.intake.inboundSms(params.token, await formOf(req)) }),
  route({ method: 'POST', path: '/intake/:token/email', public: true, raw: true, rateLimit: 300, status: 200, handler: async ({ s, params, req }) => s.intake.inboundEmail(params.token, await formOf(req)) }),
  route({ method: 'POST', path: '/intake/:token/ussd', public: true, raw: true, rateLimit: 600, status: 200, handler: async ({ s, params, req }) => s.intake.ussd(params.token, await formOf(req)) }),

  // Notices ------------------------------------------------------------------------------------
  route({ method: 'GET', path: '/notices', permissions: [P.SERVICE_VIEW], handler: ({ s, user }) => s.notices.list(user) }),
  route({
    method: 'POST',
    path: '/notices',
    permissions: [P.NOTICE_SEND],
    body: z.object({
      type: z.enum(NOTICE_TYPES),
      title: z.string().trim().min(3).max(120),
      message: z.string().trim().min(10).max(400),
      zoneIds: z.array(zId).max(200).default([]),
      startsAt: zDate.nullable().optional(),
      endsAt: zDate.nullable().optional(),
      sendSms: z.boolean().default(true),
      publish: z.boolean().default(true),
    }),
    handler: ({ s, user, body }) => s.notices.create(user, body),
  }),

  // Debt: payment plans and collection cases ----------------------------------------------------
  route({ method: 'GET', path: '/debt/summary', permissions: [P.CUSTOMER_VIEW], handler: ({ s, user }) => s.debt.summary(user) }),
  route({ method: 'GET', path: '/payment-plans', permissions: [P.CUSTOMER_VIEW], query: z.object({ status: z.enum(PLAN_STATUSES).optional(), customerId: zId.optional() }), handler: ({ s, user, query }) => s.debt.listPlans(user, query) }),
  route({
    method: 'POST',
    path: '/payment-plans',
    permissions: [P.DEBT_MANAGE],
    body: z.object({ customerId: zId, deposit: zDecimal, instalments: z.number().int().min(1).max(36), startDate: zDate, graceDays: z.number().int().min(0).max(60).optional(), notes: optionalText(500) }),
    handler: ({ s, user, body }) => s.debt.createPlan(user, body),
  }),
  route({ method: 'POST', path: '/payment-plans/:id/review', permissions: [P.DEBT_APPROVE], status: 200, body: z.object({ approve: z.boolean() }), handler: ({ s, user, params, body }) => s.debt.reviewPlan(user, parseId(params.id), body.approve) }),
  route({ method: 'POST', path: '/payment-plans/:id/cancel', permissions: [P.DEBT_MANAGE], status: 200, body: z.object({ note: z.string().trim().min(3).max(300) }), handler: ({ s, user, params, body }) => s.debt.cancelPlan(user, parseId(params.id), body.note) }),
  route({ method: 'GET', path: '/debt-cases', permissions: [P.CUSTOMER_VIEW], query: z.object({ stage: z.enum(CASE_STAGES).optional(), open: zBool.optional(), customerId: zId.optional() }), handler: ({ s, user, query }) => s.debt.listCases(user, query) }),
  route({
    method: 'POST',
    path: '/debt-cases',
    permissions: [P.DEBT_MANAGE],
    body: z.object({ customerId: zId, stage: z.enum(CASE_STAGES).optional(), note: optionalText(500), assignedTo: zId.nullable().optional() }),
    handler: ({ s, user, body }) => s.debt.openCase(user, body),
  }),
  route({
    method: 'POST',
    path: '/debt-cases/:id/stage',
    permissions: [P.DEBT_MANAGE],
    status: 200,
    body: z.object({
      stage: z.enum(CASE_STAGES),
      note: optionalText(500),
      collector: optionalText(150),
      legal: z.object({ advocate: optionalText(150), court: optionalText(150), caseNo: optionalText(60), filedAt: zDate.nullable().optional(), nextHearing: zDate.nullable().optional(), judgementAmount: zDecimal.nullable().optional() }).optional(),
      nextActionAt: zDate.nullable().optional(),
    }),
    handler: ({ s, user, params, body }) => s.debt.advance(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/debt-cases/:id/write-off', permissions: [P.DEBT_MANAGE], status: 200, body: z.object({ reason: z.string().trim().min(5).max(300) }), handler: ({ s, user, params, body }) => s.debt.writeOff(user, parseId(params.id), body.reason) }),
  route({ method: 'POST', path: '/debt/collection-run', permissions: [P.DEBT_MANAGE], status: 200, handler: ({ s, user }) => s.debt.collectionRun(user) }),

  // Customer self-service portal (public; signed in with an SMS code) ---------------------------
  route({ method: 'GET', path: '/portal/:org', public: true, handler: ({ s, params }) => s.portal.info(params.org) }),
  route({
    method: 'POST',
    path: '/portal/:org/code',
    public: true,
    rateLimit: 10,
    status: 200,
    body: z.object({ accountNo: z.string().trim().min(1).max(30), phone: z.string().trim().min(9).max(20) }),
    handler: ({ s, params, body }) => s.portal.requestCode(params.org, body),
  }),
  route({
    method: 'POST',
    path: '/portal/:org/session',
    public: true,
    rateLimit: 20,
    status: 200,
    body: z.object({ accountNo: z.string().trim().min(1).max(30), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
    handler: async ({ s, params, body, setCookie }) => {
      const { token } = await s.portal.verify(params.org, body);
      setCookie(PORTAL_COOKIE, token, { maxAge: PORTAL_SESSION_SECONDS, secure });
      return { ok: true };
    },
  }),
  route({
    method: 'POST',
    path: '/portal/:org/logout',
    public: true,
    status: 200,
    handler: ({ setCookie }) => {
      setCookie(PORTAL_COOKIE, '', { maxAge: 0, secure });
      return { ok: true };
    },
  }),
  route({ method: 'GET', path: '/portal/:org/me', public: true, handler: async ({ s, params, req }) => s.portal.me(await s.portal.authenticate(req, params.org)) }),
  route({ method: 'GET', path: '/portal/:org/bills/:id', public: true, handler: async ({ s, params, req }) => s.portal.bill(await s.portal.authenticate(req, params.org), parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/portal/:org/tickets',
    public: true,
    rateLimit: 20,
    body: z.object({ category: z.enum(TICKET_CATEGORIES), subject: z.string().trim().min(3).max(200), description: optionalText(2000), location: optionalText(200), gps }),
    handler: async ({ s, params, req, body }) => s.portal.report(await s.portal.authenticate(req, params.org), body),
  }),
  route({
    method: 'POST',
    path: '/portal/:org/tickets/:id/feedback',
    public: true,
    status: 200,
    body: z.object({ confirmed: z.boolean(), satisfaction: z.number().int().min(1).max(5).nullable().optional(), recommend: z.number().int().min(0).max(10).nullable().optional(), note: optionalText(300) }),
    handler: async ({ s, params, req, body }) => s.portal.feedback(await s.portal.authenticate(req, params.org), parseId(params.id), body),
  }),
];
