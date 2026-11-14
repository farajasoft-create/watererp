import { InferSchemaType, Schema, Types } from 'mongoose';
import { ledgerSyncSchema } from '@/platform/schemas';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;

export const EMPLOYMENT_TYPES = ['PERMANENT', 'CONTRACT', 'CASUAL', 'INTERN'] as const;
export const EMPLOYEE_STATUSES = ['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export const PAY_METHODS = ['BANK', 'MPESA', 'CASH'] as const;
/** Monthly salary, or a rate for each day or hour worked (casual and part-time staff). */
export const PAY_TYPES = ['MONTHLY', 'DAILY', 'HOURLY'] as const;
export const PAY_ITEM_KINDS = ['EARNING', 'DEDUCTION'] as const;
export const PAY_RUN_STATUSES = ['DRAFT', 'APPROVED', 'PAID', 'CANCELLED'] as const;
/** The month's payroll, or an extra one in the month: a bonus, arrears, someone's final dues. */
export const PAY_RUN_KINDS = ['REGULAR', 'OFF_CYCLE', 'GROUP'] as const;
/** Board members and seconded staff are paid on their own payroll each month; staff and casuals on the regular one. */
export const PAY_GROUPS = ['STAFF', 'BOARD', 'SECONDED'] as const;
export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export const TERMINATION_REASONS = ['RESIGNATION', 'END_OF_CONTRACT', 'DISMISSAL', 'REDUNDANCY', 'RETIREMENT', 'DEATH', 'OTHER'] as const;

/** HR settings of an organisation (one document each). */
export const hrSettingsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, unique: true },
    employeeNoPrefix: { type: String, default: 'EMP' },
    /** Public holidays (YYYY-MM-DD) left out when counting leave days and unpaid leave. */
    holidays: [{ _id: false, date: String, name: String }],
    /** Ledger account ids payroll posts to (see payroll/journals.ts). */
    accounts: { type: Schema.Types.Mixed, default: {} },
    /** Training budget for each calendar year. */
    trainingBudgets: { type: [new Schema({ year: { type: Number, required: true }, amount: { ...D128 } }, { _id: false })], default: [] },
  },
  opts,
);

const band = new Schema({ upTo: { type: Decimal128, default: null }, rate: { ...D128 } }, { _id: false });

/** Statutory rates from a date; a payroll uses the latest set in force at the end of its month. */
export const rateSetSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    effectiveFrom: { type: Date, required: true },
    reference: String,
    paye: { bands: [band], personalRelief: { ...D128 } },
    nssf: { rate: { ...D128 }, lowerLimit: { ...D128 }, upperLimit: { ...D128 } },
    shif: { rate: { ...D128 }, minimum: { ...D128 } },
    ahl: { employeeRate: { ...D128 }, employerRate: { ...D128 } },
    nitaPerEmployee: { ...D128 },
    pensionReliefCap: { ...D128 },
  },
  opts,
);
rateSetSchema.index({ organisationId: 1, effectiveFrom: -1 }, { unique: true });

export const departmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    /** Where the unit sits: directorates hold departments, which hold divisions, sections and service units. */
    level: { type: String, enum: ['DIRECTORATE', 'DEPARTMENT', 'DIVISION', 'SECTION', 'SERVICE_UNIT'], default: 'DEPARTMENT' },
    parentId: { type: ObjectId, default: null },
    /** The employee heading the unit. */
    headId: { type: ObjectId, default: null },
    active: { type: Boolean, default: true },
  },
  opts,
);
departmentSchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const employeeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeNo: { type: String, required: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    otherNames: String,
    gender: { type: String, enum: ['MALE', 'FEMALE'], default: null },
    dateOfBirth: Date,
    nationalId: String,
    kraPin: String,
    nssfNo: String,
    shaNo: String,
    phone: String,
    email: String,
    address: String,
    departmentId: { type: ObjectId, default: null },
    jobTitle: String,
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'PERMANENT' },
    hireDate: { type: Date, required: true },
    probationEndDate: Date,
    contractEndDate: Date,
    managerId: { type: ObjectId, default: null },
    status: { type: String, enum: EMPLOYEE_STATUSES, default: 'ACTIVE' },
    terminationDate: Date,
    terminationReason: { type: String, enum: [...TERMINATION_REASONS, null], default: null },
    terminationNote: String,
    basicSalary: { ...D128 },
    payType: { type: String, enum: PAY_TYPES, default: 'MONTHLY' },
    /** Pay for a day or an hour, for daily and hourly staff. */
    rate: { ...D128 },
    payMethod: { type: String, enum: PAY_METHODS, default: 'BANK' },
    bank: { name: String, branch: String, accountNo: String, accountName: String },
    mpesaPhone: String,
    exempt: { paye: { type: Boolean, default: false }, nssf: { type: Boolean, default: false }, shif: { type: Boolean, default: false }, ahl: { type: Boolean, default: false } },
    nextOfKin: { name: String, phone: String, relationship: String },
    /** Job group (grade) and the notch on its salary scale. */
    jobGroupId: { type: ObjectId, default: null },
    notch: { type: Number, default: null },
    /** Duty station or region, for grouping staff. */
    station: String,
    /** Next annual increment is due on or after this date. */
    nextIncrementDate: { type: Date, default: null },
    qualifications: {
      type: [new Schema({ level: { type: String, required: true }, title: { type: String, required: true }, institution: String, year: Number }, { _id: true })],
      default: [],
    },
    dependants: {
      type: [new Schema({ name: { type: String, required: true }, relationship: { type: String, required: true }, dateOfBirth: Date }, { _id: true })],
      default: [],
    },
    /** New-starter tasks: letter, office, ICT account, ID card, induction… */
    onboarding: {
      type: [new Schema({ task: { type: String, required: true }, owner: { type: String, default: 'HR' }, done: { type: Boolean, default: false }, doneBy: { type: ObjectId, default: null }, doneAt: { type: Date, default: null }, note: { type: String, default: '' } }, { _id: true })],
      default: [],
    },
    /** The application this employee was appointed from. */
    applicationId: { type: ObjectId, default: null },
    payGroup: { type: String, enum: PAY_GROUPS, default: 'STAFF' },
    /** Contract gratuity accrued monthly, as a percentage of basic pay. */
    gratuityRate: { type: Number, default: 0 },
    /** The platform user this employee signs in as (self-service). */
    userId: { type: ObjectId, default: null },
    /** Record id in the system the employee came from (farajasofterp), for migration. */
    legacyId: String,
  },
  opts,
);
employeeSchema.index({ organisationId: 1, employeeNo: 1 }, { unique: true });
employeeSchema.index({ organisationId: 1, status: 1, departmentId: 1 });
employeeSchema.index({ organisationId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } });
employeeSchema.index({ organisationId: 1, nationalId: 1 }, { unique: true, partialFilterExpression: { nationalId: { $type: 'string' } } });
employeeSchema.index({ organisationId: 1, legacyId: 1 }, { unique: true, partialFilterExpression: { legacyId: { $type: 'string' } } });

