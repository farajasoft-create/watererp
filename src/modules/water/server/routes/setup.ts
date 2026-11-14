import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/water/manifest';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { CUSTOMER_CATEGORIES } from '@/modules/water/server/schemas';
import { route } from '../route';

const ZoneBody = z.object({
  code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/, 'Letters and digits only'),
  name: z.string().trim().min(1).max(100),
  type: z.enum(['ZONE', 'DMA']).default('ZONE'),
  parentId: zId.nullable().optional(),
  active: z.boolean().optional(),
});

const TariffBody = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  category: z.enum(CUSTOMER_CATEGORIES),
  effectiveFrom: zDate,
  approvalReference: z.string().trim().max(100).optional(),
  blocks: z.array(z.object({ upTo: zDecimal.nullable(), rate: zDecimal, fixedAmount: zDecimal.nullable().optional() })).min(1).max(12),
  meterRent: zDecimal.default('0'),
  sewerPercent: zDecimal.default('0'),
  minimumCharge: zDecimal.default('0'),
  defaultEstimate: zDecimal.default('0'),
  active: z.boolean().optional(),
});

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const setupRoutes = [
  route({ method: 'GET', path: '/zones', handler: ({ s, user }) => s.masterData.listZones(user) }),
  route({ method: 'POST', path: '/zones', permissions: [P.ZONE_MANAGE], body: ZoneBody, handler: ({ s, user, body }) => s.masterData.saveZone(user, null, body) }),
  route({ method: 'PATCH', path: '/zones/:id', permissions: [P.ZONE_MANAGE], body: ZoneBody, handler: ({ s, user, params, body }) => s.masterData.saveZone(user, parseId(params.id), body) }),

  route({ method: 'GET', path: '/tariffs', handler: ({ s, user }) => s.masterData.listTariffs(user) }),
  route({ method: 'GET', path: '/tariffs/:id', handler: ({ s, user, params }) => s.masterData.getTariff(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/tariffs', permissions: [P.TARIFF_MANAGE], body: TariffBody, handler: ({ s, user, body }) => s.masterData.saveTariff(user, null, body) }),
  route({ method: 'PATCH', path: '/tariffs/:id', permissions: [P.TARIFF_MANAGE], body: TariffBody, handler: ({ s, user, params, body }) => s.masterData.saveTariff(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/tariffs/:id/calculate',
    status: 200,
    body: z.object({ units: zDecimal, sewered: z.boolean().default(false) }),
    handler: ({ s, user, params, body }) => s.billing.preview(user, { tariffId: parseId(params.id), ...body }),
  }),

  route({ method: 'GET', path: '/settings', permissions: [P.SETTINGS_MANAGE], handler: ({ s, user }) => s.settings.get(user) }),
  route({
    method: 'PATCH',
    path: '/settings/billing',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({
      licenceArea: optionalText(300),
      billing: z.object({
        dueDays: z.number().int().min(0).max(90),
        penaltyPercent: zDecimal,
        reconnectionFee: zDecimal,
        disconnectionMinArrears: zDecimal,
        disconnectionGraceDays: z.number().int().min(0).max(365),
        highFactor: z.number().min(1).max(20),
        lowFactor: z.number().min(0).max(1),
        paybill: optionalText(20),
        billFooter: optionalText(500),
        sendBillSms: z.boolean().default(false),
        emailBills: z.boolean().default(false),
        sendReceipts: z.boolean().default(false),
      }),
    }),
    handler: ({ s, user, body }) => s.settings.updateBilling(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/settings/mpesa',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ shortcode: z.string().trim().regex(/^\d{5,7}$/, 'A paybill number has 5 to 7 digits').optional(), rotateToken: z.boolean().optional() }),
    handler: ({ s, user, body }) => s.settings.updateMpesa(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/settings/regulatory',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ populationInArea: z.number().int().min(0).nullable().optional(), peoplePerConnection: z.number().min(1).max(30).default(5), peoplePerKiosk: z.number().int().min(1).max(5000).default(300), staffCount: z.number().int().min(0).nullable().optional() }),
    handler: ({ s, user, body }) => s.settings.updateRegulatory(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/settings/service',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({
      slaHours: z.record(z.number().min(1).max(24 * 60)).default({}),
      portalEnabled: z.boolean().default(true),
      autoCloseDays: z.number().int().min(1).max(60).default(7),
      reminderAfterDays: z.number().int().min(1).max(365).default(14),
      routing: z.array(z.object({ category: z.string().trim().max(30).nullable().default(null), zoneId: zId.nullable().default(null), assignTo: zId })).max(200).optional(),
    }),
    handler: ({ s, user, body }) => s.settings.updateService(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/settings/accounts',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ accounts: z.record(z.string()).default({}) }),
    handler: ({ s, user, body }) => s.settings.updateAccounts(user, body.accounts),
  }),
  route({ method: 'GET', path: '/accounting/status', permissions: [P.SETTINGS_MANAGE], handler: ({ s, user }) => s.accounting.status(user.organisationId) }),
  route({ method: 'POST', path: '/accounting/retry', permissions: [P.SETTINGS_MANAGE], status: 200, handler: ({ s, user }) => s.accounting.retryPending(user.organisationId) }),
];
