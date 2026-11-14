import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { csvResponse } from '@/platform/common/csv';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { escapeRegex } from '@/platform/common/validation';
import { AuditService } from '@/platform/services/audit.service';
import { NotificationsService } from '@/platform/services/notifications.service';
import { IctDb as Db } from './db';
import { ASSET_CONDITIONS, ASSET_KINDS, OPEN_STATUSES } from './schemas';

type Id = Types.ObjectId;
type Condition = (typeof ASSET_CONDITIONS)[number];
const DAY = 86_400_000;

export interface OfficeAssetInput {
  tag: string;
  description: string;
  kind: (typeof ASSET_KINDS)[number];
  make?: string;
  model?: string;
  serialNo?: string;
  location?: string;
  condition: Condition;
}

/**
 * Office equipment issued to staff (who holds what, since when, in what condition, and its history)
 * and office consumables (stock, receipts, issues to staff and departments, re-order alerts).
 */
export class OfficeAssetsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // Equipment --------------------------------------------------------------------------------------

  async list(user: AuthUser, q: { status?: string; holderId?: Id; search?: string }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    if (q.holderId) filter.holderId = q.holderId;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ tag: rx }, { description: rx }, { serialNo: rx }, { holderName: rx }, { department: rx }];
    }
    return this.db.officeAssets.find(filter, { allocations: 0 }).sort({ tag: 1 }).limit(1000).lean();
  }

  async get(user: AuthUser, id: Id) {
    const a = await this.db.officeAssets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Asset not found');
    const tickets = await this.db.tickets.find({ organisationId: user.organisationId, assetTag: a.tag }, { number: 1, subject: 1, status: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(50).lean();
    return { ...a, tickets };
  }

  /** What the signed-in user holds, for self-service. */
  mine(user: AuthUser) {
    return this.db.officeAssets.find({ organisationId: user.organisationId, holderId: user.id, status: 'ISSUED' }, { allocations: 0 }).sort({ tag: 1 }).lean();
  }

  async save(user: AuthUser, id: Id | null, input: OfficeAssetInput) {
    const fields = { ...input, tag: input.tag.toUpperCase() };
    try {
      const doc = id
        ? await this.db.officeAssets.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean()
        : (await this.db.officeAssets.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Asset not found');
      await this.audit.record(user, id ? 'ict.asset.update' : 'ict.asset.create', 'ictOfficeAsset', doc._id, { tag: fields.tag });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new BadRequestException(`Tag ${fields.tag} is already used`);
      throw err;
    }
  }

  async issue(user: AuthUser, id: Id, input: { holderId: Id; department?: string; condition?: Condition; note?: string; date?: Date }) {
    const a = await this.db.officeAssets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Asset not found');
    if (a.status !== 'IN_STORE') throw new BadRequestException(a.status === 'ISSUED' ? `${a.tag} is with ${a.holderName}; take it back first` : `${a.tag} is ${a.status.toLowerCase().replace('_', ' ')}`);
    const holder = await this.db.users.findOne({ _id: input.holderId, organisationId: user.organisationId }, { name: 1 }).lean();
    if (!holder) throw new NotFoundException('Staff member not found');
    const at = input.date ?? new Date();
    const condition = input.condition ?? a.condition;
    const updated = await this.db.officeAssets
      .findOneAndUpdate(
        { _id: id, status: 'IN_STORE' },
        { status: 'ISSUED', holderId: holder._id, holderName: holder.name, department: input.department, issuedAt: at, condition, $push: { allocations: { holderId: holder._id, holderName: holder.name, department: input.department, issuedAt: at, issuedBy: user.id, conditionOut: condition, note: input.note } } },
        { new: true },
      )
      .lean();
    if (!updated) throw new BadRequestException('The asset was changed by someone else');
    await this.audit.record(user, 'ict.asset.issue', 'ictOfficeAsset', id, { tag: a.tag, to: holder.name });
    await this.notifications.notify(user.organisationId, [holder._id], { title: `${a.tag} issued to you`, body: `${a.description}${a.serialNo ? ` (serial ${a.serialNo})` : ''}, condition ${condition.toLowerCase()}. You are responsible for it until it is returned.`, module: 'ict', link: '/ict/help' });
    return updated;
  }

  async takeBack(user: AuthUser, id: Id, input: { condition: Condition; note?: string; toRepair?: boolean }) {
    const a = await this.db.officeAssets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Asset not found');
    if (a.status !== 'ISSUED') throw new BadRequestException(`${a.tag} is not issued to anyone`);
    const open = (a.allocations ?? []).length - 1;
    const now = new Date();
    const updated = await this.db.officeAssets
      .findOneAndUpdate(
        { _id: id, status: 'ISSUED' },
        {
          status: input.toRepair || input.condition === 'FAULTY' ? 'UNDER_REPAIR' : 'IN_STORE',
          condition: input.condition,
          holderId: null,
          holderName: null,
          department: null,
          issuedAt: null,
          [`allocations.${open}.returnedAt`]: now,
          [`allocations.${open}.receivedBy`]: user.id,
          [`allocations.${open}.conditionIn`]: input.condition,
          ...(input.note && { [`allocations.${open}.note`]: [a.allocations?.[open]?.note, input.note].filter(Boolean).join(' / ') }),
        },
        { new: true },
      )
      .lean();
    if (!updated) throw new BadRequestException('The asset was changed by someone else');
    await this.audit.record(user, 'ict.asset.return', 'ictOfficeAsset', id, { tag: a.tag, from: a.holderName, condition: input.condition });
    return updated;
  }

  async setStatus(user: AuthUser, id: Id, status: 'IN_STORE' | 'UNDER_REPAIR' | 'DISPOSED', note?: string) {
    const a = await this.db.officeAssets.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Asset not found');
    if (a.status === 'ISSUED') throw new BadRequestException(`${a.tag} is with ${a.holderName}; take it back first`);
    if (a.status === 'DISPOSED') throw new BadRequestException(`${a.tag} was disposed of`);
    await this.db.officeAssets.updateOne({ _id: id }, { status });
    await this.audit.record(user, 'ict.asset.status', 'ictOfficeAsset', id, { tag: a.tag, status, note });
    return this.get(user, id);
  }

  async holdingsCsv(user: AuthUser) {
    const rows = await this.db.officeAssets.find({ organisationId: user.organisationId, status: { $ne: 'DISPOSED' } }, { allocations: 0 }).sort({ holderName: 1, tag: 1 }).lean();
    return csvResponse('office-assets.csv', [
      ['Tag', 'Description', 'Kind', 'Make', 'Model', 'Serial', 'Status', 'Condition', 'Held by', 'Department', 'Issued', 'Location'],
      ...rows.map((a) => [a.tag, a.description, a.kind, a.make, a.model, a.serialNo, a.status, a.condition, a.holderName, a.department, a.issuedAt ? a.issuedAt.toISOString().slice(0, 10) : '', a.location]),
    ]);
  }

  // Consumables ------------------------------------------------------------------------------------

  consumables(user: AuthUser) {
    return this.db.consumables.find({ organisationId: user.organisationId }).sort({ name: 1 }).lean().then((rows) => rows.map((c) => ({ ...c, low: c.active && c.onHand <= c.reorderLevel })));
  }

  async saveConsumable(user: AuthUser, id: Id | null, input: { code: string; name: string; unit: string; reorderLevel: number; active?: boolean }) {
    const fields = { ...input, code: input.code.toUpperCase() };
    try {
      const doc = id
        ? await this.db.consumables.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean()
        : (await this.db.consumables.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Item not found');
      await this.audit.record(user, id ? 'ict.consumable.update' : 'ict.consumable.create', 'ictConsumable', doc._id, fields);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new BadRequestException(`There is already an item ${fields.code}`);
      throw err;
    }
  }

  /** Stock in (a delivery), out (an issue to someone) or a count correction. Stock never goes below zero. */
  async move(user: AuthUser, id: Id, input: { kind: 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT'; quantity: number; toId?: Id | null; department?: string; reference?: string; date?: Date }) {
    const item = await this.db.consumables.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!item) throw new NotFoundException('Item not found');
    if (input.kind !== 'ADJUSTMENT' && input.quantity <= 0) throw new BadRequestException('Enter a quantity above zero');
    if (input.kind === 'ISSUE' && !input.toId && !input.department) throw new BadRequestException('Say who or which department it was issued to');
    const to = input.toId ? await this.db.users.findOne({ _id: input.toId, organisationId: user.organisationId }, { name: 1 }).lean() : null;
    if (input.toId && !to) throw new NotFoundException('Staff member not found');
    const change = input.kind === 'ISSUE' ? -input.quantity : input.quantity;
    const result = await this.db.transaction(async (session) => {
      const updated = await this.db.consumables.findOneAndUpdate({ _id: id, onHand: { $gte: -change } }, { $inc: { onHand: change } }, { new: true, session }).lean();
      if (!updated) throw new BadRequestException(`Only ${item.onHand} ${item.unit} of ${item.name} in stock`);
      await this.db.consumableMoves.create([{ organisationId: user.organisationId, consumableId: id, kind: input.kind, quantity: change, toId: to?._id ?? null, toName: to?.name, department: input.department, reference: input.reference, date: input.date ?? new Date(), by: user.id }], { session });
      await this.audit.record(user, `ict.consumable.${input.kind.toLowerCase()}`, 'ictConsumable', id, { quantity: change, to: to?.name, department: input.department }, session);
      return updated;
    });
    if (input.kind === 'ISSUE' && item.onHand > item.reorderLevel && result.onHand <= result.reorderLevel) {
      const admins = await this.db.users.find({ organisationId: user.organisationId, active: { $ne: false }, $or: [{ isAdmin: true }, { access: { $elemMatch: { module: 'ict', role: { $in: ['MANAGER', 'ADMIN_OFFICER'] } } } }] }, { _id: 1 }).lean();
      await this.notifications.notify(user.organisationId, admins.map((a) => a._id), { title: `Re-order ${item.name}`, body: `${result.onHand} ${item.unit} left (re-order level ${item.reorderLevel})`, module: 'ict', link: '/ict/assets' });
    }
    return { ...result, low: result.onHand <= result.reorderLevel };
  }

  moves(user: AuthUser, id: Id) {
    return this.db.consumableMoves.find({ organisationId: user.organisationId, consumableId: id }).sort({ date: -1, createdAt: -1 }).limit(200).lean();
  }

  // Report -----------------------------------------------------------------------------------------

  /**
   * Administrative efficiency for a period: equipment in use, idle, under repair and faulty; who holds
   * how much; consumables issued by department and item; items to re-order; and help desk load by asset.
   */
  async report(user: AuthUser, from: Date, to: Date) {
    const org = user.organisationId;
    const end = new Date(to.getTime() + DAY);
    const [assets, items, issues, tickets] = await Promise.all([
      this.db.officeAssets.find({ organisationId: org, status: { $ne: 'DISPOSED' } }, { allocations: 0 }).lean(),
      this.db.consumables.find({ organisationId: org, active: true }).lean(),
      this.db.consumableMoves.find({ organisationId: org, kind: 'ISSUE', date: { $gte: from, $lt: end } }).lean(),
      this.db.tickets.find({ organisationId: org, assetTag: { $nin: [null, ''] }, createdAt: { $gte: from, $lt: end } }, { assetTag: 1, status: 1 }).lean(),
    ]);
    const count = <T>(xs: T[], key: (x: T) => string) => [...xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>())].map(([k, n]) => ({ key: k, count: n })).sort((a, b) => b.count - a.count);
    const issuedBy = (key: (m: (typeof issues)[number]) => string) =>
      [...issues.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) - x.quantity), new Map<string, number>())].map(([k, q]) => ({ key: k, quantity: q })).sort((a, b) => b.quantity - a.quantity);
    const itemName = new Map(items.map((i) => [i._id.toHexString(), `${i.name} (${i.unit})`]));
    const repeat = count(tickets, (t) => t.assetTag!).filter((r) => r.count > 1);
    return {
      equipment: {
        total: assets.length,
        issued: assets.filter((a) => a.status === 'ISSUED').length,
        inStore: assets.filter((a) => a.status === 'IN_STORE').length,
        underRepair: assets.filter((a) => a.status === 'UNDER_REPAIR').length,
        poorOrFaulty: assets.filter((a) => a.condition === 'POOR' || a.condition === 'FAULTY').length,
        utilisationPct: assets.length ? Math.round((assets.filter((a) => a.status === 'ISSUED').length / assets.length) * 1000) / 10 : null,
        byKind: count(assets, (a) => a.kind),
        byDepartment: count(assets.filter((a) => a.status === 'ISSUED'), (a) => a.department || 'Not given'),
      },
      consumables: {
        issues: issues.length,
        byDepartment: issuedBy((m) => m.department || 'Not given'),
        byItem: issuedBy((m) => itemName.get(m.consumableId.toHexString()) ?? 'Removed item'),
        toReorder: items.filter((i) => i.onHand <= i.reorderLevel).map((i) => ({ code: i.code, name: i.name, onHand: i.onHand, reorderLevel: i.reorderLevel, unit: i.unit })),
      },
      /** Equipment with more than one help desk ticket in the period: candidates for replacement. */
      repeatFaults: repeat,
      openAssetTickets: tickets.filter((t) => (OPEN_STATUSES as readonly string[]).includes(t.status)).length,
    };
  }
}