/**
 * A recurring or one-off earning or deduction on an employee. Ongoing items have no `toPeriod`; a
 * one-off has `fromPeriod` = `toPeriod`. A deduction with a `balance` (a loan) stops when it is repaid.
 */
export const payItemSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    kind: { type: String, enum: PAY_ITEM_KINDS, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    amount: { ...D128 },
    /** Earnings: false for reimbursements, which are not pay. */
    taxable: { type: Boolean, default: true },
    /** Deductions: a registered pension scheme (tax relief). */
    pension: { type: Boolean, default: false },
    balance: { type: Decimal128, default: null },
    /** Deductions: an insurance premium (life, health, education) that earns insurance relief. */
    insurance: { type: Boolean, default: false },
    /** Pension deductions: what the employer adds, as an amount or a percentage of basic pay. */
    employerAmount: { type: Decimal128, default: null },
    employerRate: { type: Number, default: null },
    /** Pension deductions: the member's number with the scheme, for the remittance schedule. */
    memberNo: { type: String, default: null },
    /** Set when the deduction comes from a deduction scheme (pension, union, SACCO...): its rates decide the amount. */
    schemeId: { type: ObjectId, default: null },
    fromPeriod: { type: String, required: true },
    toPeriod: { type: String, default: null },
    active: { type: Boolean, default: true },
  },
  opts,
);
payItemSchema.index({ organisationId: 1, employeeId: 1, active: 1 });

/**
 * A payment on an off-cycle payroll. A deduction can recover a loan (`payItemId`); leave paid out
 * (`leaveDays`) comes off the balance when the payroll is approved.
 */
const payEntrySchema = new Schema({
  employeeId: { type: ObjectId, required: true },
  kind: { type: String, enum: PAY_ITEM_KINDS, required: true },
  code: { type: String, required: true },
  name: { type: String, required: true },
  amount: { ...D128 },
  taxable: { type: Boolean, default: true },
  payItemId: ObjectId,
  leaveTypeId: ObjectId,
  leaveDays: Number,
  leaveYear: Number,
});

