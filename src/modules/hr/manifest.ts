import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  EMPLOYEE_VIEW: 'hr.employee.view',
  EMPLOYEE_MANAGE: 'hr.employee.manage',
  /** Salaries, bank details and pay items; without it employee records show no pay. */
  SALARY_VIEW: 'hr.salary.view',
  SALARY_MANAGE: 'hr.salary.manage',
  PAYROLL_RUN: 'hr.payroll.run',
  PAYROLL_APPROVE: 'hr.payroll.approve',
  PAYROLL_PAY: 'hr.payroll.pay',
  LEAVE_VIEW: 'hr.leave.view',
  LEAVE_APPROVE: 'hr.leave.approve',
  LEAVE_MANAGE: 'hr.leave.manage',
  REPORTS_VIEW: 'hr.reports.view',
  SETTINGS_MANAGE: 'hr.settings.manage',
  /** Approve promotions, transfers, acting appointments, salary changes and increments. */
  CAREER_APPROVE: 'hr.career.approve',
  /** Disciplinary cases and grievances (confidential). */
  CASES_MANAGE: 'hr.cases.manage',
  /** Fleet: see vehicles, bookings and reports. */
  FLEET_VIEW: 'hr.fleet.view',
  /** Approve transport requests from a department. */
  FLEET_APPROVE: 'hr.fleet.approve',
  /** Transport office: vehicles, drivers, allocation, work tickets, fuel, repairs, incidents. */
  FLEET_MANAGE: 'hr.fleet.manage',
  /** Attendance register; biometric terminals post clock events with a key holding this. */
  ATTENDANCE: 'hr.attendance',
  /** An employee's own payslips, P9 and leave. */
  SELF: 'hr.self',
} as const;

const P = PERMISSIONS;
const ALL = Object.values(P);

/** Approving one's own payroll or leave is blocked in the services, not only by role. */
export const hrManifest = defineManifest({
  key: 'hr',
  name: 'HR & Payroll',
  description: 'Employees, Kenyan statutory payroll (PAYE, NSSF, SHIF, housing levy), payslips, P9s, leave and staff self-service.',
  home: '/hr',
  permissions: P,
  roles: {
    HR_MANAGER: {
      label: 'HR manager',
      permissions: [P.EMPLOYEE_VIEW, P.EMPLOYEE_MANAGE, P.SALARY_VIEW, P.SALARY_MANAGE, P.PAYROLL_APPROVE, P.LEAVE_VIEW, P.LEAVE_APPROVE, P.LEAVE_MANAGE, P.REPORTS_VIEW, P.SETTINGS_MANAGE, P.CAREER_APPROVE, P.CASES_MANAGE, P.FLEET_VIEW, P.FLEET_APPROVE, P.ATTENDANCE, P.SELF],
    },
    PAYROLL_OFFICER: { label: 'Payroll officer', description: 'Prepares payroll; someone else approves it.', permissions: [P.EMPLOYEE_VIEW, P.SALARY_VIEW, P.SALARY_MANAGE, P.PAYROLL_RUN, P.LEAVE_VIEW, P.REPORTS_VIEW, P.SELF] },
    FINANCE: { label: 'Finance (approves and pays payroll)', permissions: [P.EMPLOYEE_VIEW, P.SALARY_VIEW, P.PAYROLL_APPROVE, P.PAYROLL_PAY, P.REPORTS_VIEW, P.SELF] },
    HR_OFFICER: { label: 'HR officer', permissions: [P.EMPLOYEE_VIEW, P.EMPLOYEE_MANAGE, P.LEAVE_VIEW, P.LEAVE_APPROVE, P.LEAVE_MANAGE, P.CASES_MANAGE, P.ATTENDANCE, P.SELF] },
    LINE_MANAGER: { label: 'Line manager', description: 'Approves leave and transport for the departments they are limited to.', permissions: [P.EMPLOYEE_VIEW, P.LEAVE_VIEW, P.LEAVE_APPROVE, P.FLEET_VIEW, P.FLEET_APPROVE, P.SELF] },
    TRANSPORT_OFFICER: { label: 'Transport officer', description: 'Runs the fleet: vehicles, drivers, allocation, work tickets, fuel, repairs and incidents.', permissions: [P.FLEET_VIEW, P.FLEET_MANAGE, P.SELF] },
    EMPLOYEE: { label: 'Employee (self-service)', description: 'Own payslips, P9 and leave only.', permissions: [P.SELF] },
    FULL: { label: 'Full access', permissions: ALL },
  },
  scope: { label: 'Departments (they see only these employees)', endpoint: '/hr/departments' },
  nav: [
    { href: '/hr', label: 'Dashboard', permission: P.REPORTS_VIEW },
    { href: '/hr/employees', label: 'Employees', permission: P.EMPLOYEE_VIEW },
    { href: '/hr/establishment', label: 'Establishment & careers', permission: P.EMPLOYEE_VIEW },
    { href: '/hr/recruitment', label: 'Recruitment', permission: P.EMPLOYEE_VIEW },
    { href: '/hr/induction', label: 'Induction', permission: P.EMPLOYEE_VIEW },
    { href: '/hr/relations', label: 'Staff relations & exits', permission: P.EMPLOYEE_VIEW },
    { href: '/hr/performance', label: 'Appraisal & training', permission: P.EMPLOYEE_VIEW },
    { href: '/hr/fleet', label: 'Transport & fleet', permission: P.FLEET_VIEW },
    { href: '/hr/payroll', label: 'Payroll', permission: P.SALARY_VIEW },
    { href: '/hr/leave', label: 'Leave', permission: P.LEAVE_VIEW },
    { href: '/hr/attendance', label: 'Attendance', permission: P.ATTENDANCE },
    { href: '/hr/reports', label: 'Statutory returns', permission: P.REPORTS_VIEW },
    { href: '/hr/settings', label: 'HR settings', permission: P.SETTINGS_MANAGE },
  ],
  links: [{ href: '/hr/me', label: 'My payslips & leave →', permission: P.SELF }],
});
