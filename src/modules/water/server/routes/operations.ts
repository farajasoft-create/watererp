import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/water/manifest';
import { parseId, zBool, zDate, zDecimal, zId, zPage, zPeriod } from '@/platform/common/validation';
import { DISCONNECTION_STATUSES, PAYMENT_CHANNELS, PAYMENT_STATUSES, READING_STATUSES } from '@/modules/water/server/schemas';
import { route } from '../route';
import { FIELD_EXCEPTIONS, READING_EXCEPTIONS } from '../readings/consumption';

const optionalText = (max: number) => z.string().trim().max(max).optional();

const CaptureBody = z.object({
  clientId: z.string().trim().min(8).max(64),
  meterId: zId,
  value: zDecimal.nullable().optional(),
  fieldException: z.enum(FIELD_EXCEPTIONS).nullable().optional(),
  readAt: z.string().datetime({ offset: true }).transform((v) => new Date(v)),
  gps: z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().optional() }).nullable().optional(),
  photoId: zId.nullable().optional(),
  note: optionalText(300),
});

export const operationsRoutes = [
  // Reading cycles and capture -----------------------------------------------------------------
  route({ method: 'GET', path: '/cycles', handler: ({ s, user }) => s.readings.listCycles(user) }),
  route({
    method: 'POST',
    path: '/cycles',
    permissions: [P.BILLING_RUN],
    body: z.object({ period: zPeriod, readingFrom: zDate.optional(), readingTo: zDate.optional() }),
    handler: ({ s, user, body }) => s.readings.openCycle(user, body),
  }),
  route({ method: 'POST', path: '/cycles/:period/close', permissions: [P.BILLING_RUN], status: 200, handler: ({ s, user, params }) => s.readings.closeCycle(user, params.period) }),
  route({
    method: 'POST',
    path: '/cycles/:period/estimate',
    permissions: [P.READING_APPROVE],
    status: 200,
    body: z.object({ zoneId: zId.optional() }),
    handler: ({ s, user, params, body }) => s.readings.estimateMissing(user, params.period, body.zoneId),
  }),

  route({ method: 'GET', path: '/field/route', permissions: [P.READING_CAPTURE], query: z.object({ zoneId: zId.optional() }), handler: ({ s, user, query }) => s.readings.route(user, query.zoneId) }),
  route({ method: 'POST', path: '/readings', permissions: [P.READING_CAPTURE], body: CaptureBody, handler: async ({ s, user, body }) => (await s.readings.capture(user, body)).reading }),
  route({
    method: 'POST',
    path: '/readings/sync',
    permissions: [P.READING_CAPTURE],
    status: 200,
    body: z.object({ readings: z.array(CaptureBody).max(500) }),
    handler: ({ s, user, body }) => s.readings.sync(user, body.readings),
  }),
  route({
    method: 'POST',
    path: '/readings/import',
    permissions: [P.READING_APPROVE],
    status: 200,
    body: z.object({ rows: z.array(z.object({ serialNo: z.string().trim().min(1).max(40), value: zDecimal, readAt: zDate, note: optionalText(300) })).min(1).max(5000) }),
    handler: ({ s, user, body }) => s.readings.importRows(user, body.rows),
  }),
  route({ method: 'POST', path: '/readings/photos', permissions: [P.READING_CAPTURE], raw: true, handler: ({ s, user, req }) => s.readings.uploadPhoto(user, req) }),
  route({ method: 'GET', path: '/readings/photos/:id', permissions: [P.CUSTOMER_VIEW], handler: ({ s, user, params }) => s.readings.photo(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/readings',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ period: zPeriod.optional(), status: z.enum(READING_STATUSES).optional(), exception: z.enum(READING_EXCEPTIONS).optional(), exceptionsOnly: zBool.optional(), zoneId: zId.optional(), ...zPage }),
    handler: ({ s, user, query }) => s.readings.list(user, query),
  }),
  route({
    method: 'POST',
    path: '/readings/:id/review',
    permissions: [P.READING_APPROVE],
    status: 200,
    body: z.object({ action: z.enum(['APPROVE', 'REJECT']), correctedValue: zDecimal.nullable().optional(), note: optionalText(300) }),
    handler: ({ s, user, params, body }) => s.readings.review(user, parseId(params.id), body),
  }),

  // Billing ------------------------------------------------------------------------------------
  route({ method: 'GET', path: '/bill-runs', permissions: [P.CUSTOMER_VIEW], handler: ({ s, user }) => s.billing.listRuns(user) }),
  route({
    method: 'GET',
    path: '/bill-runs/:id',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ search: z.string().trim().max(60).optional(), ...zPage }),
    handler: ({ s, user, params, query }) => s.billing.getRun(user, parseId(params.id), query),
  }),
  route({
    method: 'POST',
    path: '/bill-runs',
    permissions: [P.BILLING_RUN],
    body: z.object({ period: zPeriod, zoneId: zId.nullable().optional(), billDate: zDate, dueDate: zDate.nullable().optional() }),
    handler: ({ s, user, body }) => s.billing.createRun(user, body),
  }),
  route({
    method: 'POST',
    path: '/bill-runs/supplementary',
    permissions: [P.BILLING_RUN],
    body: z.object({
      customerId: zId,
      period: zPeriod,
      reason: z.string().trim().min(5, 'Say why the bill is raised').max(300),
      billDate: zDate,
      dueDate: zDate.nullable().optional(),
      units: zDecimal.nullable().optional(),
      charges: z.array(z.object({ description: z.string().trim().min(1).max(150), amount: zDecimal })).max(20).optional(),
    }),
    handler: ({ s, user, body }) => s.billing.createSupplementary(user, body),
  }),
  route({ method: 'POST', path: '/bill-runs/:id/approve', permissions: [P.BILLING_APPROVE], status: 200, handler: ({ s, user, params }) => s.billing.approveRun(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/bill-runs/:id/cancel', permissions: [P.BILLING_RUN], status: 200, handler: ({ s, user, params }) => s.billing.cancelRun(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/bills/:id', permissions: [P.CUSTOMER_VIEW], handler: ({ s, user, params }) => s.billing.getBill(user, parseId(params.id)) }),

  // Payments -----------------------------------------------------------------------------------
  route({
    method: 'GET',
    path: '/payments',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ status: z.enum(PAYMENT_STATUSES).optional(), channel: z.enum(PAYMENT_CHANNELS).optional(), search: z.string().trim().max(60).optional(), from: zDate.optional(), to: zDate.optional(), customerId: zId.optional(), ...zPage }),
    handler: ({ s, user, query }) => s.payments.list(user, query),
  }),
  route({
    method: 'POST',
    path: '/payments',
    permissions: [P.PAYMENT_RECORD],
    body: z.object({ customerId: zId, amount: zDecimal, channel: z.enum(PAYMENT_CHANNELS), reference: z.string().trim().min(1).max(60), paidAt: zDate, payerName: optionalText(150), payerPhone: optionalText(20), chequeNo: optionalText(30), drawerBank: optionalText(80) }),
    handler: ({ s, user, body }) => s.payments.record(user, body),
  }),
  route({
    method: 'POST',
    path: '/payments/split',
    permissions: [P.PAYMENT_RECORD],
    body: z.object({
      channel: z.enum(PAYMENT_CHANNELS),
      reference: z.string().trim().min(1).max(55),
      paidAt: zDate,
      payerName: optionalText(150),
      payerPhone: optionalText(20),
      chequeNo: optionalText(30),
      drawerBank: optionalText(80),
      parts: z.array(z.object({ customerId: zId, amount: zDecimal })).min(2).max(50),
    }),
    handler: ({ s, user, body }) => s.payments.split(user, body),
  }),
  route({
    method: 'POST',
    path: '/payments/:id/split',
    permissions: [P.PAYMENT_ALLOCATE],
    status: 200,
    body: z.object({ parts: z.array(z.object({ customerId: zId, amount: zDecimal })).min(2).max(50) }),
    handler: ({ s, user, params, body }) => s.payments.split(user, { paymentId: parseId(params.id), parts: body.parts }),
  }),
  route({ method: 'POST', path: '/payments/:id/allocate', permissions: [P.PAYMENT_ALLOCATE], status: 200, body: z.object({ customerId: zId }), handler: ({ s, user, params, body }) => s.payments.allocate(user, parseId(params.id), body.customerId) }),
  route({
    method: 'POST',
    path: '/payments/:id/reverse',
    permissions: [P.PAYMENT_ALLOCATE],
    status: 200,
    body: z.object({ reason: z.string().trim().min(5, 'Give the reason').max(300) }),
    handler: ({ s, user, params, body }) => s.payments.reverse(user, parseId(params.id), body.reason),
  }),

  // Safaricom Daraja C2B. Register https://<host>/api/v1/mpesa/c2b/<token>/validation and …/confirmation.
  route({ method: 'POST', path: '/mpesa/c2b/:token/validation', public: true, status: 200, handler: ({ s, params, body }) => s.payments.mpesaValidate(params.token, body) }),
  route({ method: 'POST', path: '/mpesa/c2b/:token/confirmation', public: true, status: 200, handler: ({ s, params, body }) => s.payments.mpesaConfirm(params.token, body) }),

  // Disconnections -----------------------------------------------------------------------------
  route({
    method: 'GET',
    path: '/disconnections',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ status: z.enum(DISCONNECTION_STATUSES).optional() }),
    handler: ({ s, user, query }) => s.disconnections.list(user, query.status),
  }),
  route({ method: 'POST', path: '/disconnections/generate', permissions: [P.DISCONNECTION_MANAGE], status: 200, body: z.object({ zoneId: zId.optional() }), handler: ({ s, user, body }) => s.disconnections.generate(user, body.zoneId) }),
  route({ method: 'POST', path: '/disconnections/notices', permissions: [P.DISCONNECTION_MANAGE], status: 200, body: z.object({ ids: z.array(zId).min(1).max(1000) }), handler: ({ s, user, body }) => s.disconnections.sendNotices(user, body.ids) }),
  route({
    method: 'POST',
    path: '/disconnections/:id/disconnect',
    permissions: [P.DISCONNECTION_MANAGE],
    status: 200,
    body: z.object({ meterReading: zDecimal.nullable().optional(), note: optionalText(300) }),
    handler: ({ s, user, params, body }) => s.disconnections.disconnect(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/disconnections/:id/cancel', permissions: [P.DISCONNECTION_MANAGE], status: 200, body: z.object({ note: optionalText(300) }), handler: ({ s, user, params, body }) => s.disconnections.cancel(user, parseId(params.id), body.note) }),
  route({
    method: 'POST',
    path: '/disconnections/:id/reconnect',
    permissions: [P.DISCONNECTION_MANAGE],
    status: 200,
    body: z.object({ waiveFee: z.boolean().optional(), note: optionalText(300) }),
    handler: ({ s, user, params, body }) => s.disconnections.reconnect(user, parseId(params.id), body),
  }),

  // Reports ------------------------------------------------------------------------------------
  route({ method: 'GET', path: '/reports/dashboard', permissions: [P.REPORTS_VIEW], query: z.object({ period: zPeriod }), handler: ({ s, user, query }) => s.reports.dashboard(user, query.period) }),
  route({ method: 'GET', path: '/reports/water-balance', permissions: [P.NRW_VIEW], query: z.object({ period: zPeriod }), handler: ({ s, user, query }) => s.reports.waterBalance(user, query.period) }),
  route({ method: 'GET', path: '/reports/ageing', permissions: [P.REPORTS_VIEW], handler: ({ s, user }) => s.reports.ageing(user) }),
  route({ method: 'GET', path: '/reports/billing-register', permissions: [P.REPORTS_VIEW], query: z.object({ period: zPeriod }), handler: ({ s, user, query }) => s.reports.billingRegisterCsv(user, query.period) }),
];
