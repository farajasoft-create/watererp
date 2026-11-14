import { HydratedDocument, InferSchemaType, Schema, Types } from 'mongoose';

const ObjectId = Schema.Types.ObjectId;
const Decimal128 = Schema.Types.Decimal128;
const options = { timestamps: true, versionKey: false } as const;

export const ACCOUNT_CLASSES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

/** Account subtypes, grouped by the class they belong to. */
export const ACCOUNT_TYPES: Record<AccountClass, readonly string[]> = {
  ASSET: [
    'BANK',
    'CASH',
    'RECEIVABLE',
    'INVENTORY',
    'PREPAYMENT',
    'CURRENT_ASSET',
    'FIXED_ASSET',
    'ACCUMULATED_DEPRECIATION',
    'NON_CURRENT_ASSET',
    'INTER_BRANCH',
  ],
  LIABILITY: ['PAYABLE', 'TAX_PAYABLE', 'ACCRUAL', 'CURRENT_LIABILITY', 'LOAN', 'NON_CURRENT_LIABILITY'],
  EQUITY: ['SHARE_CAPITAL', 'RETAINED_EARNINGS', 'RESERVE', 'EQUITY'],
  REVENUE: ['REVENUE', 'OTHER_INCOME', 'FX_GAIN'],
  COST_OF_SALES: ['COST_OF_SALES'],
  EXPENSE: ['EXPENSE', 'DEPRECIATION', 'FX_LOSS', 'TAX_EXPENSE'],
};
export const ALL_ACCOUNT_TYPES = Object.values(ACCOUNT_TYPES).flat();

/** Debit-normal classes increase with debits; the rest increase with credits. */
export const DEBIT_NORMAL: ReadonlySet<AccountClass> = new Set(['ASSET', 'COST_OF_SALES', 'EXPENSE']);
export const INCOME_STATEMENT_CLASSES: AccountClass[] = ['REVENUE', 'COST_OF_SALES', 'EXPENSE'];

export const DIMENSION_TYPES = ['DEPARTMENT', 'COST_CENTRE', 'PROJECT', 'FUND'] as const;
export type DimensionType = (typeof DIMENSION_TYPES)[number];

