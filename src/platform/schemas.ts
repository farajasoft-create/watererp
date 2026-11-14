import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId } = Schema.Types;
const opts = { timestamps: true } as const;

export const SYNC_STATUSES = ['NOT_SENT', 'PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;

/** How a module's record has been mirrored in the general ledger; modules embed it in their documents. */
export const ledgerSyncSchema = new Schema(
  {
    status: { type: String, enum: SYNC_STATUSES, default: 'NOT_SENT' },
    journalId: String,
    error: String,
    attempts: { type: Number, default: 0 },
    lastAttemptAt: Date,
  },
  { _id: false },
);

export const organisationSchema = new Schema(
  {
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true },
    address: String,
    phone: String,
    email: String,
    kraPin: String,
    currency: { type: String, default: 'KES' },
    /** Keys of the modules this organisation uses. */
    modules: { type: [String], default: [] },
    sms: {
      provider: { type: String, enum: ['NONE', 'AFRICASTALKING'], default: 'NONE' },
      username: String,
      apiKeySealed: String,
      senderId: String,
    },
    /** Outgoing mail through the organisation's own mail server (SMTP). */
    mail: {
      enabled: { type: Boolean, default: false },
      host: String,
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      username: String,
      passwordSealed: String,
      from: String,
    },
    /** Roles the organisation defined itself, per module, from that module's permissions. */
    customRoles: {
      type: [new Schema({ module: { type: String, required: true }, key: { type: String, required: true }, label: { type: String, required: true }, description: String, permissions: { type: [String], default: [] } }, { _id: false })],
      default: [],
    },
    security: {
      /** Who must use an authenticator app code at sign-in. */
      requireTwoFactor: { type: String, enum: ['NONE', 'ADMINS', 'ALL'], default: 'NONE' },
      /** Sign-in with the organisation's identity provider (Microsoft Entra ID, Google Workspace…) over OpenID Connect. */
      sso: {
        enabled: { type: Boolean, default: false },
        issuer: String,
        clientId: String,
        clientSecretSealed: String,
        /** Only these email domains may sign in this way. */
        domains: [String],
      },
    },
    /** The general ledger every module posts to (FarajaSoft Accounting, until a finance module is installed). */
    ledger: {
      enabled: { type: Boolean, default: false },
      baseUrl: String,
      apiKeySealed: String,
      entityId: String,
      branchId: String,
      /** DRAFT leaves journals for review; SUBMIT sends them for approval; POST posts them. */
      mode: { type: String, enum: ['DRAFT', 'SUBMIT', 'POST'], default: 'SUBMIT' },
    },
  },
  opts,
);

const accessSchema = new Schema({ module: { type: String, required: true }, role: { type: String, required: true }, scope: [{ type: ObjectId }] }, { _id: false });

export const userSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    phone: String,
    passwordHash: { type: String, required: true },
    /** Administrators hold every permission in every enabled module and manage the platform. */
    isAdmin: { type: Boolean, default: false },
    /** One role per module; no entry means no access to that module. */
    access: { type: [accessSchema], default: [] },
    active: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    /** Public keys or X.509 certificates the user signs approvals with (the private key never leaves their device). */
    signingKeys: {
      type: [new Schema({ label: String, kind: { type: String, enum: ['KEY', 'CERTIFICATE'] }, publicKeyPem: String, certificatePem: String, fingerprint: String, subject: String, validTo: Date, createdAt: Date, revokedAt: Date }, { _id: true })],
      default: [],
    },
    /** Keys other systems use to call the API as this user (stored hashed; shown once). */
    apiKeys: {
      type: [new Schema({ hash: { type: String, required: true }, prefix: String, label: String, createdAt: Date, createdBy: Schema.Types.ObjectId, expiresAt: Date, lastUsedAt: Date }, { _id: true })],
      default: [],
    },
    lastLoginAt: Date,
    /** Authenticator app (TOTP). Recovery codes are stored hashed and each works once. */
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretSealed: String,
      pendingSecretSealed: String,
      recoveryHashes: [String],
      enrolledAt: Date,
    },
  },
  opts,
);
userSchema.index({ email: 1 }, { unique: true });

/** Sequence numbers (account, bill, receipt, invoice numbers…), per organisation and name. */
export const counterSchema = new Schema({ organisationId: ObjectId, name: String, value: { type: Number, default: 0 } });
counterSchema.index({ organisationId: 1, name: 1 }, { unique: true });

export const smsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    to: { type: String, required: true },
    message: { type: String, required: true },
    /** Who queued it and why, e.g. water:bill. */
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
smsSchema.index({ organisationId: 1, status: 1, createdAt: 1 });

export const auditSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: ObjectId,
    action: { type: String, required: true },
    entity: String,
    entityId: ObjectId,
    data: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ organisationId: 1, createdAt: -1 });
auditSchema.index({ organisationId: 1, entity: 1, entityId: 1 });

/** Who opened which record or downloaded which file, in every module; kept two years. */
export const accessLogSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    module: String,
    kind: { type: String, enum: ['VIEW', 'DOWNLOAD'], required: true },
    path: { type: String, required: true },
    ip: String,
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
accessLogSchema.index({ organisationId: 1, at: -1 });
accessLogSchema.index({ organisationId: 1, userId: 1, at: -1 });
accessLogSchema.index({ at: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 3600 });

export const idempotencySchema = new Schema(
  {
    organisationId: ObjectId,
    userId: ObjectId,
    key: String,
    method: String,
    path: String,
    requestHash: String,
    status: { type: String, default: 'IN_PROGRESS' },
    responseStatus: Number,
    responseBody: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
idempotencySchema.index({ organisationId: 1, userId: 1, key: 1 }, { unique: true });
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type OrganisationDoc = InferSchemaType<typeof organisationSchema> & { _id: Types.ObjectId };
export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
