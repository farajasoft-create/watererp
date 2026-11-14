import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { route } from '../route';

const RateSetBody = z.object({
  effectiveFrom: zDate,
  reference: z.string().trim().max(200).optional(),
  paye: z.object({ bands: z.array(z.object({ upTo: zDecimal.nullable(), rate: zDecimal })).min(1).max(12), personalRelief: zDecimal }),
  nssf: z.object({ rate: zDecimal, lowerLimit: zDecimal, upperLimit: zDecimal }),
  shif: z.object({ rate: zDecimal, minimum: zDecimal }),
  ahl: z.object({ employeeRate: zDecimal, employerRate: zDecimal }),
  nitaPerEmployee: zDecimal,
  pensionReliefCap: zDecimal,
});

const DepartmentBody = z.object({
  code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/, 'Letters and digits only'),
  name: z.string().trim().min(1).max(100),
  level: z.enum(['DIRECTORATE', 'DEPARTMENT', 'DIVISION', 'SECTION', 'SERVICE_UNIT']).default('DEPARTMENT'),
  parentId: zId.nullable().optional(),
  headId: zId.nullable().optional(),
  active: z.boolean().default(true),
});

const LeaveTypeBody = z.object({
  code: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/, 'Letters and digits only'),
  name: z.string().trim().min(1).max(60),
  paid: z.boolean(),
  daysPerYear: z.number().min(0).max(366),
  accrual: z.enum(['MONTHLY', 'ANNUAL']),
  carryForwardMax: z.number().min(0).max(366).default(0),
  gender: z.enum(['MALE', 'FEMALE']).nullable().optional(),
  unlimited: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const setupRoutes = [
  route({ method: 'GET', path: '/dashboard', permissions: [P.REPORTS_VIEW], handler: ({ s, user }) => s.reports.dashboard(user) }),

  route({ method: 'GET', path: '/settings', permissions: [P.SETTINGS_MANAGE], handler: ({ s, user }) => s.settings.get(user) }),
  route({
    method: 'PATCH',
    path: '/settings/general',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({
      employeeNoPrefix: z.string().trim().min(1).max(8).regex(/^[A-Za-z0-9]+$/, 'Letters and digits only'),
      holidays: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(1).max(80) })).max(200),
    }),
    handler: ({ s, user, body }) => s.settings.updateGeneral(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/settings/accounts',
    permissions: [P.SETTINGS_MANAGE],
    body: z.object({ accounts: z.record(z.string(), z.string().max(24)) }),
    handler: ({ s, user, body }) => s.settings.updateAccounts(user, body.accounts),
  }),
  route({ method: 'POST', path: '/accounting/retry', permissions: [P.SETTINGS_MANAGE], status: 200, handler: ({ s, user }) => s.payroll.retryLedger(user) }),

  route({ method: 'GET', path: '/rates', permissions: [P.SALARY_VIEW], handler: ({ s, user }) => s.settings.listRateSets(user) }),
  route({ method: 'POST', path: '/rates', permissions: [P.SETTINGS_MANAGE], body: RateSetBody, handler: ({ s, user, body }) => s.settings.saveRateSet(user, null, body) }),
  route({ method: 'PUT', path: '/rates/:id', permissions: [P.SETTINGS_MANAGE], body: RateSetBody, handler: ({ s, user, params, body }) => s.settings.saveRateSet(user, parseId(params.id), body) }),
  route({ method: 'DELETE', path: '/rates/:id', permissions: [P.SETTINGS_MANAGE], handler: ({ s, user, params }) => s.settings.deleteRateSet(user, parseId(params.id)) }),

  /** Also feeds the department picker on the platform's user screen (HR scope). */
  route({ method: 'GET', path: '/departments', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user }) => s.settings.listDepartments(user) }),
  route({ method: 'POST', path: '/departments', permissions: [P.SETTINGS_MANAGE], body: DepartmentBody, handler: ({ s, user, body }) => s.settings.saveDepartment(user, null, body) }),
  route({ method: 'PUT', path: '/departments/:id', permissions: [P.SETTINGS_MANAGE], body: DepartmentBody, handler: ({ s, user, params, body }) => s.settings.saveDepartment(user, parseId(params.id), body) }),

  route({ method: 'GET', path: '/leave-types', permissions: [P.LEAVE_VIEW], handler: ({ s, user }) => s.settings.listLeaveTypes(user) }),
  route({ method: 'POST', path: '/leave-types', permissions: [P.LEAVE_MANAGE], body: LeaveTypeBody, handler: ({ s, user, body }) => s.settings.saveLeaveType(user, null, body) }),
  route({ method: 'PUT', path: '/leave-types/:id', permissions: [P.LEAVE_MANAGE], body: LeaveTypeBody, handler: ({ s, user, params, body }) => s.settings.saveLeaveType(user, parseId(params.id), body) }),
];
