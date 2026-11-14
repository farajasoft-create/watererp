export type AccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COST_OF_SALES' | 'EXPENSE';
export type JournalStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REJECTED';
export type PeriodStatus = 'OPEN' | 'SOFT_CLOSED' | 'HARD_CLOSED';
export type DimensionType = 'DEPARTMENT' | 'COST_CENTRE' | 'PROJECT' | 'FUND';

export interface Organisation {
  id: string;
  name: string;
  slug: string;
  reportingCurrency: string;
  activeCurrencies: string[];
  settings: {
    retainedEarningsAccountId: string | null;
    requireJournalApproval: boolean;
    supplierOnboardingApproval?: boolean;
    requireProcurementPlan?: boolean;
    requireGoodsInspection?: boolean;
    stockInTransitAccountId?: string | null;
    budgetAlertPercent?: number | null;
    receivablesAccountId?: string | null;
    payablesAccountId?: string | null;
    fxGainAccountId?: string | null;
    fxLossAccountId?: string | null;
    matchTolerancePercent?: string | null;
    unrealisedFxGainAccountId?: string | null;
    unrealisedFxLossAccountId?: string | null;
    interBranchAccountId?: string | null;
    employeeClaimsAccountId?: string | null;
    budgetControl?: 'OFF' | 'WARN' | 'BLOCK';
    documentRetentionYears?: number;
    requireMfa?: boolean;
    aiEnabled?: boolean;
  };
}

export interface Me {
  id: string;
  name: string;
  email: string;
  permissions: string[];
  allBranches: boolean;
  branchIds: string[];
  approvalLimit: string | null;
  organisation: Organisation;
  permissionCatalog: Record<string, string>;
  mfaEnabled: boolean;
  recoveryCodesLeft: number;
  mfaEnrollmentRequired: boolean;
  emailPreferences: { approvals: 'immediate' | 'digest' | 'off' };
  smsPreferences?: { approvals: boolean };
  /** The organisation lets approvers opt in to text messages. */
  smsApprovalAlerts?: boolean;
  /** For expense reimbursements by M-Pesa. */
  phone?: string;
}

export interface Entity {
  id: string;
  code: string;
  name: string;
  legalName: string;
  registrationNumber: string;
  taxId: string;
  country: string;
  functionalCurrency: string;
  ownershipPercent?: string | null;
  /** Printed on invoices. */
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  paymentInstructions?: string;
  isActive: boolean;
}

export interface Branch {
  id: string;
  entityId: string;
  code: string;
  name: string;
  address: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  taxRegistrationNumber: string;
  currency: string;
  isActive: boolean;
}

export interface Dimension {
  id: string;
  type: DimensionType;
  code: string;
  name: string;
  entityId: string | null;
  headUserId?: string | null;
  isActive: boolean;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  description: string;
  accountClass: AccountClass;
  accountType: string;
  parentId: string | null;
  isPostable: boolean;
  isControl: boolean;
  allowManualPosting: boolean;
  currency: string | null;
  requiresDepartment: boolean;
  requiresCostCentre: boolean;
  requiresProject: boolean;
  entityIds: string[];
  isActive: boolean;
}

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  precision: number;
  isActive: boolean;
}

export interface ExchangeRate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rateType: 'SPOT' | 'CLOSING' | 'AVERAGE';
  rate: string;
  effectiveDate: string;
  source: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdBy: string;
  createdAt: string;
}

export interface Period {
  id: string;
  number: number;
  name: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  statusReason: string;
  statusChangedAt: string | null;
}

export interface FiscalYear {
  id: string;
  entityId: string;
  name: string;
  startDate: string;
  endDate: string;
  periods: Period[];
}

export interface JournalLine {
  lineNo: number;
  accountId: string;
  branchId: string;
  departmentId: string | null;
  costCentreId: string | null;
  projectId: string | null;
  fundId: string | null;
  /** Intercompany: the other group entity (eliminated on consolidation). */
  intercompanyEntityId?: string | null;
  autoInterBranch?: boolean;
  description: string;
  currency: string;
  exchangeRate: string;
  debitTx: string;
  creditTx: string;
  debit: string;
  credit: string;
}

export interface Journal {
  id: string;
  entityId: string;
  branchId: string;
  number: string;
  journalDate: string;
  periodId: string;
  description: string;
  reference: string;
  type: 'STANDARD' | 'ACCRUAL' | 'OPENING' | 'REVERSAL';
  source: string;
  status: JournalStatus;
  functionalCurrency: string;
  totalDebit: string;
  totalCredit: string;
  autoReverseDate: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  lines: JournalLine[];
  createdBy: string;
  createdAt: string;
  createdByName?: string;
  submittedByName?: string | null;
  submittedAt: string | null;
  approvedByName?: string | null;
  approvedAt: string | null;
  postedByName?: string | null;
  postedAt: string | null;
  rejectedByName?: string | null;
  rejectedAt: string | null;
  rejectionReason: string;
  reversalOfNumber?: string | null;
  reversedByNumber?: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  roleIds: string[];
  allBranches: boolean;
  branchIds: string[];
  approvalLimit: string | null;
  phone?: string;
  lastLoginAt: string | null;
  mfa?: { enabled: boolean; enabledAt: string | null };
  lockedUntil?: string | null;
  invitedAt?: string | null;
  passwordSetAt?: string | null;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  userCount: number;
}

export interface AuditEvent {
  id: string;
  userName: string;
  action: string;
  recordType: string;
  recordId: string | null;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}
