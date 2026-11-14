import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum, toD128 } from '../../common/money';
import { escapeRegex } from '../../common/workflow';
import { ASSET_CONDITIONS, MAINTENANCE_KINDS } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { AssetsService } from './assets.service';

const DAY = 86_400_000;

/**
 * Looking after assets once they are on the register: tags printed as QR labels and scanned to find and
 * verify an asset, servicing and repairs with what they cost, and warranty and insurance cover that is
 * about to lapse.
 */
export class AssetCareService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly assets: AssetsService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  /** The asset a scanned label points at (its tag, or the asset number for older labels). */
  async byTag(user: AuthUser, tag: string) {
    const t = tag.trim().toUpperCase();
    const asset = await this.db.fixedAssets.findOne({ ...this.scope(user), $or: [{ tagNumber: t }, { number: t }] }).lean();
    if (!asset) throw new NotFoundException(`No asset is tagged ${t}`);
    return asset;
  }

  /** Physical verification: confirms the asset was seen, where, and in what state. */
  async verify(user: AuthUser, input: { tag: string; location?: string; condition?: (typeof ASSET_CONDITIONS)[number]; date?: Date }) {
    const asset = await this.byTag(user, input.tag);
    if (asset.status === 'DISPOSED') throw new BadRequestException(`${asset.number} was disposed of on ${asset.disposal?.date?.toISOString().slice(0, 10)}; report it to finance`);
    const me = await this.db.users.findById(user.id, { name: 1 }).lean();
    const location = input.location ?? asset.location;
    const condition = input.condition ?? asset.condition;
    const after = await this.db.fixedAssets
      .findByIdAndUpdate(asset._id, { $set: { lastVerified: { date: input.date ?? new Date(), by: user.id, byName: me?.name ?? '', location, condition }, location, condition } }, { new: true })
      .lean();
    const moved = location !== asset.location;
    await this.audit.log(user, {
      action: 'asset.verify',
      recordType: 'FixedAsset',
      recordId: asset._id,
      summary: `Verified ${asset.number}${moved ? ` at ${location} (register said ${asset.location || 'no location'})` : location ? ` at ${location}` : ''}, condition ${condition.toLowerCase()}`,
    });
    return { asset: after, moved, previousLocation: asset.location };
  }

  async addMaintenance(user: AuthUser, id: Types.ObjectId, input: { date: Date; kind: (typeof MAINTENANCE_KINDS)[number]; description: string; vendor?: string; cost: Decimal; invoiceId?: Types.ObjectId | null; nextDue?: Date | null }) {
    const asset = await this.assets.load(user, id);
    if (input.cost.isNeg()) throw new BadRequestException('The cost cannot be negative');
    if (input.date < asset.acquisitionDate) throw new BadRequestException('Maintenance cannot be dated before the asset was acquired');
    if (input.nextDue && input.nextDue <= input.date) throw new BadRequestException('The next service must fall after this one');
    let invoiceNumber = '';
    let vendor = input.vendor ?? '';
    if (input.invoiceId) {
      // Linking the supplier bill ties the cost to what was actually posted to the ledger.
      const bill = await this.db.invoices.findOne({ _id: input.invoiceId, organisationId: user.organisationId, entityId: asset.entityId, kind: 'PURCHASE_BILL', status: 'POSTED' }, { number: 1, partyName: 1, subtotal: 1 }).lean();
      if (!bill) throw new BadRequestException('Link a posted supplier bill of the same entity');
      const linked = await this.db.fixedAssets.exists({ organisationId: user.organisationId, 'maintenance.invoiceId': bill._id });
      if (linked) throw new BadRequestException(`${bill.number} is already linked to maintenance on another record`);
      if (input.cost.gt(dec(bill.subtotal))) throw new BadRequestException(`The cost is more than ${bill.number} (${dec(bill.subtotal).toFixed()} before tax)`);
      invoiceNumber = bill.number;
      vendor ||= bill.partyName;
    }
    const entry = { _id: new Types.ObjectId(), date: input.date, kind: input.kind, description: input.description, vendor, cost: toD128(input.cost), invoiceId: input.invoiceId ?? null, invoiceNumber, nextDue: input.nextDue ?? null, recordedBy: user.id };
    const after = await this.db.fixedAssets.findByIdAndUpdate(asset._id, { $push: { maintenance: { $each: [entry], $sort: { date: 1 } } } }, { new: true }).lean();
    await this.audit.log(user, { action: 'asset.maintenance', recordType: 'FixedAsset', recordId: asset._id, summary: `${input.kind.toLowerCase().replace('_', ' ')} on ${asset.number}: ${input.description} (${input.cost.toFixed()}${invoiceNumber ? `, ${invoiceNumber}` : ''})` });
    return after;
  }

  async removeMaintenance(user: AuthUser, id: Types.ObjectId, entryId: Types.ObjectId) {
    const asset = await this.assets.load(user, id);
    const entry = asset.maintenance.find((m) => m._id.equals(entryId));
    if (!entry) throw new NotFoundException('Maintenance entry not found');
    const after = await this.db.fixedAssets.findByIdAndUpdate(asset._id, { $pull: { maintenance: { _id: entryId } } }, { new: true }).lean();
    await this.audit.log(user, { action: 'asset.maintenance_remove', recordType: 'FixedAsset', recordId: asset._id, summary: `Removed maintenance of ${entry.date.toISOString().slice(0, 10)} from ${asset.number}: ${entry.description}` });
    return after;
  }

  /**
   * What needs attention: warranties and insurance that have lapsed or lapse within `days`, assets with no
   * insurance, services that are due, and assets nobody has verified for a year.
   */
  async care(user: AuthUser, q: { entityId: Types.ObjectId; days: number; asOf?: Date }) {
    const now = q.asOf ?? new Date();
    const horizon = new Date(now.getTime() + q.days * DAY);
    const assets = await this.db.fixedAssets.find({ ...this.scope(user), entityId: q.entityId, status: { $ne: 'DISPOSED' } }).sort({ number: 1 }).lean();
    const row = (a: (typeof assets)[number]) => ({ id: a._id, number: a.number, tagNumber: a.tagNumber || a.number, name: a.name, location: a.location, custodian: a.custodian, branchId: a.branchId });
    const until = (d: Date) => Math.ceil((d.getTime() - now.getTime()) / DAY);
    const warranty = assets.filter((a) => a.warranty?.expiresOn && a.warranty.expiresOn <= horizon).map((a) => ({ ...row(a), provider: a.warranty!.provider, expiresOn: a.warranty!.expiresOn, days: until(a.warranty!.expiresOn!) }));
    const insurance = assets
      .filter((a) => a.insurance?.expiresOn && a.insurance.expiresOn <= horizon)
      .map((a) => ({ ...row(a), insurer: a.insurance!.insurer, policyNumber: a.insurance!.policyNumber, sumInsured: a.insurance!.sumInsured, expiresOn: a.insurance!.expiresOn, days: until(a.insurance!.expiresOn!) }));
    const uninsured = assets.filter((a) => !a.insurance?.policyNumber).map((a) => ({ ...row(a), cost: a.cost }));
    const serviceDue = assets.flatMap((a) => {
      const last = a.maintenance.filter((m) => m.nextDue).at(-1);
      return last?.nextDue && last.nextDue <= horizon ? [{ ...row(a), lastService: last.date, nextDue: last.nextDue, days: until(last.nextDue) }] : [];
    });
    const yearAgo = new Date(now.getTime() - 365 * DAY);
    const unverified = assets.filter((a) => !a.lastVerified?.date || a.lastVerified.date < yearAgo).map((a) => ({ ...row(a), lastVerified: a.lastVerified?.date ?? null }));
    const maintenanceCost = sum(assets.flatMap((a) => a.maintenance.filter((m) => m.date.getUTCFullYear() === now.getUTCFullYear()).map((m) => m.cost)));
    return { asOf: now, days: q.days, warranty, insurance, uninsured, serviceDue, unverified, maintenanceCostThisYear: maintenanceCost };
  }

  /**
   * A sheet of asset labels (A4, 3 × 7, the common 63.5 × 38.1 mm layout): the organisation, a QR code
   * holding the tag, the tag in large type and the asset name. Without ids, every active asset of the
   * entity (optionally only those in a location).
   */
  async labels(user: AuthUser, q: { entityId: Types.ObjectId; ids?: Types.ObjectId[]; location?: string; skip?: number }) {
    const filter: Record<string, unknown> = { ...this.scope(user), entityId: q.entityId, status: { $ne: 'DISPOSED' } };
    if (q.ids?.length) filter._id = { $in: q.ids };
    if (q.location) filter.location = new RegExp(`^${escapeRegex(q.location)}`, 'i');
    const [assets, entity] = await Promise.all([this.db.fixedAssets.find(filter, { number: 1, tagNumber: 1, name: 1, location: 1 }).sort({ number: 1 }).limit(2100).lean(), this.db.entities.findOne({ _id: q.entityId, organisationId: user.organisationId }).lean()]);
    if (!entity) throw new NotFoundException('Entity not found');
    if (!assets.length) throw new BadRequestException('No assets to label');
    const owner = entity.legalName || entity.name;

    const mm = (n: number) => (n * 72) / 25.4;
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Asset labels ${entity.code}`, Author: owner } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const cols = 3;
    const rows = 7;
    const w = mm(63.5);
    const h = mm(38.1);
    const left = (doc.page.width - cols * w - 2 * mm(2.5)) / 2;
    const top = (doc.page.height - rows * h) / 2;
    // Skipping lets a part-used sheet be fed again.
    let slot = Math.min(Math.max(q.skip ?? 0, 0), cols * rows - 1);
    for (const a of assets) {
      if (slot === cols * rows) {
        doc.addPage();
        slot = 0;
      }
      const x = left + (slot % cols) * (w + mm(2.5));
      const y = top + Math.floor(slot / cols) * h;
      const tag = a.tagNumber || a.number;
      const qr = await QRCode.toBuffer(tag, { margin: 0, width: 200, errorCorrectionLevel: 'M' });
      const pad = mm(3);
      const size = mm(24);
      doc.image(qr, x + pad, y + (h - size) / 2, { width: size, height: size });
      const tx = x + pad + size + mm(2);
      const tw = w - (tx - x) - mm(2);
      doc.fillColor('#555555').font('Helvetica').fontSize(5.5).text(`PROPERTY OF ${owner.toUpperCase()}`, tx, y + pad, { width: tw, height: 14, ellipsis: true });
      // The tag is the one thing that must be read by eye: largest size that fits on one line.
      doc.font('Helvetica-Bold');
      let fs = 12;
      while (fs > 6 && doc.fontSize(fs).widthOfString(tag) > tw) fs -= 0.5;
      doc.fillColor('#000000').fontSize(fs).text(tag, tx, y + pad + 16, { lineBreak: false });
      doc.font('Helvetica').fontSize(7).text(a.name, tx, y + pad + 32, { width: tw, height: 26, ellipsis: true });
      if (a.location) doc.fillColor('#555555').fontSize(5.5).text(a.location, tx, y + h - pad - 6, { width: tw, height: 7, ellipsis: true });
      slot++;
    }
    doc.end();
    await this.audit.log(user, { action: 'asset.labels', recordType: 'Entity', recordId: entity._id, summary: `Printed ${assets.length} asset label${assets.length === 1 ? '' : 's'}` });
    return { data: await done, filename: `Asset labels ${entity.code}.pdf`, count: assets.length };
  }
}
