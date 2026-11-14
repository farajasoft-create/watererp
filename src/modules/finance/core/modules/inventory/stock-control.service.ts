import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { ProcurementService } from '../procurement/procurement.service';
import { InventoryService } from './inventory.service';
import { StoreRequisitionsService } from './store-requisitions.service';

type Id = Types.ObjectId;
const OPEN_REQUISITION = ['DRAFT', 'SUBMITTED', 'APPROVED'];

/** RED: out of stock or below half the re-order level; AMBER: below the re-order level; GREEN: fine. */
export function stockLight(quantity: Decimal, reorderLevel: Decimal | null): 'RED' | 'AMBER' | 'GREEN' | 'NONE' {
  if (quantity.lte(0)) return 'RED';
  if (!reorderLevel || reorderLevel.lte(0)) return 'NONE';
  if (quantity.lt(reorderLevel.div(2))) return 'RED';
  if (quantity.lt(reorderLevel)) return 'AMBER';
  return 'GREEN';
}

/**
 * Stock control: the multi-level item category tree, barcodes, the traffic-light stock dashboard, automatic
 * purchase requisitions for items below their re-order level, and issuing store requisitions by scanning.
 */
export class StockControlService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly procurement: ProcurementService,
    private readonly storeRequisitions: StoreRequisitionsService,
  ) {}

  // ----- Categories --------------------------------------------------------------------------

  /** Every category with its full path and depth, in tree order, and the number of items in it and below it. */
  async categories(user: AuthUser) {
    const all = await this.db.itemCategories.find({ organisationId: user.organisationId }).lean();
    const counts = await this.db.items.aggregate<{ _id: Id; n: number }>([{ $match: { organisationId: user.organisationId, categoryId: { $ne: null } } }, { $group: { _id: '$categoryId', n: { $sum: 1 } } }]);
    const own = (id: Id) => counts.find((c) => c._id.equals(id))?.n ?? 0;
    const children = (id: Id | null) => all.filter((c) => (id ? c.parentId?.equals(id) : !c.parentId)).sort((a, b) => a.name.localeCompare(b.name));
    const out: { id: Id; code: string; name: string; parentId: Id | null; path: string; depth: number; items: number; itemsBelow: number; isActive: boolean }[] = [];
    const walk = (id: Id | null, path: string, depth: number): number => {
      let total = 0;
      for (const c of children(id)) {
        const p = path ? `${path} / ${c.name}` : c.name;
        const row = { id: c._id, code: c.code, name: c.name, parentId: c.parentId ?? null, path: p, depth, items: own(c._id), itemsBelow: 0, isActive: c.isActive };
        out.push(row);
        row.itemsBelow = row.items + walk(c._id, p, depth + 1);
        total += row.itemsBelow;
      }
      return total;
    };
    walk(null, '', 0);
    return out;
  }

  /** The category and every category under it. */
  async descendants(organisationId: Id, id: Id) {
    const all = await this.db.itemCategories.find({ organisationId }, { parentId: 1 }).lean();
    const ids = [id];
    for (let i = 0; i < ids.length; i++) for (const c of all) if (c.parentId?.equals(ids[i])) ids.push(c._id);
    return ids;
  }

  async path(organisationId: Id, id: Id, session?: ClientSession) {
    const names: string[] = [];
    let cur: Id | null = id;
    for (let guard = 0; cur && guard < 20; guard++) {
      const c: { name: string; parentId?: Id | null } | null = await this.db.itemCategories.findOne({ _id: cur, organisationId }, { name: 1, parentId: 1 }).session(session ?? null).lean();
      if (!c) throw new BadRequestException('Item category not found');
      names.unshift(c.name);
      cur = c.parentId ?? null;
    }
    return names.join(' / ');
  }

  async saveCategory(user: AuthUser, id: Id | null, input: { code: string; name: string; parentId?: Id | null; isActive?: boolean }) {
    if (input.parentId) {
      if (id && (await this.descendants(user.organisationId, id)).some((d) => d.equals(input.parentId!))) throw new BadRequestException('A category cannot sit under itself or one of its own subcategories');
      await this.path(user.organisationId, input.parentId);
    }
    const fields = { code: input.code.toUpperCase(), name: input.name, parentId: input.parentId ?? null, ...(input.isActive !== undefined && { isActive: input.isActive }) };
    if (await this.db.itemCategories.exists({ organisationId: user.organisationId, code: fields.code, ...(id && { _id: { $ne: id } }) })) throw new BadRequestException(`Category ${fields.code} already exists`);
    const doc = id ? await this.db.itemCategories.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.itemCategories.create({ ...fields, organisationId: user.organisationId })).toObject();
    if (!doc) throw new NotFoundException('Item category not found');
    // Keep the display path on items in this branch of the tree up to date.
    for (const cid of await this.descendants(user.organisationId, doc._id)) await this.db.items.updateMany({ organisationId: user.organisationId, categoryId: cid }, { category: await this.path(user.organisationId, cid) });
    await this.audit.log(user, { action: id ? 'item-category.update' : 'item-category.create', recordType: 'ItemCategory', recordId: doc._id, summary: `${id ? 'Edited' : 'Created'} item category ${fields.code}` });
    return doc;
  }

  /** Items, optionally in a category and everything under it. */
  async items(user: AuthUser, q: { categoryId?: Id; search?: string }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.categoryId) filter.categoryId = { $in: await this.descendants(user.organisationId, q.categoryId) };
    if (q.search) {
      const rx = new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ code: rx }, { name: rx }, { barcode: q.search }];
    }
    return this.db.items.find(filter).sort({ code: 1 }).lean();
  }

  async byBarcode(user: AuthUser, code: string) {
    const item = await this.db.items.findOne({ organisationId: user.organisationId, $or: [{ barcode: code }, { code: code.toUpperCase() }] }).lean();
    if (!item) throw new NotFoundException(`No item has the code ${code}`);
    return item;
  }

  // ----- Dashboard and automatic requisitions --------------------------------------------------

  async dashboard(user: AuthUser, entityId: Id) {
    const stock = await this.inventory.onHand(user, entityId);
    const items = await this.db.items.find({ organisationId: user.organisationId, type: 'STOCK' }, { reorderLevel: 1, reorderQty: 1, lastAutoRequisition: 1, isActive: 1 }).lean();
    const rows = stock.rows
      .map((r) => {
        const it = items.find((i) => i._id.equals(r.itemId));
        const level = it?.reorderLevel ? dec(it.reorderLevel) : null;
        return { ...r, reorderLevel: level, reorderQty: it?.reorderQty ? dec(it.reorderQty) : null, light: stockLight(r.quantity, level), autoRequisition: it?.lastAutoRequisition ?? null, active: it?.isActive !== false };
      })
      .filter((r) => r.active);
    const count = (l: string) => rows.filter((r) => r.light === l).length;
    const order = { RED: 0, AMBER: 1, NONE: 2, GREEN: 3 } as const;
    return {
      currency: stock.currency,
      summary: { items: rows.length, red: count('RED'), amber: count('AMBER'), green: count('GREEN'), unset: count('NONE'), value: stock.total },
      rows: rows.sort((a, b) => order[a.light] - order[b.light] || a.code.localeCompare(b.code)),
    };
  }

  /**
   * Raises one draft purchase requisition for every stock item below its re-order level that has no open
   * automatic requisition: the re-order quantity, or enough to bring stock back to twice the level.
   */
  async autoRequisition(user: AuthUser, input: { entityId: Id; branchId: Id; date: Date }) {
    const board = await this.dashboard(user, input.entityId);
    const due = board.rows.filter((r) => (r.light === 'RED' || r.light === 'AMBER') && r.reorderLevel);
    const open = await this.db.requisitions.find({ organisationId: user.organisationId, _id: { $in: due.map((r) => r.autoRequisition?.id).filter(Boolean) as Id[] }, status: { $in: OPEN_REQUISITION } }, { _id: 1 }).lean();
    const lines = [];
    for (const r of due) {
      if (r.autoRequisition?.id && open.some((o) => o._id.equals(r.autoRequisition!.id!))) continue;
      const item = await this.db.items.findById(r.itemId).lean();
      if (!item) continue;
      const quantity = r.reorderQty ?? Decimal.max(r.reorderLevel!.times(2).minus(r.quantity), 1);
      const price = item.lastPurchase?.unitPrice ? dec(item.lastPurchase.unitPrice) : r.averageCost;
      lines.push({ item, line: { description: `${item.code} ${item.name} (${r.quantity.toFixed()} ${item.unit} left, re-order level ${r.reorderLevel!.toFixed()})`, accountId: item.inventoryAccountId ?? item.purchaseAccountId ?? null, quantity, estimatedUnitPrice: price.toDecimalPlaces(2) } });
    }
    if (!lines.length) return { created: null, items: 0 };
    const req = await this.procurement.createRequisition(user, { entityId: input.entityId, branchId: input.branchId, date: input.date, description: `Re-order: ${lines.length} item(s) below their re-order level`, lines: lines.map((l) => l.line) });
    for (const l of lines) await this.db.items.updateOne({ _id: l.item._id }, { lastAutoRequisition: { id: req._id, number: req.number, at: new Date() } });
    await this.audit.log(user, { action: 'inventory.auto-requisition', recordType: 'Requisition', recordId: req._id, summary: `Raised ${req.number} for ${lines.length} item(s) below their re-order level` });
    return { created: { id: req._id, number: req.number }, items: lines.length };
  }

  // ----- Issuing by scanning -------------------------------------------------------------------

  /** Turns the scanned barcodes (each scan one unit unless a quantity is given) into issue lines. */
  async issueByScan(user: AuthUser, id: Id, input: { date: Date; collectedBy?: string; reference?: string; scans: { code: string; quantity?: Decimal }[] }) {
    const r = await this.db.storeRequisitions.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r) throw new NotFoundException('Store requisition not found');
    const totals = new Map<number, Decimal>();
    for (const s of input.scans) {
      const item = await this.byBarcode(user, s.code);
      const line = r.lines.find((l) => l.itemId.equals(item._id));
      if (!line) throw new BadRequestException(`${item.code} ${item.name} is not on ${r.number}`);
      totals.set(line.lineNo, (totals.get(line.lineNo) ?? new Decimal(0)).plus(s.quantity ?? 1));
    }
    return this.storeRequisitions.issue(user, id, { date: input.date, collectedBy: input.collectedBy, reference: input.reference, lines: [...totals].map(([lineNo, quantity]) => ({ lineNo, quantity })) });
  }

  /** For item saves: the category path to store with the item. */
  async categoryFields(organisationId: Id, categoryId: Id | null | undefined) {
    if (categoryId === undefined) return {};
    if (categoryId === null) return { categoryId: null };
    return { categoryId, category: await this.path(organisationId, categoryId) };
  }

  reorderQtyField(v: Decimal | null | undefined) {
    return v === undefined ? {} : { reorderQty: v ? toD128(v) : null };
  }
}