export const payRunSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    period: { type: String, required: true },
    kind: { type: String, enum: PAY_RUN_KINDS, default: 'REGULAR' },
    /** What an off-cycle payroll is for, e.g. "December bonus". */
    title: String,
    entries: [payEntrySchema],
    status: { type: String, enum: PAY_RUN_STATUSES, default: 'DRAFT' },
    payDate: Date,
    /** When the payslips were last worked out; approval checks no other payroll that month came after. */
    calculatedAt: Date,
    rateSetId: ObjectId,
    employeeCount: { type: Number, default: 0 },
    totals: {
      gross: { ...D128 },
      paye: { ...D128 },
      nssfEmployee: { ...D128 },
      nssfEmployer: { ...D128 },
      shif: { ...D128 },
      ahlEmployee: { ...D128 },
      ahlEmployer: { ...D128 },
      nita: { ...D128 },
      otherDeductions: { ...D128 },
      netPay: { ...D128 },
      employerPension: { ...D128 },
      gratuity: { ...D128 },
      gratuityPaid: { ...D128 },
      employerCost: { ...D128 },
    },
    payGroup: { type: String, enum: PAY_GROUPS, default: null },
    warningCount: { type: Number, default: 0 },
    createdBy: ObjectId,
    approvedBy: ObjectId,
    approvedAt: Date,
    paidBy: ObjectId,
    paidAt: Date,
    paymentReference: String,
    accounting: { type: ledgerSyncSchema, default: () => ({}) },
    paymentAccounting: { type: ledgerSyncSchema, default: () => ({}) },
    /** History brought from another system: already in the books, so never sent to the ledger. */
    imported: { type: Boolean, default: false },
    legacyId: String,
  },
  opts,
);
payRunSchema.index({ organisationId: 1, legacyId: 1 }, { unique: true, partialFilterExpression: { legacyId: { $type: 'string' } } });
// One monthly payroll a month; off-cycle payrolls as many as needed.
payRunSchema.index({ organisationId: 1, period: 1, payGroup: 1 }, { name: 'one_group_payroll_a_month', unique: true, partialFilterExpression: { status: { $in: ['DRAFT', 'APPROVED', 'PAID'] }, kind: 'GROUP' } });
payRunSchema.index({ organisationId: 1, period: 1 }, { name: 'one_regular_payroll_a_month', unique: true, partialFilterExpression: { status: { $in: ['DRAFT', 'APPROVED', 'PAID'] }, kind: 'REGULAR' } });

const payLine = new Schema({ type: String, code: String, name: String, amount: { ...D128 } }, { _id: false });

export const payslipSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    payRunId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    period: { type: String, required: true },
    payslipNo: String,
    status: { type: String, enum: PAY_RUN_STATUSES, default: 'DRAFT' },
    /** A copy of the employee as paid, so a payslip never changes when the record does. */
    employee: {
      employeeNo: String,
      name: String,
      departmentId: ObjectId,
      department: String,
      jobTitle: String,
      kraPin: String,
      nssfNo: String,
      shaNo: String,
      nationalId: String,
      payMethod: String,
      bankName: String,
      bankBranch: String,
      accountNo: String,
      mpesaPhone: String,
    },
    daysPaid: Number,
    daysInPeriod: Number,
    payType: { type: String, enum: PAY_TYPES, default: 'MONTHLY' },
    /** Days or hours paid, for daily and hourly staff. */
    units: Number,
    rate: Decimal128,
    unpaidLeaveDays: { type: Number, default: 0 },
    /** The off-cycle payroll's title, shown on the payslip. */
    title: String,
    /** Pay on earlier payrolls this month, which statutory deductions here were worked together with. */
    priorGrossPay: Decimal128,
    lines: [payLine],
    gross: { ...D128 },
    grossPay: { ...D128 },
    nssfEmployee: { ...D128 },
    nssfTier1: { ...D128 },
    nssfTier2: { ...D128 },
    nssfEmployer: { ...D128 },
    shif: { ...D128 },
    ahlEmployee: { ...D128 },
    ahlEmployer: { ...D128 },
    pensionRelief: { ...D128 },
    taxablePay: { ...D128 },
    taxCharged: { ...D128 },
    personalRelief: { ...D128 },
    paye: { ...D128 },
    otherDeductions: { ...D128 },
    totalDeductions: { ...D128 },
    netPay: { ...D128 },
    nita: { ...D128 },
    insuranceRelief: { ...D128 },
    employerPension: { ...D128 },
    gratuity: { ...D128 },
    gratuityPaid: { ...D128 },
    employerCost: { ...D128 },
    /** Loan deductions taken, so approval can reduce the balances. */
    repayments: [{ _id: false, payItemId: ObjectId, amount: { ...D128 } }],
    warnings: [String],
  },
  opts,
);
payslipSchema.index({ organisationId: 1, payRunId: 1, employeeId: 1 }, { unique: true });
payslipSchema.index({ organisationId: 1, employeeId: 1, period: -1 });
payslipSchema.index({ organisationId: 1, payslipNo: 1 }, { unique: true, partialFilterExpression: { payslipNo: { $type: 'string' } } });

/** Days or hours worked in a month by daily and hourly staff, entered before the payroll is approved. */
export const payInputSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    period: { type: String, required: true },
    employeeId: { type: ObjectId, required: true },
    units: { type: Number, required: true },
    enteredBy: ObjectId,
  },
  opts,
);
payInputSchema.index({ organisationId: 1, period: 1, employeeId: 1 }, { unique: true });

