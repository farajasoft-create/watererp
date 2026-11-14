import { createHash } from 'node:crypto';
import { ClientSession, Model, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, HttpError, NotFoundException } from '../../common/errors';
import { Permission, PERMISSIONS as P } from '../../common/permissions';
import { escapeRegex } from '../../common/workflow';
import { Db } from '../../database/db.service';
import { Attachment, ATTACHMENT_CATEGORIES, ATTACHMENT_RECORD_TYPES, AttachmentRecordType } from '../../database/governance.schemas';
import { AuditService } from '../audit/audit.service';
import { createFileStore, FileStore } from './file-store';
import { scanBuffer, scannerConfigured, scanRequired } from './virus-scan';

/** Files sent through the API itself (serverless request bodies are limited to about 4.5 MB). */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Files uploaded straight to object storage. */
export const MAX_DIRECT_BYTES = Number(process.env.ATTACHMENT_MAX_MB ?? 25) * 1024 * 1024;

interface UploadInput {
  recordType: string;
  recordId: Types.ObjectId;
  name: string;
  category?: string;
  description?: string;
  replaces?: Types.ObjectId | null;
}
const DEFAULT_RETENTION_YEARS = 7;

/* eslint-disable @typescript-eslint/no-explicit-any -- records of many collections */
type AnyRecord = Record<string, any> & { _id: Types.ObjectId };

interface RecordKind {
  model: (db: Db) => Model<any>;
  label: (r: AnyRecord) => string;
  link: (r: AnyRecord) => string;
  view: (user: AuthUser, r: AnyRecord) => boolean;
  manage: (user: AuthUser, r: AnyRecord) => boolean;
  /** Evidence on records in these states is retained and cannot be deleted. */
  locked: (r: AnyRecord) => boolean;
}

const can = (user: AuthUser, ...perms: Permission[]) => perms.some((p) => hasPermission(user, p));
const salesKind = (r: AnyRecord) => r.kind === 'SALES_INVOICE' || r.kind === 'SALES_CREDIT' || r.kind === 'RECEIPT';

