import { createHash } from 'node:crypto';
import { mongo, Types } from 'mongoose';
import { AuthUser } from '../auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../common/errors';
import { escapeRegex } from '../common/validation';
import { Db } from '../db';
import { AuditService } from './audit.service';

const BUCKET = 'documents';
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|vnd\.ms-powerpoint|zip|json|geo\+json)|image\/(jpeg|png|webp|gif|tiff)|text\/(plain|csv))$/;

export interface UploadMeta {
  name: string;
  module?: string | null;
  entity?: string | null;
  entityId?: Types.ObjectId | null;
  category?: string;
  tags?: string[];
  description?: string;
  access?: 'ORGANISATION' | 'MODULE' | 'RESTRICTED';
  /** Upload a new version of this document. */
  replaces?: Types.ObjectId | null;
}

/**
 * The organisation's document store: scanned letters, certificates, contracts, customer files, audit
 * evidence. Each file has versions, a category and tags, access rules, and an audit trail of uploads,
 * downloads and deletions.
 */
export class DocumentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private bucket() {
    return new mongo.GridFSBucket(this.db.connection.db!, { bucketName: BUCKET });
  }

  /** Who may see a document: the organisation, users of its module, or only those it is shared with. */
  private canSee(user: AuthUser, d: { access?: string | null; module?: string | null; uploadedBy?: Types.ObjectId | null; sharedWith?: Types.ObjectId[] }) {
    if (user.isAdmin || d.uploadedBy?.equals(user.id)) return true;
    if (d.access === 'RESTRICTED') return (d.sharedWith ?? []).some((id) => id.equals(user.id));
    if (d.access === 'MODULE' && d.module) return user.permissions.some((p) => p.startsWith(`${d.module}.`)) || user.access[d.module] !== undefined;
    return true;
  }

  async upload(user: AuthUser, req: Request, meta: UploadMeta) {
    const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED.test(contentType)) throw new BadRequestException('Upload a PDF, Office document, image, CSV or text file');
    const data = Buffer.from(await req.arrayBuffer());
    if (!data.length) throw new BadRequestException('The file is empty');
    if (data.length > MAX_BYTES) throw new BadRequestException('The file is larger than 15 MB');
    if (meta.module && !user.isAdmin && user.access[meta.module] === undefined) throw new ForbiddenException(`You have no role in ${meta.module}`);
    let seriesId = new Types.ObjectId();
    let version = 1;
    let base: Partial<UploadMeta> = {};
    if (meta.replaces) {
      const prev = await this.db.documents.findOne({ _id: meta.replaces, organisationId: user.organisationId, deletedAt: null }).lean();
      if (!prev || !this.canSee(user, prev)) throw new NotFoundException('Document not found');
      seriesId = prev.seriesId;
      version = prev.version + 1;
      base = { module: prev.module, entity: prev.entity, entityId: prev.entityId, category: prev.category, tags: prev.tags, access: prev.access as UploadMeta['access'], description: prev.description ?? undefined };
    }
    const fileId = new Types.ObjectId();
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket().openUploadStreamWithId(fileId, meta.name, { metadata: { organisationId: user.organisationId, contentType } });
      stream.on('finish', () => resolve()).on('error', reject);
      stream.end(data);
    });
    const doc = await this.db.transaction(async (session) => {
      if (meta.replaces) await this.db.documents.updateMany({ organisationId: user.organisationId, seriesId }, { latest: false }, { session });
      const [d] = await this.db.documents.create(
        [
          {
            ...base,
            ...Object.fromEntries(Object.entries(meta).filter(([k, v]) => v !== undefined && v !== null && k !== 'replaces')),
            category: meta.category ?? base.category ?? 'GENERAL',
            organisationId: user.organisationId,
            seriesId,
            version,
            latest: true,
            contentType,
            size: data.length,
            sha256: createHash('sha256').update(data).digest('hex'),
            fileId,
            uploadedBy: user.id,
          },
        ],
        { session },
      );
      await this.audit.record(user, 'document.upload', 'document', d._id, { name: meta.name, version, module: d.module, entity: d.entity, entityId: d.entityId }, session);
      return d.toObject();
    });
    return doc;
  }

  async list(user: AuthUser, q: { module?: string; entity?: string; entityId?: Types.ObjectId; category?: string; search?: string; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, latest: true, deletedAt: null };
    if (q.module) filter.module = q.module;
    if (q.entity) filter.entity = q.entity;
    if (q.entityId) filter.entityId = q.entityId;
    if (q.category) filter.category = q.category;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ name: rx }, { tags: rx }, { description: rx }];
    }
    const rows = await this.db.documents.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
    const visible = rows.filter((d) => this.canSee(user, d));
    const page = visible.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const users = await this.db.users.find({ _id: { $in: page.map((d) => d.uploadedBy) } }, { name: 1 }).lean();
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return { items: page.map((d) => ({ ...d, uploadedByName: d.uploadedBy ? names.get(d.uploadedBy.toHexString()) : null })), total: visible.length, page: q.page, pageSize: q.pageSize };
  }

  async versions(user: AuthUser, id: Types.ObjectId) {
    const d = await this.db.documents.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!d || !this.canSee(user, d)) throw new NotFoundException('Document not found');
    return this.db.documents.find({ organisationId: user.organisationId, seriesId: d.seriesId }).sort({ version: -1 }).lean();
  }

  /** Streams a file, and records who opened it. */
  async download(user: AuthUser, id: Types.ObjectId, ip: string | null): Promise<Response> {
    const d = await this.db.documents.findOne({ _id: id, organisationId: user.organisationId, deletedAt: null }).lean();
    if (!d || !this.canSee(user, d)) throw new NotFoundException('Document not found');
    const chunks: Buffer[] = [];
    for await (const chunk of this.bucket().openDownloadStream(d.fileId)) chunks.push(chunk as Buffer);
    await this.audit.record({ ...user, ip }, 'document.download', 'document', d._id, { name: d.name, version: d.version });
    return new Response(Buffer.concat(chunks), { headers: { 'content-type': d.contentType, 'content-disposition': `inline; filename="${d.name.replace(/[^\w.\- ]/g, '_')}"`, 'cache-control': 'private, no-store' } });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: { name?: string; category?: string; tags?: string[]; description?: string; access?: 'ORGANISATION' | 'MODULE' | 'RESTRICTED'; sharedWith?: Types.ObjectId[] }) {
    const d = await this.db.documents.findOne({ _id: id, organisationId: user.organisationId, deletedAt: null }).lean();
    if (!d || !this.canSee(user, d)) throw new NotFoundException('Document not found');
    if (!user.isAdmin && !d.uploadedBy?.equals(user.id)) throw new ForbiddenException('Only the uploader or an administrator can change it');
    const updated = await this.db.documents.findByIdAndUpdate(id, input, { new: true }).lean();
    await this.audit.record(user, 'document.update', 'document', id, input);
    return updated;
  }

  /** Soft delete: the file stays for the audit trail but no longer shows. */
  async remove(user: AuthUser, id: Types.ObjectId, reason: string) {
    const d = await this.db.documents.findOne({ _id: id, organisationId: user.organisationId, deletedAt: null }).lean();
    if (!d || !this.canSee(user, d)) throw new NotFoundException('Document not found');
    if (!user.isAdmin && !d.uploadedBy?.equals(user.id)) throw new ForbiddenException('Only the uploader or an administrator can delete it');
    await this.db.documents.updateMany({ organisationId: user.organisationId, seriesId: d.seriesId }, { deletedAt: new Date(), latest: false });
    await this.audit.record(user, 'document.delete', 'document', id, { name: d.name, reason });
    return { ok: true };
  }

  /** Who uploaded, changed, opened or deleted a document. */
  async trail(user: AuthUser, id: Types.ObjectId) {
    const d = await this.db.documents.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!d || !this.canSee(user, d)) throw new NotFoundException('Document not found');
    const ids = (await this.db.documents.find({ seriesId: d.seriesId }, { _id: 1 }).lean()).map((x) => x._id);
    const rows = await this.db.audit.find({ organisationId: user.organisationId, entity: 'document', entityId: { $in: ids } }).sort({ createdAt: -1 }).limit(500).lean();
    const users = await this.db.users.find({ _id: { $in: rows.map((r) => r.userId).filter(Boolean) } }, { name: 1 }).lean();
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return rows.map((r) => ({ ...r, userName: r.userId ? names.get(r.userId.toHexString()) : null }));
  }
}