export const leaveTypeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    paid: { type: Boolean, default: true },
    daysPerYear: { type: Number, default: 0 },
    accrual: { type: String, enum: ['MONTHLY', 'ANNUAL'], default: 'ANNUAL' },
    /** Unused days that move into the next year. */
    carryForwardMax: { type: Number, default: 0 },
    gender: { type: String, enum: ['MALE', 'FEMALE', null], default: null },
    /** Unpaid leave and the like: no balance to check. */
    unlimited: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  opts,
);
leaveTypeSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** Opening balances, carry-forward and corrections to a leave balance. */
export const leaveAdjustmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    leaveTypeId: { type: ObjectId, required: true },
    year: { type: Number, required: true },
    days: { type: Number, required: true },
    kind: { type: String, enum: ['OPENING', 'CARRY_FORWARD', 'ADJUSTMENT', 'ENCASHMENT'], default: 'ADJUSTMENT' },
    reason: String,
    createdBy: ObjectId,
  },
  opts,
);
leaveAdjustmentSchema.index({ organisationId: 1, employeeId: 1, year: 1 });
leaveAdjustmentSchema.index({ organisationId: 1, employeeId: 1, leaveTypeId: 1, year: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: 'CARRY_FORWARD' } });

export const leaveRequestSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    departmentId: { type: ObjectId, default: null },
    leaveTypeId: { type: ObjectId, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    days: { type: Number, required: true },
    reason: String,
    status: { type: String, enum: LEAVE_STATUSES, default: 'PENDING' },
    requestedBy: ObjectId,
    reviewedBy: ObjectId,
    reviewedAt: Date,
    reviewNote: String,
    /** Who covers while the employee is away, and what was handed over. */
    handoverTo: { type: ObjectId, default: null },
    handoverNotes: String,
    /** Recalled from leave: the day back at work and the days given back. */
    recalledAt: { type: Date, default: null },
    recalledBy: { type: ObjectId, default: null },
    recallReason: String,
    daysRestored: { type: Number, default: 0 },
    legacyId: String,
  },
  opts,
);
leaveRequestSchema.index({ organisationId: 1, legacyId: 1 }, { unique: true, partialFilterExpression: { legacyId: { $type: 'string' } } });
leaveRequestSchema.index({ organisationId: 1, status: 1, startDate: 1 });
leaveRequestSchema.index({ organisationId: 1, employeeId: 1, startDate: -1 });

export type EmployeeDoc = InferSchemaType<typeof employeeSchema> & { _id: Types.ObjectId };
export type PayItemDoc = InferSchemaType<typeof payItemSchema> & { _id: Types.ObjectId };
export type RateSetDoc = InferSchemaType<typeof rateSetSchema> & { _id: Types.ObjectId };
export type LeaveTypeDoc = InferSchemaType<typeof leaveTypeSchema> & { _id: Types.ObjectId };
export type PayslipDoc = InferSchemaType<typeof payslipSchema> & { _id: Types.ObjectId };
export type PayRunDoc = InferSchemaType<typeof payRunSchema> & { _id: Types.ObjectId };

export const CAREER_EVENT_KINDS = ['PROMOTION', 'DEMOTION', 'TRANSFER', 'REDESIGNATION', 'SECONDMENT', 'ACTING', 'SALARY_CHANGE', 'INCREMENT'] as const;

/** A grade with its salary scale (pay at each notch) and the allowances that come with it. */
export const jobGroupSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    /** Seniority: higher is more senior. */
    rank: { type: Number, default: 0 },
    notches: { type: [Schema.Types.Decimal128], default: [] },
    allowances: { type: [new Schema({ code: { type: String, required: true }, name: { type: String, required: true }, amount: D128, taxable: { type: Boolean, default: true } }, { _id: false })], default: [] },
    active: { type: Boolean, default: true },
  },
  opts,
);
jobGroupSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** Authorised posts: how many of a designation, in a job group, a department may have. */
export const establishmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    departmentId: { type: ObjectId, required: true },
    jobGroupId: { type: ObjectId, required: true },
    designation: { type: String, required: true },
    authorised: { type: Number, required: true },
  },
  opts,
);
establishmentSchema.index({ organisationId: 1, departmentId: 1, jobGroupId: 1, designation: 1 }, { unique: true });

const postingSchema = new Schema(
  { departmentId: { type: ObjectId, default: null }, jobGroupId: { type: ObjectId, default: null }, notch: { type: Number, default: null }, jobTitle: String, station: String, basicSalary: { type: Schema.Types.Decimal128, default: null } },
  { _id: false },
);

/**
 * A change in an employee's career: promotion, transfer, secondment, acting appointment, salary change
 * or increment. Requested by HR, approved by someone else, then applied; together they are the
 * employee's job and salary history.
 */
export const careerEventSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    kind: { type: String, enum: CAREER_EVENT_KINDS, required: true },
    effectiveDate: { type: Date, required: true },
    /** Acting appointments and secondments end. */
    endDate: { type: Date, default: null },
    from: { type: postingSchema, required: true },
    to: { type: postingSchema, required: true },
    actingAllowance: { type: Schema.Types.Decimal128, default: null },
    secondedTo: String,
    reason: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    requestedBy: { type: ObjectId, required: true },
    decidedBy: { type: ObjectId, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: String,
    payItemId: { type: ObjectId, default: null },
  },
  opts,
);
careerEventSchema.index({ organisationId: 1, employeeId: 1, effectiveDate: -1 });
careerEventSchema.index({ organisationId: 1, status: 1 });