export const PERIOD_STATUSES = ['OPEN', 'SOFT_CLOSED', 'HARD_CLOSED'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const JOURNAL_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
export const JOURNAL_TYPES = ['STANDARD', 'ACCRUAL', 'OPENING', 'REVERSAL'] as const;
export const JOURNAL_SOURCES = ['MANUAL', 'API', 'IMPORT', 'SYSTEM', 'REVERSAL'] as const;

export const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const RATE_TYPES = ['SPOT', 'CLOSING', 'AVERAGE'] as const;
export type RateType = (typeof RATE_TYPES)[number];
export const RATE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

// ---------------------------------------------------------------------------------------------
// Tenancy, identity and access
// ---------------------------------------------------------------------------------------------

export const OrganisationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true },
    reportingCurrency: { type: String, required: true },
    activeCurrencies: { type: [String], default: [] },
    settings: {
      retainedEarningsAccountId: { type: ObjectId, default: null },
      /** When false, journals may be posted directly from draft by a user holding journal.post. */
      requireJournalApproval: { type: Boolean, default: true },
      /** New suppliers wait for a procurement approver before they can be ordered from or paid. */
      supplierOnboardingApproval: { type: Boolean, default: false },
      /** Requisition lines must draw on an item of the approved annual procurement plan. */
      requireProcurementPlan: { type: Boolean, default: false },
      /** Deliveries must be accepted by an inspection committee before they can be billed. */
      requireGoodsInspection: { type: Boolean, default: false },
      /** Stock dispatched to another store and not yet received; blank keeps it in the inventory account. */
      stockInTransitAccountId: { type: ObjectId, default: null },
      /** Control and FX accounts used by the subledgers (AR, AP, banking). */
      receivablesAccountId: { type: ObjectId, default: null },
      payablesAccountId: { type: ObjectId, default: null },
      fxGainAccountId: { type: ObjectId, default: null },
      fxLossAccountId: { type: ObjectId, default: null },
      /** Unrealised FX on period-end revaluation (Phase 3). */
      unrealisedFxGainAccountId: { type: ObjectId, default: null },
      unrealisedFxLossAccountId: { type: ObjectId, default: null },
      /** Clearing account that keeps every branch balanced when a journal spans branches. */
      interBranchAccountId: { type: ObjectId, default: null },
      /** Phase 4: liability for approved employee expense claims awaiting reimbursement. */
      employeeClaimsAccountId: { type: ObjectId, default: null },
      /** Staff imprest advances not yet accounted for (an asset, created on first use). */
      imprestAccountId: { type: ObjectId, default: null },
      /** Goods received not invoiced: credited when stock arrives on a goods received note, debited by the bill. */
      grniAccountId: { type: ObjectId, default: null },
      /** Net pay owed to employees, cleared when salaries are paid. */
      salariesPayableAccountId: { type: ObjectId, default: null },
      /** Freight, duty and clearing charges wait here until a landed-cost allocation moves them into stock. */
      landedCostAccountId: { type: ObjectId, default: null },
      /** Notify department heads when spending and commitments reach this % of a budget line (null: off). */
      budgetAlertPercent: { type: Number, default: null },
      /** Phase 4: spending against approved budgets on purchase orders and bills. */
      budgetControl: { type: String, enum: ['OFF', 'WARN', 'BLOCK'], default: 'WARN' },
      /** Years supporting documents on posted records are kept. */
      documentRetentionYears: { type: Number, default: 7 },
      /** Every user must sign in with a second factor. */
      requireMfa: { type: Boolean, default: false },
      /** AI assistance sends documents and figures to the model provider; off until an administrator allows it. */
      aiEnabled: { type: Boolean, default: false },
      /** Single sign-on through an OpenID Connect provider (Microsoft Entra ID, Google Workspace, Okta...). */
      sso: {
        enabled: { type: Boolean, default: false },
        /** OpenID Connect, or SAML 2.0 for providers without it (e.g. ADFS). */
        protocol: { type: String, enum: ['OIDC', 'SAML'], default: 'OIDC' },
        label: { type: String, default: '' },
        saml: {
          /** The identity provider's single sign-on URL (HTTP-Redirect binding). */
          entryPoint: { type: String, default: '' },
          /** The identity provider's entity ID (checked against the response issuer when set). */
          idpIssuer: { type: String, default: '' },
          /** The identity provider's signing certificate (PEM). */
          idpCert: { type: String, default: '' },
        },
        issuer: { type: String, default: '' },
        clientId: { type: String, default: '' },
        clientSecret: { type: String, default: null },
        allowedDomains: { type: [String], default: [] },
        /** When false, users must sign in through SSO (administrators keep password sign-in for emergencies). */
        allowPasswordLogin: { type: Boolean, default: true },
      },
      /** SCIM user provisioning from the identity provider (bearer token stored as a hash). */
      scim: {
        enabled: { type: Boolean, default: false },
        tokenHash: { type: String, default: null },
        defaultRoleIds: { type: [ObjectId], default: [] },
        lastUsedAt: { type: Date, default: null },
      },
      /** Text messages to customers (each costs money, so off until an administrator turns it on). */
      sms: {
        enabled: { type: Boolean, default: false },
        /** Confirm M-Pesa payments to the payer's phone. */
        paymentConfirmations: { type: Boolean, default: true },
        /** Text approvers who opted in when something is waiting for them. */
        approvalAlerts: { type: Boolean, default: false },
      },
      /** Allowed unit-price variance (percent) between a purchase order and the supplier bill. */
      matchTolerancePercent: { type: Decimal128, default: null },
    },
    /** Data-migration level; see MigrationsService. */
    schemaVersion: { type: Number, default: 1 },
  },
  options,
);

export const UserSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, index: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    /** Mobile number for expense reimbursements by M-Pesa. */
    phone: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    /** The person's role in the finance module on the platform; finance roles are reset when it changes. */
    platformRole: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    roleIds: { type: [ObjectId], default: [] },
    /** When false the user may only see and transact on the branches listed in branchIds. */
    allBranches: { type: Boolean, default: true },
    branchIds: { type: [ObjectId], default: [] },
    /** Maximum journal value (functional currency) the user may approve. Null means unlimited. */
    approvalLimit: { type: Decimal128, default: null },
    /** Incremented to invalidate all issued tokens (logout everywhere, password change, deactivation). */
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    /** Service accounts act through API keys only and can never sign in with a password. */
    isServiceAccount: { type: Boolean, default: false },
    /** Time-based one-time passwords (RFC 6238). Secrets are encrypted; recovery codes are hashed. */
    mfa: {
      enabled: { type: Boolean, default: false },
      secret: { type: String, default: null },
      pendingSecret: { type: String, default: null },
      recoveryCodes: { type: [String], default: [] },
      enabledAt: { type: Date, default: null },
      lastUsedStep: { type: Number, default: null },
    },
    /** How the user hears about approvals waiting for them: at once, in a daily digest, or not by email. */
    emailPreferences: {
      approvals: { type: String, enum: ['immediate', 'digest', 'off'], default: 'immediate' },
      lastDigestAt: { type: Date, default: null },
    },
    /** Text messages for items waiting for this user's approval (when the organisation allows them). */
    smsPreferences: {
      approvals: { type: Boolean, default: false },
    },
    /** Invited users choose their own password from the invitation email. */
    invitedAt: { type: Date, default: null },
    passwordSetAt: { type: Date, default: null },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    /** Provisioned by SCIM: the identity provider's id for the person. */
    scimExternalId: { type: String, default: null },
  },
  options,
);

