import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId } = Schema.Types;
const opts = { timestamps: true } as const;

/** Emails through an outbox, like texts: queued with the change that caused them, sent afterwards. */
export const emailSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    to: { type: String, required: true },
    subject: { type: String, required: true },
    text: { type: String, required: true },
    html: String,
    purpose: String,
    sourceId: ObjectId,
    status: { type: String, enum: ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'], default: 'QUEUED' },
    attempts: { type: Number, default: 0 },
    providerId: String,
    error: String,
    sentAt: Date,
  },
  opts,
);
emailSchema.index({ organisationId: 1, status: 1, createdAt: 1 });

/**
 * A file kept by the platform (GridFS bucket "documents"), optionally attached to a record of a module
 * (a customer, an employee, a supplier, an audit working paper). Versions share a `seriesId`.
 */
export const documentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    seriesId: { type: ObjectId, required: true },
    version: { type: Number, default: 1 },
    latest: { type: Boolean, default: true },
    name: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    fileId: { type: ObjectId, required: true },
    /** Which module and record it belongs to; empty for the general registry. */
    module: { type: String, default: null },
    entity: { type: String, default: null },
    entityId: { type: ObjectId, default: null },
    category: { type: String, default: 'GENERAL' },
    tags: [String],
    description: String,
    /** RESTRICTED: only the uploader, administrators and the users listed can open it. */
    access: { type: String, enum: ['ORGANISATION', 'MODULE', 'RESTRICTED'], default: 'MODULE' },
    sharedWith: [{ type: ObjectId }],
    uploadedBy: ObjectId,
    deletedAt: Date,
  },
  opts,
);
documentSchema.index({ organisationId: 1, module: 1, entity: 1, entityId: 1, latest: 1 });
documentSchema.index({ organisationId: 1, seriesId: 1, version: -1 });
documentSchema.index({ organisationId: 1, name: 'text', tags: 'text', description: 'text' });

export const notificationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    title: { type: String, required: true },
    body: String,
    link: String,
    module: String,
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;

/** Work assigned between people and departments, with deadlines, escalation and turnaround analytics. */
export const taskSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    title: { type: String, required: true },
    description: String,
    module: { type: String, default: null },
    /** A link back to the record the task is about. */
    link: String,
    department: String,
    assignedTo: { type: ObjectId, required: true },
    createdBy: { type: ObjectId, required: true },
    escalateTo: { type: ObjectId, default: null },
    priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH'], default: 'NORMAL' },
    status: { type: String, enum: TASK_STATUSES, default: 'OPEN' },
    dueAt: Date,
    startedAt: Date,
    completedAt: Date,
    escalatedAt: Date,
    comments: [{ at: Date, by: ObjectId, text: String, _id: false }],
  },
  opts,
);
taskSchema.index({ organisationId: 1, number: 1 }, { unique: true });
taskSchema.index({ organisationId: 1, assignedTo: 1, status: 1, dueAt: 1 });

/**
 * A configurable approval chain for a kind of document (a requisition, a payment voucher, a leave
 * request…): steps in order, each approved by holders of a module role or named users, with an amount
 * above which the step applies.
 */
export const approvalRuleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    module: { type: String, required: true },
    docType: { type: String, required: true },
    name: String,
    steps: [
      {
        name: { type: String, required: true },
        /** Users holding one of these roles in the module may approve. */
        roles: [String],
        /** Or these named users. */
        userIds: [{ type: ObjectId }],
        /** Every named user signs, in any order (a parallel step); otherwise any one of them. */
        parallel: { type: Boolean, default: false },
        /** The step applies only when the document's amount is at least this (0: always). */
        minAmount: { type: Number, default: 0 },
        _id: false,
      },
    ],
    active: { type: Boolean, default: true },
  },
  opts,
);
approvalRuleSchema.index({ organisationId: 1, module: 1, docType: 1 }, { unique: true });

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED'] as const;

export const approvalRequestSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    module: { type: String, required: true },
    docType: { type: String, required: true },
    docId: { type: ObjectId, required: true },
    title: { type: String, required: true },
    amount: { type: Number, default: 0 },
    link: String,
    requestedBy: { type: ObjectId, required: true },
    status: { type: String, enum: APPROVAL_STATUSES, default: 'PENDING' },
    current: { type: Number, default: 0 },
    steps: [
      {
        name: String,
        roles: [String],
        userIds: [{ type: ObjectId }],
        parallel: { type: Boolean, default: false },
        /** Parallel steps: each named signer's own decision and signature. */
        signers: [
          {
            userId: ObjectId,
            decision: { type: String, enum: ['APPROVED', 'REJECTED', 'RETURNED', null], default: null },
            byName: String,
            at: Date,
            note: String,
            signature: { method: String, ip: String, documentHash: String, signatureHash: String, image: String, keyFingerprint: String, value: String },
            _id: false,
          },
        ],
        decision: { type: String, enum: ['APPROVED', 'REJECTED', 'RETURNED', null], default: null },
        by: ObjectId,
        byName: String,
        at: Date,
        note: String,
        /** Electronic signature: who, when, from where, over a hash of what was approved. */
        signature: { method: String, ip: String, documentHash: String, signatureHash: String, image: String, keyFingerprint: String, value: String },
        _id: false,
      },
    ],
    /** Hash of the document's content when it was submitted, so a later change is detectable. */
    documentHash: String,
  },
  opts,
);
approvalRequestSchema.index({ organisationId: 1, module: 1, docType: 1, docId: 1, status: 1 });
approvalRequestSchema.index({ organisationId: 1, status: 1 });

export type DocumentDoc = InferSchemaType<typeof documentSchema> & { _id: Types.ObjectId };
export type ApprovalRequestDoc = InferSchemaType<typeof approvalRequestSchema> & { _id: Types.ObjectId };
