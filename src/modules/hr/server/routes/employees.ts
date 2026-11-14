import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, parseWith, zBool, zDate, zDecimal, zId, zPage, zPeriod, zPhone } from '@/platform/common/validation';
import { EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, PAY_GROUPS, PAY_ITEM_KINDS, PAY_METHODS, PAY_TYPES, TERMINATION_REASONS } from '../schemas';
import { route } from '../route';
import { exportEmployees } from '../reports/employee-export';
import { zFileFormat } from '../reports/formats';

const optionalText = (max: number) => z.string().trim().max(max).optional();
const blank = <T extends z.ZodTypeAny>(schema: T) => schema.optional().or(z.literal('').transform(() => undefined));

const EmployeeBody = z.object({
  employeeNo: blank(z.string().trim().max(20)),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  otherNames: optionalText(60),
  gender: z.enum(['MALE', 'FEMALE']).nullable().optional(),
  dateOfBirth: zDate.nullable().optional(),
  nationalId: blank(z.string().trim().max(20)),
  kraPin: blank(
    z
      .string()
      .trim()
      .regex(/^[AP]\d{9}[A-Z]$/i, 'A KRA PIN looks like A012345678Z')
      .transform((v) => v.toUpperCase()),
  ),
  nssfNo: optionalText(20),
  shaNo: optionalText(20),
  phone: blank(zPhone),
  email: blank(z.string().trim().toLowerCase().email()),
  address: optionalText(200),
  departmentId: zId.nullable().optional(),
  jobTitle: optionalText(100),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('PERMANENT'),
  hireDate: zDate,
  probationEndDate: zDate.nullable().optional(),
  contractEndDate: zDate.nullable().optional(),
  managerId: zId.nullable().optional(),
  nextOfKin: z.object({ name: optionalText(100), phone: optionalText(20), relationship: optionalText(40) }).optional(),
  station: optionalText(100),
  payGroup: z.enum(PAY_GROUPS).optional(),
  qualifications: z.array(z.object({ level: z.string().trim().min(1).max(60), title: z.string().trim().min(1).max(200), institution: optionalText(200), year: z.number().int().min(1950).max(2100).nullable().optional() })).max(30).optional(),
  dependants: z.array(z.object({ name: z.string().trim().min(1).max(120), relationship: z.string().trim().min(1).max(40), dateOfBirth: zDate.nullable().optional() })).max(30).optional(),
});

const PayBody = z.object({
  jobGroupId: zId.nullable().optional(),
  notch: z.number().int().min(1).max(60).nullable().optional(),
  gratuityRate: z.number().min(0).max(50).optional(),
  basicSalary: zDecimal.default('0'),
  payType: z.enum(PAY_TYPES).default('MONTHLY'),
  rate: zDecimal.optional(),
  payMethod: z.enum(PAY_METHODS),
  bank: z.object({ name: optionalText(80), branch: optionalText(80), accountNo: optionalText(40), accountName: optionalText(100) }).optional(),
  mpesaPhone: blank(zPhone),
  exempt: z.object({ paye: z.boolean(), nssf: z.boolean(), shif: z.boolean(), ahl: z.boolean() }).default({ paye: false, nssf: false, shif: false, ahl: false }),
});

const PayItemBody = z.object({
  kind: z.enum(PAY_ITEM_KINDS),
  code: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9_]+$/, 'Letters, digits and _ only'),
  name: z.string().trim().min(1).max(60),
  amount: zDecimal,
  taxable: z.boolean().default(true),
  pension: z.boolean().default(false),
  insurance: z.boolean().default(false),
  employerAmount: zDecimal.nullable().optional(),
  employerRate: z.number().min(0).max(100).nullable().optional(),
  memberNo: z.string().trim().max(40).nullable().optional(),
  balance: zDecimal.nullable().optional(),
  fromPeriod: zPeriod,
  toPeriod: zPeriod.nullable().optional(),
});

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const When = z.string().datetime({ offset: true }).transform((v) => new Date(v));

