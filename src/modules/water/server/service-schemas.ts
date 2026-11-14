import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;

// ---------------------------------------------------------------------------------------------
// Customer service: complaints, incidents and service requests
// ---------------------------------------------------------------------------------------------

export const TICKET_CATEGORIES = ['BILLING', 'NO_WATER', 'LOW_PRESSURE', 'LEAK', 'BURST', 'METER', 'WATER_QUALITY', 'SEWER', 'NEW_CONNECTION', 'RECONNECTION', 'ILLEGAL_CONNECTION', 'STAFF_CONDUCT', 'OTHER'] as const;
export const TICKET_CHANNELS = ['WALK_IN', 'PHONE', 'CALL_CENTRE', 'SMS', 'USSD', 'PORTAL', 'EMAIL', 'FIELD', 'SOCIAL_MEDIA'] as const;
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'URGENT', 'EMERGENCY'] as const;
export const TICKET_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED'] as const;

/** Hours to resolve, per category (WASREB customer service standards); editable in Water settings. */
export const DEFAULT_SLA_HOURS: Record<(typeof TICKET_CATEGORIES)[number], number> = {
  BILLING: 72,
  NO_WATER: 24,
  LOW_PRESSURE: 48,
  LEAK: 24,
  BURST: 6,
  METER: 72,
  WATER_QUALITY: 24,
  SEWER: 12,
  NEW_CONNECTION: 168,
  RECONNECTION: 24,
  ILLEGAL_CONNECTION: 72,
  STAFF_CONDUCT: 120,
  OTHER: 72,
};

export const ticketSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    category: { type: String, enum: TICKET_CATEGORIES, required: true },
    channel: { type: String, enum: TICKET_CHANNELS, required: true },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'NORMAL' },
    status: { type: String, enum: TICKET_STATUSES, default: 'OPEN' },
    customerId: { type: ObjectId, default: null },
    accountNo: String,
    name: String,
    phone: String,
    email: String,
    subject: { type: String, required: true },
    description: String,
    zoneId: { type: ObjectId, default: null },
    location: String,
    gps: { lat: Number, lng: Number },
    assignedTo: { type: ObjectId, default: null },
    slaDueAt: Date,
    escalatedAt: Date,
    escalationLevel: { type: Number, default: 0 },
    firstResponseAt: Date,
    resolvedAt: Date,
    closedAt: Date,
    resolution: String,
    /** The customer confirmed it is sorted (closing waits for this, or for the auto-close days). */
    customerConfirmed: { type: Boolean, default: false },
    /** 1–5 from the customer when closing (CSAT). */
    satisfaction: { type: Number, min: 1, max: 5, default: null },
    /** "How likely are you to recommend us?" 0–10, for the net promoter score. */
    recommend: { type: Number, min: 0, max: 10, default: null },
    workOrderId: { type: ObjectId, default: null },
    /** Set by intake from outside systems (call centre id, SMS id) so a retried push is stored once. */
    externalRef: String,
    createdBy: ObjectId,
    history: [{ at: Date, by: ObjectId, action: String, note: String, status: String, _id: false }],
  },
  opts,
);
ticketSchema.index({ organisationId: 1, number: 1 }, { unique: true });
ticketSchema.index({ organisationId: 1, status: 1, slaDueAt: 1 });
ticketSchema.index({ organisationId: 1, customerId: 1, createdAt: -1 });
ticketSchema.index({ organisationId: 1, externalRef: 1 }, { unique: true, partialFilterExpression: { externalRef: { $type: 'string' } } });

// ---------------------------------------------------------------------------------------------
// Debt management: payment plans and collection / legal cases
// ---------------------------------------------------------------------------------------------

export const PLAN_STATUSES = ['PENDING', 'ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED', 'REJECTED'] as const;

export const paymentPlanSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    customerId: { type: ObjectId, required: true },
    accountNo: String,
    /** Arrears the plan clears (the balance when it was agreed). */
    arrears: { ...D128 },
    deposit: { ...D128 },
    instalments: [{ dueDate: Date, amount: Decimal128, paid: { ...D128 }, _id: false }],
    /** Payments credited since the plan started; instalments are cleared in date order. */
    paidToDate: { ...D128 },
    startDate: { type: Date, required: true },
    status: { type: String, enum: PLAN_STATUSES, default: 'PENDING' },
    /** Days an instalment may run late before the plan is in default. */
    graceDays: { type: Number, default: 7 },
    notes: String,
    createdBy: ObjectId,
    approvedBy: ObjectId,
    approvedAt: Date,
    closedAt: Date,
  },
  opts,
);
paymentPlanSchema.index({ organisationId: 1, number: 1 }, { unique: true });
paymentPlanSchema.index({ organisationId: 1, customerId: 1, status: 1 });

export const CASE_STAGES = ['REMINDER', 'DEMAND_LETTER', 'FINAL_NOTICE', 'DEBT_COLLECTOR', 'LEGAL', 'JUDGEMENT', 'SETTLED', 'WRITTEN_OFF'] as const;
export const CLOSED_STAGES = ['SETTLED', 'WRITTEN_OFF'];

export const debtCaseSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    customerId: { type: ObjectId, required: true },
    accountNo: String,
    category: String,
    amount: { ...D128 },
    stage: { type: String, enum: CASE_STAGES, default: 'REMINDER' },
    open: { type: Boolean, default: true },
    assignedTo: { type: ObjectId, default: null },
    collector: String,
    legal: { advocate: String, court: String, caseNo: String, filedAt: Date, nextHearing: Date, judgementAmount: Decimal128 },
    writeOffAdjustmentId: { type: ObjectId, default: null },
    nextActionAt: Date,
    history: [{ at: Date, by: ObjectId, stage: String, note: String, _id: false }],
    createdBy: ObjectId,
  },
  opts,
);
debtCaseSchema.index({ organisationId: 1, number: 1 }, { unique: true });
debtCaseSchema.index({ organisationId: 1, open: 1, stage: 1 });
debtCaseSchema.index({ organisationId: 1, customerId: 1, open: 1 });

// ---------------------------------------------------------------------------------------------
// Notices to customers (interruptions, rationing) and the self-service portal
// ---------------------------------------------------------------------------------------------

export const NOTICE_TYPES = ['INTERRUPTION', 'RATIONING', 'WATER_QUALITY', 'TARIFF', 'GENERAL'] as const;

export const noticeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    type: { type: String, enum: NOTICE_TYPES, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    zoneIds: [{ type: ObjectId }],
    startsAt: Date,
    endsAt: Date,
    sentCount: { type: Number, default: 0 },
    /** Also shown on the customer portal and read out by USSD while current. */
    publish: { type: Boolean, default: true },
    createdBy: ObjectId,
  },
  opts,
);
noticeSchema.index({ organisationId: 1, createdAt: -1 });

/** One-time sign-in codes sent by SMS to the phone on the account. */
export const portalCodeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
portalCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
portalCodeSchema.index({ organisationId: 1, customerId: 1, createdAt: -1 });

export type TicketDoc = InferSchemaType<typeof ticketSchema> & { _id: Types.ObjectId };
export type PaymentPlanDoc = InferSchemaType<typeof paymentPlanSchema> & { _id: Types.ObjectId };
export type DebtCaseDoc = InferSchemaType<typeof debtCaseSchema> & { _id: Types.ObjectId };
