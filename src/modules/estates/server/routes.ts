import { z } from 'zod';
import { parseId, zDate, zDecimal, zId, zPeriod } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { route } from './route';

const text = (max: number) => z.string().trim().max(max);
const code = text(20).min(1).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only');
const Money = zDecimal.refine((v) => v.gte(0), 'Cannot be negative');
const Positive = zDecimal.refine((v) => v.gt(0), 'Must be more than zero');
const CATEGORY = z.enum(['PLUMBING', 'ELECTRICAL', 'STRUCTURAL', 'SECURITY', 'CLEANING', 'OTHER']);
const PRIORITY = z.enum(['LOW', 'NORMAL', 'URGENT']);

const PropertyBody = z.object({
  code,
  name: text(150).min(2),
  location: text(200).optional(),
  kind: z.enum(['RESIDENTIAL', 'COMMERCIAL', 'LAND', 'MIXED']).default('COMMERCIAL'),
  units: z.array(z.object({ id: zId.optional(), code, description: text(200).optional(), sizeSqm: z.number().min(0).max(1_000_000).nullable().optional(), marketRent: Money, active: z.boolean().optional() })).max(500),
});
const TenantBody = z.object({ name: text(200).min(2), kind: z.enum(['INDIVIDUAL', 'COMPANY']).default('INDIVIDUAL'), idNumber: text(30).optional(), kraPin: text(20).optional(), phone: text(20).optional(), email: text(200).optional() });

export const estatesRoutes = [
  route({ method: 'GET', path: '/properties', permissions: [P.VIEW], handler: ({ s, user }) => s.estates.properties(user) }),
  route({ method: 'POST', path: '/properties', permissions: [P.MANAGE], body: PropertyBody, handler: ({ s, user, body }) => s.estates.saveProperty(user, null, body) }),
  route({ method: 'PUT', path: '/properties/:id', permissions: [P.MANAGE], body: PropertyBody, handler: ({ s, user, params, body }) => s.estates.saveProperty(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/tenants', permissions: [P.VIEW], handler: ({ s, user }) => s.estates.tenants(user) }),
  route({ method: 'POST', path: '/tenants', permissions: [P.MANAGE], body: TenantBody, handler: ({ s, user, body }) => s.estates.saveTenant(user, null, body) }),
  route({ method: 'PUT', path: '/tenants/:id', permissions: [P.MANAGE], body: TenantBody, handler: ({ s, user, params, body }) => s.estates.saveTenant(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenants/:id/portal', permissions: [P.MANAGE], status: 200, handler: ({ s, user, params }) => s.estates.portalLink(user, parseId(params.id)) }),

  route({ method: 'GET', path: '/rent-roll', permissions: [P.VIEW], query: z.object({ format: z.enum(['json', 'csv']).default('json') }), handler: ({ s, user, query }) => (query.format === 'csv' ? s.estates.rentRollCsv(user) : s.estates.rentRoll(user)) }),
  route({
    method: 'POST',
    path: '/leases',
    permissions: [P.MANAGE],
    body: z.object({ tenantId: zId, propertyId: zId, unitId: zId, startDate: zDate, endDate: zDate, rent: Positive, serviceCharge: Money.default('0'), escalationPct: z.number().min(0).max(100).default(0), dueDay: z.number().int().min(1).max(28).default(5), deposit: Money.default('0') }),
    handler: ({ s, user, body }) => s.estates.createLease(user, body),
  }),
  route({ method: 'GET', path: '/leases/:id', permissions: [P.VIEW], handler: ({ s, user, params }) => s.estates.lease(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/leases/:id/receive', permissions: [P.MANAGE], status: 200, body: z.object({ date: zDate, amount: Positive, reference: text(80).optional(), kind: z.enum(['RENT', 'DEPOSIT']).default('RENT') }), handler: ({ s, user, params, body }) => s.estates.receive(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/leases/:id/adjust', permissions: [P.MANAGE], status: 200, body: z.object({ amount: zDecimal, description: text(300).min(3), kind: z.enum(['ADJUSTMENT', 'PENALTY']).default('ADJUSTMENT') }), handler: ({ s, user, params, body }) => s.estates.adjust(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/leases/:id/end', permissions: [P.MANAGE], status: 200, body: z.object({ date: zDate, reason: text(300).optional(), refundReference: text(80).optional(), deductions: Money.optional() }), handler: ({ s, user, params, body }) => s.estates.end(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/rent/bill', permissions: [P.MANAGE], status: 200, body: z.object({ period: zPeriod }), handler: ({ s, user, body }) => s.estates.billRent(user, body.period) }),

  route({ method: 'GET', path: '/maintenance', permissions: [P.VIEW], query: z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional() }), handler: ({ s, user, query }) => s.estates.maintenanceList(user, query.status) }),
  route({ method: 'POST', path: '/maintenance', permissions: [P.MAINTAIN], body: z.object({ propertyId: zId, unitId: zId.nullable().optional(), category: CATEGORY.default('OTHER'), description: text(2000).min(3), priority: PRIORITY.default('NORMAL') }), handler: ({ s, user, body }) => s.estates.createMaintenance(user, body) }),
  route({ method: 'PATCH', path: '/maintenance/:id', permissions: [P.MAINTAIN], body: z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']), assignedTo: zId.nullable().optional(), resolution: text(2000).optional(), cost: Money.optional() }), handler: ({ s, user, params, body }) => s.estates.updateMaintenance(user, parseId(params.id), body) }),

  // The tenant portal, opened by the secret in the tenant's link.
  route({ method: 'GET', path: '/tenant-portal/:token', public: true, rateLimit: 60, handler: ({ s, params }) => s.estates.portal(params.token) }),
  route({ method: 'POST', path: '/tenant-portal/:token/requests', public: true, rateLimit: 10, body: z.object({ leaseId: zId, category: CATEGORY.default('OTHER'), description: text(2000).min(5), priority: PRIORITY.default('NORMAL') }), handler: ({ s, params, body }) => s.estates.portalRequest(params.token, body) }),
];
