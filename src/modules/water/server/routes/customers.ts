import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/water/manifest';
import { parseId, zBool, zDate, zDecimal, zId, zPage, zPhone } from '@/platform/common/validation';
import { CUSTOMER_CATEGORIES, CUSTOMER_STATUSES, METER_STATUSES, METER_TEST_RESULTS, METER_TYPES } from '@/modules/water/server/schemas';
import { csvResponse } from '@/platform/common/csv';
import { IMPORT_COLUMNS } from '../customers/import.service';
import { route } from '../route';

const optionalText = (max: number) => z.string().trim().max(max).optional();

const CustomerBody = z.object({
  name: z.string().trim().min(1).max(150),
  category: z.enum(CUSTOMER_CATEGORIES),
  idType: z.enum(['NATIONAL_ID', 'PASSPORT', 'ALIEN_ID', 'COMPANY_REG', 'OTHER']).optional(),
  idNumber: optionalText(30),
  kraPin: z.string().trim().regex(/^[AP]\d{9}[A-Z]$/i, 'A KRA PIN looks like A012345678Z').transform((v) => v.toUpperCase()).optional().or(z.literal('').transform(() => undefined)),
  phone: zPhone.optional().or(z.literal('').transform(() => undefined)),
  altPhone: zPhone.optional().or(z.literal('').transform(() => undefined)),
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  postalAddress: optionalText(200),
  zoneId: zId,
  location: optionalText(200),
  plotNo: optionalText(50),
  gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
  tariffId: zId,
  sewered: z.boolean().optional(),
  notes: optionalText(1000),
});

const MeterBody = z.object({
  serialNo: z.string().trim().min(1).max(40),
  make: optionalText(60),
  sizeMm: z.number().int().min(10).max(600).optional(),
  dials: z.number().int().min(3).max(9).optional(),
  type: z.enum(METER_TYPES).default('CUSTOMER'),
  zoneId: zId.nullable().optional(),
  initialReading: zDecimal.optional(),
  calibrationDue: zDate.nullable().optional(),
});

export const customerRoutes = [
  route({
    method: 'GET',
    path: '/customers',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ search: z.string().trim().max(100).optional(), zoneId: zId.optional(), status: z.enum(CUSTOMER_STATUSES).optional(), category: z.enum(CUSTOMER_CATEGORIES).optional(), inArrears: zBool.optional(), ...zPage }),
    handler: ({ s, user, query }) => s.customers.list(user, query),
  }),
  route({ method: 'GET', path: '/customers/import/template', permissions: [P.CUSTOMER_MANAGE], handler: () => csvResponse('customer-import-template.csv', [IMPORT_COLUMNS, ['ACC-0001', 'Jane Wanjiku', 'DOMESTIC', '0722000000', '', '12345678', '', 'KML', 'DOM', 'Plot 12', 'Kamelil', '1250.00', 'ACTIVE']]) }),
  route({
    method: 'POST',
    path: '/customers/import',
    permissions: [P.CUSTOMER_MANAGE],
    status: 200,
    body: z.object({ csv: z.string().min(10).max(20_000_000), commit: z.boolean().default(false) }),
    handler: ({ s, user, body }) => s.customerImport.run(user, body.csv, body.commit),
  }),
  route({ method: 'GET', path: '/customers/:id', permissions: [P.CUSTOMER_VIEW], handler: ({ s, user, params }) => s.customers.get(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/customers',
    permissions: [P.CUSTOMER_MANAGE],
    body: CustomerBody.extend({ openingBalance: zDecimal.optional(), status: z.enum(['APPLIED', 'ACTIVE']).optional() }),
    handler: ({ s, user, body }) => s.customers.create(user, body),
  }),
  route({ method: 'PATCH', path: '/customers/:id', permissions: [P.CUSTOMER_MANAGE], body: CustomerBody, handler: ({ s, user, params, body }) => s.customers.update(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/customers/:id/status',
    permissions: [P.CUSTOMER_MANAGE],
    status: 200,
    body: z.object({ status: z.enum(CUSTOMER_STATUSES), reason: optionalText(300) }),
    handler: ({ s, user, params, body }) => s.customers.changeStatus(user, parseId(params.id), body.status, body.reason),
  }),
  route({
    method: 'GET',
    path: '/customers/:id/statement',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ from: zDate.optional(), to: zDate.optional() }),
    handler: ({ s, user, params, query }) => s.customers.statementOf(user, parseId(params.id), query),
  }),

  route({
    method: 'GET',
    path: '/meters',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ search: z.string().trim().max(60).optional(), status: z.enum(METER_STATUSES).optional(), type: z.enum(METER_TYPES).optional(), zoneId: zId.optional(), ...zPage }),
    handler: ({ s, user, query }) => s.meters.list(user, query),
  }),
  route({ method: 'GET', path: '/meters/calibration-due', permissions: [P.CUSTOMER_VIEW], query: z.object({ by: zDate.optional() }), handler: ({ s, user, query }) => s.meters.calibrationDue(user, query.by) }),
  route({
    method: 'POST',
    path: '/meters/:id/tests',
    permissions: [P.METER_MANAGE],
    body: z.object({
      at: zDate,
      result: z.enum(METER_TEST_RESULTS),
      errorPercent: zDecimal.nullable().optional(),
      testFlow: optionalText(60),
      certificateNo: optionalText(60),
      testedBy: optionalText(120),
      nextCalibration: zDate.nullable().optional(),
      note: optionalText(300),
    }),
    handler: ({ s, user, params, body }) => s.meters.recordTest(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/meters/:id', permissions: [P.CUSTOMER_VIEW], handler: ({ s, user, params }) => s.meters.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/meters', permissions: [P.METER_MANAGE], body: MeterBody, handler: ({ s, user, body }) => s.meters.create(user, body) }),
  route({
    method: 'POST',
    path: '/meters/:id/install',
    permissions: [P.METER_MANAGE],
    status: 200,
    body: z.object({ customerId: zId, reading: zDecimal, date: zDate, oldMeterFinalReading: zDecimal.nullable().optional(), note: optionalText(300) }),
    handler: ({ s, user, params, body }) => s.meters.install(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/meters/:id/status',
    permissions: [P.METER_MANAGE],
    status: 200,
    body: z.object({ status: z.enum(['FAULTY', 'IN_STORE', 'SCRAPPED']), note: optionalText(300), calibrationDue: zDate.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.meters.setStatus(user, parseId(params.id), body),
  }),

  route({
    method: 'GET',
    path: '/adjustments',
    permissions: [P.CUSTOMER_VIEW],
    query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), customerId: zId.optional() }),
    handler: ({ s, user, query }) => s.adjustments.list(user, query),
  }),
  route({
    method: 'POST',
    path: '/adjustments',
    permissions: [P.ADJUSTMENT_CREATE],
    body: z.object({ customerId: zId, amount: zDecimal, reason: z.string().trim().min(5, 'Explain the adjustment').max(500), category: z.enum(['BILLING_ERROR', 'LEAK_ALLOWANCE', 'METER_FAULT', 'WAIVER', 'DEBIT_NOTE', 'OTHER']).default('OTHER') }),
    handler: ({ s, user, body }) => s.adjustments.request(user, body),
  }),
  route({
    method: 'POST',
    path: '/adjustments/:id/review',
    permissions: [P.ADJUSTMENT_APPROVE],
    status: 200,
    body: z.object({ approve: z.boolean(), note: optionalText(300) }),
    handler: ({ s, user, params, body }) => s.adjustments.review(user, parseId(params.id), body),
  }),
];
