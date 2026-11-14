import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { InventoryService } from './inventory.service';

export interface LandedCostInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  date: Date;
  description: string;
  /** Where the charges were booked when billed (freight, duty, clearing); defaults to Landed Costs Clearing. */
  clearingAccountId?: Types.ObjectId | null;
  /** Functional currency amount to move into stock. */
  amount: Decimal;
  method: 'VALUE' | 'QUANTITY';
  receipts: { type: 'GoodsReceipt' | 'Invoice'; id: Types.ObjectId }[];
}

/**
 * Landed costs: freight, duty and clearing charges booked to a clearing account are added to the cost of
 * the stock they brought in (the goods received notes or bills receiving it), in proportion to value or
 * quantity. The share of goods already sold goes to cost of sales.
 */
export class LandedCostsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly inventory: InventoryService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  async list(user: AuthUser, entityId?: Types.ObjectId) {
    return this.db.landedCosts.find({ ...this.scope(user), ...(entityId && { entityId }) }).sort({ date: -1, number: -1 }).limit(500).lean();
  }

  /** Recent goods received notes and bills that brought stock in: what a landed cost can be spread over. */
  async receipts(user: AuthUser, entityId: Types.ObjectId) {
    const restricted = allowedBranches(user);
    const rows = await this.db.stockMovements.aggregate<{ _id: Types.ObjectId; type: string; number: string; date: Date; quantity: unknown; value: unknown }>([
      { $match: { organisationId: user.organisationId, entityId, type: 'PURCHASE', quantity: { $gt: toD128(0) }, reversedById: null, sourceType: { $in: ['GoodsReceipt', 'Invoice'] }, ...(restricted && { branchId: { $in: restricted } }) } },
      { $group: { _id: '$sourceId', type: { $first: '$sourceType' }, number: { $first: '$sourceNumber' }, date: { $first: '$date' }, quantity: { $sum: '$quantity' }, value: { $sum: '$value' } } },
      { $sort: { date: -1 } },
      { $limit: 200 },
    ]);
    return rows.map((r) => ({ id: r._id, type: r.type, number: r.number, date: r.date, quantity: dec(r.quantity as never), value: dec(r.value as never) }));
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    return withTrail(this.db, await this.load(user, id));
  }

  private async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession) {
    const lc = await this.db.landedCosts.findOne({ _id: id, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!lc) throw new NotFoundException('Landed cost not found');
    assertBranchAccess(user, [lc.branchId]);
    return lc;
  }

  /** The stock received by the chosen receipts, per item and warehouse, as the allocation base. */
  private async targets(user: AuthUser, entityId: Types.ObjectId, receipts: LandedCostInput['receipts'], session?: ClientSession) {
    if (!receipts.length) throw new BadRequestException('Choose the goods received notes or bills that brought the stock in');
    const refs: { type: string; id: Types.ObjectId; number: string }[] = [];
    for (const r of receipts) {
      const doc =
        r.type === 'GoodsReceipt'
          ? await this.db.goodsReceipts.findOne({ _id: r.id, organisationId: user.organisationId, entityId, status: { $ne: 'REVERSED' } }).session(session ?? null).lean()
          : await this.db.invoices.findOne({ _id: r.id, organisationId: user.organisationId, entityId, kind: 'PURCHASE_BILL', status: 'POSTED' }).session(session ?? null).lean();
      if (!doc) throw new BadRequestException(`${r.type === 'GoodsReceipt' ? 'Goods received note' : 'Posted bill'} ${r.id.toHexString()} not found in this entity`);
      refs.push({ type: r.type, id: doc._id, number: doc.number });
    }
    const movements = await this.db.stockMovements
      .find({ organisationId: user.organisationId, sourceId: { $in: refs.map((r) => r.id) }, type: 'PURCHASE', quantity: { $gt: toD128(0) }, reversedById: null })
      .session(session ?? null)
      .lean();
    const groups = new Map<string, { itemId: Types.ObjectId; warehouseId: Types.ObjectId; quantity: Decimal; value: Decimal }>();
    for (const m of movements) {
      const key = `${m.itemId.toHexString()}:${m.warehouseId.toHexString()}`;
      const g = groups.get(key) ?? { itemId: m.itemId, warehouseId: m.warehouseId, quantity: new Decimal(0), value: new Decimal(0) };
      groups.set(key, { ...g, quantity: g.quantity.plus(dec(m.quantity)), value: g.value.plus(dec(m.value)) });
    }
    if (!groups.size) throw new BadRequestException('The chosen documents received no stock');
    return { refs, groups: [...groups.values()] };
  }

  private async fields(user: AuthUser, input: LandedCostInput, session: ClientSession) {
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).session(session).lean();
    if (!entity?.isActive) throw new BadRequestException('Entity not found or inactive');
    const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: user.organisationId, entityId: entity._id }).session(session).lean();
    if (!branch) throw new BadRequestException('Branch not found in this entity');
    assertBranchAccess(user, [branch._id]);
    if (!input.amount.gt(0)) throw new BadRequestException('The amount must be positive');
    const org = await this.db.organisations.findById(user.organisationId).session(session).lean();
    const clearingAccountId = input.clearingAccountId ?? org?.settings?.landedCostAccountId;
    if (!clearingAccountId) throw new BadRequestException('Choose the clearing account the charges were booked to');
    const account = await this.db.accounts.findOne({ _id: clearingAccountId, organisationId: user.organisationId }).session(session).lean();
    if (!account?.isActive) throw new BadRequestException('Clearing account not found or inactive');
    const { refs } = await this.targets(user, entity._id, input.receipts, session);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    return {
      entity,
      fields: {
        entityId: entity._id,
        branchId: branch._id,
        date: input.date,
        description: input.description,
        clearingAccountId: account._id,
        amount: toD128(round(input.amount, fp)),
        method: input.method,
        receipts: refs,
      },
    };
  }

  async create(user: AuthUser, input: LandedCostInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.fields(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, 'LC', session);
      const [lc] = await this.db.landedCosts.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'landed_cost.create', recordType: 'LandedCost', recordId: lc._id, summary: `Created ${number}: ${fields.description}`, after: lc }, session);
      return lc.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: LandedCostInput) {
    return this.db.transaction(async (session) => {
      const lc = await this.load(user, id, session);
      if (lc.status !== 'DRAFT') throw new BadRequestException('Only draft landed costs can be edited');
      const { fields } = await this.fields(user, input, session);
      await this.db.landedCosts.updateOne({ _id: id }, fields, { session });
      await this.audit.log(user, { action: 'landed_cost.update', recordType: 'LandedCost', recordId: id, summary: `Updated ${lc.number}`, before: lc }, session);
      return this.db.landedCosts.findById(id).session(session).lean();
    });
  }

  async cancel(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const lc = await this.load(user, id, session);
      if (lc.status !== 'DRAFT') throw new BadRequestException('Only draft landed costs can be cancelled; reverse a posted one');
      await this.db.landedCosts.updateOne({ _id: id }, { status: 'CANCELLED' }, { session });
      await this.audit.log(user, { action: 'landed_cost.cancel', recordType: 'LandedCost', recordId: id, summary: `Cancelled ${lc.number}` }, session);
      return this.db.landedCosts.findById(id).session(session).lean();
    });
  }

  /**
   * Allocates the amount over the stock received (by value or quantity), adds each share to the stock
   * still on hand and the rest to cost of sales: Dr inventory / Dr cost of sales, Cr clearing.
   */
  async post(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const lc = await this.load(user, id, session);
      if (lc.status !== 'DRAFT') throw new BadRequestException(`${lc.number} is ${lc.status.toLowerCase()}`);
      const entity = (await this.db.entities.findById(lc.entityId).session(session).lean())!;
      const fp = await this.currencies.precision(entity.functionalCurrency);
      const { groups } = await this.targets(user, lc.entityId, lc.receipts.map((r) => ({ type: r.type as 'GoodsReceipt' | 'Invoice', id: r.id })), session);
      const amount = dec(lc.amount);
      const basis = (g: (typeof groups)[number]) => (lc.method === 'QUANTITY' ? g.quantity : g.value);
      const total = groups.reduce((a, g) => a.plus(basis(g)), new Decimal(0));
      if (!total.gt(0)) throw new BadRequestException(`The received stock has no ${lc.method === 'QUANTITY' ? 'quantity' : 'value'} to allocate by`);

      const source = { type: 'LandedCost', id: lc._id, number: lc.number };
      const lines: LineInput[] = [];
      const allocations = [];
      let left = amount;
      for (const [i, g] of groups.entries()) {
        const share = i === groups.length - 1 ? left : round(amount.times(basis(g)).div(total), fp);
        left = left.minus(share);
        const item = await this.inventory.item(user.organisationId, g.itemId, session);
        const wh = await this.inventory.warehouse(user.organisationId, g.warehouseId, lc.entityId, session);
        const { applied, remainder } = share.isZero()
          ? { applied: new Decimal(0), remainder: new Decimal(0) }
          : await this.inventory.revalue(user, { entityId: lc.entityId, itemId: g.itemId, warehouseId: g.warehouseId, date: lc.date, type: 'LANDED_COST', value: share, basisQuantity: g.quantity, source }, session);
        const line = (accountId: Types.ObjectId, branchId: Types.ObjectId, value: Decimal, description: string): LineInput => ({
          accountId,
          branchId,
          currency: entity.functionalCurrency,
          description,
          debit: value,
          credit: null,
          functionalDebit: value,
          functionalCredit: new Decimal(0),
        });
        if (!applied.isZero()) lines.push(line(item.inventoryAccountId!, wh.branchId, applied, `Landed cost on ${item.code} (${lc.number})`));
        if (!remainder.isZero()) lines.push(line(item.cogsAccountId!, lc.branchId, remainder, `Landed cost on ${item.code} already sold (${lc.number})`));
        allocations.push({ itemId: g.itemId, warehouseId: g.warehouseId, quantity: toD128(g.quantity), basisValue: toD128(g.value), amount: toD128(share), capitalised: toD128(applied), expensed: toD128(remainder) });
      }
      lines.push({ accountId: lc.clearingAccountId, currency: entity.functionalCurrency, description: `${lc.description} (${lc.number})`, debit: null, credit: amount, functionalDebit: new Decimal(0), functionalCredit: amount });
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: lc.entityId, branchId: lc.branchId, journalDate: lc.date, description: `Landed cost ${lc.number} · ${lc.description}`, reference: lc.receipts.map((r) => r.number).join(', ').slice(0, 100), lines },
        { sourceType: 'LandedCost', sourceId: lc._id, sourceNumber: lc.number },
        session,
      );
      await this.db.landedCosts.updateOne({ _id: id }, { status: 'POSTED', allocations, journalId: journal._id, postedBy: user.id, postedAt: new Date() }, { session });
      await this.audit.log(user, { action: 'landed_cost.post', recordType: 'LandedCost', recordId: id, summary: `Posted ${lc.number} (${journal.number}): ${amount.toFixed()} ${entity.functionalCurrency} by ${lc.method.toLowerCase()}` }, session);
      return this.db.landedCosts.findById(id).session(session).lean();
    });
  }

  async reverse(user: AuthUser, id: Types.ObjectId, input: { date: Date; reason: string }) {
    return this.db.transaction(async (session) => {
      const lc = await this.load(user, id, session);
      if (lc.status !== 'POSTED') throw new BadRequestException('Only posted landed costs can be reversed');
      if (input.date < lc.date) throw new BadRequestException('The reversal date cannot be before the landed cost');
      const reversal = await this.journals.reverseSystemJournal(user, lc.journalId!, input.date, `Reversal of ${lc.number}: ${input.reason}`, session);
      // Each item's share comes back out of the stock still on hand; the part sold since went to cost of sales.
      const entity = (await this.db.entities.findById(lc.entityId).session(session).lean())!;
      const movements = await this.db.stockMovements.find({ organisationId: user.organisationId, sourceId: lc._id, reversedById: null, type: { $ne: 'REVERSAL' } }).session(session).lean();
      const lines: LineInput[] = [];
      for (const mv of movements) {
        const { applied } = await this.inventory.revalue(user, { entityId: mv.entityId, itemId: mv.itemId, warehouseId: mv.warehouseId, date: input.date, type: 'REVERSAL', value: dec(mv.value).neg(), source: { type: 'LandedCost', id: lc._id, number: `${lc.number} (reversal)` } }, session);
        await this.db.stockMovements.updateOne({ _id: mv._id }, { reversedById: mv._id }, { session });
        // The journal reversal took the whole share out of inventory; put back what stock did not give up.
        const gap = dec(mv.value).plus(applied);
        if (gap.isZero()) continue;
        const item = await this.inventory.item(user.organisationId, mv.itemId, session);
        const up = gap.gt(0);
        const leg = (accountId: Types.ObjectId, branchId: Types.ObjectId, debit: boolean, description: string): LineInput => ({
          accountId,
          branchId,
          currency: entity.functionalCurrency,
          description,
          debit: debit ? gap.abs() : null,
          credit: debit ? null : gap.abs(),
          functionalDebit: debit ? gap.abs() : new Decimal(0),
          functionalCredit: debit ? new Decimal(0) : gap.abs(),
        });
        lines.push(leg(item.inventoryAccountId!, mv.branchId, up, `${lc.number}: ${item.code} share no longer in stock`), leg(item.cogsAccountId!, lc.branchId, !up, `${lc.number}: ${item.code} share already sold`));
      }
      if (lines.length) {
        await this.journals.postSystemJournal(
          user,
          { entityId: lc.entityId, branchId: lc.branchId, journalDate: input.date, description: `Landed cost ${lc.number} reversed after stock was sold`, reference: lc.number, lines },
          { sourceType: 'LandedCost', sourceId: lc._id, sourceNumber: lc.number },
          session,
        );
      }
      await this.db.landedCosts.updateOne({ _id: id }, { status: 'REVERSED', reversedAt: new Date(), reversedBy: user.id, reversalReason: input.reason, reversalJournalId: reversal._id }, { session });
      await this.audit.log(user, { action: 'landed_cost.reverse', recordType: 'LandedCost', recordId: id, summary: `Reversed ${lc.number}: ${input.reason}` }, session);
      return this.db.landedCosts.findById(id).session(session).lean();
    });
  }
}