export type JobGroupDoc = InferSchemaType<typeof jobGroupSchema> & { _id: Types.ObjectId };
export type CareerEventDoc = InferSchemaType<typeof careerEventSchema> & { _id: Types.ObjectId };

export const VACANCY_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PUBLISHED', 'CLOSED', 'FILLED', 'CANCELLED'] as const;
export const APPLICATION_STATUSES = ['RECEIVED', 'SHORTLISTED', 'NOT_SHORTLISTED', 'INTERVIEWED', 'SELECTED', 'OFFERED', 'APPOINTED', 'REGRET', 'WITHDRAWN'] as const;
export const QUALIFICATION_LEVELS = ['KCSE', 'CERTIFICATE', 'DIPLOMA', 'DEGREE', 'MASTERS', 'DOCTORATE'] as const;

/** A post to fill: approved against the establishment, then advertised on the jobs page. */
export const vacancySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    title: { type: String, required: true },
    departmentId: { type: ObjectId, required: true },
    jobGroupId: { type: ObjectId, default: null },
    positions: { type: Number, default: 1 },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'PERMANENT' },
    description: { type: String, default: '' },
    requirements: { type: String, default: '' },
    /** Shortlisting criteria. */
    minimumLevel: { type: String, enum: [...QUALIFICATION_LEVELS, null], default: null },
    minimumExperience: { type: Number, default: 0 },
    closingDate: { type: Date, required: true },
    internalOnly: { type: Boolean, default: false },
    status: { type: String, enum: VACANCY_STATUSES, default: 'DRAFT' },
    /** Why it goes beyond the vacant authorised posts, if it does. */
    establishmentNote: { type: String, default: '' },
    createdBy: { type: ObjectId, required: true },
    submittedAt: { type: Date, default: null },
    approvedBy: { type: ObjectId, default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    publishedAt: { type: Date, default: null },
    /** Interview panel members (platform users). */
    panel: { type: [ObjectId], default: [] },
    /** Officers appointed to shortlist (they can overrule the automatic shortlist). */
    shortlistOfficers: { type: [ObjectId], default: [] },
  },
  opts,
);
vacancySchema.index({ organisationId: 1, number: 1 }, { unique: true });
vacancySchema.index({ organisationId: 1, status: 1, closingDate: 1 });

/** Someone's application for a vacancy, from the jobs page or entered by HR. */
export const applicationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    vacancyId: { type: ObjectId, required: true },
    reference: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    nationalId: { type: String, required: true },
    gender: { type: String, enum: ['MALE', 'FEMALE', null], default: null },
    dateOfBirth: { type: Date, default: null },
    county: { type: String, default: '' },
    disability: { type: Boolean, default: false },
    highestLevel: { type: String, enum: QUALIFICATION_LEVELS, required: true },
    qualifications: {
      type: [new Schema({ level: { type: String, required: true }, title: { type: String, required: true }, institution: String, year: Number }, { _id: false })],
      default: [],
    },
    experienceYears: { type: Number, default: 0 },
    coverLetter: { type: String, default: '' },
    status: { type: String, enum: APPLICATION_STATUSES, default: 'RECEIVED' },
    shortlistNote: { type: String, default: '' },
    shortlistedAt: { type: Date, default: null },
    interviewAt: { type: Date, default: null },
    scores: {
      type: [new Schema({ userId: { type: ObjectId, required: true }, name: { type: String, required: true }, score: { type: Number, required: true }, comment: { type: String, default: '' }, at: { type: Date, required: true } }, { _id: false })],
      default: [],
    },
    employeeId: { type: ObjectId, default: null },
    /** The applicant account it came from (online applications by a registered applicant). */
    applicantId: { type: ObjectId, default: null },
    /** The applicant's whole profile as it stood when they applied, kept with the long list. */
    archivedProfile: { type: Schema.Types.Mixed, default: null },
    /** A shortlisting officer's decision, overriding the automatic one. */
    shortlistedBy: { type: ObjectId, default: null },
    invitedAt: { type: Date, default: null },
    interviewVenue: { type: String, default: '' },
    selectedBy: { type: ObjectId, default: null },
    offerApprovedBy: { type: ObjectId, default: null },
    offeredAt: { type: Date, default: null },
    reportBy: { type: Date, default: null },
    notices: { type: [new Schema({ at: Date, kind: String, email: Boolean, sms: Boolean }, { _id: false })], default: [] },
  },
  opts,
);
applicationSchema.index({ organisationId: 1, vacancyId: 1, nationalId: 1 }, { unique: true });
applicationSchema.index({ organisationId: 1, reference: 1 }, { unique: true });

export type VacancyDoc = InferSchemaType<typeof vacancySchema> & { _id: Types.ObjectId };
export type ApplicationDoc = InferSchemaType<typeof applicationSchema> & { _id: Types.ObjectId };

