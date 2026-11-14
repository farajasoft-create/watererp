import { createHash, randomBytes } from 'node:crypto';
import { mongo, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { openPortal, portalBranding } from '@/platform/common/branding';
import { BadRequestException, ConflictException, NotFoundException } from '@/platform/common/errors';
import { toD128 } from '@/platform/common/money';
import { escapeRegex } from '@/platform/common/validation';
import { AuditService } from '@/platform/services/audit.service';
import { SmsService } from '@/platform/services/sms.service';
import { PortalsDb as Db } from './db';
import { LIBRARY_CATEGORIES, MSME_SECTORS, PORTAL_KEYS, PortalKey } from './schemas';

type Id = Types.ObjectId;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export interface LibraryInput { title: string; author?: string; category: (typeof LIBRARY_CATEGORIES)[number]; year?: number | null; summary?: string; tags: string[]; documentId?: Id | null; url?: string; audience: 'PUBLIC' | 'STAFF'; active?: boolean }
export interface MsmeInput { businessName: string; ownerName: string; phone: string; email?: string; sector: (typeof MSME_SECTORS)[number]; location?: string; kraPin?: string; registrationNo?: string; agpo: 'NONE' | 'YOUTH' | 'WOMEN' | 'PWD'; agpoCertificate?: string; description?: string; products: { name: string; description?: string; price?: string | null; unit?: string }[] }

/**
 * The organisation's public portals: settings and branding for each, the e-library (public items for
 * anyone, the rest for staff), and the MSME products portal where local businesses register, are
 * approved, and keep their products listed for the public and for buyers.
 */
export class PortalsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
  ) {}

  private async org(code: string) {
    const org = await this.db.organisations.findOne({ code: code.toUpperCase() }, { name: 1, modules: 1, code: 1 }).lean();
    if (!org) throw new NotFoundException('Organisation not found');
    return org;
  }

  // Settings ----------------------------------------------------------------------------------------

  async settings(user: AuthUser) {
    return Promise.all(PORTAL_KEYS.map((p) => portalBranding(this.db.connection, user.organisationId, p)));
  }

  async saveSettings(user: AuthUser, portal: PortalKey, input: { enabled: boolean; title?: string; welcome?: string; accent?: string; logoUrl?: string; contactEmail?: string; contactPhone?: string; footer?: string }) {
    if (input.accent && !/^#[0-9a-fA-F]{6}$/.test(input.accent)) throw new BadRequestException('Give the colour as #RRGGBB');
    if (input.logoUrl && !/^https:\/\//.test(input.logoUrl)) throw new BadRequestException('The logo must be an https:// address');
    await this.db.settings.updateOne({ organisationId: user.organisationId, portal }, { $set: input }, { upsert: true });
    await this.audit.record(user, 'portals.settings.update', 'portalSettings', null, { portal, enabled: input.enabled });
    return portalBranding(this.db.connection, user.organisationId, portal);
  }

  /** The branding a public page shows, by the organisation's code. */
  async publicBranding(code: string, portal: PortalKey) {
    const org = await this.org(code);
    return { organisation: org.name, ...(await portalBranding(this.db.connection, org._id, portal)) };
  }

  // E-library ---------------------------------------------------------------------------------------

  async library(user: AuthUser, q: { search?: string; category?: string }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.category) filter.category = q.category;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ title: rx }, { summary: rx }, { author: rx }, { tags: rx }];
    }
    return this.db.library.find(filter).sort({ year: -1, title: 1 }).limit(500).lean();
  }

  async saveItem(user: AuthUser, id: Id | null, input: LibraryInput) {
    if (!input.documentId && !input.url) throw new BadRequestException('Attach a document or give a link');
    if (input.url && !/^https?:\/\//.test(input.url)) throw new BadRequestException('Links start with http:// or https://');
    if (input.documentId && !(await this.db.documents.exists({ _id: input.documentId, organisationId: user.organisationId, deletedAt: null }))) throw new BadRequestException('Document not found');
    const fields = { ...input, tags: input.tags.map((t) => t.toLowerCase()), documentId: input.documentId ?? null, url: input.url ?? '' };
    const doc = id ? await this.db.library.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.library.create({ ...fields, organisationId: user.organisationId, addedBy: user.id })).toObject();
    if (!doc) throw new NotFoundException('Item not found');
    await this.audit.record(user, id ? 'portals.library.update' : 'portals.library.create', 'portalLibraryItem', doc._id, { title: input.title, audience: input.audience });
    return doc;
  }

  async publicLibrary(code: string, q: { search?: string; category?: string }) {
    const org = await this.org(code);
    const branding = await openPortal(this.db.connection, org._id, 'library');
    const filter: Record<string, unknown> = { organisationId: org._id, audience: 'PUBLIC', active: true };
    if (q.category) filter.category = q.category;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ title: rx }, { summary: rx }, { author: rx }, { tags: rx }];
    }
    const items = await this.db.library.find(filter, { title: 1, author: 1, category: 1, year: 1, summary: 1, tags: 1, url: 1, documentId: 1, downloads: 1 }).sort({ year: -1, title: 1 }).limit(500).lean();
    return { organisation: org.name, branding, items: items.map((i) => ({ ...i, documentId: undefined, hasFile: Boolean(i.documentId) })) };
  }

  /** Opens a library file: public items for anyone; staff items through the staff route only. */
  async open(organisationId: Id, itemId: Id, audience: 'PUBLIC' | 'ANY') {
    const item = await this.db.library.findOne({ _id: itemId, organisationId, active: true, ...(audience === 'PUBLIC' && { audience: 'PUBLIC' }) }).lean();
    if (!item) throw new NotFoundException('Not found');
    await this.db.library.updateOne({ _id: item._id }, { $inc: { downloads: 1 } });
    if (!item.documentId) return Response.redirect(item.url, 302);
    const d = await this.db.documents.findOne({ _id: item.documentId, organisationId, deletedAt: null }).lean();
    if (!d) throw new NotFoundException('The file is no longer available');
    const bucket = new mongo.GridFSBucket(this.db.connection.db!, { bucketName: 'documents' });
    const chunks: Buffer[] = [];
    for await (const chunk of bucket.openDownloadStream(d.fileId)) chunks.push(chunk as Buffer);
    return new Response(Buffer.concat(chunks), { headers: { 'content-type': d.contentType, 'content-disposition': `inline; filename="${d.name.replace(/[^\w.\- ]/g, '_')}"`, 'cache-control': audience === 'PUBLIC' ? 'public, max-age=300' : 'private, no-store' } });
  }

  async publicOpen(code: string, itemId: Id) {
    const org = await this.org(code);
    await openPortal(this.db.connection, org._id, 'library');
    return this.open(org._id, itemId, 'PUBLIC');
  }

  // MSMEs -------------------------------------------------------------------------------------------

  private products(input: MsmeInput['products']) {
    return input.map((p) => ({ name: p.name, description: p.description, unit: p.unit, price: p.price ? toD128(p.price) : null, active: true }));
  }

  /** A business registers on the public portal; it is listed once the organisation approves it. */
  async register(code: string, input: MsmeInput) {
    const org = await this.org(code);
    await openPortal(this.db.connection, org._id, 'msme');
    const seq = await this.db.next(org._id, 'portals:msme');
    try {
      const [doc] = await this.db.msmes.create([{ organisationId: org._id, reference: `MSME-${String(seq).padStart(5, '0')}`, ...input, products: this.products(input.products) }]);
      await this.sms.queue(org._id, input.phone, `${org.name}: we received the registration of ${input.businessName} (${doc.reference}). We will text you once it is approved.`, 'portals:msme', doc._id);
      await this.sms.deliverDue(org._id);
      return { reference: doc.reference, status: doc.status };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('A business with this phone number is already registered');
      throw err;
    }
  }

  msmes(user: AuthUser, status?: string) {
    return this.db.msmes.find({ organisationId: user.organisationId, ...(status && { status }) }, { tokenHash: 0 }).sort({ createdAt: -1 }).limit(500).lean();
  }

  /** Approve (the business gets its own link by SMS to keep products up to date), reject or suspend. */
  async decide(user: AuthUser, id: Id, input: { status: 'APPROVED' | 'REJECTED' | 'SUSPENDED'; reason?: string }) {
    if (input.status !== 'APPROVED' && !input.reason?.trim()) throw new BadRequestException('Give the reason; the business is told');
    const m = await this.db.msmes.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!m) throw new NotFoundException('Business not found');
    const token = input.status === 'APPROVED' && !m.tokenHash ? randomBytes(24).toString('base64url') : null;
    await this.db.msmes.updateOne({ _id: id }, { status: input.status, reason: input.reason ?? '', decidedBy: user.id, decidedAt: new Date(), ...(token && { tokenHash: hash(token) }) });
    await this.audit.record(user, `portals.msme.${input.status.toLowerCase()}`, 'portalMsme', id, { reference: m.reference, reason: input.reason });
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    const text = input.status === 'APPROVED' ? `${m.businessName} is now listed on the ${org?.name} MSME portal.${token ? ` Keep your products up to date at /msme-account/${token}` : ''}` : `${m.businessName}: your MSME listing was ${input.status.toLowerCase()}. ${input.reason}`;
    await this.sms.queue(user.organisationId, m.phone, text, 'portals:msme', m._id);
    await this.sms.deliverDue(user.organisationId);
    return { ...(await this.db.msmes.findById(id, { tokenHash: 0 }).lean()), path: token ? `/msme-account/${token}` : null };
  }

  /** The public catalogue: approved businesses and their products, searchable by sector and words. */
  async catalogue(code: string, q: { search?: string; sector?: string; agpo?: string }) {
    const org = await this.org(code);
    const branding = await openPortal(this.db.connection, org._id, 'msme');
    const filter: Record<string, unknown> = { organisationId: org._id, status: 'APPROVED' };
    if (q.sector) filter.sector = q.sector;
    if (q.agpo) filter.agpo = q.agpo;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ businessName: rx }, { description: rx }, { 'products.name': rx }, { location: rx }];
    }
    const rows = await this.db.msmes.find(filter, { businessName: 1, sector: 1, location: 1, phone: 1, email: 1, agpo: 1, description: 1, products: 1 }).sort({ businessName: 1 }).limit(500).lean();
    return { organisation: org.name, branding, businesses: rows.map((r) => ({ ...r, products: r.products.filter((p) => p.active) })) };
  }

  private async byToken(token: string) {
    if (!token || token.length < 20) throw new NotFoundException('This link is not valid');
    const m = await this.db.msmes.findOne({ tokenHash: hash(token), status: 'APPROVED' }).lean();
    if (!m) throw new NotFoundException('This link is not valid');
    return m;
  }

  async account(token: string) {
    const m = await this.byToken(token);
    return { ...m, tokenHash: undefined };
  }

  async saveProducts(token: string, input: { description?: string; products: MsmeInput['products'] }) {
    const m = await this.byToken(token);
    await this.db.msmes.updateOne({ _id: m._id }, { products: this.products(input.products), ...(input.description !== undefined && { description: input.description }) });
    return this.account(token);
  }
}
