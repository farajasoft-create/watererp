import { BadRequestException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { assertApprovalLimit, assertSegregation, escapeRegex, transition } from '../../common/workflow';
import { PurchaseOrder, PurchaseOrderStatus } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { assertSupplierUsable } from './supplier-management.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { checkRequisitionAgainstPlan } from './procurement-plan.service';
import { BudgetsService } from '../budgets/budgets.service';
import { computeLine, TaxService } from '../tax/tax.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';
import { InventoryService, LotInput, lotsOf } from '../inventory/inventory.service';
import { JournalsService, LineInput } from '../journals/journals.service';

interface Dimensions {
  departmentId?: Types.ObjectId | null;
  costCentreId?: Types.ObjectId | null;
  projectId?: Types.ObjectId | null;
}

export interface RequisitionInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  date: Date;
  requiredBy?: Date | null;
  description: string;
  lines: ({ description: string; accountId?: Types.ObjectId | null; quantity: Decimal; estimatedUnitPrice: Decimal; planItemId?: Types.ObjectId | null } & Dimensions)[];
}

export interface PurchaseOrderInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  supplierId: Types.ObjectId;
  date: Date;
  expectedDate?: Date | null;
  reference?: string;
  notes?: string;
  deliveryAddress?: string;
  requisitionId?: Types.ObjectId | null;
  exchangeRate?: Decimal | null;
  priceIncludesTax?: boolean;
  lines: ({ description: string; accountId: Types.ObjectId; quantity: Decimal; unitPrice: Decimal; taxCodeId?: Types.ObjectId | null; itemId?: Types.ObjectId | null; warehouseId?: Types.ObjectId | null; planItemId?: Types.ObjectId | null } & Dimensions)[];
}

export interface ProcurementListQuery {
  entityId?: Types.ObjectId;
  status?: string;
  supplierId?: Types.ObjectId;
  search?: string;
  page: number;
  pageSize: number;
}

const OPEN_FOR_RECEIPT: PurchaseOrderStatus[] = ['APPROVED', 'PARTIALLY_RECEIVED'];