export const CASE_KINDS = ['DISCIPLINARY', 'GRIEVANCE'] as const;
export const CASE_STATUSES = ['OPEN', 'SHOW_CAUSE', 'HEARING', 'DECIDED', 'APPEALED', 'CLOSED'] as const;
export const CASE_OUTCOMES = ['NO_ACTION', 'VERBAL_WARNING', 'WRITTEN_WARNING', 'FINAL_WARNING', 'SUSPENSION', 'SURCHARGE', 'DEMOTION', 'DISMISSAL', 'RESOLVED', 'NOT_UPHELD'] as const;
export const CLEARANCE_SECTIONS = ['Supervisor', 'ICT', 'Finance', 'Stores', 'Transport', 'HR'] as const;

/** An employee's request to change their personal or bank details, applied once HR approves it. */
export const changeRequestSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    kind: { type: String, enum: ['PERSONAL', 'BANK'], required: true },
    changes: { type: Schema.Types.Mixed, required: true },
    before: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    requestedBy: { type: ObjectId, required: true },
    decidedBy: { type: ObjectId, default: null },
    decidedAt: { type: Date, default: null },
    note: String,
  },
  opts,
);
changeRequestSchema.index({ organisationId: 1, status: 1 });

/** A disciplinary case against an employee, or a grievance raised by one, with every step taken. */
export const caseSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    kind: { type: String, enum: CASE_KINDS, required: true },
    employeeId: { type: ObjectId, required: true },
    /** Grievances: who or what the complaint is about. */
    against: String,
    category: { type: String, required: true },
    description: { type: String, required: true },
    incidentDate: { type: Date, default: null },
    status: { type: String, enum: CASE_STATUSES, default: 'OPEN' },
    steps: {
      type: [new Schema({ action: { type: String, required: true }, at: { type: Date, required: true }, by: { type: ObjectId, required: true }, byName: String, note: String, dueDate: Date }, { _id: false })],
      default: [],
    },
    outcome: { type: String, enum: [...CASE_OUTCOMES, null], default: null },
    outcomeNote: String,
    appeal: { lodgedAt: Date, grounds: String, decision: { type: String, enum: ['UPHELD', 'VARIED', 'OVERTURNED', null], default: null }, decidedAt: Date, note: String },
    openedBy: { type: ObjectId, required: true },
  },
  opts,
);
caseSchema.index({ organisationId: 1, number: 1 }, { unique: true });
caseSchema.index({ organisationId: 1, employeeId: 1 });

/** Clearance of a leaving employee by each section, the exit interview, and the clearance certificate. */
export const clearanceSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    lastDay: { type: Date, required: true },
    reason: { type: String, required: true },
    items: {
      type: [new Schema({ section: { type: String, required: true }, cleared: { type: Boolean, default: false }, owed: { ...D128 }, note: String, clearedBy: { type: ObjectId, default: null }, clearedByName: String, clearedAt: { type: Date, default: null } }, { _id: false })],
      default: [],
    },
    exitInterview: { conductedAt: Date, by: ObjectId, reasonForLeaving: String, wouldRecommend: Boolean, comments: String },
    status: { type: String, enum: ['OPEN', 'CLEARED'], default: 'OPEN' },
    clearedAt: { type: Date, default: null },
    startedBy: { type: ObjectId, required: true },
  },
  opts,
);
clearanceSchema.index({ organisationId: 1, employeeId: 1 }, { unique: true });

export type CaseDoc = InferSchemaType<typeof caseSchema> & { _id: Types.ObjectId };
export type ClearanceDoc = InferSchemaType<typeof clearanceSchema> & { _id: Types.ObjectId };

export const BSC_PERSPECTIVES = ['FINANCIAL', 'CUSTOMER', 'INTERNAL_PROCESS', 'LEARNING_GROWTH'] as const;
export const APPRAISAL_STATUSES = ['TARGETS_SET', 'AGREED', 'SELF_REVIEWED', 'REVIEWED', 'APPEALED', 'CLOSED'] as const;
export const RECOMMENDATIONS = ['NONE', 'REWARD', 'PROMOTION', 'TRAINING', 'IMPROVEMENT_PLAN'] as const;
export const TRAINING_KINDS = ['TRAINING', 'WORKSHOP', 'MENTORSHIP', 'COACHING'] as const;

/** A performance appraisal period. */
export const appraisalCycleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
  },
  opts,
);

/**
 * An employee's balanced-scorecard appraisal for a cycle: weighted targets in the four perspectives,
 * agreed with the employee, rated by them and then by their supervisor (1-5), with the overall score,
 * recommendation, training needs and any appeal.
 */
