import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { assertApprovalLimit, assertSegregation, transition } from '../../common/workflow';
import { Item, StockDocument, StockMovementType, Warehouse } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

export interface MoveInput {
  entityId: Types.ObjectId;
  itemId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  date: Date;
  type: StockMovementType;
  /** Signed quantity: positive receives, negative issues. */
  quantity: Decimal;
  /**
   * Value in functional currency (positive). Receipts default to the current average cost; issues are
   * valued at average cost unless an explicit value is given (supplier returns at the credited amount).
   */
  value?: Decimal | null;
  source: { type: string; id: Types.ObjectId; number: string };
  /** Tracked items: the batches or serials (positive quantities). Batch issues default to first expiry first out. */
  lots?: LotInput[] | null;
  /** Purchases in another currency: the amount paid in that currency. */
  foreign?: { currency: string; value: Decimal } | null;
}

export interface LotInput {
  number: string;
  expiryDate?: Date | null;
  quantity: Decimal;
}

/** Lots as stored on documents. */
export const lotsOf = (lots?: LotInput[] | null) => (lots ?? []).map((l) => ({ number: l.number.trim().toUpperCase(), expiryDate: l.expiryDate ?? null, quantity: toD128(l.quantity) }));
/** Lots read back from a document. */
export const lotInputs = (lots?: { number: string; expiryDate?: Date | null; quantity: unknown }[] | null): LotInput[] => (lots ?? []).map((l) => ({ number: l.number, expiryDate: l.expiryDate ?? null, quantity: dec(l.quantity as never).abs() }));

export interface StockDocumentInput {
  entityId: Types.ObjectId;
  kind: 'ADJUSTMENT' | 'TRANSFER';
  date: Date;
  reason: string;
  warehouseId: Types.ObjectId;
  toWarehouseId?: Types.ObjectId | null;
  adjustmentAccountId?: Types.ObjectId | null;
  lines: { itemId: Types.ObjectId; quantity: Decimal; unitCost?: Decimal | null; lots?: LotInput[] | null }[];
}

/**
 * Perpetual inventory at weighted average cost. Every change in stock is an immutable movement with
 * quantity and value; balances per item and warehouse are maintained in the same transaction as the
 * ledger posting, so stock valuation always agrees with the inventory accounts.
 */
