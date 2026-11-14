import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zBool, zDate, zDecimal, zId, zPage, zPeriod } from '@/platform/common/validation';
import { RETURN_TYPES } from '../reports/reports.service';
import { route } from '../route';
import { inFormat, zFileFormat } from '../reports/formats';
import { SCHEME_KINDS } from '../payroll/schemes.service';
import type { HrServices } from '../container';
import type { AuthUser } from '@/platform/auth';

const orgName = async (s: HrServices, user: AuthUser) => (await s.db.organisations.findById(user.organisationId, { name: 1 }).lean())?.name ?? '';

const Positive = zDecimal.refine((v) => v.gt(0), 'Must be more than zero');
const Entry = z.object({
  employeeId: zId,
  kind: z.enum(['EARNING', 'DEDUCTION']),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,24}$/, 'Letters, digits and _ only').optional(),
  name: z.string().trim().min(1).max(80),
  amount: Positive,
  taxable: z.boolean().default(true),
  payItemId: zId.optional(),
  leaveTypeId: zId.optional(),
  leaveDays: z.number().positive().max(366).optional(),
  leaveYear: z.number().int().min(2000).max(2100).optional(),
});

export const payrollRoutes = [
  route({ method: 'GET', path: '/payroll', permissions: [P.SALARY_VIEW], handler: ({ s, user }) => s.payroll.listRuns(user) }),
  route({
    method: 'GET',
    path: '/payroll/:id',
    permissions: [P.SALARY_VIEW],
    query: z.object({ search: z.string().trim().max(100).optional(), warnings: zBool.optional(), ...zPage }),
    handler: ({ s, user, params, query }) => s.payroll.getRun(user, parseId(params.id), query),
  }),
  route({
    method: 'POST',
    path: '/payroll',
    permissions: [P.PAYROLL_RUN],
    body: z.object({ period: zPeriod, payDate: zDate.nullable().optional(), kind: z.enum(['REGULAR', 'OFF_CYCLE', 'GROUP']).default('REGULAR'), title: z.string().trim().min(1).max(80).optional(), payGroup: z.enum(['BOARD', 'SECONDED']).optional() }),
    handler: ({ s, user, body }) => s.payroll.createRun(user, body),
  }),
  route({
    method: 'POST',
    path: '/payroll/:id/entries',
    permissions: [P.PAYROLL_RUN],
    status: 200,
    body: z.object({ rows: z.array(Entry).min(1).max(500) }),
    handler: ({ s, user, params, body }) => s.payroll.addEntries(user, parseId(params.id), body.rows),
  }),
  route({
    method: 'POST',
    path: '/payroll/:id/entries/many',
    permissions: [P.PAYROLL_RUN],
    status: 200,
    body: z.object({ departmentId: zId.nullable().optional(), name: z.string().trim().min(1).max(80), amount: Positive.optional(), percentOfBasic: z.number().positive().max(1000).optional(), taxable: z.boolean().default(true) }),
    handler: ({ s, user, params, body }) => s.payroll.addToMany(user, parseId(params.id), body),
  }),
  route({ method: 'DELETE', path: '/payroll/:id/entries/:entryId', permissions: [P.PAYROLL_RUN], handler: ({ s, user, params }) => s.payroll.removeEntry(user, parseId(params.id), parseId(params.entryId)) }),
  route({ method: 'GET', path: '/final-dues/:employeeId', permissions: [P.SALARY_VIEW, P.PAYROLL_RUN], handler: ({ s, user, params }) => s.payroll.finalDues(user, parseId(params.employeeId)) }),
  route({ method: 'POST', path: '/payroll/:id/recalculate', permissions: [P.PAYROLL_RUN], status: 200, handler: ({ s, user, params }) => s.payroll.recalculate(user, parseId(params.id)) }),
  route({
    method: 'PUT',
    path: '/payroll/:id/units',
    permissions: [P.PAYROLL_RUN],
    body: z.object({ rows: z.array(z.object({ employeeId: zId, units: z.number().min(0).max(744) })).max(5000) }),
    handler: ({ s, user, params, body }) => s.payroll.setUnits(user, parseId(params.id), body.rows),
  }),
  route({ method: 'POST', path: '/payroll/:id/cancel', permissions: [P.PAYROLL_RUN], status: 200, handler: ({ s, user, params }) => s.payroll.cancelRun(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/payroll/:id/approve', permissions: [P.PAYROLL_APPROVE], status: 200, handler: ({ s, user, params }) => s.payroll.approveRun(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/payroll/:id/paid',
    permissions: [P.PAYROLL_PAY],
    status: 200,
    body: z.object({ paidAt: zDate, reference: z.string().trim().max(100).optional() }),
    handler: ({ s, user, params, body }) => s.payroll.markPaid(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/payroll/:id/register', permissions: [P.SALARY_VIEW], query: z.object({ format: zFileFormat.default('csv') }), handler: async ({ s, user, params, query }) => inFormat(s.reports.registerCsv(user, parseId(params.id)), query.format, 'Payroll register', await orgName(s, user)) }),
  route({
    method: 'GET',
    path: '/payroll/:id/changes',
    permissions: [P.SALARY_VIEW],
    query: z.object({ format: z.enum(['json', 'csv', 'xls', 'doc', 'pdf']).default('json') }),
    handler: async ({ s, user, params, query }) => (query.format === 'json' ? s.payrollExtras.changeAdvice(user, parseId(params.id)) : inFormat(s.payrollExtras.changeAdviceCsv(user, parseId(params.id)), query.format, 'Pay change advice', await orgName(s, user))),
  }),
  route({
    method: 'GET',
    path: '/payroll/:id/pension',
    permissions: [P.SALARY_VIEW],
    query: z.object({ format: z.enum(['json', 'csv', 'xls', 'doc', 'pdf']).default('json'), scheme: z.string().trim().max(80).optional() }),
    handler: async ({ s, user, params, query }) => (query.format === 'json' ? s.payrollExtras.pensionSchedule(user, parseId(params.id)) : inFormat(s.payrollExtras.pensionScheduleCsv(user, parseId(params.id), query.scheme), query.format, 'Pension schedule', await orgName(s, user))),
  }),
  route({
    method: 'GET',
    path: '/payroll-audit',
    permissions: [P.SALARY_VIEW, P.REPORTS_VIEW],
    query: z.object({ from: zDate, to: zDate, employeeId: zId.optional(), format: z.enum(['json', 'csv', 'xls', 'doc', 'pdf']).default('json') }),
    handler: async ({ s, user, query }) => (query.format === 'json' ? s.payrollExtras.auditTrail(user, query) : inFormat(s.payrollExtras.auditTrailCsv(user, query), query.format, 'Payroll audit trail', await orgName(s, user))),
  }),
  route({
    method: 'GET',
    path: '/gratuity',
    permissions: [P.SALARY_VIEW],
    query: z.object({ format: z.enum(['json', 'csv', 'xls', 'doc', 'pdf']).default('json') }),
    handler: async ({ s, user, query }) => (query.format === 'json' ? s.payrollExtras.gratuity(user) : inFormat(s.payrollExtras.gratuityCsv(user), query.format, 'Gratuity', await orgName(s, user))),
  }),
  route({ method: 'GET', path: '/payslips/:id', permissions: [P.SALARY_VIEW], handler: ({ s, user, params }) => s.payroll.getPayslip(user, parseId(params.id)) }),

  // Deduction schemes: pension schemes, unions, SACCOs, welfare funds, insurers, with their own rates.
  route({ method: 'GET', path: '/deduction-schemes', permissions: [P.SALARY_VIEW], handler: ({ s, user }) => s.schemes.list(user) }),
  ...(['POST', 'PUT'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/deduction-schemes' : '/deduction-schemes/:id',
      permissions: [P.SETTINGS_MANAGE],
      body: z.object({
        code: z.string().trim().min(2).max(12).regex(/^[A-Za-z0-9_]+$/, 'Letters, digits and _ only'),
        name: z.string().trim().min(2).max(100),
        kind: z.enum(SCHEME_KINDS),
        employeeRate: z.number().min(0).max(100).nullable().optional(),
        employeeAmount: zDecimal.nullable().optional(),
        minimum: zDecimal.nullable().optional(),
        maximum: zDecimal.nullable().optional(),
        employerRate: z.number().min(0).max(100).nullable().optional(),
        employerAmount: zDecimal.nullable().optional(),
        payee: z.string().trim().max(150).optional(),
        payeeAccount: z.string().trim().max(60).optional(),
        active: z.boolean().optional(),
      }),
      handler: ({ s, user, params, body }) => s.schemes.save(user, method === 'POST' ? null : parseId(params.id), body),
    }),
  ),
  route({ method: 'GET', path: '/deduction-schemes/:id/members', permissions: [P.SALARY_VIEW], handler: ({ s, user, params }) => s.schemes.members(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/deduction-schemes/:id/members', permissions: [P.SALARY_MANAGE], body: z.object({ employeeId: zId, memberNo: z.string().trim().max(40).optional(), fromPeriod: zPeriod }), handler: ({ s, user, params, body }) => s.schemes.enrol(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/deduction-schemes/members/:payItemId/leave', permissions: [P.SALARY_MANAGE], status: 200, body: z.object({ lastPeriod: zPeriod }), handler: ({ s, user, params, body }) => s.schemes.leave(user, parseId(params.payItemId), body.lastPeriod) }),

  route({ method: 'GET', path: '/returns', permissions: [P.REPORTS_VIEW, P.SALARY_VIEW], query: z.object({ period: zPeriod }), handler: ({ s, user, query }) => s.reports.statutory(user, query.period) }),
  route({
    method: 'GET',
    path: '/returns/csv',
    permissions: [P.REPORTS_VIEW, P.SALARY_VIEW],
    query: z.object({ period: zPeriod, type: z.enum(RETURN_TYPES), format: zFileFormat.default('csv') }),
    handler: async ({ s, user, query }) => inFormat(s.reports.returnCsv(user, query.period, query.type), query.format, `${query.type} return ${query.period}`, await orgName(s, user)),
  }),
];