export const appraisalSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    cycleId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    departmentId: { type: ObjectId, default: null },
    appraiserId: { type: ObjectId, required: true },
    targets: {
      type: [
        new Schema({
          perspective: { type: String, enum: BSC_PERSPECTIVES, required: true },
          objective: { type: String, required: true },
          measure: { type: String, default: '' },
          target: { type: String, default: '' },
          weight: { type: Number, required: true },
          selfRating: { type: Number, default: null },
          selfComment: String,
          rating: { type: Number, default: null },
          comment: String,
        }),
      ],
      default: [],
    },
    status: { type: String, enum: APPRAISAL_STATUSES, default: 'TARGETS_SET' },
    agreedAt: { type: Date, default: null },
    selfReviewedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    score: { type: Number, default: null },
    grade: { type: String, default: '' },
    supervisorComment: String,
    recommendation: { type: String, enum: RECOMMENDATIONS, default: 'NONE' },
    trainingNeeds: { type: [String], default: [] },
    appeal: { grounds: String, lodgedAt: Date, decision: String, decidedBy: ObjectId, decidedAt: Date, originalScore: Number },
  },
  opts,
);
appraisalSchema.index({ organisationId: 1, cycleId: 1, employeeId: 1 }, { unique: true });

/** A training, workshop, mentorship or coaching, its participants, cost and evaluation. */
export const trainingSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    title: { type: String, required: true },
    kind: { type: String, enum: TRAINING_KINDS, default: 'TRAINING' },
    provider: String,
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    cost: { ...D128 },
    /** Mentorship and coaching: the mentor. */
    mentorId: { type: ObjectId, default: null },
    participants: {
      type: [new Schema({ employeeId: { type: ObjectId, required: true }, departmentId: { type: ObjectId, default: null }, attended: { type: Boolean, default: null }, rating: { type: Number, default: null }, feedback: String }, { _id: false })],
      default: [],
    },
    needs: { type: [String], default: [] },
    status: { type: String, enum: ['PLANNED', 'APPROVED', 'COMPLETED', 'CANCELLED'], default: 'PLANNED' },
    createdBy: { type: ObjectId, required: true },
    approvedBy: { type: ObjectId, default: null },
    approvedAt: { type: Date, default: null },
  },
  opts,
);
trainingSchema.index({ organisationId: 1, startDate: -1 });

export type AppraisalDoc = InferSchemaType<typeof appraisalSchema> & { _id: Types.ObjectId };
export type TrainingDoc = InferSchemaType<typeof trainingSchema> & { _id: Types.ObjectId };

export const VEHICLE_TYPES = ['SALOON', 'PICKUP', 'LORRY', 'BUS', 'MOTORCYCLE', 'TRACTOR', 'WATER_BOWSER', 'OTHER'] as const;
export const VEHICLE_STATUSES = ['ACTIVE', 'UNDER_REPAIR', 'GROUNDED', 'DISPOSED'] as const;
export const TRIP_STATUSES = ['PENDING', 'APPROVED', 'ALLOCATED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const;
export const MAINTENANCE_KINDS = ['SERVICE', 'REPAIR', 'TYRES', 'INSPECTION', 'BODYWORK'] as const;
export const INCIDENT_KINDS = ['ACCIDENT', 'BREAKDOWN', 'THEFT', 'TRAFFIC_OFFENCE', 'DAMAGE'] as const;

/** A vehicle in the fleet, with its papers and service schedule. */
export const vehicleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    regNo: { type: String, required: true, uppercase: true, trim: true },
    make: { type: String, required: true },
    model: { type: String, default: '' },
    year: { type: Number, default: null },
    type: { type: String, enum: VEHICLE_TYPES, default: 'PICKUP' },
    fuelType: { type: String, enum: ['PETROL', 'DIESEL', 'ELECTRIC'], default: 'DIESEL' },
    seats: { type: Number, default: null },
    chassisNo: String,
    engineNo: String,
    colour: String,
    departmentId: { type: ObjectId, default: null },
    station: String,
    status: { type: String, enum: VEHICLE_STATUSES, default: 'ACTIVE' },
    odometer: { type: Number, default: 0 },
    purchaseDate: { type: Date, default: null },
    purchaseCost: { type: Schema.Types.Decimal128, default: null },
    /** Finance fixed-asset number, when it is on the asset register. */
    assetNumber: String,
    insurance: { insurer: String, policyNo: String, expiresOn: Date },
    inspectionDue: { type: Date, default: null },
    serviceEveryKm: { type: Number, default: 5000 },
    serviceEveryMonths: { type: Number, default: 6 },
    lastServiceKm: { type: Number, default: 0 },
    lastServiceDate: { type: Date, default: null },
    fuelCard: { number: String, provider: String, monthlyLimit: { type: Schema.Types.Decimal128, default: null } },
    tracker: { provider: String, deviceId: String },
    disposedAt: { type: Date, default: null },
  },
  opts,
);
vehicleSchema.index({ organisationId: 1, regNo: 1 }, { unique: true });

/** A driver: an employee with a valid licence. */
export const driverSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    licenceNo: { type: String, required: true },
    licenceClasses: { type: [String], default: [] },
    licenceExpiry: { type: Date, required: true },
    active: { type: Boolean, default: true },
  },
  opts,
);
driverSchema.index({ organisationId: 1, employeeId: 1 }, { unique: true });

/**
 * A transport request: approved, then allocated a vehicle and driver; the work ticket records the
 * odometer out and in, the fuel drawn and the distance.
 */