export const employeeRoutes = [
  // Attendance from biometric terminals (fingerprint, face, card): devices post clock events with an API key.
  route({ method: 'GET', path: '/attendance/settings', permissions: [P.ATTENDANCE], handler: ({ s, user }) => s.attendance.settings(user) }),
  route({ method: 'PUT', path: '/attendance/settings', permissions: [P.SETTINGS_MANAGE], body: z.object({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), graceMinutes: z.number().int().min(0).max(120), workSaturday: z.boolean() }), handler: ({ s, user, body }) => s.attendance.saveSettings(user, body) }),
  route({ method: 'POST', path: '/attendance/punches', permissions: [P.ATTENDANCE], status: 200, body: z.object({ device: z.string().trim().min(1).max(60), punches: z.array(z.object({ employeeNo: z.string().trim().min(1).max(30), at: When, method: z.enum(['FINGERPRINT', 'FACE', 'CARD', 'PIN']).optional() })).min(1).max(20_000) }), handler: ({ s, user, body }) => s.attendance.punches(user, body) }),
  route({ method: 'GET', path: '/attendance/day', permissions: [P.ATTENDANCE], query: z.object({ date: Day, departmentId: zId.optional() }), handler: ({ s, user, query }) => s.attendance.day(user, query.date, query.departmentId) }),
  route({ method: 'GET', path: '/attendance/summary', permissions: [P.ATTENDANCE], query: z.object({ from: Day, to: Day, departmentId: zId.optional(), csv: zBool.optional() }), handler: ({ s, user, query }) => (query.csv ? s.attendance.summaryCsv(user, query) : s.attendance.summary(user, query)) }),
  route({
    method: 'GET',
    path: '/employees',
    permissions: [P.EMPLOYEE_VIEW],
    query: z.object({ search: z.string().trim().max(100).optional(), departmentId: zId.optional(), status: z.enum(EMPLOYEE_STATUSES).optional(), ...zPage }),
    handler: ({ s, user, query }) => s.employees.list(user, query),
  }),
  route({
    method: 'GET',
    path: '/employees/export/:format',
    permissions: [P.EMPLOYEE_VIEW],
    query: z.object({ departmentId: zId.optional(), status: z.enum(EMPLOYEE_STATUSES).optional() }),
    handler: ({ s, user, params, query }) => exportEmployees(s.db, user, query, parseWith(zFileFormat, params.format)),
  }),
  route({ method: 'GET', path: '/employees/options', permissions: [P.EMPLOYEE_VIEW], query: z.object({ leavers: zBool.optional() }), handler: ({ s, user, query }) => s.employees.options(user, query.leavers) }),
  route({ method: 'GET', path: '/employees/:id', permissions: [P.EMPLOYEE_VIEW], handler: ({ s, user, params }) => s.employees.get(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/employees',
    permissions: [P.EMPLOYEE_MANAGE],
    body: EmployeeBody.extend({ pay: PayBody.optional() }),
    handler: ({ s, user, body }) => {
      const { pay, ...employee } = body;
      return s.employees.create(user, employee, pay);
    },
  }),
  route({ method: 'PATCH', path: '/employees/:id', permissions: [P.EMPLOYEE_MANAGE], body: EmployeeBody, handler: ({ s, user, params, body }) => s.employees.update(user, parseId(params.id), body) }),
  route({ method: 'PATCH', path: '/employees/:id/pay', permissions: [P.SALARY_MANAGE], body: PayBody, handler: ({ s, user, params, body }) => s.employees.updatePay(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/employees/:id/terminate',
    permissions: [P.EMPLOYEE_MANAGE],
    status: 200,
    body: z.object({ date: zDate, reason: z.enum(TERMINATION_REASONS), note: optionalText(500) }),
    handler: ({ s, user, params, body }) => s.employees.terminate(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/employees/:id/suspend',
    permissions: [P.EMPLOYEE_MANAGE],
    status: 200,
    body: z.object({ note: z.string().trim().min(1).max(500) }),
    handler: ({ s, user, params, body }) => s.employees.suspend(user, parseId(params.id), body.note),
  }),
  route({
    method: 'POST',
    path: '/employees/:id/reinstate',
    permissions: [P.EMPLOYEE_MANAGE],
    status: 200,
    body: z.object({ hireDate: zDate }),
    handler: ({ s, user, params, body }) => s.employees.reinstate(user, parseId(params.id), body.hireDate),
  }),
  route({
    method: 'POST',
    path: '/employees/:id/portal',
    permissions: [P.EMPLOYEE_MANAGE],
    status: 200,
    body: z.object({ password: z.string().min(10, 'Use at least 10 characters').max(200).optional() }),
    handler: ({ s, user, params, body }) => s.employees.grantPortal(user, parseId(params.id), body.password),
  }),
  route({
    method: 'GET',
    path: '/employees/:id/pay-preview',
    permissions: [P.SALARY_VIEW],
    query: z.object({ period: zPeriod }),
    handler: ({ s, user, params, query }) => s.payroll.preview(user, parseId(params.id), query.period),
  }),
  route({
    method: 'GET',
    path: '/employees/:id/leave',
    permissions: [P.LEAVE_VIEW],
    query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
    handler: ({ s, user, params, query }) => s.leave.employeeBalances(user, parseId(params.id), query.year),
  }),
  route({
    method: 'GET',
    path: '/employees/:id/p9',
    permissions: [P.SALARY_VIEW],
    query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
    handler: ({ s, user, params, query }) => s.reports.p9(user.organisationId, parseId(params.id), query.year, user),
  }),
  route({ method: 'POST', path: '/employees/:id/pay-items', permissions: [P.SALARY_MANAGE], body: PayItemBody, handler: ({ s, user, params, body }) => s.employees.addPayItem(user, parseId(params.id), body) }),
  route({
    method: 'PUT',
    path: '/pay-items/:id',
    permissions: [P.SALARY_MANAGE],
    body: PayItemBody.extend({ active: z.boolean() }),
    handler: ({ s, user, params, body }) => s.employees.updatePayItem(user, parseId(params.id), body),
  }),
];