export const RoleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    isSystem: { type: Boolean, default: false },
    permissions: { type: [String], default: [] },
  },
  options,
);
RoleSchema.index({ organisationId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Currencies & exchange rates
// ---------------------------------------------------------------------------------------------

/** Global ISO 4217 reference list shared by all tenants. */
export const CurrencySchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    name: { type: String, required: true },
    symbol: { type: String, default: '' },
    precision: { type: Number, required: true, min: 0, max: 4 },
  },
  options,
);

export const ExchangeRateSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    fromCurrency: { type: String, required: true },
    toCurrency: { type: String, required: true },
    rateType: { type: String, enum: RATE_TYPES, default: 'SPOT' },
    /** 1 unit of fromCurrency = rate units of toCurrency. */
    rate: { type: Decimal128, required: true },
    effectiveDate: { type: Date, required: true },
    source: { type: String, default: 'MANUAL' },
    status: { type: String, enum: RATE_STATUSES, default: 'PENDING' },
    createdBy: { type: ObjectId, required: true },
    approvedBy: { type: ObjectId, default: null },
    approvedAt: { type: Date, default: null },
  },
  options,
);
ExchangeRateSchema.index({ organisationId: 1, fromCurrency: 1, toCurrency: 1, rateType: 1, status: 1, effectiveDate: -1 });

// ---------------------------------------------------------------------------------------------
// Organisation structure & dimensions
// ---------------------------------------------------------------------------------------------

export const LegalEntitySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    legalName: { type: String, default: '' },
    registrationNumber: { type: String, default: '' },
    taxId: { type: String, default: '' },
    country: { type: String, default: '' },
    functionalCurrency: { type: String, required: true },
    /** Shown on invoices and statements. */
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    website: { type: String, default: '' },
    /** How customers should pay (bank details, M-Pesa paybill), printed on invoices. */
    paymentInstructions: { type: String, default: '' },
    /** The group's ownership share (%). Below 100 the rest is a non-controlling interest on consolidation. */
    ownershipPercent: { type: Decimal128, default: null },
    isActive: { type: Boolean, default: true },
  },
  options,
);
LegalEntitySchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const BranchSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    country: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    taxRegistrationNumber: { type: String, default: '' },
    /** Default transaction currency for the branch; the ledger still posts in the entity's functional currency. */
    currency: { type: String, required: true },
    managerUserId: { type: ObjectId, default: null },
    isActive: { type: Boolean, default: true },
  },
  options,
);
BranchSchema.index({ organisationId: 1, code: 1 }, { unique: true });
BranchSchema.index({ organisationId: 1, entityId: 1 });

export const DimensionValueSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    type: { type: String, enum: DIMENSION_TYPES, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    /** Optional restriction to a single legal entity. */
    entityId: { type: ObjectId, default: null },
    /** Departments: the head who receives budget balance notices. */
    headUserId: { type: ObjectId, default: null },
    /** Projects: commercial details for project profitability (Phase 4). */
    project: {
      customerId: { type: ObjectId, default: null },
      managerUserId: { type: ObjectId, default: null },
      contractValue: { type: Decimal128, default: null },
      budgetCost: { type: Decimal128, default: null },
      startDate: { type: Date, default: null },
      endDate: { type: Date, default: null },
      status: { type: String, enum: ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED'], default: 'ACTIVE' },
    },
    isActive: { type: Boolean, default: true },
  },
  options,
);
DimensionValueSchema.index({ organisationId: 1, type: 1, code: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Chart of accounts & periods
// ---------------------------------------------------------------------------------------------

export const AccountSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    accountClass: { type: String, enum: ACCOUNT_CLASSES, required: true },
    accountType: { type: String, enum: ALL_ACCOUNT_TYPES, required: true },
    parentId: { type: ObjectId, default: null },
    /** Header accounts group others and cannot receive postings. */
    isPostable: { type: Boolean, default: true },
    /** Control accounts are fed by subledgers (AR, AP, ...). */
    isControl: { type: Boolean, default: false },
    allowManualPosting: { type: Boolean, default: true },
    /** When set, lines on this account must be in this transaction currency (e.g. a USD bank account). */
    currency: { type: String, default: null },
    requiresDepartment: { type: Boolean, default: false },
    requiresCostCentre: { type: Boolean, default: false },
    requiresProject: { type: Boolean, default: false },
    /** Entities the account may be used in. Empty means all entities. */
    entityIds: { type: [ObjectId], default: [] },
    isActive: { type: Boolean, default: true },
  },
  options,
);
AccountSchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const FiscalYearSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
  },
  options,
);
FiscalYearSchema.index({ organisationId: 1, entityId: 1, startDate: 1 }, { unique: true });

