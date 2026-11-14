import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { CAREER_EVENT_KINDS } from '../schemas';
import { route } from '../route';

const JobGroupBody = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  rank: z.number().int().min(0).max(100).default(0),
  notches: z.array(zDecimal).max(60).default([]),
  allowances: z.array(z.object({ code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_]+$/), name: z.string().trim().min(1).max(100), amount: zDecimal, taxable: z.boolean().default(true) })).max(20).default([]),
  active: z.boolean().default(true),
});

const CareerBody = z.object({
  employeeId: zId,
  kind: z.enum(CAREER_EVENT_KINDS),
  effectiveDate: zDate,
  endDate: zDate.nullable().optional(),
  departmentId: zId.nullable().optional(),
  jobGroupId: zId.nullable().optional(),
  notch: z.number().int().min(1).max(60).nullable().optional(),
  jobTitle: z.string().trim().max(100).optional(),
  station: z.string().trim().max(100).optional(),
  basicSalary: zDecimal.nullable().optional(),
  actingAllowance: zDecimal.nullable().optional(),
  secondedTo: z.string().trim().max(200).optional(),
  reason: z.string().trim().min(3, 'Give the reason').max(500),
});

export const structureRoutes = [
  route({ method: 'GET', path: '/job-groups', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.structure.jobGroups(user) }),
  route({ method: 'POST', path: '/job-groups', permissions: [P.SETTINGS_MANAGE], body: JobGroupBody, handler: ({ s, user, body }) => s.structure.saveJobGroup(user, null, body) }),
  route({ method: 'PATCH', path: '/job-groups/:id', permissions: [P.SETTINGS_MANAGE], body: JobGroupBody, handler: ({ s, user, params, body }) => s.structure.saveJobGroup(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/establishment', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.structure.establishment(user) }),
  route({
    method: 'PUT',
    path: '/establishment',
    permissions: [P.SETTINGS_MANAGE],
    status: 200,
    body: z.object({ rows: z.array(z.object({ departmentId: zId, jobGroupId: zId, designation: z.string().trim().min(1).max(100), authorised: z.number().int().min(0).max(10000) })).max(2000) }),
    handler: ({ s, user, body }) => s.structure.saveEstablishment(user, body.rows),
  }),
  route({ method: 'GET', path: '/career-events', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.structure.pending(user) }),
  route({ method: 'GET', path: '/employees/:id/career', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user, params }) => s.structure.history(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/career-events', permissions: [P.EMPLOYEE_MANAGE], body: CareerBody, handler: ({ s, user, body }) => s.structure.request(user, body) }),
  route({
    method: 'POST',
    path: '/career-events/:id/decide',
    permissions: [P.CAREER_APPROVE],
    status: 200,
    body: z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.structure.decide(user, parseId(params.id), body.approve, body.note),
  }),
  route({ method: 'GET', path: '/increments/due', permissions: [P.EMPLOYEE_VIEW], query: z.object({ asOf: zDate }), handler: ({ s, user, query }) => s.structure.incrementsDue(user, query.asOf) }),
  route({
    method: 'POST',
    path: '/increments',
    permissions: [P.SALARY_MANAGE],
    body: z.object({ employeeIds: z.array(zId).min(1).max(2000), effectiveDate: zDate }),
    handler: ({ s, user, body }) => s.structure.requestIncrements(user, body),
  }),
  route({ method: 'GET', path: '/contracts/ending', permissions: [P.EMPLOYEE_VIEW], query: z.object({ days: z.coerce.number().int().min(0).max(366).default(60) }), handler: ({ s, user, query }) => s.structure.contractsEnding(user, query.days) }),
];
