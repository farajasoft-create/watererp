export type { Page } from '@/lib/types';

export interface Department {
  id: string;
  code: string;
  name: string;
  active: boolean;
  level?: string;
  parentId?: string | null;
  headId?: string | null;
  path?: string;
  depth?: number;
  head?: string;
  staff?: number;
  staffBelow?: number;
}

export interface Employee {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  otherNames?: string;
  gender?: 'MALE' | 'FEMALE' | null;
  dateOfBirth?: string | null;
  nationalId?: string;
  kraPin?: string;
  nssfNo?: string;
  shaNo?: string;
  phone?: string;
  email?: string;
  address?: string;
  departmentId?: string | null;
  jobTitle?: string;
  employmentType: 'PERMANENT' | 'CONTRACT' | 'CASUAL' | 'INTERN';
  hireDate: string;
  probationEndDate?: string | null;
  contractEndDate?: string | null;
  managerId?: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  terminationDate?: string | null;
  terminationReason?: string | null;
  terminationNote?: string;
  nextOfKin?: { name?: string; phone?: string; relationship?: string };
  station?: string;
  jobGroupId?: string | null;
  notch?: number | null;
  qualifications?: { level: string; title: string; institution?: string; year?: number | null }[];
  dependants?: { name: string; relationship: string; dateOfBirth?: string | null }[];
  onboarding?: { id: string; task: string; owner: string; done: boolean; doneAt: string | null; note: string }[];
  userId?: string | null;
  /** Pay details are left out for users without salary access. */
  basicSalary?: string;
  payType?: 'MONTHLY' | 'DAILY' | 'HOURLY';
  rate?: string;
  payMethod?: 'BANK' | 'MPESA' | 'CASH';
  bank?: { name?: string; branch?: string; accountNo?: string; accountName?: string };
  mpesaPhone?: string;
  exempt?: { paye: boolean; nssf: boolean; shif: boolean; ahl: boolean };
  /** STAFF is the monthly payroll; board members and seconded staff have their own. */
  payGroup?: 'STAFF' | 'BOARD' | 'SECONDED';
  /** Contract gratuity accrued monthly, % of basic pay. */
  gratuityRate?: number;
}

export interface PayItem {
  id: string;
  employeeId: string;
  kind: 'EARNING' | 'DEDUCTION';
  code: string;
  name: string;
  amount: string;
  taxable: boolean;
  pension: boolean;
  insurance?: boolean;
  employerAmount?: string | null;
  employerRate?: number | null;
  memberNo?: string | null;
  balance: string | null;
  fromPeriod: string;
  toPeriod: string | null;
  active: boolean;
}

export type SyncState = { status: string; error?: string; journalId?: string };

export interface PayRunTotals {
  gross: string;
  paye: string;
  nssfEmployee: string;
  nssfEmployer: string;
  shif: string;
  ahlEmployee: string;
  ahlEmployer: string;
  nita: string;
  otherDeductions: string;
  netPay: string;
  employerPension?: string;
  gratuity?: string;
  gratuityPaid?: string;
  employerCost: string;
}

export interface PayRun {
  id: string;
  period: string;
  /** OFF_CYCLE: a bonus, arrears or someone's final dues, paid apart from the month's payroll. GROUP: board or seconded staff. */
  kind?: 'REGULAR' | 'OFF_CYCLE' | 'GROUP';
  payGroup?: 'BOARD' | 'SECONDED' | null;
  title?: string;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'CANCELLED';
  payDate?: string;
  employeeCount: number;
  warningCount: number;
  totals: PayRunTotals;
  createdBy?: string;
  approvedBy?: string;
  approvedAt?: string;
  paidAt?: string;
  paymentReference?: string;
  accounting?: SyncState;
  paymentAccounting?: SyncState;
  /** History brought from farajasofterp; never sent to the ledger. */
  imported?: boolean;
}

export interface PayEntry {
  id: string;
  employeeId: string;
  employeeNo?: string;
  employeeName?: string;
  kind: 'EARNING' | 'DEDUCTION';
  code: string;
  name: string;
  amount: string;
  taxable: boolean;
  payItemId?: string;
  leaveTypeId?: string;
  leaveDays?: number;
  leaveYear?: number;
}

export interface FinalDues {
  employee: { id: string; employeeNo: string; name: string; status: string; hireDate: string; terminationDate?: string; terminationReason?: string; payType: string };
  dayRate: string;
  dayRateBasis: string;
  yearsOfService: number;
  lines: (Omit<PayEntry, 'id' | 'employeeNo' | 'employeeName'> & { suggested: boolean; note?: string })[];
}

export interface PayLine {
  type: 'BASIC' | 'EARNING' | 'REIMBURSEMENT' | 'STATUTORY' | 'DEDUCTION' | 'EMPLOYER';
  code: string;
  name: string;
  amount: string;
}

export interface Payslip {
  id: string;
  payRunId: string;
  employeeId: string;
  period: string;
  payslipNo?: string;
  status: string;
  employee: { employeeNo: string; name: string; department?: string; jobTitle?: string; kraPin?: string; nssfNo?: string; shaNo?: string; nationalId?: string; payMethod?: string; bankName?: string; bankBranch?: string; accountNo?: string; mpesaPhone?: string };
  daysPaid?: number;
  daysInPeriod?: number;
  unpaidLeaveDays: number;
  /** The off-cycle payroll's title. */
  title?: string;
  /** Pay on the month's earlier payrolls, which the deductions here were worked together with. */
  priorGrossPay?: string;
  payType?: 'MONTHLY' | 'DAILY' | 'HOURLY';
  units?: number;
  rate?: string;
  lines?: PayLine[];
  gross: string;
  grossPay: string;
  nssfEmployee: string;
  shif: string;
  ahlEmployee: string;
  pensionRelief: string;
  taxablePay: string;
  taxCharged: string;
  personalRelief: string;
  paye: string;
  otherDeductions: string;
  totalDeductions: string;
  netPay: string;
  employerCost: string;
  warnings: string[];
}

export interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: number;
  accrual: 'MONTHLY' | 'ANNUAL';
  carryForwardMax: number;
  gender: 'MALE' | 'FEMALE' | null;
  unlimited: boolean;
  active: boolean;
}

export interface LeaveBalance {
  leaveTypeId: string;
  code: string;
  name: string;
  paid: boolean;
  unlimited: boolean;
  earned: number;
  adjusted: number;
  taken: number;
  pending: number;
  available: number;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeNo?: string;
  employeeName: string;
  leaveType: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reviewNote?: string;
  createdAt: string;
  recalledAt?: string | null;
  daysRestored?: number;
  handoverTo?: string | null;
}

export interface EmployeeOption {
  id: string;
  employeeNo: string;
  name: string;
  departmentId: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  status?: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
}

export interface P9 {
  year: number;
  employer: { name?: string; kraPin?: string; address?: string };
  employee: { employeeNo: string; name: string; kraPin?: string; nationalId?: string };
  months: Record<'period' | 'basic' | 'otherPay' | 'gross' | 'retirement' | 'shif' | 'ahl' | 'taxablePay' | 'taxCharged' | 'relief' | 'paye', string>[];
  totals: Record<string, string>;
}
