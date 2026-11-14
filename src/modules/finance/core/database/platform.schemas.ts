import { InferSchemaType, Schema, Types } from 'mongoose';

/**
 * Phase 5 (enterprise) data model: API keys and idempotency, webhooks with a transactional outbox,
 * the approval workflow engine, in-app notifications and the reporting warehouse. Every collection is
 * tenant-scoped by organisationId.
 */

const ObjectId = Schema.Types.ObjectId;
const Decimal128 = Schema.Types.Decimal128;
const options = { timestamps: true, versionKey: false } as const;

// ---------------------------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------------------------

/** A secret for a service account. Only a SHA-256 hash is stored; the key is shown once. */
export const ApiKeySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    prefix: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    createdBy: { type: ObjectId, required: true },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    lastUsedIp: { type: String, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: ObjectId, default: null },
  },
  options,
);
ApiKeySchema.index({ organisationId: 1, userId: 1 });

/** A replayable response for an Idempotency-Key, kept for 24 hours. */
export const IdempotencyRecordSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    key: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'DONE'], default: 'PENDING' },
    responseStatus: { type: Number, default: null },
    responseBody: { type: String, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
IdempotencyRecordSchema.index({ organisationId: 1, userId: 1, key: 1 }, { unique: true });
IdempotencyRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export const WebhookEndpointSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    url: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    /** Event types, `prefix.*` patterns or `*` for everything. */
    events: { type: [String], default: ['*'] },
    secret: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    consecutiveFailures: { type: Number, default: 0 },
    disabledReason: { type: String, default: '' },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
WebhookEndpointSchema.index({ organisationId: 1, isActive: 1 });

/** Outbox row, written in the same transaction as the audit event it describes. */
export const WebhookEventSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    type: { type: String, required: true },
    recordType: { type: String, required: true },
    recordId: { type: ObjectId, default: null },
    summary: { type: String, default: '' },
    actor: { type: String, default: '' },
    occurredAt: { type: Date, required: true },
  },
  { versionKey: false },
);
WebhookEventSchema.index({ organisationId: 1, occurredAt: -1 });