export const tripSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    requestedBy: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, default: null },
    departmentId: { type: ObjectId, default: null },
    purpose: { type: String, required: true },
    destination: { type: String, required: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    passengers: { type: Number, default: 1 },
    status: { type: String, enum: TRIP_STATUSES, default: 'PENDING' },
    approvedBy: { type: ObjectId, default: null },
    decisionNote: String,
    vehicleId: { type: ObjectId, default: null },
    driverId: { type: ObjectId, default: null },
    allocatedBy: { type: ObjectId, default: null },
    ticket: {
      number: String,
      odometerOut: Number,
      odometerIn: Number,
      distance: Number,
      issuedAt: Date,
      returnedAt: Date,
      remarks: String,
    },
  },
  opts,
);
tripSchema.index({ organisationId: 1, number: 1 }, { unique: true });
tripSchema.index({ organisationId: 1, vehicleId: 1, from: 1, to: 1 });

/** Fuel drawn: litres, cost, odometer, station and card. */
export const fuelSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    vehicleId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    litres: { type: Number, required: true },
    amount: { ...D128 },
    odometer: { type: Number, required: true },
    station: String,
    receiptNo: String,
    viaCard: { type: Boolean, default: false },
    tripId: { type: ObjectId, default: null },
    recordedBy: { type: ObjectId, required: true },
  },
  opts,
);
fuelSchema.index({ organisationId: 1, vehicleId: 1, date: 1 });

export const vehicleMaintenanceSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    vehicleId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    kind: { type: String, enum: MAINTENANCE_KINDS, required: true },
    description: { type: String, required: true },
    garage: String,
    cost: { ...D128 },
    odometer: { type: Number, default: null },
    daysOff: { type: Number, default: 0 },
    recordedBy: { type: ObjectId, required: true },
  },
  opts,
);
vehicleMaintenanceSchema.index({ organisationId: 1, vehicleId: 1, date: -1 });

export const vehicleIncidentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    vehicleId: { type: ObjectId, required: true },
    driverId: { type: ObjectId, default: null },
    date: { type: Date, required: true },
    kind: { type: String, enum: INCIDENT_KINDS, required: true },
    location: String,
    description: { type: String, required: true },
    policeAbstract: String,
    insuranceClaimNo: String,
    cost: { ...D128 },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },
    outcome: String,
    recordedBy: { type: ObjectId, required: true },
  },
  opts,
);
vehicleIncidentSchema.index({ organisationId: 1, number: 1 }, { unique: true });

export type VehicleDoc = InferSchemaType<typeof vehicleSchema> & { _id: Types.ObjectId };
export type TripDoc = InferSchemaType<typeof tripSchema> & { _id: Types.ObjectId };

/** A registered job applicant: an account on the public jobs page, separate from staff sign-in. */
export const applicantSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    name: { type: String, required: true },
    nationalId: { type: String, required: true },
    passwordHash: { type: String, required: true },
    verifiedAt: { type: Date, default: null },
    status: { type: String, enum: ['ACTIVE', 'DEACTIVATED'], default: 'ACTIVE' },
    deactivatedAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
    /** The current one-time code (hashed) and what it is for. */
    otp: {
      codeHash: String,
      purpose: { type: String, enum: ['REGISTER', 'LOGIN', 'RESET', null], default: null },
      expiresAt: Date,
      attempts: { type: Number, default: 0 },
    },
    profile: {
      gender: { type: String, enum: ['MALE', 'FEMALE', null], default: null },
      dateOfBirth: { type: Date, default: null },
      county: { type: String, default: '' },
      disability: { type: Boolean, default: false },
      highestLevel: { type: String, enum: [...QUALIFICATION_LEVELS, null], default: null },
      experienceYears: { type: Number, default: 0 },
      qualifications: { type: [new Schema({ level: String, title: String, institution: String, year: Number }, { _id: false })], default: [] },
      experience: { type: [new Schema({ employer: String, position: String, from: Date, to: Date, duties: String }, { _id: false })], default: [] },
      professional: { type: [new Schema({ body: String, membershipNo: String, year: Number }, { _id: false })], default: [] },
      referees: { type: [new Schema({ name: String, position: String, phone: String, email: String }, { _id: false })], default: [] },
      summary: { type: String, default: '' },
    },
  },
  opts,
);
applicantSchema.index({ organisationId: 1, email: 1 }, { unique: true });
applicantSchema.index({ organisationId: 1, nationalId: 1 }, { unique: true });

/** An induction programme for new staff, put together by HR with the user departments. */
export const inductionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    title: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    venue: { type: String, default: '' },
    sessions: {
      type: [new Schema({ date: Date, time: String, topic: { type: String, required: true }, departmentId: { type: ObjectId, default: null }, facilitator: String, contributedBy: ObjectId })],
      default: [],
    },
    participants: { type: [new Schema({ employeeId: { type: ObjectId, required: true }, notifiedAt: Date, remindedAt: Date, attended: { type: Boolean, default: null } }, { _id: false })], default: [] },
    status: { type: String, enum: ['PLANNED', 'COMPLETED', 'CANCELLED'], default: 'PLANNED' },
    createdBy: ObjectId,
  },
  opts,
);