export const PeriodSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    fiscalYearId: { type: ObjectId, required: true },
    number: { type: Number, required: true },
    name: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: PERIOD_STATUSES, default: 'OPEN' },
    statusChangedBy: { type: ObjectId, default: null },
    statusChangedAt: { type: Date, default: null },
    statusReason: { type: String, default: '' },
  },
  options,
);
PeriodSchema.index({ organisationId: 1, entityId: 1, startDate: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Journals & the posted ledger
// ---------------------------------------------------------------------------------------------

const JournalLineSchema = new Schema(
  {
    lineNo: { type: Number, required: true },
    accountId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    departmentId: { type: ObjectId, default: null },
    costCentreId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
    fundId: { type: ObjectId, default: null },
    /** Customer or supplier the line relates to (subledger postings to control accounts). */
    partyType: { type: String, default: null },
    partyId: { type: ObjectId, default: null },
    /** Intercompany: the other group entity (loans, interest, recharges); eliminated on consolidation. */
    intercompanyEntityId: { type: ObjectId, default: null },
    /** Added by the system to balance branches against the inter-branch clearing account. */
    autoInterBranch: { type: Boolean, default: false },
    description: { type: String, default: '' },
    /** Transaction currency and the rate used to translate into the entity's functional currency. */
    currency: { type: String, required: true },
    exchangeRate: { type: Decimal128, required: true },
    debitTx: { type: Decimal128, required: true },
    creditTx: { type: Decimal128, required: true },
    /** Functional-currency amounts. */
    debit: { type: Decimal128, required: true },
    credit: { type: Decimal128, required: true },
  },
  { _id: false },
);

export const JournalSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    journalDate: { type: Date, required: true },
    periodId: { type: ObjectId, required: true },
    description: { type: String, required: true },
    reference: { type: String, default: '' },
    type: { type: String, enum: JOURNAL_TYPES, default: 'STANDARD' },
    source: { type: String, enum: JOURNAL_SOURCES, default: 'MANUAL' },
    status: { type: String, enum: JOURNAL_STATUSES, default: 'DRAFT' },
    functionalCurrency: { type: String, required: true },
    totalDebit: { type: Decimal128, required: true },
    totalCredit: { type: Decimal128, required: true },
    autoReverseDate: { type: Date, default: null },
    reversalOfId: { type: ObjectId, default: null },
    reversedById: { type: ObjectId, default: null },
    /** The subledger document that generated a SYSTEM journal (invoice, payment, transfer, ...). */
    sourceType: { type: String, default: null },
    sourceId: { type: ObjectId, default: null },
    sourceNumber: { type: String, default: null },
    idempotencyKey: { type: String, default: undefined },
    lines: { type: [JournalLineSchema], default: [] },
    createdBy: { type: ObjectId, required: true },
    submittedBy: { type: ObjectId, default: null },
    submittedAt: { type: Date, default: null },
    approvedBy: { type: ObjectId, default: null },
    approvedAt: { type: Date, default: null },
    postedBy: { type: ObjectId, default: null },
    postedAt: { type: Date, default: null },
    rejectedBy: { type: ObjectId, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
  },
  options,
);
JournalSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
JournalSchema.index({ organisationId: 1, status: 1, journalDate: -1 });
JournalSchema.index({ organisationId: 1, sourceId: 1 });
JournalSchema.index(
  { organisationId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

/** Immutable general-ledger rows written when a journal is posted. All reports read from here. */
export const LedgerEntrySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    journalId: { type: ObjectId, required: true },
    journalNumber: { type: String, required: true },
    lineNo: { type: Number, required: true },
    date: { type: Date, required: true },
    periodId: { type: ObjectId, required: true },
    accountId: { type: ObjectId, required: true },
    accountClass: { type: String, enum: ACCOUNT_CLASSES, required: true },
    branchId: { type: ObjectId, required: true },
    departmentId: { type: ObjectId, default: null },
    costCentreId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
    fundId: { type: ObjectId, default: null },
    partyType: { type: String, default: null },
    partyId: { type: ObjectId, default: null },
    intercompanyEntityId: { type: ObjectId, default: null },
    description: { type: String, default: '' },
    currency: { type: String, required: true },
    exchangeRate: { type: Decimal128, required: true },
    debitTx: { type: Decimal128, required: true },
    creditTx: { type: Decimal128, required: true },
    debit: { type: Decimal128, required: true },
    credit: { type: Decimal128, required: true },
    source: { type: String, required: true },
    postedAt: { type: Date, required: true },
  },
  { versionKey: false },
);
// Account activity pages in date, journal and line order straight off the index (no in-memory sort).
LedgerEntrySchema.index({ organisationId: 1, entityId: 1, accountId: 1, date: 1, journalNumber: 1, lineNo: 1 });
LedgerEntrySchema.index({ organisationId: 1, entityId: 1, date: 1 });
LedgerEntrySchema.index({ journalId: 1, lineNo: 1 }, { unique: true });
LedgerEntrySchema.index({ organisationId: 1, partyId: 1, date: 1 });
LedgerEntrySchema.index({ organisationId: 1, intercompanyEntityId: 1, date: 1 }, { partialFilterExpression: { intercompanyEntityId: { $type: 'objectId' } } });
// Foreign-currency balances (revaluation, FX exposure) without reading every functional-currency line.
LedgerEntrySchema.index({ organisationId: 1, entityId: 1, currency: 1, accountId: 1, date: 1 });

// ---------------------------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------------------------

export const CounterSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, default: null },
    key: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);
