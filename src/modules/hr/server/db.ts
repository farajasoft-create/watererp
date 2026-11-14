import { ClientSession, Connection, Types } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import { deductionSchemeSchema } from './payroll/schemes.service';
import { attendanceSettingsSchema, punchSchema } from './attendance/attendance.service';
import * as S from './schemas';

/** The HR module's collections, all prefixed hr_. */
export function hrModels(conn: Connection) {
  return {
    hrSettings: defineModel(conn, 'HrSettings', S.hrSettingsSchema, 'hr_settings'),
    punches: defineModel(conn, 'HrPunch', punchSchema, 'hr_punches'),
    attendanceSettings: defineModel(conn, 'HrAttendanceSettings', attendanceSettingsSchema, 'hr_attendance_settings'),
    rateSets: defineModel(conn, 'HrRateSet', S.rateSetSchema, 'hr_statutory_rates'),
    departments: defineModel(conn, 'HrDepartment', S.departmentSchema, 'hr_departments'),
    employees: defineModel(conn, 'HrEmployee', S.employeeSchema, 'hr_employees'),
    payItems: defineModel(conn, 'HrPayItem', S.payItemSchema, 'hr_pay_items'),
    payInputs: defineModel(conn, 'HrPayInput', S.payInputSchema, 'hr_pay_inputs'),
    payRuns: defineModel(conn, 'HrPayRun', S.payRunSchema, 'hr_pay_runs'),
    payslips: defineModel(conn, 'HrPayslip', S.payslipSchema, 'hr_payslips'),
    leaveTypes: defineModel(conn, 'HrLeaveType', S.leaveTypeSchema, 'hr_leave_types'),
    leaveAdjustments: defineModel(conn, 'HrLeaveAdjustment', S.leaveAdjustmentSchema, 'hr_leave_adjustments'),
    leaveRequests: defineModel(conn, 'HrLeaveRequest', S.leaveRequestSchema, 'hr_leave_requests'),
    jobGroups: defineModel(conn, 'HrJobGroup', S.jobGroupSchema, 'hr_job_groups'),
    deductionSchemes: defineModel(conn, 'HrDeductionScheme', deductionSchemeSchema, 'hr_deduction_schemes'),
    establishment: defineModel(conn, 'HrEstablishment', S.establishmentSchema, 'hr_establishment'),
    careerEvents: defineModel(conn, 'HrCareerEvent', S.careerEventSchema, 'hr_career_events'),
    vacancies: defineModel(conn, 'HrVacancy', S.vacancySchema, 'hr_vacancies'),
    applications: defineModel(conn, 'HrApplication', S.applicationSchema, 'hr_applications'),
    changeRequests: defineModel(conn, 'HrChangeRequest', S.changeRequestSchema, 'hr_change_requests'),
    cases: defineModel(conn, 'HrCase', S.caseSchema, 'hr_cases'),
    clearances: defineModel(conn, 'HrClearance', S.clearanceSchema, 'hr_clearances'),
    appraisalCycles: defineModel(conn, 'HrAppraisalCycle', S.appraisalCycleSchema, 'hr_appraisal_cycles'),
    appraisals: defineModel(conn, 'HrAppraisal', S.appraisalSchema, 'hr_appraisals'),
    trainings: defineModel(conn, 'HrTraining', S.trainingSchema, 'hr_trainings'),
    vehicles: defineModel(conn, 'HrVehicle', S.vehicleSchema, 'hr_vehicles'),
    drivers: defineModel(conn, 'HrDriver', S.driverSchema, 'hr_drivers'),
    trips: defineModel(conn, 'HrTrip', S.tripSchema, 'hr_trips'),
    fuel: defineModel(conn, 'HrFuel', S.fuelSchema, 'hr_fuel'),
    vehicleMaintenance: defineModel(conn, 'HrVehicleMaintenance', S.vehicleMaintenanceSchema, 'hr_vehicle_maintenance'),
    vehicleIncidents: defineModel(conn, 'HrVehicleIncident', S.vehicleIncidentSchema, 'hr_vehicle_incidents'),
    applicants: defineModel(conn, 'HrApplicant', S.applicantSchema, 'hr_applicants'),
    inductions: defineModel(conn, 'HrInduction', S.inductionSchema, 'hr_inductions'),
  };
}

export type HrModels = ReturnType<typeof hrModels>;
export type HrDb = Db & HrModels;

/** The organisation's HR settings, created with defaults on first use. */
export async function hrSettings(db: HrDb, organisationId: Types.ObjectId, session?: ClientSession) {
  const doc = await db.hrSettings.findOneAndUpdate({ organisationId }, { $setOnInsert: { organisationId } }, { upsert: true, new: true, session }).lean();
  return doc!;
}

export const fullName = (e: { firstName: string; lastName: string; otherNames?: string | null }) => [e.firstName, e.otherNames, e.lastName].filter(Boolean).join(' ');
