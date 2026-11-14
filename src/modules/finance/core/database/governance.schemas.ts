import { InferSchemaType, Schema, Types } from 'mongoose';

/**
 * Phase 6 (governance) data model: document attachments with versions and retention, and sign-in
 * sessions for session management. File contents live in the `attachments` GridFS bucket.
 */

const ObjectId = Schema.Types.ObjectId;
const options = { timestamps: true, versionKey: false } as const;

export const ATTACHMENT_RECORD_TYPES = [
  'Journal',
  'Invoice',
  'Payment',
  'PurchaseRequisition',
  'PurchaseOrder',
  'ExpenseClaim',
  'FixedAsset',
  'Customer',
  'Supplier',
  'BankAccount',
  'Budget',
  'StockDocument',
  'ConsolidationAdjustment',
] as const;
export type AttachmentRecordType = (typeof ATTACHMENT_RECORD_TYPES)[number];

export const ATTACHMENT_CATEGORIES = ['INVOICE', 'RECEIPT', 'CONTRACT', 'PURCHASE_ORDER', 'DELIVERY_NOTE', 'BANK_STATEMENT', 'TAX', 'APPROVAL_EVIDENCE', 'CORRESPONDENCE', 'OTHER'] as const;

export const AttachmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    recordType: { type: String, enum: ATTACHMENT_RECORD_TYPES, required: true },
    recordId: { type: ObjectId, required: true },
    /** Number or code of the record, for search results. */
    recordLabel: { type: String, default: '' },
    entityId: { type: ObjectId, default: null },
    branchId: { type: ObjectId, default: null },
    category: { type: String, enum: ATTACHMENT_CATEGORIES, default: 'OTHER' },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, default: '' },
    /** Where the bytes live: Cloudflare R2 in production, GridFS in development. */
    storage: { type: String, enum: ['r2', 'gridfs', 'memory'], default: 'gridfs' },
    storageKey: { type: String, default: null },
    /** GridFS file id (development storage and attachments created before object storage). */
    fileId: { type: ObjectId, default: null },
    /** Direct uploads are PENDING until the server has checked the stored object. */
    status: { type: String, enum: ['PENDING', 'ACTIVE'], default: 'ACTIVE' },
    /** Virus scan (ClamAV): files found infected are never kept; older files are scanned in the background. */
    scanStatus: { type: String, enum: ['NOT_SCANNED', 'CLEAN', 'INFECTED', 'ERROR'], default: 'NOT_SCANNED' },
    scanSignature: { type: String, default: '' },
    scannedAt: { type: Date, default: null },
    /** All versions of one document share a group; the newest has the highest version. */
    groupId: { type: ObjectId, required: true },
    version: { type: Number, default: 1 },
    isLatest: { type: Boolean, default: true },
    uploadedBy: { type: ObjectId, required: true },
    uploadedByName: { type: String, required: true },
    /** Attachments of posted or approved records are kept until this date. */
    retainUntil: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, default: null },
  },
  options,
);
AttachmentSchema.index({ organisationId: 1, recordType: 1, recordId: 1, deletedAt: 1 });
AttachmentSchema.index({ organisationId: 1, groupId: 1, version: -1 });
AttachmentSchema.index({ organisationId: 1, sha256: 1 });
AttachmentSchema.index({ status: 1, createdAt: 1 });
AttachmentSchema.index({ organisationId: 1, name: 'text', description: 'text', recordLabel: 'text' });

/** One signed-in browser or device; revoking it signs that device out. */
export const SessionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    /** How the session was established: password only, or password plus a second factor. */
    method: { type: String, enum: ['password', 'mfa', 'recovery_code', 'sso'], default: 'password' },
    lastSeenAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '' },
  },
  options,
);
SessionSchema.index({ organisationId: 1, userId: 1, revokedAt: 1 });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const GOVERNANCE_MODELS = {
  Attachment: AttachmentSchema,
  Session: SessionSchema,
} as const;

type WithId<T> = T & { _id: Types.ObjectId };
export type Attachment = WithId<InferSchemaType<typeof AttachmentSchema>>;
export type Session = WithId<InferSchemaType<typeof SessionSchema>>;
