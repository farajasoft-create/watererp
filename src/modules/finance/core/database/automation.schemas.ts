import { InferSchemaType, Schema, Types } from 'mongoose';

/**
 * Phase 7 (automation & AI) data model: recurring journal templates, collection activity, and a log
 * of AI-assisted requests. Every collection is tenant-scoped by organisationId.
 */

const ObjectId = Schema.Types.ObjectId;
const Decimal128 = Schema.Types.Decimal128;
const options = { timestamps: true, versionKey: false } as const;

export const RECURRENCE_FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

const TemplateLine = new Schema(
  {
    accountId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, default: null },
    departmentId: { type: ObjectId, default: null },
    costCentreId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
    fundId: { type: ObjectId, default: null },
    description: { type: String, default: '' },
    currency: { type: String, default: null },
    debit: { type: Decimal128, default: null },
    credit: { type: Decimal128, default: null },
  },
  { _id: false },
);

const Run = new Schema(
  {
    date: { type: Date, required: true },
    journalId: { type: ObjectId, default: null },
    journalNumber: { type: String, default: null },
    status: { type: String, enum: ['CREATED', 'SUBMITTED', 'FAILED', 'SKIPPED'], required: true },
    error: { type: String, default: '' },
    at: { type: Date, required: true },
  },
  { _id: false },
);

/** A journal that repeats on a schedule (rent, depreciation of leases, accruals, management fees). */
export const RecurringJournalSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    /** May contain {month}, {monthName}, {year}, {period} and {date}. */
    description: { type: String, required: true },
    reference: { type: String, default: '' },
    type: { type: String, enum: ['STANDARD', 'ACCRUAL'], default: 'STANDARD' },
    /** Accruals reverse on the first day of the next month. */
    autoReverse: { type: Boolean, default: false },
    lines: { type: [TemplateLine], default: [] },
    frequency: { type: String, enum: RECURRENCE_FREQUENCIES, required: true },
    interval: { type: Number, default: 1, min: 1, max: 12 },
    /** Day of the month (1–28), or 31 for the last day. Weekly schedules repeat on the start date's weekday. */
    dayOfMonth: { type: Number, default: 1 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    maxOccurrences: { type: Number, default: null },
    /** DRAFT leaves the journal for review; SUBMIT sends it into approval. */
    action: { type: String, enum: ['DRAFT', 'SUBMIT'], default: 'SUBMIT' },
    /** Journals are prepared in this user's name (normally the creator). */
    ownerId: { type: ObjectId, required: true },
    nextRunDate: { type: Date, default: null },
    occurrences: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    runs: { type: [Run], default: [] },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
RecurringJournalSchema.index({ isActive: 1, nextRunDate: 1 });
RecurringJournalSchema.index({ organisationId: 1, entityId: 1 });

export const COLLECTION_ACTIVITY_TYPES = ['CALL', 'EMAIL', 'SMS', 'LETTER', 'MEETING', 'PROMISE', 'DISPUTE', 'NOTE'] as const;

/** A contact with a customer about money owed, optionally with a promise to pay. */
export const CollectionActivitySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, required: true },
    type: { type: String, enum: COLLECTION_ACTIVITY_TYPES, required: true },
    note: { type: String, default: '' },
    promiseDate: { type: Date, default: null },
    promiseAmount: { type: Decimal128, default: null },
    followUpDate: { type: Date, default: null },
    createdBy: { type: ObjectId, required: true },
    createdByName: { type: String, required: true },
  },
  options,
);
CollectionActivitySchema.index({ organisationId: 1, entityId: 1, customerId: 1, createdAt: -1 });

/** Every request sent to the AI model: who, what for, and the cost in tokens. Prompts are not stored. */
export const AiRequestSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    feature: { type: String, required: true },
    model: { type: String, required: true },
    recordId: { type: ObjectId, default: null },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    ok: { type: Boolean, default: true },
    error: { type: String, default: '' },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
AiRequestSchema.index({ organisationId: 1, createdAt: -1 });

export const AUTOMATION_MODELS = {
  RecurringJournal: RecurringJournalSchema,
  CollectionActivity: CollectionActivitySchema,
  AiRequest: AiRequestSchema,
} as const;

type WithId<T> = T & { _id: Types.ObjectId };
export type RecurringJournal = WithId<InferSchemaType<typeof RecurringJournalSchema>>;
export type CollectionActivity = WithId<InferSchemaType<typeof CollectionActivitySchema>>;
export type AiRequest = WithId<InferSchemaType<typeof AiRequestSchema>>;
