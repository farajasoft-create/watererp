import { Types } from 'mongoose';
import type { CoreServices } from '@/platform/container';
import { HrDb } from './db';
import { EmployeesService } from './employees/employees.service';
import { LeaveService } from './leave/leave.service';
import { PayrollService } from './payroll/payroll.service';
import { HrReportsService } from './reports/reports.service';
import { SelfService } from './self/self.service';
import { HrSettingsService } from './setup/settings.service';
import { StructureService } from './structure/structure.service';
import { RecruitmentService } from './recruitment/recruitment.service';
import { RelationsService } from './relations/relations.service';
import { PerformanceService } from './performance/performance.service';
import { FleetService } from './fleet/fleet.service';
import { PayrollExtrasService } from './reports/payroll-extras.service';
import { DeductionSchemesService } from './payroll/schemes.service';
import { AttendanceService } from './attendance/attendance.service';
import { ApplicantsService } from './recruitment/applicants.service';
import { InductionService } from './recruitment/induction.service';

/**
 * The HR module's services, built on the platform's audit, ledger and events. Other modules hear
 * about HR through events (hr.payroll.approved, hr.payroll.paid, hr.leave.approved).
 */
export function buildHrServices(db: HrDb, core: CoreServices) {
  const { audit, events, ledger, notifications } = core;
  const settings = new HrSettingsService(db, audit);
  const leave = new LeaveService(db, audit, settings, events);
  const payroll = new PayrollService(db, audit, settings, leave, ledger);
  const reports = new HrReportsService(db, leave);
  const employees = new EmployeesService(db, audit);
  const notify = async (organisationId: Types.ObjectId, userIds: Types.ObjectId[], n: { title: string; body?: string; link?: string }) => {
    if (userIds.length) await notifications.notify(organisationId, userIds, { ...n, module: 'hr' });
  };
  leave.notify = notify;
  const relations = new RelationsService(db, audit);
  relations.notify = notify;
  const performance = new PerformanceService(db, audit);
  performance.notify = notify;
  const fleet = new FleetService(db, audit);
  fleet.notify = notify;
  const applicants = new ApplicantsService(db, core.email, core.sms);
  const recruitment = new RecruitmentService(db, audit, employees);
  recruitment.tell = (org, to, subject, text, purpose, sourceId) => applicants.tell(org, to, subject, text, purpose, sourceId);
  const induction = new InductionService(db, audit);
  induction.alert = async (org, e, subject, text, sourceId) => {
    if (e.email || e.phone) await applicants.tell(org, { email: e.email ?? '', phone: e.phone ?? '' }, subject, text, 'hr:induction', sourceId);
    if (e.userId) await notify(org, [e.userId], { title: subject, body: text, link: '/hr/me' });
  };

  payroll.hooks = {
    async afterApproved(user, runId) {
      await payroll.postToLedger(user.organisationId, runId, 'approval');
      await events.emit(user.organisationId, 'hr.payroll.approved', { payRunId: runId });
    },
    async afterPaid(user, runId) {
      await payroll.postToLedger(user.organisationId, runId, 'payment');
      await events.emit(user.organisationId, 'hr.payroll.paid', { payRunId: runId });
    },
  };

  return {
    db,
    settings,
    employees,
    recruitment,
    applicants,
    induction,
    relations,
    performance,
    fleet,
    leave,
    payroll,
    reports,
    payrollExtras: new PayrollExtrasService(db),
    schemes: new DeductionSchemesService(db, core.audit),
    attendance: new AttendanceService(db, core.audit),
    structure: new StructureService(db, audit),
    self: new SelfService(db, payroll, leave, reports),
  };
}

export type HrServices = ReturnType<typeof buildHrServices>;