export const WEBHOOK_DELIVERY_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export const WebhookDeliverySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    endpointId: { type: ObjectId, required: true },
    eventId: { type: ObjectId, required: true },
    eventType: { type: String, required: true },
    status: { type: String, enum: WEBHOOK_DELIVERY_STATUSES, default: 'PENDING' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lastAttemptAt: { type: Date, default: null },
    lastStatusCode: { type: Number, default: null },
    lastError: { type: String, default: '' },
    deliveredAt: { type: Date, default: null },
    /** Set while a worker is sending, so concurrent cron runs never double-send. */
    lockedUntil: { type: Date, default: null },
  },
  options,
);
WebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
WebhookDeliverySchema.index({ organisationId: 1, endpointId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------------------------

export const WORKFLOW_DOCUMENT_TYPES = [
  'JOURNAL',
  'SALES_INVOICE',
  'SALES_CREDIT',
  'PURCHASE_BILL',
  'PURCHASE_CREDIT',
  'SUPPLIER_PAYMENT',
  'PURCHASE_REQUISITION',
  'PURCHASE_ORDER',
  'EXPENSE_CLAIM',
  'IMPREST',
  'IMPREST_SURRENDER',
  'BUDGET',
  'BUDGET_SUBMISSION',
  'BUDGET_REALLOCATION',
  'STOCK_DOCUMENT',
  'CONSOLIDATION_ADJUSTMENT',
] as const;
export type WorkflowDocumentType = (typeof WORKFLOW_DOCUMENT_TYPES)[number];

/** Who may act on a step: holders of the document's approve permission, members of a role, or one user. */
export const APPROVER_TYPES = ['PERMISSION', 'ROLE', 'USER'] as const;

const StepDefinition = new Schema(
  {
    name: { type: String, required: true, trim: true },
    approverType: { type: String, enum: APPROVER_TYPES, required: true },
    roleId: { type: ObjectId, default: null },
    userId: { type: ObjectId, default: null },
    /** More than one means parallel approval: that many different people must approve this step. */
    requiredApprovals: { type: Number, default: 1, min: 1 },
  },
  { _id: false },
);

export const ApprovalRuleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    documentType: { type: String, enum: WORKFLOW_DOCUMENT_TYPES, required: true },
    /** Lower runs first; the first matching active rule applies. */
    priority: { type: Number, default: 100 },
    entityId: { type: ObjectId, default: null },
    branchIds: { type: [ObjectId], default: [] },
    /** Functional-currency value range (inclusive minimum, exclusive maximum). */
    minAmount: { type: Decimal128, default: null },
    maxAmount: { type: Decimal128, default: null },
    steps: { type: [StepDefinition], default: [] },
    slaHours: { type: Number, default: null },
    escalateToUserId: { type: ObjectId, default: null },
    escalateToRoleId: { type: ObjectId, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
ApprovalRuleSchema.index({ organisationId: 1, documentType: 1, isActive: 1, priority: 1 });

const StepApproval = new Schema(
  {
    userId: { type: ObjectId, required: true },
    userName: { type: String, required: true },
    /** The delegator, when a delegate acted on their behalf. */
    onBehalfOfId: { type: ObjectId, default: null },
    onBehalfOfName: { type: String, default: null },
    comment: { type: String, default: '' },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const RequestStep = new Schema(
  {
    name: { type: String, required: true },
    approverType: { type: String, enum: APPROVER_TYPES, required: true },
    roleId: { type: ObjectId, default: null },
    userId: { type: ObjectId, default: null },
    requiredApprovals: { type: Number, default: 1 },
    status: { type: String, enum: ['WAITING', 'ACTIVE', 'APPROVED', 'REJECTED'], default: 'WAITING' },
    approvals: { type: [StepApproval], default: [] },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

export const APPROVAL_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export const ApprovalRequestSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    documentType: { type: String, enum: WORKFLOW_DOCUMENT_TYPES, required: true },
    documentId: { type: ObjectId, required: true },
    documentNumber: { type: String, default: '' },
    description: { type: String, default: '' },
    entityId: { type: ObjectId, default: null },
    branchId: { type: ObjectId, default: null },
    amount: { type: Decimal128, default: null },
    currency: { type: String, default: null },
    ruleId: { type: ObjectId, default: null },
    ruleName: { type: String, default: 'Default approval' },
    steps: { type: [RequestStep], default: [] },
    currentStep: { type: Number, default: 0 },
    status: { type: String, enum: APPROVAL_REQUEST_STATUSES, default: 'PENDING' },
    submittedBy: { type: ObjectId, default: null },
    submittedByName: { type: String, default: '' },
    preparedBy: { type: ObjectId, default: null },
    submittedAt: { type: Date, required: true },
    dueAt: { type: Date, default: null },
    escalateToUserId: { type: ObjectId, default: null },
    escalateToRoleId: { type: ObjectId, default: null },
    escalatedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    outcomeBy: { type: ObjectId, default: null },
    rejectionReason: { type: String, default: '' },
  },
  options,
);
ApprovalRequestSchema.index({ organisationId: 1, status: 1, documentType: 1 });
ApprovalRequestSchema.index({ organisationId: 1, documentType: 1, documentId: 1, status: 1 });
ApprovalRequestSchema.index({ status: 1, dueAt: 1 });

/** Temporary hand-over of approval authority, e.g. while on leave. */
export const DelegationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    fromUserId: { type: ObjectId, required: true },
    toUserId: { type: ObjectId, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    /** Empty means every document type. */
    documentTypes: { type: [String], default: [] },
    reason: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
DelegationSchema.index({ organisationId: 1, toUserId: 1, isActive: 1 });

export const NotificationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    kind: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    link: { type: String, default: null },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
NotificationSchema.index({ organisationId: 1, userId: 1, readAt: 1, createdAt: -1 });
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// ---------------------------------------------------------------------------------------------
// Reporting warehouse
// ---------------------------------------------------------------------------------------------

/**
 * Monthly ledger facts by entity, branch, account and dimension: the read model for BI, trends and
 * forecasting, so analytical queries never scan the transactional ledger.
 */
export const LedgerFactSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    month: { type: Date, required: true },
    branchId: { type: ObjectId, required: true },
    accountId: { type: ObjectId, required: true },
    accountClass: { type: String, required: true },
    accountType: { type: String, default: null },
    departmentId: { type: ObjectId, default: null },
    costCentreId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
    debit: { type: Decimal128, required: true },
    credit: { type: Decimal128, required: true },
    entries: { type: Number, required: true },
    /** Manual postings (journals typed in, imported or sent by API): count, sum and sum of squares of line
     * amounts, for the unusual-amount analysis without rescanning a year of ledger. */
    manualCount: { type: Number, default: 0 },
    manualSum: { type: Number, default: 0 },
    manualSumSq: { type: Number, default: 0 },
  },
  { versionKey: false },
);
// One row per month, branch, account and dimension combination: postings add to it in place.
LedgerFactSchema.index({ organisationId: 1, entityId: 1, month: 1, branchId: 1, accountId: 1, departmentId: 1, costCentreId: 1, projectId: 1 }, { unique: true });
LedgerFactSchema.index({ organisationId: 1, entityId: 1, month: 1 });
LedgerFactSchema.index({ organisationId: 1, entityId: 1, accountClass: 1, month: 1 });

export const WarehouseStateSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, unique: true },
    /** postedAt of the newest ledger row already loaded (before totals were maintained live). */
    watermark: { type: Date, default: null },
    /** Totals are updated with every posting; set once the first full build is done. */
    live: { type: Boolean, default: false },
    lastRefreshedAt: { type: Date, default: null },
    lastDurationMs: { type: Number, default: null },
    monthsRefreshed: { type: Number, default: 0 },
    facts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { versionKey: false },
);

export const PLATFORM_MODELS = {
  ApiKey: ApiKeySchema,
  IdempotencyRecord: IdempotencyRecordSchema,
  WebhookEndpoint: WebhookEndpointSchema,
  WebhookEvent: WebhookEventSchema,
  WebhookDelivery: WebhookDeliverySchema,
  ApprovalRule: ApprovalRuleSchema,
  ApprovalRequest: ApprovalRequestSchema,
  Delegation: DelegationSchema,
  Notification: NotificationSchema,
  LedgerFact: LedgerFactSchema,
  WarehouseState: WarehouseStateSchema,
} as const;

// ---------------------------------------------------------------------------------------------

type WithId<T> = T & { _id: Types.ObjectId };
export type ApiKey = WithId<InferSchemaType<typeof ApiKeySchema>>;
export type IdempotencyRecord = WithId<InferSchemaType<typeof IdempotencyRecordSchema>>;
export type WebhookEndpoint = WithId<InferSchemaType<typeof WebhookEndpointSchema>>;
export type WebhookEvent = WithId<InferSchemaType<typeof WebhookEventSchema>>;
export type WebhookDelivery = WithId<InferSchemaType<typeof WebhookDeliverySchema>>;
export type ApprovalRule = WithId<InferSchemaType<typeof ApprovalRuleSchema>>;
export type ApprovalRequest = WithId<InferSchemaType<typeof ApprovalRequestSchema>>;
export type Delegation = WithId<InferSchemaType<typeof DelegationSchema>>;
export type Notification = WithId<InferSchemaType<typeof NotificationSchema>>;
export type LedgerFact = WithId<InferSchemaType<typeof LedgerFactSchema>>;
export type WarehouseState = WithId<InferSchemaType<typeof WarehouseStateSchema>>;