export class InventoryService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly workflow: WorkflowService,
  ) {}

  async item(organisationId: Types.ObjectId, id: Types.ObjectId, session?: ClientSession): Promise<Item> {
    const item = await this.db.items.findOne({ _id: id, organisationId }).session(session ?? null).lean();
    if (!item) throw new BadRequestException('Item not found');
    return item;
  }

  async warehouse(organisationId: Types.ObjectId, id: Types.ObjectId, entityId: Types.ObjectId, session?: ClientSession): Promise<Warehouse> {
    const w = await this.db.warehouses.findOne({ _id: id, organisationId }).session(session ?? null).lean();
    if (!w || !w.entityId.equals(entityId)) throw new BadRequestException('Warehouse not found in this entity');
    if (!w.isActive) throw new BadRequestException(`Warehouse ${w.code} is inactive`);
    return w;
  }

  /**
   * Checks the batches or serials given for a tracked item without moving anything (document validation).
   * Receipts must name them; serial issues must name them; batch issues may leave them to first-expiry-first-out.
   */
  checkLots(item: Item, quantity: Decimal, lots: LotInput[] | null | undefined, inward: boolean, tag: string) {
    const tracking = item.tracking ?? 'NONE';
    const given = (lots ?? []).filter((l) => !l.quantity.isZero());
    if (tracking === 'NONE') {
      if (given.length) throw new BadRequestException(`${tag}: ${item.code} is not tracked by batch or serial number`);
      return;
    }
    const kind = tracking === 'SERIAL' ? 'serial number' : 'batch';
    const numbers = given.map((l) => l.number.trim().toUpperCase());
    if (numbers.some((n) => !n)) throw new BadRequestException(`${tag}: enter each ${kind}`);
    if (new Set(numbers).size !== numbers.length) throw new BadRequestException(`${tag}: a ${kind} is entered twice`);
    if (given.some((l) => l.quantity.isNeg())) throw new BadRequestException(`${tag}: ${kind} quantities must be positive`);
    if (tracking === 'SERIAL' && given.some((l) => !l.quantity.eq(1))) throw new BadRequestException(`${tag}: each serial number is one unit`);
    if (tracking === 'SERIAL' && !quantity.isInteger()) throw new BadRequestException(`${tag}: ${item.code} is counted in whole units`);
    if (!given.length && (inward || tracking === 'SERIAL')) throw new BadRequestException(`${tag}: ${item.code} is tracked by ${kind}; enter the ${kind}${tracking === 'SERIAL' ? 's' : ''} ${inward ? 'received' : 'issued'}`);
    if (given.length && !sum(given.map((l) => l.quantity)).eq(quantity.abs())) {
      throw new BadRequestException(`${tag}: the ${kind}s add up to ${sum(given.map((l) => l.quantity)).toFixed()}, not ${quantity.abs().toFixed()}`);
    }
    if (inward && tracking === 'BATCH' && item.trackExpiry && given.some((l) => !l.expiryDate)) throw new BadRequestException(`${tag}: enter the expiry date of each batch of ${item.code}`);
  }

  /** Moves the batches or serials of a tracked item; returns them with signed quantities for the movement. */
  private async applyLots(org: Types.ObjectId, item: Item, warehouse: Warehouse, m: MoveInput, session: ClientSession) {
    if ((item.tracking ?? 'NONE') === 'NONE') {
      if (m.lots?.some((l) => !l.quantity.isZero())) throw new BadRequestException(`${item.code} is not tracked by batch or serial number`);
      return [];
    }
    const inward = m.quantity.gt(0);
    const tag = `${item.code} in ${warehouse.code}`;
    // Reversals and transfers carry the lots they move, whatever the expiry rule says now.
    this.checkLots({ ...item, trackExpiry: m.type === 'REVERSAL' || m.type === 'TRANSFER_IN' ? false : item.trackExpiry }, m.quantity, m.lots, inward, tag);
    const kind = item.tracking === 'SERIAL' ? 'Serial number' : 'Batch';
    const out: { number: string; expiryDate: Date | null; quantity: Decimal }[] = [];
    if (inward) {
      for (const l of m.lots!.filter((x) => !x.quantity.isZero())) {
        const number = l.number.trim().toUpperCase();
        if (item.tracking === 'SERIAL' && (await this.db.stockLots.exists({ organisationId: org, itemId: item._id, number, quantity: { $gt: toD128(0) } }).session(session))) {
          throw new BadRequestException(`${kind} ${number} of ${item.code} is already in stock`);
        }
        const existing = await this.db.stockLots.findOne({ organisationId: org, itemId: item._id, warehouseId: warehouse._id, number }).session(session).lean();
        const expiryDate = l.expiryDate ?? existing?.expiryDate ?? null;
        if (existing) {
          if (l.expiryDate && existing.expiryDate && l.expiryDate.getTime() !== existing.expiryDate.getTime()) {
            throw new BadRequestException(`${kind} ${number} of ${item.code} expires on ${existing.expiryDate.toISOString().slice(0, 10)}, not ${l.expiryDate.toISOString().slice(0, 10)}`);
          }
          await this.db.stockLots.updateOne({ _id: existing._id }, { quantity: toD128(dec(existing.quantity).plus(l.quantity)), ...(!existing.expiryDate && l.expiryDate && { expiryDate: l.expiryDate }) }, { session });
        } else {
          await this.db.stockLots.create([{ organisationId: org, entityId: m.entityId, itemId: item._id, warehouseId: warehouse._id, number, expiryDate, quantity: toD128(l.quantity), receivedDate: m.date }], { session });
        }
        out.push({ number, expiryDate, quantity: l.quantity });
      }
      return out;
    }
    const needed = m.quantity.neg();
    const available = await this.db.stockLots.find({ organisationId: org, itemId: item._id, warehouseId: warehouse._id, quantity: { $gt: toD128(0) } }).session(session).lean();
    let picks: { lot: (typeof available)[number]; quantity: Decimal }[];
    if (m.lots?.some((l) => !l.quantity.isZero())) {
      picks = m.lots
        .filter((l) => !l.quantity.isZero())
        .map((l) => {
          const number = l.number.trim().toUpperCase();
          const lot = available.find((a) => a.number === number);
          if (!lot || dec(lot.quantity).lt(l.quantity)) throw new BadRequestException(`${kind} ${number} of ${item.code} in ${warehouse.code}: ${lot ? dec(lot.quantity).toFixed() : 'none'} on hand, ${l.quantity.toFixed()} needed`);
          return { lot, quantity: l.quantity };
        });
    } else {
      // First expiry, first out; batches without expiry last, oldest first.
      const ordered = [...available].sort(
        (a, b) => (a.expiryDate?.getTime() ?? Infinity) - (b.expiryDate?.getTime() ?? Infinity) || a.receivedDate.getTime() - b.receivedDate.getTime() || a.number.localeCompare(b.number),
      );
      picks = [];
      let left = needed;
      for (const lot of ordered) {
        if (left.isZero()) break;
        const take = Decimal.min(left, dec(lot.quantity));
        picks.push({ lot, quantity: take });
        left = left.minus(take);
      }
      if (!left.isZero()) throw new BadRequestException(`Not enough ${item.code} in batches in ${warehouse.code}: ${needed.minus(left).toFixed()} available, ${needed.toFixed()} needed`);
    }
    for (const p of picks) {
      await this.db.stockLots.updateOne({ _id: p.lot._id }, { quantity: toD128(dec(p.lot.quantity).minus(p.quantity)) }, { session });
      out.push({ number: p.lot.number, expiryDate: p.lot.expiryDate ?? null, quantity: p.quantity.neg() });
    }
    return out;
  }

  /** Applies one stock movement and returns its signed value (functional currency) and the lots moved. */
  async move(user: AuthUser, m: MoveInput, session: ClientSession): Promise<{ value: Decimal; unitCost: Decimal; lots: LotInput[] }> {
    if (m.quantity.isZero()) throw new BadRequestException('A stock movement needs a quantity');
    const org = user.organisationId;
    const item = await this.item(org, m.itemId, session);
    if (item.type !== 'STOCK') throw new BadRequestException(`${item.code} is not a stock item`);
    const warehouse = await this.warehouse(org, m.warehouseId, m.entityId, session);
    const entity = (await this.db.entities.findById(m.entityId).session(session).lean())!;
    const fp = await this.currencies.precision(entity.functionalCurrency);

    const balance = await this.db.stockBalances.findOne({ organisationId: org, itemId: item._id, warehouseId: warehouse._id }).session(session).lean();
    const qty = dec(balance?.quantity);
    const val = dec(balance?.value);
    const average = qty.gt(0) ? val.div(qty) : await this.lastUnitCost(org, item._id, session);

    const layered = item.valuation === 'FIFO' || item.valuation === 'LIFO';
    let value: Decimal;
    if (m.quantity.gt(0)) {
      value = m.value ? round(m.value, fp) : round(average.times(m.quantity), fp);
    } else {
      const out = m.quantity.neg();
      if (out.gt(qty)) {
        throw new BadRequestException(`Insufficient stock of ${item.code} in ${warehouse.code}: ${qty.toFixed()} on hand, ${out.toFixed()} needed`);
      }
      // Issuing everything clears the value exactly; otherwise issue at the weighted average cost, or from
      // the oldest (FIFO) or newest (LIFO) receipts still on hand. An explicit value (reversals) keeps the
      // stock ledger equal to the reversed ledger posting.
      const layerCost = layered ? await this.consumeLayers(org, item._id, warehouse._id, out, item.valuation === 'LIFO', fp, session) : null;
      value = (m.value ? round(m.value, fp) : out.eq(qty) ? val : (layerCost ?? round(val.times(out).div(qty), fp))).neg();
    }
    const newQty = qty.plus(m.quantity);
    const newVal = val.plus(value);
    if (newVal.isNeg()) throw new BadRequestException(`${item.code} in ${warehouse.code} would have a negative stock value`);
    if (layered && m.quantity.gt(0)) {
      await this.db.stockLayers.create([{ organisationId: org, itemId: item._id, warehouseId: warehouse._id, date: m.date, quantity: toD128(m.quantity), unitCost: toD128(value.div(m.quantity).toDecimalPlaces(6)), sourceNumber: m.source.number }], { session });
    }
    if (layered && newQty.isZero()) await this.db.stockLayers.deleteMany({ organisationId: org, itemId: item._id, warehouseId: warehouse._id }, { session });
    const lots = await this.applyLots(org, item, warehouse, m, session);
    if (m.type === 'PURCHASE' && m.quantity.gt(0) && (!item.lastPurchase?.date || item.lastPurchase.date <= m.date)) {
      const currency = m.foreign?.currency ?? entity.functionalCurrency;
      const paid = m.foreign?.value ?? value;
      await this.db.items.updateOne({ _id: item._id }, { lastPurchase: { currency, unitPrice: toD128(paid.div(m.quantity).toDecimalPlaces(6)), date: m.date } }, { session });
    }
    await this.db.stockBalances.updateOne(
      { organisationId: org, itemId: item._id, warehouseId: warehouse._id },
      {
        $set: {
          entityId: m.entityId,
          quantity: toD128(newQty),
          value: toD128(newVal),
          ...(m.quantity.gt(0) && { lastReceiptDate: m.date }),
        },
      },
      { upsert: true, session },
    );
    const unitCost = m.quantity.isZero() ? new Decimal(0) : value.div(m.quantity).toDecimalPlaces(6);
    await this.db.stockMovements.create(
      [
        {
          organisationId: org,
          entityId: m.entityId,
          branchId: warehouse.branchId,
          itemId: item._id,
          warehouseId: warehouse._id,
          date: m.date,
          type: m.type,
          quantity: toD128(m.quantity),
          value: toD128(value),
          unitCost: toD128(unitCost.abs()),
          balanceQuantity: toD128(newQty),
          balanceValue: toD128(newVal),
          sourceType: m.source.type,
          sourceId: m.source.id,
          sourceNumber: m.source.number,
          lots: lots.map((l) => ({ ...l, quantity: toD128(l.quantity) })),
          foreignCurrency: m.foreign?.currency ?? null,
          foreignValue: m.foreign ? toD128(m.foreign.value) : null,
          createdBy: user.id,
        },
      ],
      { session },
    );
    return { value, unitCost: unitCost.abs(), lots: lots.map((l) => ({ ...l, quantity: l.quantity.abs() })) };
  }

  /**
   * Changes the value of the stock of an item in a warehouse without moving any quantity (purchase price
   * variances, landed costs). Only what the stock on hand can absorb is applied; the rest (for goods
   * already sold) is returned for the caller to expense. Recorded as a zero-quantity movement.
   */
  async revalue(user: AuthUser, m: Omit<MoveInput, 'quantity' | 'type' | 'value'> & { value: Decimal; type?: StockMovementType; basisQuantity?: Decimal }, session: ClientSession): Promise<{ applied: Decimal; remainder: Decimal }> {
    const org = user.organisationId;
    const item = await this.item(org, m.itemId, session);
    if (item.type !== 'STOCK') throw new BadRequestException(`${item.code} is not a stock item`);
    const warehouse = await this.warehouse(org, m.warehouseId, m.entityId, session);
    const entity = (await this.db.entities.findById(m.entityId).session(session).lean())!;
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const balance = await this.db.stockBalances.findOne({ organisationId: org, itemId: item._id, warehouseId: warehouse._id }).session(session).lean();
    const qty = dec(balance?.quantity);
    const val = dec(balance?.value);
    const value = round(m.value, fp);
    // The value relates to basisQuantity units (when given): only the share still on hand is stock, the rest
    // belongs to goods already sold. Nothing on hand takes nothing; a reduction never takes the value below zero.
    const share = qty.lte(0) ? new Decimal(0) : m.basisQuantity?.gt(0) ? round(value.times(Decimal.min(qty, m.basisQuantity)).div(m.basisQuantity), fp) : value;
    const applied = share.isNeg() ? Decimal.max(share, val.neg()) : share;
    if (!applied.isZero()) {
      const newVal = val.plus(applied);
      // FIFO/LIFO: the change is spread over the receipts still on hand, by quantity.
      if ((item.valuation === 'FIFO' || item.valuation === 'LIFO') && qty.gt(0)) {
        const perUnit = applied.div(qty);
        for (const l of await this.db.stockLayers.find({ organisationId: org, itemId: item._id, warehouseId: warehouse._id }).session(session).lean()) {
          await this.db.stockLayers.updateOne({ _id: l._id }, { unitCost: toD128(Decimal.max(dec(l.unitCost).plus(perUnit), 0).toDecimalPlaces(6)) }, { session });
        }
      }
      await this.db.stockBalances.updateOne({ organisationId: org, itemId: item._id, warehouseId: warehouse._id }, { $set: { value: toD128(newVal) } }, { session });
      await this.db.stockMovements.create(
        [
          {
            organisationId: org,
            entityId: m.entityId,
            branchId: warehouse.branchId,
            itemId: item._id,
            warehouseId: warehouse._id,
            date: m.date,
            type: m.type ?? 'ADJUSTMENT',
            quantity: toD128(0),
            value: toD128(applied),
            unitCost: toD128(0),
            balanceQuantity: toD128(qty),
            balanceValue: toD128(newVal),
            sourceType: m.source.type,
            sourceId: m.source.id,
            sourceNumber: m.source.number,
            createdBy: user.id,
          },
        ],
        { session },
      );
    }
    return { applied, remainder: value.minus(applied) };
  }

  /** Takes `out` units from the cost layers, oldest first (or newest first for LIFO); returns their cost. */
  private async consumeLayers(org: Types.ObjectId, itemId: Types.ObjectId, warehouseId: Types.ObjectId, out: Decimal, lifo: boolean, fp: number, session: ClientSession) {
    const dir = lifo ? -1 : 1;
    const layers = await this.db.stockLayers.find({ organisationId: org, itemId, warehouseId, quantity: { $gt: toD128(0) } }).sort({ date: dir, createdAt: dir }).session(session).lean();
    let left = out;
    let cost = new Decimal(0);
    for (const l of layers) {
      if (left.isZero()) break;
      const take = Decimal.min(left, dec(l.quantity));
      cost = cost.plus(take.times(dec(l.unitCost)));
      left = left.minus(take);
      const rest = dec(l.quantity).minus(take);
      if (rest.isZero()) await this.db.stockLayers.deleteOne({ _id: l._id }, { session });
      else await this.db.stockLayers.updateOne({ _id: l._id }, { quantity: toD128(rest) }, { session });
    }
    // Stock received before the item was switched to FIFO/LIFO has no layers; it is costed at the average.
    return left.isZero() ? round(cost, fp) : null;
  }

  private async lastUnitCost(organisationId: Types.ObjectId, itemId: Types.ObjectId, session?: ClientSession): Promise<Decimal> {
    const last = await this.db.stockMovements.findOne({ organisationId, itemId, quantity: { $gt: toD128(0) } }).sort({ date: -1, createdAt: -1 }).session(session ?? null).lean();
    return last ? dec(last.unitCost) : new Decimal(0);
  }

  /** Reverses every movement of a source document (voids). Returns the signed value reversed. */
  async reverseSource(user: AuthUser, sourceId: Types.ObjectId, date: Date, session: ClientSession): Promise<Decimal> {
    const movements = await this.db.stockMovements.find({ organisationId: user.organisationId, sourceId, reversedById: null, type: { $ne: 'REVERSAL' } }).session(session).lean();
    let total = new Decimal(0);
    for (const mv of movements) {
      if (dec(mv.quantity).isZero()) {
        // A value-only change (price variance, landed cost) is reversed by the opposite revaluation.
        const { applied } = await this.revalue(user, { entityId: mv.entityId, itemId: mv.itemId, warehouseId: mv.warehouseId, date, type: 'REVERSAL', value: dec(mv.value).neg(), source: { type: mv.sourceType, id: mv.sourceId, number: `${mv.sourceNumber} (reversal)` } }, session);
        total = total.plus(applied);
        await this.db.stockMovements.updateOne({ _id: mv._id }, { reversedById: mv._id }, { session });
        continue;
      }
      const { value } = await this.move(
        user,
        {
          entityId: mv.entityId,
          itemId: mv.itemId,
          warehouseId: mv.warehouseId,
          date,
          type: 'REVERSAL',
          quantity: dec(mv.quantity).neg(),
          value: dec(mv.value).abs(),
          lots: lotInputs(mv.lots),
          source: { type: mv.sourceType, id: mv.sourceId, number: `${mv.sourceNumber} (reversal)` },
        },
        session,
      );
      total = total.plus(value);
      await this.db.stockMovements.updateOne({ _id: mv._id }, { reversedById: mv._id }, { session });
    }
    return total;
  }

  // ------------------------------------------------------------------------------------------
  // Stock adjustments and transfers
  // ------------------------------------------------------------------------------------------

  private async buildDocument(user: AuthUser, input: StockDocumentInput, session?: ClientSession) {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(session ?? null).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const from = await this.warehouse(org, input.warehouseId, entity._id, session);
    assertBranchAccess(user, [from.branchId]);
    if (input.kind === 'TRANSFER') {
      if (!input.toWarehouseId || input.toWarehouseId.equals(input.warehouseId)) throw new BadRequestException('Choose a different destination warehouse');
      const to = await this.warehouse(org, input.toWarehouseId, entity._id, session);
      assertBranchAccess(user, [to.branchId]);
    } else {
      if (!input.adjustmentAccountId) throw new BadRequestException('Choose the account for the adjustment (e.g. stock write-offs)');
      const account = await this.db.accounts.findOne({ _id: input.adjustmentAccountId, organisationId: org }).session(session ?? null).lean();
      if (!account?.isPostable || !account.allowManualPosting) throw new BadRequestException('The adjustment account must be a postable, non-control account');
    }
    if (!input.lines.length) throw new BadRequestException('Add at least one item');
    for (const [i, l] of input.lines.entries()) {
      const item = await this.item(org, l.itemId, session);
      if (item.type !== 'STOCK') throw new BadRequestException(`Line ${i + 1}: ${item.code} is not a stock item`);
      if (l.quantity.isZero()) throw new BadRequestException(`Line ${i + 1}: quantity cannot be zero`);
      if (input.kind === 'TRANSFER' && l.quantity.isNeg()) throw new BadRequestException(`Line ${i + 1}: transfer quantities must be positive`);
      if (l.unitCost?.isNeg()) throw new BadRequestException(`Line ${i + 1}: unit cost cannot be negative`);
      // Transfers and write-offs of batches may leave the batch to first expiry first out.
      this.checkLots(item, l.quantity, l.lots, input.kind === 'ADJUSTMENT' && l.quantity.gt(0), `Line ${i + 1}`);
    }
    return {
      entity,
      fields: {
        entityId: entity._id,
        kind: input.kind,
        date: input.date,
        reason: input.reason,
        warehouseId: input.warehouseId,
        toWarehouseId: input.kind === 'TRANSFER' ? input.toWarehouseId : null,
        adjustmentAccountId: input.kind === 'ADJUSTMENT' ? input.adjustmentAccountId : null,
        lines: input.lines.map((l) => ({ itemId: l.itemId, quantity: toD128(l.quantity), unitCost: l.unitCost ? toD128(l.unitCost) : null, value: null, lots: lotsOf(l.lots) })),
      },
    };
  }

  async listDocuments(user: AuthUser, entityId?: Types.ObjectId) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (entityId) filter.entityId = entityId;
    return this.db.stockDocuments.find(filter).sort({ date: -1, number: -1 }).limit(200).lean();
  }

  async getDocument(user: AuthUser, id: Types.ObjectId) {
    const d = await this.db.stockDocuments.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!d) throw new NotFoundException('Stock document not found');
    return withTrail(this.db, d);
  }

  async createDocument(user: AuthUser, input: StockDocumentInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.buildDocument(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, input.kind === 'TRANSFER' ? 'STR' : 'SADJ', session);
      const [doc] = await this.db.stockDocuments.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'stock.document.create', recordType: 'StockDocument', recordId: doc._id, summary: `Created ${number}: ${input.reason}`, after: doc }, session);
      return doc.toObject();
    });
  }

  async updateDocument(user: AuthUser, id: Types.ObjectId, input: StockDocumentInput) {
    return this.db.transaction(async (session) => {
      const before = await this.getDocument(user, id);
      if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only drafts can be edited');
      const { fields } = await this.buildDocument(user, input, session);
      const after = await transition(this.db.stockDocuments, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT' }, session);
      await this.audit.log(user, { action: 'stock.document.update', recordType: 'StockDocument', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  async actDocument(user: AuthUser, id: Types.ObjectId, action: 'submit' | 'approve' | 'reject', reason?: string) {
    return this.db.transaction(async (session) => {
      const d = (await this.db.stockDocuments.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as StockDocument | null;
      if (!d) throw new NotFoundException('Stock document not found');
      const now = new Date();
      if (action === 'submit') {
        await this.buildDocument(user, this.inputOf(d), session);
        const after = await transition(this.db.stockDocuments, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
        await this.audit.log(user, { action: 'stock.document.submit', recordType: 'StockDocument', recordId: id, summary: `Submitted ${d.number}` }, session);
        await this.workflow.open(user, subjectOf('STOCK_DOCUMENT', after), session);
        return after;
      }
      if (action === 'reject') {
        const after = await transition(this.db.stockDocuments, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason ?? '' }, session);
        await this.audit.log(user, { action: 'stock.document.reject', recordType: 'StockDocument', recordId: id, summary: `Rejected ${d.number}: ${reason ?? ''}` }, session);
        await this.workflow.close(user, 'STOCK_DOCUMENT', id, 'REJECTED', reason ?? '', session);
        return after;
      }
      if (d.status !== 'SUBMITTED') throw new BadRequestException('Only submitted documents can be approved');
      assertSegregation(user, d, 'a stock document');
      const gate = await this.workflow.gate(user, subjectOf('STOCK_DOCUMENT', d), reason, session);
      if (!gate.final) return { ...d, approval: this.workflow.view(gate.request) };
      return this.post(user, d, session);
    });
  }

  private inputOf(d: StockDocument): StockDocumentInput {
    return {
      entityId: d.entityId,
      kind: d.kind as 'ADJUSTMENT' | 'TRANSFER',
      date: d.date,
      reason: d.reason,
      warehouseId: d.warehouseId,
      toWarehouseId: d.toWarehouseId,
      adjustmentAccountId: d.adjustmentAccountId,
      lines: d.lines.map((l) => ({ itemId: l.itemId, quantity: dec(l.quantity), unitCost: l.unitCost ? dec(l.unitCost) : null, lots: lotInputs(l.lots) })),
    };
  }

  /** Posts the stock movements and their journal: inventory against the adjustment account, or between branches. */
  private async post(user: AuthUser, d: StockDocument, session: ClientSession) {
    const org = user.organisationId;
    const source = { type: 'StockDocument', id: d._id, number: d.number };
    const entity = (await this.db.entities.findById(d.entityId).session(session).lean())!;
    const from = await this.warehouse(org, d.warehouseId, d.entityId, session);
    const lines: LineInput[] = [];
    const fn = (debit: boolean, accountId: Types.ObjectId, branchId: Types.ObjectId, amount: Decimal, description: string): LineInput => ({
      accountId,
      branchId,
      currency: entity.functionalCurrency,
      description,
      debit: debit ? amount : null,
      credit: debit ? null : amount,
      functionalDebit: debit ? amount : new Decimal(0),
      functionalCredit: debit ? new Decimal(0) : amount,
    });
    const posted = [];
    let total = new Decimal(0);
    for (const l of d.lines) {
      const item = await this.item(org, l.itemId, session);
      const qty = dec(l.quantity);
      if (d.kind === 'ADJUSTMENT') {
        const value = qty.gt(0) && l.unitCost ? qty.times(dec(l.unitCost)) : null;
        const res = await this.move(user, { entityId: d.entityId, itemId: item._id, warehouseId: from._id, date: d.date, type: 'ADJUSTMENT', quantity: qty, value, lots: lotInputs(l.lots), source }, session);
        posted.push({ ...l, value: toD128(res.value), lots: lotsOf(res.lots) });
        if (!res.value.isZero()) {
          const up = res.value.gt(0);
          lines.push(fn(up, item.inventoryAccountId!, from.branchId, res.value.abs(), `${item.code} ${up ? 'found' : 'written off'}`));
          lines.push(fn(!up, d.adjustmentAccountId!, from.branchId, res.value.abs(), `${d.number}: ${d.reason}`));
        }
        total = total.plus(res.value.abs());
      } else {
        const to = await this.warehouse(org, d.toWarehouseId!, d.entityId, session);
        const out = await this.move(user, { entityId: d.entityId, itemId: item._id, warehouseId: from._id, date: d.date, type: 'TRANSFER_OUT', quantity: qty.neg(), lots: lotInputs(l.lots), source }, session);
        await this.move(user, { entityId: d.entityId, itemId: item._id, warehouseId: to._id, date: d.date, type: 'TRANSFER_IN', quantity: qty, value: out.value.abs(), lots: out.lots, source }, session);
        posted.push({ ...l, value: toD128(out.value.abs()), lots: lotsOf(out.lots) });
        // Same inventory account; the journal only matters when the warehouses sit in different branches.
        if (!from.branchId.equals(to.branchId) && !out.value.isZero()) {
          lines.push(fn(true, item.inventoryAccountId!, to.branchId, out.value.abs(), `${item.code} transferred in from ${from.code}`));
          lines.push(fn(false, item.inventoryAccountId!, from.branchId, out.value.abs(), `${item.code} transferred out to ${to.code}`));
        }
        total = total.plus(out.value.abs());
      }
    }
    if (d.kind === 'ADJUSTMENT') assertApprovalLimit(user, total, entity.functionalCurrency, 'The stock adjustment');
    let journalId: Types.ObjectId | null = null;
    if (lines.length) {
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: d.entityId, branchId: from.branchId, journalDate: d.date, description: `${d.kind === 'TRANSFER' ? 'Stock transfer' : 'Stock adjustment'} ${d.number}: ${d.reason}`, lines },
        { sourceType: 'StockDocument', sourceId: d._id, sourceNumber: d.number },
        session,
      );
      journalId = journal._id;
    }
    const after = await transition(this.db.stockDocuments, d._id, ['SUBMITTED'], { status: 'POSTED', approvedBy: user.id, approvedAt: new Date(), journalId, lines: posted }, session);
    await this.audit.log(user, { action: 'stock.document.post', recordType: 'StockDocument', recordId: d._id, summary: `Approved and posted ${d.number} (value ${total.toFixed()} ${entity.functionalCurrency})` }, session);
    return after;
  }

  // ------------------------------------------------------------------------------------------
  // Reports
  // ------------------------------------------------------------------------------------------

  /** Stock on hand and valuation per item and warehouse, with reorder flags; optionally also in another currency. */
  async onHand(user: AuthUser, entityId: Types.ObjectId, opts: { currency?: string; date?: Date } = {}) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const restricted = allowedBranches(user);
    const warehouses = await this.db.warehouses.find({ organisationId: user.organisationId, entityId, ...(restricted && { branchId: { $in: restricted } }) }).lean();
    const balances = await this.db.stockBalances.find({ organisationId: user.organisationId, warehouseId: { $in: warehouses.map((w) => w._id) } }).lean();
    const items = await this.db.items.find({ organisationId: user.organisationId, type: 'STOCK' }).sort({ code: 1 }).lean();
    const rows = items.map((item) => {
      const per = warehouses.map((w) => {
        const b = balances.find((x) => x.itemId.equals(item._id) && x.warehouseId.equals(w._id));
        return { warehouseId: w._id, code: w.code, quantity: dec(b?.quantity), value: dec(b?.value) };
      });
      const quantity = sum(per.map((p) => p.quantity));
      const value = sum(per.map((p) => p.value));
      return {
        itemId: item._id,
        code: item.code,
        name: item.name,
        unit: item.unit,
        category: item.category,
        warehouses: per,
        quantity,
        value,
        averageCost: quantity.gt(0) ? value.div(quantity).toDecimalPlaces(4) : new Decimal(0),
        belowReorder: item.reorderLevel ? quantity.lt(dec(item.reorderLevel)) : false,
        lastReceiptDate: balances.filter((b) => b.itemId.equals(item._id)).reduce<Date | null>((a, b) => (b.lastReceiptDate && (!a || b.lastReceiptDate > a) ? b.lastReceiptDate : a), null),
      };
    });
    // Reconcile to the inventory accounts in the ledger.
    const accountIds = [...new Set(items.map((i) => i.inventoryAccountId?.toHexString()).filter(Boolean))].map((id) => new Types.ObjectId(id));
    const [gl] = await this.db.ledger.aggregate<{ debit: unknown; credit: unknown }>([
      { $match: { organisationId: user.organisationId, entityId, accountId: { $in: accountIds }, ...(restricted && { branchId: { $in: restricted } }) } },
      { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]);
    const total = sum(rows.map((r) => r.value));
    const ledger = gl ? dec(gl.debit as never).minus(dec(gl.credit as never)) : new Decimal(0);
    // Presentation in another currency, at the closing rate (spot if none) on the date.
    let presentation = null;
    if (opts.currency && opts.currency !== entity.functionalCurrency) {
      const date = opts.date ?? new Date();
      const found =
        (await this.currencies.findRate(user.organisationId, entity.functionalCurrency, opts.currency, date, 'CLOSING')) ??
        (await this.currencies.findRate(user.organisationId, entity.functionalCurrency, opts.currency, date, 'SPOT'));
      if (!found) throw new BadRequestException(`No approved ${entity.functionalCurrency}/${opts.currency} rate on or before ${date.toISOString().slice(0, 10)}`);
      const p = await this.currencies.precision(opts.currency);
      presentation = {
        currency: opts.currency,
        rate: found.rate,
        date,
        total: round(total.times(found.rate), p),
        rows: rows.map((r) => ({ itemId: r.itemId, value: round(r.value.times(found.rate), p) })),
      };
    }
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      warehouses: warehouses.map((w) => ({ id: w._id, code: w.code, name: w.name })),
      rows,
      total,
      ledger,
      difference: ledger.minus(total),
      presentation,
    };
  }

  /** Batches and serial numbers on hand (or all, with empties), with days to expiry. */
  async lots(user: AuthUser, q: { entityId: Types.ObjectId; itemId?: Types.ObjectId; warehouseId?: Types.ObjectId; expiringWithinDays?: number; includeEmpty?: boolean }) {
    const restricted = allowedBranches(user);
    const warehouses = await this.db.warehouses.find({ organisationId: user.organisationId, entityId: q.entityId, ...(restricted && { branchId: { $in: restricted } }) }).lean();
    const filter: Record<string, unknown> = { organisationId: user.organisationId, entityId: q.entityId, warehouseId: { $in: warehouses.map((w) => w._id) } };
    if (q.itemId) filter.itemId = q.itemId;
    if (q.warehouseId) filter.warehouseId = q.warehouseId;
    if (!q.includeEmpty) filter.quantity = { $gt: toD128(0) };
    const today = new Date(new Date().toISOString().slice(0, 10));
    if (q.expiringWithinDays != null) filter.expiryDate = { $ne: null, $lte: new Date(today.getTime() + q.expiringWithinDays * 86_400_000) };
    const lots = await this.db.stockLots.find(filter).sort({ expiryDate: 1, number: 1 }).limit(5000).lean();
    const items = new Map((await this.db.items.find({ organisationId: user.organisationId, _id: { $in: [...new Set(lots.map((l) => l.itemId.toHexString()))] } }).lean()).map((i) => [i._id.toHexString(), i]));
    return lots.map((l) => {
      const item = items.get(l.itemId.toHexString());
      const w = warehouses.find((x) => x._id.equals(l.warehouseId));
      const days = l.expiryDate ? Math.floor((l.expiryDate.getTime() - today.getTime()) / 86_400_000) : null;
      return {
        id: l._id,
        itemId: l.itemId,
        itemCode: item?.code ?? '',
        itemName: item?.name ?? '',
        tracking: item?.tracking ?? 'NONE',
        warehouseId: l.warehouseId,
        warehouseCode: w?.code ?? '',
        number: l.number,
        expiryDate: l.expiryDate,
        daysToExpiry: days,
        expired: days != null && days < 0,
        quantity: dec(l.quantity),
        receivedDate: l.receivedDate,
      };
    });
  }

  /** Where a batch or serial number is and everything that happened to it. */
  async trace(user: AuthUser, q: { entityId: Types.ObjectId; number: string; itemId?: Types.ObjectId }) {
    const number = q.number.trim().toUpperCase();
    const restricted = allowedBranches(user);
    const lots = await this.db.stockLots.find({ organisationId: user.organisationId, entityId: q.entityId, number, ...(q.itemId && { itemId: q.itemId }) }).lean();
    const movements = await this.db.stockMovements
      .find({ organisationId: user.organisationId, entityId: q.entityId, 'lots.number': number, ...(q.itemId && { itemId: q.itemId }), ...(restricted && { branchId: { $in: restricted } }) })
      .sort({ date: 1, createdAt: 1 })
      .limit(1000)
      .lean();
    const itemIds = [...new Set([...lots, ...movements].map((x) => x.itemId.toHexString()))];
    const items = new Map((await this.db.items.find({ organisationId: user.organisationId, _id: { $in: itemIds } }).lean()).map((i) => [i._id.toHexString(), i]));
    const warehouses = new Map((await this.db.warehouses.find({ organisationId: user.organisationId, entityId: q.entityId }).lean()).map((w) => [w._id.toHexString(), w]));
    return {
      number,
      onHand: lots
        .filter((l) => dec(l.quantity).gt(0))
        .map((l) => ({ itemCode: items.get(l.itemId.toHexString())?.code ?? '', warehouseCode: warehouses.get(l.warehouseId.toHexString())?.code ?? '', quantity: dec(l.quantity), expiryDate: l.expiryDate })),
      movements: movements.map((m) => ({
        id: m._id,
        date: m.date,
        type: m.type,
        itemCode: items.get(m.itemId.toHexString())?.code ?? '',
        warehouseCode: warehouses.get(m.warehouseId.toHexString())?.code ?? '',
        quantity: sum(m.lots.filter((l) => l.number === number).map((l) => l.quantity)),
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        sourceNumber: m.sourceNumber,
      })),
    };
  }

  async movements(user: AuthUser, q: { entityId: Types.ObjectId; itemId?: Types.ObjectId; warehouseId?: Types.ObjectId; from?: Date; to?: Date }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, entityId: q.entityId };
    if (q.itemId) filter.itemId = q.itemId;
    if (q.warehouseId) filter.warehouseId = q.warehouseId;
    if (q.from || q.to) filter.date = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return this.db.stockMovements.find(filter).sort({ date: -1, createdAt: -1 }).limit(1000).lean();
  }
}
