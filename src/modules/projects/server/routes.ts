import { z } from 'zod';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { route } from './route';
import { DONOR_TYPES } from './schemas';

const text = (max: number) => z.string().trim().max(max);
const code = text(20).min(1).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only');
const Money = zDecimal.refine((v) => v.gte(0), 'Cannot be negative');

const GrantBody = z.object({
  donorId: zId,
  code,
  title: text(200).min(3),
  agreementRef: text(80).optional(),
  currency: text(3).min(3).default('KES'),
  amount: Money,
  startDate: zDate.nullable().optional(),
  endDate: zDate.nullable().optional(),
  fundCode: text(20).optional(),
  status: z.enum(['PIPELINE', 'ACTIVE', 'CLOSED']).default('ACTIVE'),
  conditions: text(5000).optional(),
  reportingFrequency: z.enum(['MONTHLY', 'QUARTERLY', 'BIANNUAL', 'ANNUAL']).default('QUARTERLY'),
  budgetLines: z.array(z.object({ code, name: text(150).min(2), amount: Money, accountPrefixes: z.array(text(20).min(1)).max(30).default([]) })).max(100).default([]),
});
const ProjectBody = z.object({
  code,
  name: text(200).min(3),
  description: text(5000).optional(),
  kind: z.enum(['CAPEX', 'OPEX', 'MIXED']).default('CAPEX'),
  financeCode: code,
  grantIds: z.array(zId).max(20).default([]),
  budget: Money,
  startDate: zDate.nullable().optional(),
  endDate: zDate.nullable().optional(),
  location: text(200).optional(),
  managerId: zId.nullable().optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).default('ACTIVE'),
});
const DonorBody = z.object({ name: text(200).min(2), type: z.enum(DONOR_TYPES).default('OTHER'), contactName: text(150).optional(), email: text(200).optional(), phone: text(20).optional(), active: z.boolean().optional() });

export const projectsRoutes = [
  route({ method: 'GET', path: '/dashboard', permissions: [P.VIEW], handler: ({ s, user }) => s.projects.dashboard(user) }),
  route({ method: 'GET', path: '/donors', permissions: [P.VIEW], handler: ({ s, user }) => s.projects.donors(user) }),
  route({ method: 'POST', path: '/donors', permissions: [P.MANAGE], body: DonorBody, handler: ({ s, user, body }) => s.projects.saveDonor(user, null, body) }),
  route({ method: 'PUT', path: '/donors/:id', permissions: [P.MANAGE], body: DonorBody, handler: ({ s, user, params, body }) => s.projects.saveDonor(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/donors/:id/portal', permissions: [P.MANAGE], status: 200, body: z.object({ enable: z.boolean() }), handler: ({ s, user, params, body }) => s.projects.donorPortalLink(user, parseId(params.id), body.enable) }),

  route({ method: 'GET', path: '/grants', permissions: [P.VIEW], handler: ({ s, user }) => s.projects.grants(user) }),
  route({ method: 'POST', path: '/grants', permissions: [P.MANAGE], body: GrantBody, handler: ({ s, user, body }) => s.projects.saveGrant(user, null, body) }),
  route({ method: 'GET', path: '/grants/:id', permissions: [P.VIEW], handler: ({ s, user, params }) => s.projects.grant(user, parseId(params.id)) }),
  route({ method: 'PUT', path: '/grants/:id', permissions: [P.MANAGE], body: GrantBody, handler: ({ s, user, params, body }) => s.projects.saveGrant(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/grants/:id/disbursements', permissions: [P.MANAGE], body: z.object({ date: zDate, amount: zDecimal.refine((v) => v.gt(0), 'Must be more than zero'), reference: text(80).optional(), note: text(500).optional() }), handler: ({ s, user, params, body }) => s.projects.disburse(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/grants/:id/transactions', permissions: [P.VIEW], query: z.object({ line: text(20).optional() }), handler: ({ s, user, params, query }) => s.projects.grantTransactions(user, parseId(params.id), query.line) }),
  route({ method: 'GET', path: '/grants/:id/report/:format', permissions: [P.VIEW], handler: ({ s, user, params }) => s.projects.donorReport(user, parseId(params.id), z.enum(['xls', 'pdf', 'doc', 'csv']).parse(params.format)) }),

  route({ method: 'GET', path: '/projects', permissions: [P.VIEW], handler: ({ s, user }) => s.projects.projects(user) }),
  route({ method: 'POST', path: '/projects', permissions: [P.MANAGE], body: ProjectBody, handler: ({ s, user, body }) => s.projects.saveProject(user, null, body) }),
  route({ method: 'GET', path: '/projects/:id', permissions: [P.VIEW], handler: ({ s, user, params }) => s.projects.project(user, parseId(params.id)) }),
  route({ method: 'PUT', path: '/projects/:id', permissions: [P.MANAGE], body: ProjectBody, handler: ({ s, user, params, body }) => s.projects.saveProject(user, parseId(params.id), body) }),
  route({
    method: 'PUT',
    path: '/projects/:id/milestones',
    permissions: [P.MANAGE],
    body: z.object({ milestones: z.array(z.object({ id: zId.optional(), name: text(200).min(2), due: zDate.nullable().optional(), weight: z.number().min(0).max(100).default(1), percentComplete: z.number().min(0).max(100).default(0), note: text(500).optional() })).max(100) }),
    handler: ({ s, user, params, body }) => s.projects.setMilestones(user, parseId(params.id), body.milestones),
  }),
  route({ method: 'POST', path: '/projects/:id/kpis', permissions: [P.MANAGE], status: 200, body: z.object({ kpiId: zId.optional(), name: text(150).min(2), unit: text(30).optional(), baseline: z.number().default(0), target: z.number(), direction: z.enum(['UP', 'DOWN']).default('UP') }), handler: ({ s, user, params, body }) => s.projects.saveKpi(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/projects/:id/kpis/:kpiId/record', permissions: [P.MANAGE], status: 200, body: z.object({ value: z.number(), note: text(500).optional() }), handler: ({ s, user, params, body }) => s.projects.recordKpi(user, parseId(params.id), parseId(params.kpiId), body) }),
  route({ method: 'POST', path: '/projects/:id/capitalise', permissions: [P.MANAGE], status: 200, body: z.object({ date: zDate, amount: zDecimal.refine((v) => v.gt(0), 'Must be more than zero'), assetRef: text(80).optional(), note: text(500).optional() }), handler: ({ s, user, params, body }) => s.projects.capitalise(user, parseId(params.id), body) }),

  // The donor's read-only portal, opened by the secret in their link.
  route({ method: 'GET', path: '/donor-portal/:token', public: true, rateLimit: 60, handler: ({ s, params }) => s.projects.donorPortal(params.token) }),
];