const KINDS: Record<AttachmentRecordType, RecordKind> = {
  Journal: {
    model: (db) => db.journals,
    label: (r) => r.number,
    link: (r) => `/finance/journals/${r._id}`,
    view: (u) => can(u, P.JOURNAL_VIEW),
    manage: (u) => can(u, P.JOURNAL_CREATE, P.JOURNAL_APPROVE),
    locked: (r) => ['POSTED', 'REVERSED'].includes(r.status),
  },
  Invoice: {
    model: (db) => db.invoices,
    label: (r) => `${r.number} · ${r.partyName}`,
    link: (r) => (salesKind(r) ? `/finance/sales/invoices/${r._id}` : `/finance/purchases/bills/${r._id}`),
    view: (u, r) => can(u, salesKind(r) ? P.AR_VIEW : P.AP_VIEW),
    manage: (u, r) => can(u, ...(salesKind(r) ? [P.AR_MANAGE, P.AR_APPROVE] : [P.AP_MANAGE, P.AP_APPROVE])),
    locked: (r) => ['POSTED', 'VOID'].includes(r.status),
  },
  Payment: {
    model: (db) => db.payments,
    label: (r) => `${r.number} · ${r.partyName}`,
    link: (r) => (salesKind(r) ? `/finance/sales/receipts/${r._id}` : `/finance/purchases/payments/${r._id}`),
    view: (u, r) => can(u, salesKind(r) ? P.AR_VIEW : P.AP_VIEW),
    manage: (u, r) => can(u, ...(salesKind(r) ? [P.AR_MANAGE] : [P.AP_MANAGE, P.PAYMENTS_APPROVE])),
    locked: (r) => ['POSTED', 'VOID'].includes(r.status),
  },
  PurchaseRequisition: {
    model: (db) => db.requisitions,
    label: (r) => r.number,
    link: (r) => `/finance/purchases/requisitions/${r._id}`,
    view: (u) => can(u, P.AP_VIEW, P.PROCUREMENT_REQUEST),
    manage: (u) => can(u, P.PROCUREMENT_REQUEST, P.PROCUREMENT_MANAGE),
    locked: (r) => ['APPROVED', 'ORDERED'].includes(r.status),
  },
  PurchaseOrder: {
    model: (db) => db.purchaseOrders,
    label: (r) => `${r.number} · ${r.supplierName}`,
    link: (r) => `/finance/purchases/orders/${r._id}`,
    view: (u) => can(u, P.AP_VIEW),
    manage: (u) => can(u, P.PROCUREMENT_MANAGE, P.PROCUREMENT_APPROVE),
    locked: (r) => ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(r.status),
  },
  ExpenseClaim: {
    model: (db) => db.expenseClaims,
    label: (r) => `${r.number} · ${r.claimantName}`,
    link: () => '/finance/expenses',
    view: (u, r) => r.claimantId.equals(u.id) || can(u, P.EXPENSES_APPROVE, P.EXPENSES_PAY),
    manage: (u, r) => r.claimantId.equals(u.id) || can(u, P.EXPENSES_APPROVE),
    locked: (r) => ['APPROVED', 'PAID'].includes(r.status),
  },
  FixedAsset: {
    model: (db) => db.fixedAssets,
    label: (r) => `${r.number} · ${r.name}`,
    link: (r) => `/finance/assets/${r._id}`,
    view: (u) => can(u, P.ASSETS_VIEW),
    manage: (u) => can(u, P.ASSETS_MANAGE),
    locked: () => true,
  },
  Customer: {
    model: (db) => db.customers,
    label: (r) => `${r.code} · ${r.name}`,
    link: (r) => `/finance/sales/customers/${r._id}`,
    view: (u) => can(u, P.AR_VIEW),
    manage: (u) => can(u, P.AR_MANAGE),
    locked: () => false,
  },
  Supplier: {
    model: (db) => db.suppliers,
    label: (r) => `${r.code} · ${r.name}`,
    link: (r) => `/finance/purchases/suppliers/${r._id}`,
    view: (u) => can(u, P.AP_VIEW),
    manage: (u) => can(u, P.AP_MANAGE),
    locked: () => false,
  },
  BankAccount: {
    model: (db) => db.bankAccounts,
    label: (r) => r.name,
    link: (r) => `/finance/banking/${r._id}`,
    view: (u) => can(u, P.BANKING_VIEW),
    manage: (u) => can(u, P.BANKING_MANAGE, P.BANKING_RECONCILE),
    locked: () => false,
  },
  Budget: {
    model: (db) => db.budgets,
    label: (r) => r.name,
    link: () => '/finance/budgets',
    view: (u) => can(u, P.BUDGETS_VIEW),
    manage: (u) => can(u, P.BUDGETS_MANAGE, P.BUDGETS_APPROVE),
    locked: (r) => ['APPROVED', 'SUPERSEDED'].includes(r.status),
  },
  StockDocument: {
    model: (db) => db.stockDocuments,
    label: (r) => r.number,
    link: () => '/finance/inventory/documents',
    view: (u) => can(u, P.INVENTORY_VIEW),
    manage: (u) => can(u, P.INVENTORY_MANAGE, P.INVENTORY_APPROVE),
    locked: (r) => r.status === 'POSTED',
  },
  ConsolidationAdjustment: {
    model: (db) => db.consolidationAdjustments,
    label: (r) => r.number,
    link: () => '/finance/consolidation/adjustments',
    view: (u) => can(u, P.CONSOLIDATION_VIEW),
    manage: (u) => can(u, P.CONSOLIDATION_MANAGE, P.CONSOLIDATION_APPROVE),
    locked: (r) => ['APPROVED', 'VOID'].includes(r.status),
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const TYPES: { ext: string[]; mime: string; sniff: (b: Buffer) => boolean }[] = [
  { ext: ['pdf'], mime: 'application/pdf', sniff: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { ext: ['png'], mime: 'image/png', sniff: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ['jpg', 'jpeg'], mime: 'image/jpeg', sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['gif'], mime: 'image/gif', sniff: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: ['webp'], mime: 'image/webp', sniff: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: ['xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sniff: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  { ext: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sniff: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  { ext: ['xls'], mime: 'application/vnd.ms-excel', sniff: (b) => b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  { ext: ['doc'], mime: 'application/msword', sniff: (b) => b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) },
  { ext: ['csv'], mime: 'text/csv', sniff: (b) => !b.subarray(0, 4096).includes(0) },
  { ext: ['txt'], mime: 'text/plain', sniff: (b) => !b.subarray(0, 4096).includes(0) },
  { ext: ['eml'], mime: 'message/rfc822', sniff: (b) => !b.subarray(0, 4096).includes(0) },
];
/** Shown inline in the browser; everything else downloads. */
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const ALLOWED_EXTENSIONS = TYPES.flatMap((t) => t.ext);

/** The type a file name promises, before its content can be checked. */
function typeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const type = TYPES.find((t) => t.ext.includes(ext));
  if (!type) throw new BadRequestException(`Files of type .${ext} are not accepted. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  return type.mime;
}

function detectType(name: string, data: Buffer): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const type = TYPES.find((t) => t.ext.includes(ext));
  if (!type) throw new BadRequestException(`Files of type .${ext} are not accepted. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  if (!type.sniff(data)) throw new BadRequestException(`The file content does not match a .${ext} file`);
  return type.mime;
}

const cleanName = (name: string) =>
  name
    .replace(/[\\/]/g, '_')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .trim()
    .slice(0, 200) || 'attachment';

/**
 * Supporting documents for any record: invoices, receipts, contracts, statements and approval
 * evidence. Access follows the record's own permissions and branch; evidence on posted or approved
 * records is retained and can only be superseded by a new version, never deleted.
 */
export class AttachmentsService {
  private readonly store: FileStore;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    store?: FileStore,
  ) {
    this.store = store ?? createFileStore(db.connection);
  }

  get storageDriver() {
    return this.store.driver;
  }
  get directUploads() {
    return this.store.direct;
  }

  private kind(recordType: string): RecordKind {
    const kind = KINDS[recordType as AttachmentRecordType];
    if (!kind) throw new BadRequestException(`Attachments are not supported on ${recordType}`);
    return kind;
  }

  private async record(user: AuthUser, recordType: string, recordId: Types.ObjectId) {
    const kind = this.kind(recordType);
    const record = (await kind.model(this.db).findOne({ _id: recordId, organisationId: user.organisationId }).lean()) as AnyRecord | null;
    if (!record) throw new NotFoundException('Record not found');
    if (!kind.view(user, record)) throw new ForbiddenException('You do not have access to this record');
    if (record.branchId) assertBranchAccess(user, [record.branchId]);
    return { kind, record };
  }

  private async load(user: AuthUser, id: Types.ObjectId) {
    const a = await this.db.attachments.findOne({ _id: id, organisationId: user.organisationId, deletedAt: null, status: { $ne: 'PENDING' } }).lean();
    if (!a) throw new NotFoundException('Attachment not found');
    const { kind, record } = await this.record(user, a.recordType, a.recordId);
    return { a, kind, record };
  }

  view(a: Attachment, extra: Record<string, unknown> = {}) {
    return {
      id: a._id,
      recordType: a.recordType,
      recordId: a.recordId,
      recordLabel: a.recordLabel,
      category: a.category,
      name: a.name,
      description: a.description,
      mimeType: a.mimeType,
      size: a.size,
      sha256: a.sha256,
      groupId: a.groupId,
      version: a.version,
      isLatest: a.isLatest,
      uploadedByName: a.uploadedByName,
      createdAt: (a as { createdAt?: Date }).createdAt,
      retainUntil: a.retainUntil,
      inline: INLINE.has(a.mimeType),
      scanStatus: a.scanStatus,
      ...extra,
    };
  }

  async list(user: AuthUser, recordType: string, recordId: Types.ObjectId) {
    const { kind, record } = await this.record(user, recordType, recordId);
    const rows = await this.db.attachments.find({ organisationId: user.organisationId, recordType, recordId, deletedAt: null, status: { $ne: 'PENDING' } }).sort({ createdAt: -1 }).lean();
    const latest = rows.filter((r) => r.isLatest);
    return {
      directUploads: this.store.direct,
      maxBytes: this.store.direct ? MAX_DIRECT_BYTES : MAX_ATTACHMENT_BYTES,
      canUpload: kind.manage(user, record),
      locked: kind.locked(record),
      items: latest.map((a) => this.view(a, { versions: rows.filter((r) => r.groupId.equals(a.groupId)).length })),
    };
  }

  async versions(user: AuthUser, id: Types.ObjectId) {
    const { a } = await this.load(user, id);
    const rows = await this.db.attachments.find({ organisationId: user.organisationId, groupId: a.groupId, deletedAt: null, status: { $ne: 'PENDING' } }).sort({ version: -1 }).lean();
    return rows.map((r) => this.view(r));
  }

  /** Where a new file goes in the store. GridFS keys end in the object id it uses as the file id. */
  private storageKey(organisationId: Types.ObjectId, id: Types.ObjectId, name: string) {
    if (this.store.driver === 'gridfs') return `${organisationId.toHexString()}/${id.toHexString()}`;
    const now = new Date();
    return `${organisationId.toHexString()}/attachments/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id.toHexString()}/${encodeURIComponent(name)}`;
  }

  private keyOf(a: Attachment): string {
    return a.storageKey ?? `${a.organisationId.toHexString()}/${a.fileId!.toHexString()}`;
  }

  /** Checks the record, permission, category, name and version chain for a new file. */
  private async prepare(user: AuthUser, input: UploadInput) {
    const { kind, record } = await this.record(user, input.recordType, input.recordId);
    if (!kind.manage(user, record)) throw new ForbiddenException('You cannot add documents to this record');
    const category = input.category ?? 'OTHER';
    if (!(ATTACHMENT_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestException('Unknown category');
    const name = cleanName(input.name);
    let groupId = new Types.ObjectId();
    let version = 1;
    if (input.replaces) {
      const prior = await this.db.attachments.findOne({ _id: input.replaces, organisationId: user.organisationId, recordType: input.recordType, recordId: input.recordId, deletedAt: null, isLatest: true, status: { $ne: 'PENDING' } }).lean();
      if (!prior) throw new BadRequestException('Only the latest version of a document on this record can be replaced');
      groupId = prior.groupId;
      version = prior.version + 1;
    }
    const org = await this.db.organisations.findById(user.organisationId, { 'settings.documentRetentionYears': 1 }).lean();
    const years = (org?.settings as { documentRetentionYears?: number } | undefined)?.documentRetentionYears ?? DEFAULT_RETENTION_YEARS;
    const now = new Date();
    const retainUntil = new Date(Date.UTC(now.getUTCFullYear() + years, now.getUTCMonth(), now.getUTCDate()));
    return { kind, record, category, name, groupId, version, retainUntil };
  }

  /** Makes a checked file the current version and records it; returns any other records holding the same file. */
  /**
   * Scans a file before it is kept. Infected files are refused (and the attempt audited); with the scanner
   * down, uploads are refused unless scanning is optional, in which case the file is scanned later.
   */
  private async scan(user: AuthUser, data: Buffer, name: string, recordType: string, recordId: Types.ObjectId, discard: () => Promise<void>) {
    const result = await scanBuffer(data);
    if (result.status === 'INFECTED') {
      await discard();
      await this.audit.log(user, { action: 'attachment.malware', recordType, recordId, summary: `Refused ${name}: the virus scanner found ${result.signature}` });
      throw new BadRequestException(`${name} contains malware (${result.signature}); it was not saved`);
    }
    if (result.status === 'ERROR' && scanRequired()) {
      await discard();
      throw new HttpError(503, `${result.message}; files are not accepted until they can be scanned. Try again shortly.`);
    }
    return { scanStatus: result.status, scanSignature: '', scannedAt: result.status === 'NOT_SCANNED' ? null : new Date() };
  }

  /**
   * Scheduled: scans files kept without a scan (uploaded before scanning was set up, or while the scanner
   * was down). Infected ones are removed from storage and hidden, and the removal is audited.
   */
  async scanBacklog(limit = 50) {
    if (!scannerConfigured()) return { scanned: 0, infected: 0, failed: 0 };
    const due = await this.db.attachments.find({ status: 'ACTIVE', deletedAt: null, scanStatus: { $in: ['NOT_SCANNED', 'ERROR'] } }).sort({ createdAt: 1 }).limit(limit).lean();
    let scanned = 0;
    let infected = 0;
    let failed = 0;
    for (const a of due) {
      const store = a.storage === this.store.driver ? this.store : this.legacy(a);
      const data = await store.get(this.keyOf(a)).catch(() => null);
      if (!data) {
        failed++;
        continue;
      }
      const result = await scanBuffer(data);
      if (result.status === 'ERROR' || result.status === 'NOT_SCANNED') {
        failed++;
        await this.db.attachments.updateOne({ _id: a._id }, { scanStatus: 'ERROR' });
        continue;
      }
      scanned++;
      if (result.status === 'CLEAN') {
        await this.db.attachments.updateOne({ _id: a._id }, { scanStatus: 'CLEAN', scannedAt: new Date() });
        continue;
      }
      infected++;
      await store.delete(this.keyOf(a)).catch(() => undefined);
      await this.db.attachments.updateOne({ _id: a._id }, { scanStatus: 'INFECTED', scanSignature: result.signature, scannedAt: new Date(), deletedAt: new Date() });
      await this.audit.log({ organisationId: a.organisationId, name: 'Virus scanner' }, { action: 'attachment.malware', recordType: a.recordType, recordId: a.recordId, summary: `Removed ${a.name} from ${a.recordLabel}: the virus scanner found ${result.signature}` });
    }
    return { scanned, infected, failed };
  }

  private async activate(user: AuthUser, a: Attachment, label: string, session?: ClientSession) {
    const duplicates = await this.db.attachments.find({ organisationId: user.organisationId, sha256: a.sha256, deletedAt: null, status: { $ne: 'PENDING' }, recordId: { $ne: a.recordId } }, { recordType: 1, recordId: 1, recordLabel: 1, name: 1 }).limit(5).lean();
    const run = async (s: ClientSession) => {
      await this.db.attachments.updateMany({ organisationId: user.organisationId, groupId: a.groupId, _id: { $ne: a._id } }, { isLatest: false }, { session: s });
      await this.db.attachments.updateOne({ _id: a._id }, { status: 'ACTIVE', isLatest: true, size: a.size, sha256: a.sha256, mimeType: a.mimeType, scanStatus: a.scanStatus, scanSignature: '', scannedAt: a.scannedAt }, { session: s });
      await this.audit.log(user, { action: 'attachment.upload', recordType: a.recordType, recordId: a.recordId, summary: `Attached ${a.name}${a.version > 1 ? ` (version ${a.version})` : ''} to ${label}` }, s);
    };
    if (session) await run(session);
    else await this.db.transaction(run);
    return duplicates.map((x) => ({ recordType: x.recordType, recordId: x.recordId, recordLabel: x.recordLabel, name: x.name }));
  }

  /** Server-side upload (API clients and development); the body is limited by serverless request size. */
  async upload(user: AuthUser, input: UploadInput, data: Buffer) {
    if (!data.length) throw new BadRequestException('The file is empty');
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(`Files sent through the API can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB${this.store.direct ? '; request a direct upload for larger files' : ''}`);
    }
    const p = await this.prepare(user, input);
    const mimeType = detectType(p.name, data);
    const scan = await this.scan(user, data, p.name, input.recordType, input.recordId, async () => undefined);
    const id = new Types.ObjectId();
    const key = this.storageKey(user.organisationId, id, p.name);
    await this.store.put(key, data, mimeType);
    try {
      const [doc] = await this.db.attachments.create([{ ...this.doc(user, input, p, { id, key, mimeType, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), status: 'PENDING' }), ...scan }]);
      const duplicates = await this.activate(user, doc.toObject() as Attachment, p.kind.label(p.record));
      const created = (await this.db.attachments.findById(id).lean())!;
      return this.view(created, { duplicates });
    } catch (err) {
      await this.store.delete(key).catch(() => undefined);
      await this.db.attachments.deleteOne({ _id: id, status: 'PENDING' });
      throw err;
    }
  }

  private doc(user: AuthUser, input: UploadInput, p: Awaited<ReturnType<AttachmentsService['prepare']>>, f: { id: Types.ObjectId; key: string; mimeType: string; size: number; sha256: string; status: 'PENDING' | 'ACTIVE' }) {
    return {
      _id: f.id,
      organisationId: user.organisationId,
      recordType: input.recordType,
      recordId: input.recordId,
      recordLabel: p.kind.label(p.record),
      entityId: p.record.entityId ?? null,
      branchId: p.record.branchId ?? null,
      category: p.category,
      name: p.name,
      description: input.description ?? '',
      mimeType: f.mimeType,
      size: f.size,
      sha256: f.sha256,
      storage: this.store.driver,
      storageKey: f.key,
      fileId: this.store.driver === 'gridfs' ? f.id : null,
      status: f.status,
      groupId: p.groupId,
      version: p.version,
      isLatest: false,
      uploadedBy: user.id,
      uploadedByName: user.name,
      retainUntil: p.retainUntil,
    };
  }

  /**
   * Direct upload, step 1: the browser gets a short-lived URL and sends the file straight to object
   * storage, so large scans and photos never pass through the application servers.
   */
  async createUpload(user: AuthUser, input: UploadInput & { size: number }) {
    if (!this.store.direct) throw new BadRequestException('Direct uploads need object storage; send the file to POST /attachments instead');
    if (input.size <= 0) throw new BadRequestException('The file is empty');
    if (input.size > MAX_DIRECT_BYTES) throw new BadRequestException(`Files can be at most ${MAX_DIRECT_BYTES / 1024 / 1024} MB`);
    const p = await this.prepare(user, input);
    const mimeType = typeOf(p.name);
    const id = new Types.ObjectId();
    const key = this.storageKey(user.organisationId, id, p.name);
    await this.db.attachments.create([this.doc(user, input, p, { id, key, mimeType, size: input.size, sha256: '', status: 'PENDING' })]);
    const expiresIn = 15 * 60;
    return { id, uploadUrl: await this.store.presignPut(key, mimeType, expiresIn), method: 'PUT', headers: { 'content-type': mimeType }, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  /**
   * Direct upload, step 2: the server reads the stored object back, checks its size and signature and
   * fingerprints it before the document becomes visible. Anything that fails the checks is deleted.
   */
  async completeUpload(user: AuthUser, id: Types.ObjectId) {
    const a = await this.db.attachments.findOne({ _id: id, organisationId: user.organisationId, uploadedBy: user.id, status: 'PENDING', deletedAt: null }).lean();
    if (!a) throw new NotFoundException('Upload not found or already completed');
    const { kind, record } = await this.record(user, a.recordType, a.recordId);
    const key = this.keyOf(a);
    const fail = async (message: string) => {
      await this.store.delete(key).catch(() => undefined);
      await this.db.attachments.deleteOne({ _id: a._id, status: 'PENDING' });
      throw new BadRequestException(message);
    };
    const data = await this.store.get(key);
    if (!data) return fail('The file did not arrive in storage; try the upload again');
    if (data.length !== a.size) return fail(`The stored file is ${data.length} bytes, not the ${a.size} declared`);
    try {
      detectType(a.name, data);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'The file content does not match its type');
    }
    const scan = await this.scan(user, data, a.name, a.recordType, a.recordId, async () => {
      await this.store.delete(key).catch(() => undefined);
      await this.db.attachments.deleteOne({ _id: a._id, status: 'PENDING' });
    });
    const checked = { ...a, ...scan, sha256: createHash('sha256').update(data).digest('hex') } as Attachment;
    const duplicates = await this.activate(user, checked, kind.label(record));
    return this.view((await this.db.attachments.findById(a._id).lean())!, { duplicates });
  }

  /** The file's bytes, after the same access check as opening it (used by AI invoice capture). */
  /** A file kept unscanned while scanning is required is not handed out until the background scan passes. */
  private assertScanned(a: Attachment) {
    if (scanRequired() && a.scanStatus !== 'CLEAN') throw new HttpError(423, `${a.name} is waiting for a virus scan; try again in a few minutes`);
  }

  async content(user: AuthUser, id: Types.ObjectId) {
    const { a } = await this.load(user, id);
    this.assertScanned(a);
    const store = a.storage === this.store.driver ? this.store : this.legacy(a);
    const data = await store.get(this.keyOf(a));
    if (!data) throw new NotFoundException('The file is missing from storage');
    return { attachment: a, data };
  }

  /** Removes direct uploads that were never completed (called by the cron job). */
  async cleanupPending(olderThanHours = 24) {
    const stale = await this.db.attachments.find({ status: 'PENDING', createdAt: { $lt: new Date(Date.now() - olderThanHours * 3_600_000) } }).limit(500).lean();
    for (const a of stale) {
      await this.store.delete(this.keyOf(a)).catch(() => undefined);
      await this.db.attachments.deleteOne({ _id: a._id, status: 'PENDING' });
    }
    return { removed: stale.length };
  }

  /**
   * Opens the file. With object storage the browser is redirected to a five-minute signed link, so
   * the bytes never pass through the application; otherwise the file is streamed. Every open is audited.
   */
  async download(user: AuthUser, id: Types.ObjectId, inline: boolean) {
    const { a } = await this.load(user, id);
    this.assertScanned(a);
    await this.audit.log(user, { action: 'attachment.download', recordType: a.recordType, recordId: a.recordId, summary: `Opened ${a.name} on ${a.recordLabel}` });
    const showInline = inline && INLINE.has(a.mimeType);
    const key = this.keyOf(a);
    const store = a.storage === this.store.driver ? this.store : this.legacy(a);
    const signed = await store.presignGet(key, { seconds: 300, filename: a.name, contentType: a.mimeType, inline: showInline });
    if (signed && !signed.startsWith('memory://')) return new Response(null, { status: 302, headers: { location: signed, 'cache-control': 'private, no-store' } });
    const data = await store.get(key);
    if (!data) throw new NotFoundException('The file is missing from storage');
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': a.mimeType,
        'content-length': String(data.length),
        'content-disposition': `${showInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        'cache-control': 'private, no-store',
      },
    });
  }

  /** Files stored before the switch to object storage stay readable from GridFS. */
  private legacy(a: Attachment): FileStore {
    if (a.storage === 'gridfs') return createFileStore(this.db.connection, 'gridfs');
    return this.store;
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    const { a, kind, record } = await this.load(user, id);
    if (!kind.manage(user, record)) throw new ForbiddenException('You cannot remove documents from this record');
    if (kind.locked(record)) throw new BadRequestException(`Documents on ${kind.label(record)} are kept under the retention policy until ${a.retainUntil?.toISOString().slice(0, 10)}; upload a corrected version instead`);
    await this.db.transaction(async (session) => {
      await this.db.attachments.updateOne({ _id: a._id }, { deletedAt: new Date(), deletedBy: user.id, isLatest: false }, { session });
      // The previous version, if any, becomes current again.
      const previous = await this.db.attachments.findOne({ organisationId: user.organisationId, groupId: a.groupId, deletedAt: null, status: { $ne: 'PENDING' } }).sort({ version: -1 }).session(session).lean();
      if (previous) await this.db.attachments.updateOne({ _id: previous._id }, { isLatest: true }, { session });
      await this.audit.log(user, { action: 'attachment.delete', recordType: a.recordType, recordId: a.recordId, summary: `Removed ${a.name} from ${a.recordLabel}` }, session);
    });
    const store = a.storage === this.store.driver ? this.store : this.legacy(a);
    await store.delete(this.keyOf(a)).catch(() => undefined);
    return { deleted: true };
  }

  /** Searches documents the user may see, by name, description or record number. */
  async search(user: AuthUser, q: { q?: string; recordType?: string; category?: string; from?: Date; to?: Date; limit: number }) {
    const visibleTypes = ATTACHMENT_RECORD_TYPES.filter((t) => {
      // A permission check without a record: claims are filtered per row below.
      const probe = { _id: new Types.ObjectId(), kind: 'SALES_INVOICE', claimantId: user.id } as AnyRecord;
      const purchase = { ...probe, kind: 'PURCHASE_BILL' } as AnyRecord;
      return KINDS[t].view(user, probe) || KINDS[t].view(user, purchase);
    });
    const filter: Record<string, unknown> = { organisationId: user.organisationId, deletedAt: null, isLatest: true, status: { $ne: 'PENDING' }, recordType: { $in: visibleTypes } };
    if (q.recordType) filter.recordType = visibleTypes.includes(q.recordType as AttachmentRecordType) ? q.recordType : '__none__';
    if (q.category) filter.category = q.category;
    if (q.from || q.to) filter.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lt: new Date(q.to.getTime() + 86_400_000) }) };
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      filter.$or = [{ name: rx }, { description: rx }, { recordLabel: rx }, { uploadedByName: rx }];
    }
    const restricted = allowedBranches(user);
    if (restricted) filter.$and = [{ $or: [{ branchId: null }, { branchId: { $in: restricted } }] }];
    const rows = await this.db.attachments.find(filter).sort({ createdAt: -1 }).limit(q.limit * 2).lean();
    // Row-level checks for records whose visibility depends on the record (sales vs purchases, claimants).
    const out = [];
    for (const a of rows) {
      if (out.length >= q.limit) break;
      const kind = KINDS[a.recordType as AttachmentRecordType];
      const record = (await kind.model(this.db).findOne({ _id: a.recordId }).lean()) as AnyRecord | null;
      if (!record || !kind.view(user, record)) continue;
      out.push(this.view(a, { link: kind.link(record) }));
    }
    return out;
  }

  /** Attachment counts per record, for list badges. */
  async counts(user: AuthUser, recordType: string, recordIds: Types.ObjectId[]) {
    const rows = await this.db.attachments.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { organisationId: user.organisationId, recordType, recordId: { $in: recordIds }, deletedAt: null, isLatest: true, status: { $ne: 'PENDING' } } },
      { $group: { _id: '$recordId', n: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id.toHexString(), r.n]));
  }
}