export class ProcurementService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly tax: TaxService,
    private readonly budgets: BudgetsService,
    private readonly workflow: WorkflowService,
    private readonly inventory: InventoryService,
    private readonly journals: JournalsService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  private async context(user: AuthUser, entityId: Types.ObjectId, branchId: Types.ObjectId, session?: ClientSession) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!entity?.isActive) throw new BadRequestException('Entity not found or inactive');
    const branch = await this.db.branches.findOne({ _id: branchId, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!branch || !branch.entityId.equals(entity._id) || !branch.isActive) throw new BadRequestException('Branch not found or not active in this entity');
    assertBranchAccess(user, [branch._id]);
    return entity;
  }

  private async checkAccounts(user: AuthUser, ids: (Types.ObjectId | null | undefined)[], session?: ClientSession) {
    const wanted = [...new Set(ids.filter(Boolean).map(String))];
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, _id: { $in: wanted } }).session(session ?? null).lean();
    for (const a of accounts) {
      if (!a.isActive || !a.isPostable || a.isControl) throw new BadRequestException(`Account ${a.code} cannot be used on purchases`);
    }
    if (accounts.length !== wanted.length) throw new BadRequestException('Account not found');
  }

  // ------------------------------------------------------------------------------------------
  // Requisitions
  // ------------------------------------------------------------------------------------------

  private async buildRequisition(user: AuthUser, input: RequisitionInput, session?: ClientSession) {
    const entity = await this.context(user, input.entityId, input.branchId, session);
    if (!input.lines.length) throw new BadRequestException('A requisition needs at least one line');
    await this.checkAccounts(user, input.lines.map((l) => l.accountId), session);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const lines = input.lines.map((l, i) => {
      if (l.quantity.lte(0)) throw new BadRequestException(`Line ${i + 1}: quantity must be positive`);
      if (l.estimatedUnitPrice.isNeg()) throw new BadRequestException(`Line ${i + 1}: price cannot be negative`);
      return {
        lineNo: i + 1,
        description: l.description,
        accountId: l.accountId ?? null,
        quantity: toD128(l.quantity),
        estimatedUnitPrice: toD128(l.estimatedUnitPrice),
        planItemId: l.planItemId ?? null,
        departmentId: l.departmentId ?? null,
        costCentreId: l.costCentreId ?? null,
        projectId: l.projectId ?? null,
      };
    });
    const estimatedTotal = sum(input.lines.map((l) => round(l.quantity.times(l.estimatedUnitPrice), fp)));
    if (input.requiredBy && input.requiredBy < input.date) throw new BadRequestException('"Required by" cannot be before the request date');
    return {
      entity,
      fields: {
        entityId: entity._id,
        branchId: input.branchId,
        date: input.date,
        requiredBy: input.requiredBy ?? null,
        description: input.description,
        currency: entity.functionalCurrency,
        lines,
        estimatedTotal: toD128(estimatedTotal),
      },
    };
  }

  async listRequisitions(user: AuthUser, q: ProcurementListQuery) {
    const filter: Record<string, unknown> = this.scope(user);
    if (q.entityId) filter.entityId = q.entityId;
    if (q.status) filter.status = q.status;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ number: rx }, { description: rx }];
    }
    const [items, total] = await Promise.all([
      this.db.requisitions.find(filter, { lines: 0 }).sort({ date: -1, number: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      this.db.requisitions.countDocuments(filter),
    ]);
    const names = await this.db.users.find({ _id: { $in: items.map((r) => r.createdBy) } }, { name: 1 }).lean();
    return {
      items: items.map((r) => ({ ...r, createdByName: names.find((n) => n._id.equals(r.createdBy))?.name ?? '' })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  private async loadRequisition(user: AuthUser, id: Types.ObjectId, session?: ClientSession) {
    const r = await this.db.requisitions.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!r) throw new NotFoundException('Requisition not found');
    return r;
  }

  async getRequisition(user: AuthUser, id: Types.ObjectId) {
    const r = await this.loadRequisition(user, id);
    const orders = await this.db.purchaseOrders.find({ _id: { $in: r.purchaseOrderIds } }, { number: 1, status: 1, supplierName: 1, total: 1, currency: 1 }).lean();
    return { ...(await withTrail(this.db, r)), purchaseOrders: orders };
  }

  async createRequisition(user: AuthUser, input: RequisitionInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.buildRequisition(user, input, session);
      await checkRequisitionAgainstPlan(this.db, user, { entityId: entity._id, date: fields.date, lines: fields.lines }, session);
      const number = await this.db.nextNumber(user.organisationId, entity, 'PR', session);
      const [r] = await this.db.requisitions.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'requisition.create', recordType: 'PurchaseRequisition', recordId: r._id, summary: `Created requisition ${number}`, after: r }, session);
      return r.toObject();
    });
  }

  async updateRequisition(user: AuthUser, id: Types.ObjectId, input: RequisitionInput) {
    return this.db.transaction(async (session) => {
      const before = await this.loadRequisition(user, id, session);
      if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException(`A ${before.status.toLowerCase()} requisition cannot be edited`);
      if (!input.entityId.equals(before.entityId)) throw new BadRequestException('The entity cannot change');
      const { fields } = await this.buildRequisition(user, input, session);
      await checkRequisitionAgainstPlan(this.db, user, { entityId: before.entityId, date: fields.date, requisitionId: id, lines: fields.lines }, session);
      const after = await transition(this.db.requisitions, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT', rejectionReason: '' }, session);
      await this.audit.log(user, { action: 'requisition.update', recordType: 'PurchaseRequisition', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  async requisitionAction(user: AuthUser, id: Types.ObjectId, action: 'submit' | 'approve' | 'reject' | 'cancel', reason?: string) {
    return this.db.transaction(async (session) => {
      const r = await this.loadRequisition(user, id, session);
      const now = new Date();
      let after;
      if (action === 'submit') {
        await checkRequisitionAgainstPlan(this.db, user, { entityId: r.entityId, date: r.date, requisitionId: id, lines: r.lines.map((l) => ({ ...l, accountId: l.accountId ?? null, departmentId: l.departmentId ?? null })) }, session);
        after = await transition(this.db.requisitions, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
        await this.workflow.open(user, subjectOf('PURCHASE_REQUISITION', after), session);
      } else if (action === 'approve') {
        if (r.status !== 'SUBMITTED') throw new BadRequestException('Only submitted requisitions can be approved');
        assertSegregation(user, r, 'a requisition');
        const gate = await this.workflow.gate(user, subjectOf('PURCHASE_REQUISITION', r), reason, session);
        if (!gate.final) return { ...r, approval: this.workflow.view(gate.request) };
        assertApprovalLimit(user, dec(r.estimatedTotal), r.currency, 'The requisition');
        after = await transition(this.db.requisitions, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now }, session);
      } else if (action === 'reject') {
        if (r.status !== 'SUBMITTED') throw new BadRequestException('Only submitted requisitions can be rejected');
        after = await transition(this.db.requisitions, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason ?? '' }, session);
        await this.workflow.close(user, 'PURCHASE_REQUISITION', id, 'REJECTED', reason ?? '', session);
      } else {
        after = await transition(this.db.requisitions, id, ['DRAFT', 'REJECTED', 'SUBMITTED', 'APPROVED'], { status: 'CANCELLED' }, session);
        await this.workflow.close(user, 'PURCHASE_REQUISITION', id, 'CANCELLED', reason ?? 'Cancelled', session);
      }
      await this.audit.log(
        user,
        { action: `requisition.${action}`, recordType: 'PurchaseRequisition', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${r.number}${reason ? `: ${reason}` : ''}` },
        session,
      );
      return after;
    });
  }

  // ------------------------------------------------------------------------------------------
  // Purchase orders
  // ------------------------------------------------------------------------------------------

  async buildOrder(user: AuthUser, input: PurchaseOrderInput, session?: ClientSession) {
    const entity = await this.context(user, input.entityId, input.branchId, session);
    if (!input.lines.length) throw new BadRequestException('A purchase order needs at least one line');
    const supplier = await this.db.suppliers.findOne({ _id: input.supplierId, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!supplier) throw new BadRequestException('Supplier not found');
    assertSupplierUsable(supplier, 'ORDER');
    await this.checkAccounts(user, input.lines.map((l) => l.accountId), session);
    const functional = entity.functionalCurrency;
    const currency = supplier.currency;
    let rate = new Decimal(1);
    if (currency !== functional) {
      const found = input.exchangeRate ? null : await this.currencies.findRate(user.organisationId, currency, functional, input.date, 'SPOT', session);
      rate = input.exchangeRate ?? found?.rate ?? new Decimal(0);
      if (rate.lte(0)) throw new BadRequestException(`No approved ${currency}/${functional} rate on or before ${input.date.toISOString().slice(0, 10)}`);
    }
    const tp = await this.currencies.precision(currency);
    const fp = await this.currencies.precision(functional);
    const codes = await this.tax.codes(user.organisationId, input.lines.map((l) => l.taxCodeId), session);
    // Stock lines are received into stock on the goods received note, at the item's inventory account.
    const stock = new Map<number, { itemId: Types.ObjectId; warehouseId: Types.ObjectId; accountId: Types.ObjectId }>();
    for (const [i, l] of input.lines.entries()) {
      if (!l.itemId) continue;
      const item = await this.inventory.item(user.organisationId, l.itemId, session);
      if (item.type !== 'STOCK') throw new BadRequestException(`Line ${i + 1}: ${item.code} is not a stock item`);
      if (!l.warehouseId) throw new BadRequestException(`Line ${i + 1}: choose the warehouse receiving ${item.code}`);
      await this.inventory.warehouse(user.organisationId, l.warehouseId, entity._id, session);
      if (!item.inventoryAccountId) throw new BadRequestException(`${item.code} has no inventory account`);
      stock.set(i, { itemId: item._id, warehouseId: l.warehouseId, accountId: item.inventoryAccountId });
    }
    const lines = input.lines.map((l, i) => {
      if (l.quantity.lte(0)) throw new BadRequestException(`Line ${i + 1}: quantity must be positive`);
      if (l.unitPrice.isNeg()) throw new BadRequestException(`Line ${i + 1}: price cannot be negative`);
      let ratePercent = new Decimal(0);
      if (l.taxCodeId) ratePercent = this.tax.rateOn(this.tax.assertUsable(codes.get(l.taxCodeId.toHexString()), entity.country, 'VAT', `Line ${i + 1}`), input.date);
      const { net, tax } = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, ratePercent, inclusive: !!input.priceIncludesTax, precision: tp });
      return {
        lineNo: i + 1,
        description: l.description,
        accountId: stock.get(i)?.accountId ?? l.accountId,
        quantity: toD128(l.quantity),
        unitPrice: toD128(l.unitPrice),
        taxCodeId: l.taxCodeId ?? null,
        netAmount: toD128(net),
        taxAmount: toD128(tax),
        quantityReceived: toD128(0),
        quantityBilled: toD128(0),
        itemId: stock.get(i)?.itemId ?? null,
        warehouseId: stock.get(i)?.warehouseId ?? null,
        receivedValue: stock.has(i) ? toD128(0) : null,
        planItemId: l.planItemId ?? null,
        departmentId: l.departmentId ?? null,
        costCentreId: l.costCentreId ?? null,
        projectId: l.projectId ?? null,
      };
    });
    const subtotal = sum(lines.map((l) => l.netAmount));
    const taxTotal = sum(lines.map((l) => l.taxAmount));
    const total = subtotal.plus(taxTotal);
    if (total.lte(0)) throw new BadRequestException('The order total must be greater than zero');
    return {
      entity,
      supplier,
      fields: {
        entityId: entity._id,
        branchId: input.branchId,
        supplierId: supplier._id,
        supplierName: supplier.name,
        date: input.date,
        expectedDate: input.expectedDate ?? null,
        reference: input.reference ?? '',
        notes: input.notes ?? '',
        deliveryAddress: input.deliveryAddress ?? '',
        requisitionId: input.requisitionId ?? null,
        currency,
        exchangeRate: toD128(rate),
        priceIncludesTax: !!input.priceIncludesTax,
        lines,
        subtotal: toD128(subtotal),
        taxTotal: toD128(taxTotal),
        total: toD128(total),
        totalFunctional: toD128(round(total.times(rate), fp)),
      },
    };
  }

  async listOrders(user: AuthUser, q: ProcurementListQuery) {
    const filter: Record<string, unknown> = this.scope(user);
    if (q.entityId) filter.entityId = q.entityId;
    if (q.status === 'OPEN') filter.status = { $in: OPEN_FOR_RECEIPT };
    else if (q.status) filter.status = q.status;
    if (q.supplierId) filter.supplierId = q.supplierId;
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ number: rx }, { supplierName: rx }, { reference: rx }];
    }
    const [items, total] = await Promise.all([
      this.db.purchaseOrders.find(filter).sort({ date: -1, number: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      this.db.purchaseOrders.countDocuments(filter),
    ]);
    return {
      items: items.map(({ lines, ...po }) => ({ ...po, ...this.progress(lines) })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  private progress(lines: PurchaseOrder['lines']) {
    const ordered = sum(lines.map((l) => l.quantity));
    return {
      receivedPercent: ordered.isZero() ? '0' : sum(lines.map((l) => l.quantityReceived)).div(ordered).times(100).toDecimalPlaces(0).toFixed(),
      billedPercent: ordered.isZero() ? '0' : sum(lines.map((l) => l.quantityBilled)).div(ordered).times(100).toDecimalPlaces(0).toFixed(),
    };
  }

  private async loadOrder(user: AuthUser, id: Types.ObjectId, session?: ClientSession) {
    const po = await this.db.purchaseOrders.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  async getOrder(user: AuthUser, id: Types.ObjectId) {
    const po = await this.loadOrder(user, id);
    const [receipts, bills, requisition, supplier] = await Promise.all([
      this.db.goodsReceipts.find({ organisationId: user.organisationId, purchaseOrderId: po._id }).sort({ date: 1 }).lean(),
      this.db.invoices.find({ organisationId: user.organisationId, purchaseOrderId: po._id }, { number: 1, status: 1, date: 1, total: 1, supplierInvoiceNumber: 1, matchStatus: 1 }).lean(),
      po.requisitionId ? this.db.requisitions.findById(po.requisitionId, { number: 1 }).lean() : null,
      this.db.suppliers.findById(po.supplierId).lean(),
    ]);
    return { ...(await withTrail(this.db, po)), ...this.progress(po.lines), receipts, bills, requisitionNumber: requisition?.number ?? null, supplier };
  }

  async createOrder(user: AuthUser, input: PurchaseOrderInput) {
    return this.db.transaction((session) => this.createOrderIn(user, input, session));
  }

  /** Creates a draft purchase order inside the caller's transaction (orders raised from an RFQ award). */
  async createOrderIn(user: AuthUser, input: PurchaseOrderInput, session: ClientSession, origin?: string) {
    {
      const { entity, fields } = await this.buildOrder(user, input, session);
      let requisition = null;
      if (input.requisitionId) {
        requisition = await this.loadRequisition(user, input.requisitionId, session);
        if (!['APPROVED', 'ORDERED'].includes(requisition.status)) throw new BadRequestException(`${requisition.number} must be approved before ordering`);
        if (!requisition.entityId.equals(entity._id)) throw new BadRequestException('The requisition belongs to another entity');
      }
      const number = await this.db.nextNumber(user.organisationId, entity, 'PO', session);
      const [po] = await this.db.purchaseOrders.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }], { session });
      if (requisition) {
        await this.db.requisitions.updateOne({ _id: requisition._id }, { status: 'ORDERED', $addToSet: { purchaseOrderIds: po._id } }, { session });
      }
      await this.audit.log(
        user,
        { action: 'purchase_order.create', recordType: 'PurchaseOrder', recordId: po._id, summary: `Created ${number} for ${fields.supplierName}${requisition ? ` from ${requisition.number}` : ''}${origin ? ` from ${origin}` : ''}`, after: po },
        session,
      );
      return po.toObject();
    }
  }

  async updateOrder(user: AuthUser, id: Types.ObjectId, input: PurchaseOrderInput) {
    return this.db.transaction(async (session) => {
      const before = await this.loadOrder(user, id, session);
      if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException(`A ${before.status.toLowerCase()} order cannot be edited`);
      if (!input.entityId.equals(before.entityId)) throw new BadRequestException('The entity cannot change');
      const { fields } = await this.buildOrder(user, { ...input, requisitionId: before.requisitionId }, session);
      const after = await transition(this.db.purchaseOrders, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT', rejectionReason: '' }, session);
      await this.audit.log(user, { action: 'purchase_order.update', recordType: 'PurchaseOrder', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  async orderAction(user: AuthUser, id: Types.ObjectId, action: 'submit' | 'approve' | 'reject' | 'cancel' | 'close', reason?: string) {
    return this.db.transaction(async (session) => {
      const po = await this.loadOrder(user, id, session);
      const now = new Date();
      const received = po.lines.some((l) => dec(l.quantityReceived).gt(0));
      let after;
      let budgetNotes: string[] = [];
      switch (action) {
        case 'submit':
          after = await transition(this.db.purchaseOrders, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
          await this.workflow.open(user, subjectOf('PURCHASE_ORDER', after), session);
          break;
        case 'approve': {
          if (po.status !== 'SUBMITTED') throw new BadRequestException('Only submitted orders can be approved');
          assertSegregation(user, po, 'a purchase order');
          const gate = await this.workflow.gate(user, subjectOf('PURCHASE_ORDER', po), reason, session);
          if (!gate.final) return { ...po, approval: this.workflow.view(gate.request) };
          assertApprovalLimit(user, dec(po.totalFunctional), (await this.db.entities.findById(po.entityId).lean())!.functionalCurrency, 'The purchase order');
          budgetNotes = await this.budgets.enforce(
            user,
            { entityId: po.entityId, date: po.date, excludeOrderId: po._id, amounts: po.lines.map((l) => ({ accountId: l.accountId, amount: dec(l.netAmount).times(dec(po.exchangeRate)) })) },
            session,
          );
          after = await transition(this.db.purchaseOrders, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now }, session);
          break;
        }
        case 'reject':
          if (po.status !== 'SUBMITTED') throw new BadRequestException('Only submitted orders can be rejected');
          after = await transition(this.db.purchaseOrders, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason ?? '' }, session);
          await this.workflow.close(user, 'PURCHASE_ORDER', id, 'REJECTED', reason ?? '', session);
          break;
        case 'cancel':
          if (received) throw new BadRequestException('Goods have been received against this order; close it instead');
          after = await transition(this.db.purchaseOrders, id, ['DRAFT', 'REJECTED', 'SUBMITTED', 'APPROVED'], { status: 'CANCELLED' }, session);
          await this.workflow.close(user, 'PURCHASE_ORDER', id, 'CANCELLED', reason ?? 'Cancelled', session);
          break;
        case 'close':
          after = await transition(this.db.purchaseOrders, id, ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'], { status: 'CLOSED', closedBy: user.id, closedAt: now }, session);
          break;
      }
      await this.audit.log(
        user,
        {
          action: `purchase_order.${action}`,
          recordType: 'PurchaseOrder',
          recordId: id,
          summary: `${action[0].toUpperCase()}${action.slice(1)} ${po.number}${reason ? `: ${reason}` : ''}${budgetNotes.length ? ` — over budget: ${budgetNotes.join('; ')}` : ''}`,
        },
        session,
      );
      return after;
    });
  }

  /** Records goods or services received against an approved order. No ledger posting until the bill. */
  async receive(user: AuthUser, id: Types.ObjectId, input: { date: Date; reference?: string; notes?: string; lines: { poLineNo: number; quantity: Decimal; lots?: LotInput[] | null }[] }) {
    return this.db.transaction(async (session) => {
      const po = await this.loadOrder(user, id, session);
      if (!OPEN_FOR_RECEIPT.includes(po.status as PurchaseOrderStatus)) throw new BadRequestException(`${po.number} is ${po.status.toLowerCase().replace('_', ' ')}`);
      if (input.date < po.date) throw new BadRequestException('The receipt date cannot be before the order date');
      const lines = input.lines.filter((l) => l.quantity.gt(0));
      if (!lines.length) throw new BadRequestException('Enter a quantity received for at least one line');
      // Stock lines are valued at the order's net unit price, in functional currency at the receipt date.
      const entityDoc = (await this.db.entities.findById(po.entityId).session(session).lean())!;
      const fp = await this.currencies.precision(entityDoc.functionalCurrency);
      let rate = new Decimal(1);
      if (po.currency !== entityDoc.functionalCurrency && po.lines.some((l) => l.itemId && lines.some((x) => x.poLineNo === l.lineNo))) {
        const found = await this.currencies.findRate(user.organisationId, po.currency, entityDoc.functionalCurrency, input.date, 'SPOT', session);
        if (!found) throw new BadRequestException(`No approved ${po.currency}/${entityDoc.functionalCurrency} rate on or before ${input.date.toISOString().slice(0, 10)} to value the stock`);
        rate = found.rate;
      }
      const values = new Map<number, Decimal>();
      const updated = po.lines.map((pol) => {
        const qty = lines.filter((l) => l.poLineNo === pol.lineNo).reduce((a, l) => a.plus(l.quantity), new Decimal(0));
        const outstanding = dec(pol.quantity).minus(dec(pol.quantityReceived));
        if (qty.gt(outstanding)) throw new BadRequestException(`Line ${pol.lineNo}: receiving ${qty.toFixed()} but only ${outstanding.toFixed()} is outstanding`);
        if (!pol.itemId || qty.isZero()) return { ...pol, quantityReceived: toD128(dec(pol.quantityReceived).plus(qty)) };
        const value = round(dec(pol.netAmount).div(dec(pol.quantity)).times(qty).times(rate), fp);
        values.set(pol.lineNo, value);
        return { ...pol, quantityReceived: toD128(dec(pol.quantityReceived).plus(qty)), receivedValue: toD128(dec(pol.receivedValue).plus(value)) };
      });
      for (const l of lines) if (!po.lines.some((p) => p.lineNo === l.poLineNo)) throw new BadRequestException(`${po.number} has no line ${l.poLineNo}`);
      const complete = updated.every((l) => dec(l.quantityReceived).gte(dec(l.quantity)));
      const res = await this.db.purchaseOrders.updateOne(
        { _id: po._id, status: po.status },
        { lines: updated, status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
        { session },
      );
      if (res.modifiedCount !== 1) throw new BadRequestException('The order was changed by someone else; reload and try again');
      const entity = (await this.db.entities.findById(po.entityId).session(session).lean())!;
      const number = await this.db.nextNumber(user.organisationId, entity, 'GRN', session);
      const [grn] = await this.db.goodsReceipts.create(
        [
          {
            organisationId: user.organisationId,
            entityId: po.entityId,
            branchId: po.branchId,
            number,
            purchaseOrderId: po._id,
            purchaseOrderNumber: po.number,
            supplierId: po.supplierId,
            date: input.date,
            reference: input.reference ?? '',
            notes: input.notes ?? '',
            lines: lines.map((l) => {
              const pol = po.lines.find((p) => p.lineNo === l.poLineNo)!;
              if (l.lots?.length && !pol.itemId) throw new BadRequestException(`Line ${l.poLineNo} is not a stock line; batches and serial numbers do not apply`);
              return { poLineNo: l.poLineNo, description: pol.description, quantity: toD128(l.quantity), itemId: pol.itemId ?? null, warehouseId: pol.warehouseId ?? null, value: values.has(l.poLineNo) ? toD128(values.get(l.poLineNo)!) : null, lots: lotsOf(l.lots) };
            }),
            createdBy: user.id,
          },
        ],
        { session },
      );
      // Stock received now: Dr inventory, Cr goods received not invoiced. The bill clears GRNI later.
      if (values.size) {
        const org = await this.db.organisations.findById(user.organisationId).session(session).lean();
        const grni = org?.settings?.grniAccountId;
        if (!grni) throw new BadRequestException('Set the goods received not invoiced account in Organisation settings');
        const journalLines: LineInput[] = [];
        let total = new Decimal(0);
        for (const [lineNo, value] of values) {
          const pol = po.lines.find((p) => p.lineNo === lineNo)!;
          const wh = await this.inventory.warehouse(user.organisationId, pol.warehouseId!, po.entityId, session);
          const qty = lines.filter((l) => l.poLineNo === lineNo).reduce((a, l) => a.plus(l.quantity), new Decimal(0));
          const lots = lines.filter((l) => l.poLineNo === lineNo).flatMap((l) => l.lots ?? []);
          const foreign = po.currency !== entityDoc.functionalCurrency ? { currency: po.currency, value: dec(pol.netAmount).div(dec(pol.quantity)).times(qty) } : null;
          await this.inventory.move(user, { entityId: po.entityId, itemId: pol.itemId!, warehouseId: pol.warehouseId!, date: input.date, type: 'PURCHASE', quantity: qty, value, lots, foreign, source: { type: 'GoodsReceipt', id: grn._id, number } }, session);
          if (value.isZero()) continue;
          journalLines.push({ accountId: pol.accountId, branchId: wh.branchId, currency: entityDoc.functionalCurrency, description: `${pol.description} received (${number})`, debit: value, credit: null, functionalDebit: value, functionalCredit: new Decimal(0), departmentId: pol.departmentId, costCentreId: pol.costCentreId, projectId: pol.projectId });
          total = total.plus(value);
        }
        if (total.gt(0)) {
          journalLines.push({ accountId: grni, currency: entityDoc.functionalCurrency, description: `Received not invoiced: ${po.number} (${number})`, debit: null, credit: total, functionalDebit: new Decimal(0), functionalCredit: total, partyType: 'SUPPLIER', partyId: po.supplierId });
          const journal = await this.journals.postSystemJournal(
            user,
            { entityId: po.entityId, branchId: po.branchId, journalDate: input.date, description: `Goods received ${number} · ${po.supplierName} (${po.number})`, reference: input.reference ?? '', lines: journalLines },
            { sourceType: 'GoodsReceipt', sourceId: grn._id, sourceNumber: number },
            session,
          );
          await this.db.goodsReceipts.updateOne({ _id: grn._id }, { journalId: journal._id }, { session });
        }
      }
      await this.audit.log(user, { action: 'goods_receipt.create', recordType: 'PurchaseOrder', recordId: po._id, summary: `${number}: received goods against ${po.number}` }, session);
      return (await this.db.goodsReceipts.findById(grn._id).session(session).lean())!;
    });
  }

  /**
   * Reverses a goods received note that has not been billed: the stock comes back out at the value it came
   * in and the GRNI journal is reversed.
   */
  async reverseReceipt(user: AuthUser, id: Types.ObjectId, input: { date: Date; reason: string }) {
    return this.db.transaction(async (session) => {
      const grn = await this.db.goodsReceipts.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean();
      if (!grn) throw new NotFoundException('Goods received note not found');
      if (grn.status === 'REVERSED') throw new BadRequestException(`${grn.number} is already reversed`);
      if (input.date < grn.date) throw new BadRequestException('The reversal date cannot be before the receipt');
      const po = await this.loadOrder(user, grn.purchaseOrderId, session);
      if (['CLOSED', 'CANCELLED'].includes(po.status)) throw new BadRequestException(`${po.number} is ${po.status.toLowerCase()}`);
      const updated = po.lines.map((pol) => {
        const qty = grn.lines.filter((l) => l.poLineNo === pol.lineNo).reduce((a, l) => a.plus(dec(l.quantity)), new Decimal(0));
        if (qty.isZero()) return pol;
        const received = dec(pol.quantityReceived).minus(qty);
        if (received.lt(dec(pol.quantityBilled))) throw new BadRequestException(`Line ${pol.lineNo} of ${po.number} has been billed; credit the bill instead`);
        const value = grn.lines.filter((l) => l.poLineNo === pol.lineNo).reduce((a, l) => a.plus(dec(l.value)), new Decimal(0));
        return { ...pol, quantityReceived: toD128(received), ...(pol.itemId && { receivedValue: toD128(dec(pol.receivedValue).minus(value)) }) };
      });
      await this.inventory.reverseSource(user, grn._id, input.date, session);
      const reversal = grn.journalId ? await this.journals.reverseSystemJournal(user, grn.journalId, input.date, `Reversal of ${grn.number}: ${input.reason}`, session) : null;
      const anyReceived = updated.some((l) => dec(l.quantityReceived).gt(0));
      await this.db.purchaseOrders.updateOne({ _id: po._id }, { lines: updated, status: anyReceived ? 'PARTIALLY_RECEIVED' : 'APPROVED' }, { session });
      await this.db.goodsReceipts.updateOne({ _id: grn._id }, { status: 'REVERSED', reversedAt: new Date(), reversedBy: user.id, reversalReason: input.reason, reversalJournalId: reversal?._id ?? null }, { session });
      await this.audit.log(user, { action: 'goods_receipt.reverse', recordType: 'PurchaseOrder', recordId: po._id, summary: `Reversed ${grn.number}: ${input.reason}` }, session);
      return this.db.goodsReceipts.findById(grn._id).session(session).lean();
    });
  }

  /**
   * Goods received not invoiced: stock received on goods received notes and not yet billed, valued at
   * receipt. Reconciles to the GRNI account.
   */
  async receivedNotInvoiced(user: AuthUser, entityId: Types.ObjectId) {
    const orders = await this.db.purchaseOrders.find({ ...this.scope(user), entityId, status: { $in: ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] }, lines: { $elemMatch: { itemId: { $ne: null } } } }).lean();
    const rows = orders.flatMap((po) =>
      po.lines
        .filter((l) => l.itemId && dec(l.quantityReceived).gt(dec(l.quantityBilled)))
        .map((l) => {
          const open = dec(l.quantityReceived).minus(dec(l.quantityBilled));
          return { purchaseOrderId: po._id, number: po.number, supplierId: po.supplierId, supplierName: po.supplierName, date: po.date, lineNo: l.lineNo, description: l.description, quantity: open, value: dec(l.receivedValue).minus(dec(l.billedValue)) };
        }),
    );
    const org = await this.db.organisations.findById(user.organisationId).lean();
    const grni = org?.settings?.grniAccountId;
    const [gl] = grni
      ? await this.db.ledger.aggregate<{ debit: unknown; credit: unknown }>([{ $match: { organisationId: user.organisationId, entityId, accountId: grni } }, { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } }])
      : [];
    const total = sum(rows.map((r) => r.value));
    const ledger = gl ? dec(gl.credit as never).minus(dec(gl.debit as never)) : new Decimal(0);
    return { rows, total, ledger, difference: ledger.minus(total) };
  }

  /** Suggested bill lines for an order: everything received but not yet billed, at the order price. */
  async billDraft(user: AuthUser, id: Types.ObjectId) {
    const po = await this.loadOrder(user, id);
    const lines = po.lines
      .map((l) => ({ l, qty: dec(l.quantityReceived).minus(dec(l.quantityBilled)) }))
      .filter(({ qty }) => qty.gt(0))
      .map(({ l, qty }) => ({
        poLineNo: l.lineNo,
        description: l.description,
        accountId: l.accountId,
        quantity: qty,
        unitPrice: l.unitPrice,
        taxCodeId: l.taxCodeId,
        itemId: l.itemId ?? null,
        warehouseId: l.warehouseId ?? null,
        departmentId: l.departmentId,
        costCentreId: l.costCentreId,
        projectId: l.projectId,
      }));
    return { purchaseOrderId: po._id, number: po.number, supplierId: po.supplierId, branchId: po.branchId, priceIncludesTax: po.priceIncludesTax, lines };
  }
}