CounterSchema.index({ organisationId: 1, entityId: 1, key: 1 }, { unique: true });

export const AuditEventSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, default: null },
    userName: { type: String, default: 'system' },
    action: { type: String, required: true },
    recordType: { type: String, required: true },
    recordId: { type: ObjectId, default: null },
    summary: { type: String, default: '' },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
AuditEventSchema.index({ organisationId: 1, createdAt: -1 });
AuditEventSchema.index({ organisationId: 1, recordType: 1, recordId: 1 });

// ---------------------------------------------------------------------------------------------

export type Organisation = InferSchemaType<typeof OrganisationSchema> & { _id: Types.ObjectId };
export type User = InferSchemaType<typeof UserSchema> & { _id: Types.ObjectId };
export type Role = InferSchemaType<typeof RoleSchema> & { _id: Types.ObjectId };
export type Currency = InferSchemaType<typeof CurrencySchema> & { _id: Types.ObjectId };
export type ExchangeRate = InferSchemaType<typeof ExchangeRateSchema> & { _id: Types.ObjectId };
export type LegalEntity = InferSchemaType<typeof LegalEntitySchema> & { _id: Types.ObjectId };
export type Branch = InferSchemaType<typeof BranchSchema> & { _id: Types.ObjectId };
export type DimensionValue = InferSchemaType<typeof DimensionValueSchema> & { _id: Types.ObjectId };
export type Account = InferSchemaType<typeof AccountSchema> & { _id: Types.ObjectId };
export type FiscalYear = InferSchemaType<typeof FiscalYearSchema> & { _id: Types.ObjectId };
export type Period = InferSchemaType<typeof PeriodSchema> & { _id: Types.ObjectId };
export type JournalLine = InferSchemaType<typeof JournalLineSchema>;
export type Journal = InferSchemaType<typeof JournalSchema> & { _id: Types.ObjectId };
export type LedgerEntry = InferSchemaType<typeof LedgerEntrySchema> & { _id: Types.ObjectId };
export type Counter = InferSchemaType<typeof CounterSchema> & { _id: Types.ObjectId };
export type AuditEvent = InferSchemaType<typeof AuditEventSchema> & { _id: Types.ObjectId };
export type JournalDoc = HydratedDocument<Journal>;

export const MODELS = {
  Organisation: OrganisationSchema,
  User: UserSchema,
  Role: RoleSchema,
  Currency: CurrencySchema,
  ExchangeRate: ExchangeRateSchema,
  LegalEntity: LegalEntitySchema,
  Branch: BranchSchema,
  DimensionValue: DimensionValueSchema,
  Account: AccountSchema,
  FiscalYear: FiscalYearSchema,
  Period: PeriodSchema,
  Journal: JournalSchema,
  LedgerEntry: LedgerEntrySchema,
  Counter: CounterSchema,
  AuditEvent: AuditEventSchema,
} as const;
