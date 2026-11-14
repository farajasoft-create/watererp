import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { Permission, PERMISSIONS } from '../../common/permissions';
import { addDays, assertApprovalLimit, assertSegregation, escapeRegex, transition } from '../../common/workflow';
import { DOCUMENT_STATUSES, DocumentKind, DocumentLine, Invoice, Party, PurchaseOrder, TaxCode } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { assertSupplierUsable } from '../procurement/supplier-management.service';
import { PartyType } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { PeriodsService } from '../periods/periods.service';
import { SettlementService, SIDES } from '../settlement/settlement.service';
import { BudgetsService } from '../budgets/budgets.service';
import { InventoryService, LotInput, lotInputs, lotsOf } from '../inventory/inventory.service';
import { computeLine, TaxRow, TaxService } from '../tax/tax.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

export interface DocumentLineInput {
  description: string;
  accountId?: Types.ObjectId | null;
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent?: Decimal | null;
  taxCodeId?: Types.ObjectId | null;
  departmentId?: Types.ObjectId | null;
  costCentreId?: Types.ObjectId | null;
  projectId?: Types.ObjectId | null;
  poLineNo?: number | null;
  itemId?: Types.ObjectId | null;
  warehouseId?: Types.ObjectId | null;
  /** Tracked stock: batches or serial numbers. */
  lots?: LotInput[] | null;
}

export interface DocumentInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  kind: DocumentKind;
  partyId: Types.ObjectId;
  date: Date;
  dueDate?: Date | null;
  reference?: string;
  supplierInvoiceNumber?: string;
  purchaseOrderId?: Types.ObjectId | null;
  appliesToId?: Types.ObjectId | null;
  exchangeRate?: Decimal | null;
  priceIncludesTax?: boolean;
  notes?: string;
  lines: DocumentLineInput[];
}

export interface DocumentListQuery {
  kinds: DocumentKind[];
  entityId?: Types.ObjectId;
  partyId?: Types.ObjectId;
  status?: (typeof DOCUMENT_STATUSES)[number];
  open?: boolean;
  overdue?: boolean;
  from?: Date;
  to?: Date;
  search?: string;
  page: number;
  pageSize: number;
}

export const PARTY_OF: Record<DocumentKind, PartyType> = {
  SALES_INVOICE: 'CUSTOMER',
  SALES_CREDIT: 'CUSTOMER',
  PURCHASE_BILL: 'SUPPLIER',
  PURCHASE_CREDIT: 'SUPPLIER',
};
const PREFIX: Record<DocumentKind, string> = { SALES_INVOICE: 'INV', SALES_CREDIT: 'CN', PURCHASE_BILL: 'BILL', PURCHASE_CREDIT: 'SCN' };
export const LABEL: Record<DocumentKind, string> = {
  SALES_INVOICE: 'invoice',
  SALES_CREDIT: 'credit note',
  PURCHASE_BILL: 'bill',
  PURCHASE_CREDIT: 'supplier credit note',
};
const IS_CREDIT: Record<DocumentKind, boolean> = { SALES_INVOICE: false, SALES_CREDIT: true, PURCHASE_BILL: false, PURCHASE_CREDIT: true };
/** Whether the control account (AR/AP) is debited when the document posts. */
const CONTROL_DEBIT: Record<DocumentKind, boolean> = { SALES_INVOICE: true, SALES_CREDIT: false, PURCHASE_BILL: false, PURCHASE_CREDIT: true };

export const PARTY_PERMISSIONS: Record<PartyType, Record<'view' | 'manage' | 'approve', Permission>> = {
  CUSTOMER: { view: PERMISSIONS.AR_VIEW, manage: PERMISSIONS.AR_MANAGE, approve: PERMISSIONS.AR_APPROVE },
  SUPPLIER: { view: PERMISSIONS.AP_VIEW, manage: PERMISSIONS.AP_MANAGE, approve: PERMISSIONS.AP_APPROVE },
};

export function requirePermission(user: AuthUser, partyType: PartyType, action: 'view' | 'manage' | 'approve') {
  const permission = PARTY_PERMISSIONS[partyType][action];
  if (!hasPermission(user, permission)) throw new ForbiddenException(`Missing permission: ${permission}`);
}

export function partyModel(db: Db, partyType: PartyType) {
  return partyType === 'CUSTOMER' ? db.customers : db.suppliers;
}

/** Compares a bill with its purchase order: quantities against goods received, prices against the order. */
export function matchAgainstOrder(lines: Pick<DocumentLine, 'lineNo' | 'poLineNo' | 'quantity' | 'unitPrice'>[], po: PurchaseOrder, tolerancePercent: Decimal): string[] {
  const notes: string[] = [];
  for (const l of lines) {
    if (l.poLineNo == null) {
      notes.push(`Line ${l.lineNo} is not on purchase order ${po.number}`);
      continue;
    }
    const pol = po.lines.find((x) => x.lineNo === l.poLineNo);
    if (!pol) {
      notes.push(`Line ${l.lineNo}: ${po.number} has no line ${l.poLineNo}`);
      continue;
    }
    const unbilled = dec(pol.quantityReceived).minus(dec(pol.quantityBilled));
    if (dec(l.quantity).gt(unbilled)) {
      notes.push(`Line ${l.lineNo}: bills ${dec(l.quantity).toFixed()} but only ${unbilled.toFixed()} received and not yet billed`);
    }
    const ceiling = dec(pol.unitPrice).times(new Decimal(100).plus(tolerancePercent)).div(100);
    if (dec(l.unitPrice).gt(ceiling)) {
      notes.push(`Line ${l.lineNo}: unit price ${dec(l.unitPrice).toFixed()} is above the order price ${dec(pol.unitPrice).toFixed()}`);
    }
  }
  return notes;
}

export class DocumentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly periods: PeriodsService,
    private readonly settlement: SettlementService,
    private readonly tax: TaxService,
    private readonly inventory: InventoryService,
    private readonly budgets: BudgetsService,
    private readonly workflow: WorkflowService,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Validation & calculation
  // ------------------------------------------------------------------------------------------

  /** Validates a document against master data and calculates line, tax and document totals. */
  async build(user: AuthUser, input: DocumentInput, session?: ClientSession) {
    const org = user.organisationId;
    const s = session ?? null;
    const partyType = PARTY_OF[input.kind];
    const label = LABEL[input.kind];
    if (!input.lines.length) throw new BadRequestException(`A ${label} needs at least one line`);
    if (input.lines.length > 500) throw new BadRequestException(`A ${label} may have at most 500 lines`);

    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(s).lean();
    if (!entity?.isActive) throw new BadRequestException('Entity not found or inactive');
    const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: org }).session(s).lean();
    if (!branch || !branch.entityId.equals(entity._id) || !branch.isActive) throw new BadRequestException('Branch not found or not active in this entity');
    assertBranchAccess(user, [branch._id]);

    const party = await partyModel(this.db, partyType).findOne({ _id: input.partyId, organisationId: org }).session(s).lean();
    if (!party) throw new BadRequestException(`${partyType === 'CUSTOMER' ? 'Customer' : 'Supplier'} not found`);
    if (!party.isActive) throw new BadRequestException(`${party.name} is inactive`);
    if (partyType === 'SUPPLIER') assertSupplierUsable(party, 'BILL');

    const period = await this.periods.periodFor(org, entity._id, input.date, session);
    if (!period) throw new BadRequestException(`No accounting period covers ${input.date.toISOString().slice(0, 10)} for ${entity.code}`);
    if (period.status === 'HARD_CLOSED') throw new BadRequestException(`Period ${period.name} is closed`);

    const functional = entity.functionalCurrency;
    const currency = party.currency;
    const orgDoc = await this.db.organisations.findById(org).session(s).lean();
    if (!orgDoc?.activeCurrencies.includes(currency)) throw new BadRequestException(`Currency ${currency} is not active`);
    let rate = new Decimal(1);
    if (currency !== functional) {
      if (input.exchangeRate) rate = dec(input.exchangeRate);
      else {
        const found = await this.currencies.findRate(org, currency, functional, input.date, 'SPOT', session);
        if (!found) throw new BadRequestException(`No approved ${currency}/${functional} rate on or before ${input.date.toISOString().slice(0, 10)}`);
        rate = found.rate;
      }
      if (rate.lte(0)) throw new BadRequestException('Exchange rate must be positive');
    } else if (input.exchangeRate && !dec(input.exchangeRate).eq(1)) {
      throw new BadRequestException('The exchange rate for the functional currency must be 1');
    }
    const tp = await this.currencies.precision(currency);

    // Items: stock lines post purchases to the item's inventory account and move stock in a warehouse.
    const purchase = partyType === 'SUPPLIER';
    const itemIds = input.lines.map((l) => l.itemId).filter(Boolean);
    const items = itemIds.length ? await this.db.items.find({ organisationId: org, _id: { $in: itemIds } }).session(s).lean() : [];
    const itemById = new Map(items.map((i) => [i._id.toHexString(), i]));
    const warehouseIds = input.lines.map((l) => l.warehouseId).filter(Boolean);
    const warehouses = warehouseIds.length ? await this.db.warehouses.find({ organisationId: org, _id: { $in: warehouseIds } }).session(s).lean() : [];

    // Accounts default from the item, then the party; subledger lines may never post to control accounts directly.
    const accountIds = input.lines.map((l) => {
      const item = l.itemId ? itemById.get(l.itemId.toHexString()) : undefined;
      if (item?.type === 'STOCK' && purchase) return item.inventoryAccountId;
      return l.accountId ?? (item ? (purchase ? item.purchaseAccountId : item.salesAccountId) : null) ?? party.defaultAccountId;
    });
    const accounts = await this.db.accounts
      .find({ organisationId: org, _id: { $in: accountIds.filter(Boolean) } })
      .session(s)
      .lean();
    const accountById = new Map(accounts.map((a) => [a._id.toHexString(), a]));
    const taxCodes = await this.tax.codes(org, input.lines.map((l) => l.taxCodeId), session);

    let po: PurchaseOrder | null = null;
    if (input.purchaseOrderId) {
      if (input.kind !== 'PURCHASE_BILL') throw new BadRequestException('Only bills can be matched to a purchase order');
      po = await this.db.purchaseOrders.findOne({ _id: input.purchaseOrderId, organisationId: org }).session(s).lean();
      if (!po) throw new BadRequestException('Purchase order not found');
      if (!po.supplierId.equals(party._id) || !po.entityId.equals(entity._id)) throw new BadRequestException(`${po.number} is for a different supplier or entity`);
      if (!['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status)) throw new BadRequestException(`${po.number} is ${po.status.toLowerCase().replace('_', ' ')}`);
      const orgSettings = await this.db.organisations.findById(org, { settings: 1 }).session(s).lean();
      if (orgSettings?.settings?.requireGoodsInspection) {
        const waiting = await this.db.goodsReceipts.find({ purchaseOrderId: po._id, status: 'POSTED', 'inspection.status': { $ne: 'ACCEPTED' } }, { number: 1 }).session(s).lean();
        if (waiting.length) throw new BadRequestException(`${waiting.map((g) => g.number).join(', ')} must be inspected and accepted before the bill`);
      }
    }

    const lines: DocumentLine[] = [];
    for (const [i, l] of input.lines.entries()) {
      const tag = `Line ${i + 1}`;
      const item = l.itemId ? itemById.get(l.itemId.toHexString()) : undefined;
      if (l.itemId && (!item || !item.isActive)) throw new BadRequestException(`${tag}: item not found or inactive`);
      let warehouseId: Types.ObjectId | null = null;
      if (item?.type === 'STOCK') {
        if (!l.warehouseId) throw new BadRequestException(`${tag}: choose the warehouse for ${item.code}`);
        const warehouse = warehouses.find((w) => w._id.equals(l.warehouseId!));
        if (!warehouse || !warehouse.entityId.equals(entity._id) || !warehouse.isActive) throw new BadRequestException(`${tag}: warehouse not found or inactive in ${entity.code}`);
        if (!item.inventoryAccountId || !item.cogsAccountId) throw new BadRequestException(`${tag}: ${item.code} needs inventory and cost-of-sales accounts`);
        assertBranchAccess(user, [warehouse.branchId]);
        warehouseId = warehouse._id;
        // Stock received on a goods received note had its batches recorded there.
        const received = input.kind === 'PURCHASE_BILL' && po && l.poLineNo != null && po.lines.some((p) => p.lineNo === l.poLineNo && p.itemId);
        if (received) {
          if (l.lots?.length) throw new BadRequestException(`${tag}: batches and serial numbers are recorded on the goods received note`);
        } else this.inventory.checkLots(item, l.quantity, l.lots, input.kind === 'PURCHASE_BILL' || input.kind === 'SALES_CREDIT', tag);
      } else if (l.lots?.length) throw new BadRequestException(`${tag}: only stock lines carry batches or serial numbers`);
      const accountId = accountIds[i];
      if (!accountId) throw new BadRequestException(`${tag}: choose an account`);
      const account = accountById.get(accountId.toHexString());
      if (!account) throw new BadRequestException(`${tag}: account not found`);
      if (!account.isActive || !account.isPostable) throw new BadRequestException(`${tag}: ${account.code} is inactive or a header account`);
      if (account.isControl || !account.allowManualPosting) throw new BadRequestException(`${tag}: ${account.code} is a control account`);
      if (account.entityIds.length && !account.entityIds.some((e) => e.equals(entity._id))) {
        throw new BadRequestException(`${tag}: account ${account.code} is not available in ${entity.code}`);
      }
      if (account.currency && account.currency !== currency) throw new BadRequestException(`${tag}: account ${account.code} only accepts ${account.currency}`);
      if (account.requiresDepartment && !l.departmentId) throw new BadRequestException(`${tag}: account ${account.code} requires a department`);
      if (account.requiresCostCentre && !l.costCentreId) throw new BadRequestException(`${tag}: account ${account.code} requires a cost centre`);
      if (account.requiresProject && !l.projectId) throw new BadRequestException(`${tag}: account ${account.code} requires a project`);
      if (l.quantity.lte(0)) throw new BadRequestException(`${tag}: quantity must be positive`);
      if (l.unitPrice.isNeg()) throw new BadRequestException(`${tag}: unit price cannot be negative`);
      const discount = dec(l.discountPercent);
      if (discount.isNeg() || discount.gt(100)) throw new BadRequestException(`${tag}: discount must be between 0 and 100 percent`);
      if (l.poLineNo != null && !po) throw new BadRequestException(`${tag}: a purchase-order line needs a purchase order`);

      let ratePercent = new Decimal(0);
      if (l.taxCodeId) {
        const code = this.tax.assertUsable(taxCodes.get(l.taxCodeId.toHexString()), entity.country, 'VAT', tag);
        ratePercent = this.tax.rateOn(code, input.date);
      }
      const { net, tax } = computeLine({ quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: discount, ratePercent, inclusive: !!input.priceIncludesTax, precision: tp });
      lines.push({
        lineNo: i + 1,
        description: l.description,
        accountId: account._id,
        quantity: toD128(l.quantity),
        unitPrice: toD128(l.unitPrice),
        discountPercent: discount.isZero() ? null : toD128(discount),
        taxCodeId: l.taxCodeId ?? null,
        taxRate: toD128(ratePercent),
        netAmount: toD128(net),
        taxAmount: toD128(tax),
        poLineNo: l.poLineNo ?? null,
        itemId: item?._id ?? null,
        warehouseId,
        lots: (warehouseId ? lotsOf(l.lots) : []) as unknown as DocumentLine['lots'],
        costOfSales: null,
        departmentId: l.departmentId ?? null,
        costCentreId: l.costCentreId ?? null,
        projectId: l.projectId ?? null,
      });
    }

    if (input.appliesToId) {
      if (!IS_CREDIT[input.kind]) throw new BadRequestException('Only credit notes can be applied to another document');
      const target = await this.db.invoices.findOne({ _id: input.appliesToId, organisationId: org }).session(s).lean();
      if (!target || target.kind !== SIDES[partyType].document || !target.partyId.equals(party._id)) {
        throw new BadRequestException(`The credit note must apply to a ${SIDES[partyType].label} for ${party.name}`);
      }
      if (target.status !== 'POSTED') throw new BadRequestException(`${target.number} is not posted`);
    }
    if (input.kind === 'PURCHASE_BILL' && !input.supplierInvoiceNumber?.trim()) {
      throw new BadRequestException("Enter the supplier's invoice number");
    }

    const subtotal = sum(lines.map((l) => l.netAmount));
    const taxTotal = sum(lines.map((l) => l.taxAmount));
    const total = subtotal.plus(taxTotal);
    if (total.lte(0)) throw new BadRequestException(`The ${label} total must be greater than zero`);
    const dueDate = input.dueDate ?? (IS_CREDIT[input.kind] ? input.date : addDays(input.date, party.paymentTermsDays));
    if (dueDate < input.date) throw new BadRequestException('The due date cannot be before the document date');
    const fp = await this.currencies.precision(functional);

    return {
      entity,
      party,
      po,
      taxCodes,
      fields: {
        entityId: entity._id,
        branchId: branch._id,
        kind: input.kind,
        partyId: party._id,
        partyName: party.name,
        date: input.date,
        dueDate,
        reference: input.reference ?? '',
        supplierInvoiceNumber: input.supplierInvoiceNumber?.trim() ?? '',
        purchaseOrderId: input.purchaseOrderId ?? null,
        appliesToId: input.appliesToId ?? null,
        currency,
        exchangeRate: toD128(rate),
        functionalCurrency: functional,
        priceIncludesTax: !!input.priceIncludesTax,
        lines,
        subtotal: toD128(subtotal),
        taxTotal: toD128(taxTotal),
        total: toD128(total),
        totalFunctional: toD128(round(total.times(rate), fp)),
        amountDue: toD128(total),
        amountDueFunctional: toD128(round(total.times(rate), fp)),
        notes: input.notes ?? '',
      },
    };
  }

  private inputOf(doc: Invoice): DocumentInput {
    return {
      entityId: doc.entityId,
      branchId: doc.branchId,
      kind: doc.kind as DocumentKind,
      partyId: doc.partyId,
      date: doc.date,
      dueDate: doc.dueDate,
      reference: doc.reference,
      supplierInvoiceNumber: doc.supplierInvoiceNumber,
      purchaseOrderId: doc.purchaseOrderId,
      appliesToId: doc.appliesToId,
      exchangeRate: dec(doc.exchangeRate),
      priceIncludesTax: doc.priceIncludesTax,
      notes: doc.notes,
      lines: doc.lines.map((l) => ({
        description: l.description,
        accountId: l.accountId,
        quantity: dec(l.quantity),
        unitPrice: dec(l.unitPrice),
        discountPercent: l.discountPercent ? dec(l.discountPercent) : null,
        taxCodeId: l.taxCodeId,
        departmentId: l.departmentId,
        costCentreId: l.costCentreId,
        projectId: l.projectId,
        poLineNo: l.poLineNo,
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        lots: lotInputs(l.lots),
      })),
    };
  }

  private async assertNotDuplicate(user: AuthUser, fields: { kind: string; partyId: Types.ObjectId; supplierInvoiceNumber: string }, excludeId?: Types.ObjectId, session?: ClientSession) {
    if (fields.kind !== 'PURCHASE_BILL') return;
    const dup = await this.db.invoices
      .findOne({
        organisationId: user.organisationId,
        kind: 'PURCHASE_BILL',
        partyId: fields.partyId,
        supplierInvoiceNumber: new RegExp(`^${escapeRegex(fields.supplierInvoiceNumber)}$`, 'i'),
        status: { $ne: 'VOID' },
        ...(excludeId && { _id: { $ne: excludeId } }),
      })
      .session(session ?? null)
      .lean();
    if (dup) throw new BadRequestException(`Possible duplicate: supplier invoice ${fields.supplierInvoiceNumber} is already recorded as ${dup.number}`);
  }

  /** General-ledger lines for a document; the control line carries the sum of the translated lines. */
  private ledgerLines(
    doc: Pick<Invoice, 'kind' | 'lines' | 'currency' | 'exchangeRate' | 'partyId' | 'total' | 'number' | 'partyName'>,
    taxCodes: Map<string, TaxCode>,
    controlAccountId: Types.ObjectId,
    fp: number,
    stockBranches: Map<number, Types.ObjectId> = new Map(),
  ) {
    const kind = doc.kind as DocumentKind;
    const purchase = PARTY_OF[kind] === 'SUPPLIER';
    const rate = dec(doc.exchangeRate);
    const controlDebit = CONTROL_DEBIT[kind];
    const lines: LineInput[] = [];
    const push = (l: Omit<LineInput, 'debit' | 'credit'>, amount: Decimal, debit: boolean) => {
      if (amount.isZero()) return;
      const functional = round(amount.times(rate), fp);
      lines.push({
        ...l,
        // Every line carries the party, so intercompany revenue and expense can be eliminated on consolidation.
        partyType: PARTY_OF[kind],
        partyId: doc.partyId,
        currency: doc.currency,
        exchangeRate: rate,
        debit: debit ? amount : null,
        credit: debit ? null : amount,
        functionalDebit: debit ? functional : new Decimal(0),
        functionalCredit: debit ? new Decimal(0) : functional,
      });
    };
    const taxByAccount = new Map<string, Decimal>();
    for (const l of doc.lines) {
      const code = l.taxCodeId ? taxCodes.get(l.taxCodeId.toHexString()) : undefined;
      const recoverable = !purchase || !code || !!code.inputAccountId;
      const amount = dec(l.netAmount).plus(recoverable ? 0 : dec(l.taxAmount));
      // Purchased stock is recorded in the branch of the warehouse that holds it.
      const branchId = purchase ? stockBranches.get(l.lineNo) : undefined;
      push({ accountId: l.accountId, ...(branchId && { branchId }), description: l.description, departmentId: l.departmentId, costCentreId: l.costCentreId, projectId: l.projectId }, amount, !controlDebit);
      if (code && recoverable) {
        const account = (purchase ? code.inputAccountId : code.outputAccountId)!.toHexString();
        taxByAccount.set(account, (taxByAccount.get(account) ?? new Decimal(0)).plus(dec(l.taxAmount)));
      }
    }
    for (const [account, amount] of taxByAccount) {
      push({ accountId: new Types.ObjectId(account), description: `Tax on ${doc.number}` }, amount, !controlDebit);
    }
    const controlFunctional = sum(lines.map((l) => (controlDebit ? l.functionalCredit : l.functionalDebit)));
    lines.unshift({
      accountId: controlAccountId,
      partyType: PARTY_OF[kind],
      partyId: doc.partyId,
      description: `${doc.number} · ${doc.partyName}`,
      currency: doc.currency,
      exchangeRate: rate,
      debit: controlDebit ? dec(doc.total) : null,
      credit: controlDebit ? null : dec(doc.total),
      functionalDebit: controlDebit ? controlFunctional : new Decimal(0),
      functionalCredit: controlDebit ? new Decimal(0) : controlFunctional,
    });
    return { lines, controlFunctional };
  }

  private taxRows(doc: Invoice, party: Party, taxCodes: Map<string, TaxCode>, journalId: Types.ObjectId, fp: number): TaxRow[] {
    const kind = doc.kind as DocumentKind;
    const purchase = PARTY_OF[kind] === 'SUPPLIER';
    const sign = IS_CREDIT[kind] ? -1 : 1;
    const rate = dec(doc.exchangeRate);
    const byCode = new Map<string, { code: TaxCode; ratePercent: Decimal; taxable: Decimal; tax: Decimal }>();
    for (const l of doc.lines) {
      if (!l.taxCodeId) continue;
      const code = taxCodes.get(l.taxCodeId.toHexString())!;
      if (purchase && !code.inputAccountId && !dec(l.taxAmount).isZero()) continue; // non-recoverable: expensed, not claimed
      const key = `${code._id.toHexString()}|${dec(l.taxRate).toFixed()}`;
      const v = byCode.get(key) ?? { code, ratePercent: dec(l.taxRate), taxable: new Decimal(0), tax: new Decimal(0) };
      v.taxable = v.taxable.plus(dec(l.netAmount));
      v.tax = v.tax.plus(dec(l.taxAmount));
      byCode.set(key, v);
    }
    return [...byCode.values()].map((v) => ({
      organisationId: doc.organisationId,
      entityId: doc.entityId,
      branchId: doc.branchId,
      date: doc.date,
      direction: purchase ? 'INPUT' : 'OUTPUT',
      sourceType: 'Invoice',
      sourceId: doc._id,
      documentNumber: doc.number,
      partyType: PARTY_OF[kind],
      partyId: party._id,
      partyName: party.name,
      partyTaxId: party.taxId,
      taxCodeId: v.code._id,
      taxCode: v.code.code,
      rate: toD128(v.ratePercent),
      currency: doc.currency,
      exchangeRate: doc.exchangeRate,
      taxableAmountTx: toD128(v.taxable.times(sign)),
      taxAmountTx: toD128(v.tax.times(sign)),
      taxableAmount: toD128(round(v.taxable.times(rate), fp).times(sign)),
      taxAmount: toD128(round(v.tax.times(rate), fp).times(sign)),
      journalId,
    }));
  }

  // ------------------------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------------------------

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  async list(user: AuthUser, q: DocumentListQuery) {
    for (const t of new Set(q.kinds.map((k) => PARTY_OF[k]))) requirePermission(user, t, 'view');
    const filter: Record<string, unknown> = { ...this.scope(user), kind: { $in: q.kinds } };
    if (q.entityId) filter.entityId = q.entityId;
    if (q.partyId) filter.partyId = q.partyId;
    if (q.status) filter.status = q.status;
    if (q.open || q.overdue) {
      filter.status = 'POSTED';
      filter.paymentStatus = { $ne: 'PAID' };
    }
    if (q.overdue) filter.dueDate = { $lt: new Date() };
    if (q.from || q.to) filter.date = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ number: rx }, { partyName: rx }, { reference: rx }, { supplierInvoiceNumber: rx }];
    }
    const [items, total, totals] = await Promise.all([
      this.db.invoices
        .find(filter, { lines: 0 })
        .sort({ date: -1, number: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.invoices.countDocuments(filter),
      this.db.invoices.aggregate<{ _id: string; total: unknown; due: unknown; n: number }>([
        { $match: filter },
        { $group: { _id: '$functionalCurrency', total: { $sum: '$totalFunctional' }, due: { $sum: '$amountDueFunctional' }, n: { $sum: 1 } } },
      ]),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize, totals };
  }

  private async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession): Promise<Invoice> {
    const doc = await this.db.invoices.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const doc = await this.load(user, id);
    const partyType = PARTY_OF[doc.kind as DocumentKind];
    requirePermission(user, partyType, 'view');
    const [party, allocations, journals, po, appliesTo, credits] = await Promise.all([
      partyModel(this.db, partyType).findById(doc.partyId).lean(),
      this.settlement.history(user.organisationId, doc._id),
      this.db.journals.find({ _id: { $in: [doc.journalId, doc.voidJournalId].filter(Boolean) } }, { number: 1 }).lean(),
      doc.purchaseOrderId ? this.db.purchaseOrders.findById(doc.purchaseOrderId).lean() : null,
      doc.appliesToId ? this.db.invoices.findById(doc.appliesToId, { number: 1 }).lean() : null,
      this.db.invoices.find({ organisationId: user.organisationId, appliesToId: doc._id }, { number: 1, status: 1, total: 1 }).lean(),
    ]);
    let matchPreview: string[] | null = null;
    if (po && doc.status !== 'POSTED' && doc.status !== 'VOID') {
      matchPreview = matchAgainstOrder(doc.lines, po, (await this.settlement.accounts(user.organisationId)).matchTolerancePercent);
    }
    const balance = party ? (await this.settlement.balances(user.organisationId, partyType, [party._id])).get(party._id.toHexString()) : undefined;
    return {
      ...(await withTrail(this.db, doc)),
      party: party && {
        id: party._id,
        code: party.code,
        name: party.name,
        email: party.email,
        phone: party.phone,
        address: party.address,
        city: party.city,
        country: party.country,
        taxId: party.taxId,
        creditLimit: party.creditLimit,
        onHold: party.onHold,
        outstanding: balance?.outstanding ?? new Decimal(0),
      },
      allocations,
      journalNumber: journals.find((j) => j._id.equals(doc.journalId ?? undefined))?.number ?? null,
      voidJournalNumber: journals.find((j) => j._id.equals(doc.voidJournalId ?? undefined))?.number ?? null,
      purchaseOrder: po && { id: po._id, number: po.number, lines: po.lines },
      appliesToNumber: appliesTo?.number ?? null,
      creditNotes: credits,
      matchPreview,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle: draft → submitted → posted (approve) → void; rejected returns to the preparer
  // ------------------------------------------------------------------------------------------

  async create(user: AuthUser, input: DocumentInput, idempotencyKey?: string) {
    requirePermission(user, PARTY_OF[input.kind], 'manage');
    if (idempotencyKey) {
      const existing = await this.db.invoices.findOne({ organisationId: user.organisationId, idempotencyKey }).lean();
      if (existing) return existing;
    }
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.build(user, input, session);
      await this.assertNotDuplicate(user, fields, undefined, session);
      const number = await this.db.nextNumber(user.organisationId, entity, PREFIX[input.kind], session);
      const [doc] = await this.db.invoices.create(
        [{ ...fields, organisationId: user.organisationId, number, status: 'DRAFT', idempotencyKey, createdBy: user.id }],
        { session },
      );
      await this.audit.log(
        user,
        { action: 'document.create', recordType: 'Invoice', recordId: doc._id, summary: `Created ${LABEL[input.kind]} ${number} for ${fields.partyName}`, after: doc },
        session,
      );
      return doc.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: DocumentInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      requirePermission(user, PARTY_OF[before.kind as DocumentKind], 'manage');
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') throw new BadRequestException(`A ${before.status.toLowerCase()} document cannot be edited`);
      if (input.kind !== before.kind || !input.entityId.equals(before.entityId)) throw new BadRequestException('The type and entity of a document cannot change');
      const { fields } = await this.build(user, input, session);
      await this.assertNotDuplicate(user, fields, before._id, session);
      const after = await transition(
        this.db.invoices,
        id,
        ['DRAFT', 'REJECTED'],
        { ...fields, status: 'DRAFT', rejectedBy: null, rejectedAt: null, rejectionReason: '' },
        session,
      );
      await this.audit.log(user, { action: 'document.update', recordType: 'Invoice', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      requirePermission(user, PARTY_OF[before.kind as DocumentKind], 'manage');
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') throw new BadRequestException('Only draft or rejected documents can be deleted; void posted ones');
      await this.db.invoices.deleteOne({ _id: id, status: before.status }, { session });
      await this.workflow.close(user, before.kind as DocumentKind, id, 'CANCELLED', 'Deleted', session);
      await this.audit.log(user, { action: 'document.delete', recordType: 'Invoice', recordId: id, summary: `Deleted ${before.number}`, before }, session);
      return { id, deleted: true };
    });
  }

  async submit(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      requirePermission(user, PARTY_OF[before.kind as DocumentKind], 'manage');
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') throw new BadRequestException(`A ${before.status.toLowerCase()} document cannot be submitted`);
      await this.build(user, this.inputOf(before), session);
      await this.assertNotDuplicate(user, before, before._id, session);
      const after = await transition(this.db.invoices, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: new Date() }, session);
      await this.audit.log(user, { action: 'document.submit', recordType: 'Invoice', recordId: id, summary: `Submitted ${before.number} for approval` }, session);
      await this.workflow.open(user, subjectOf(before.kind as DocumentKind, after), session);
      return after;
    });
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      requirePermission(user, PARTY_OF[before.kind as DocumentKind], 'approve');
      if (before.status !== 'SUBMITTED') throw new BadRequestException('Only submitted documents can be rejected');
      const after = await transition(this.db.invoices, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: new Date(), rejectionReason: reason }, session);
      await this.audit.log(user, { action: 'document.reject', recordType: 'Invoice', recordId: id, summary: `Rejected ${before.number}: ${reason}` }, session);
      await this.workflow.close(user, before.kind as DocumentKind, id, 'REJECTED', reason, session);
      return after;
    });
  }

  /**
   * Approves and posts a document: credit control, purchase-order matching, then the GL journal,
   * tax transactions and subledger balance in one transaction.
   */
  async approve(user: AuthUser, id: Types.ObjectId, opts: { overrideMatch?: boolean; comment?: string } = {}) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const kind = doc.kind as DocumentKind;
      const partyType = PARTY_OF[kind];
      requirePermission(user, partyType, 'approve');
      const org = await this.db.organisations.findById(user.organisationId).session(session).lean();
      const requireApproval = org?.settings?.requireJournalApproval !== false;
      const allowed = requireApproval ? ['SUBMITTED'] : ['DRAFT', 'SUBMITTED', 'REJECTED'];
      if (!allowed.includes(doc.status)) {
        throw new BadRequestException(doc.status === 'POSTED' ? 'Document is already posted' : 'Document must be submitted before it can be approved');
      }
      if (requireApproval) {
        assertSegregation(user, doc, `a ${LABEL[kind]}`);
        // Multi-step approval: until the last step is approved the document stays submitted.
        const gate = await this.workflow.gate(user, subjectOf(kind, doc), opts.comment, session);
        if (!gate.final) return { ...doc, approval: this.workflow.view(gate.request) };
      }

      // Revalidate against current master data; the rate captured on the document is kept.
      const { party, po, taxCodes } = await this.build(user, this.inputOf(doc), session);
      await this.assertNotDuplicate(user, doc, doc._id, session);
      const fp = await this.currencies.precision(doc.functionalCurrency);
      const total = dec(doc.total);
      assertApprovalLimit(user, round(total.times(dec(doc.exchangeRate)), fp), doc.functionalCurrency, `The ${LABEL[kind]}`);

      const notes: string[] = [];
      if (kind === 'SALES_INVOICE') {
        if (party.onHold) notes.push(`${party.name} is on credit hold`);
        if (party.creditLimit) {
          const outstanding = (await this.settlement.balances(user.organisationId, 'CUSTOMER', [party._id])).get(party._id.toHexString())?.outstanding ?? new Decimal(0);
          const exposure = outstanding.plus(total);
          if (exposure.gt(dec(party.creditLimit))) {
            notes.push(`balance would be ${exposure.toFixed()} ${doc.currency}, above the credit limit of ${dec(party.creditLimit).toFixed()}`);
          }
        }
        if (notes.length && !hasPermission(user, PERMISSIONS.AR_CREDIT_OVERRIDE)) {
          throw new ForbiddenException(`Credit control: ${notes.join('; ')}. Approval requires ar.credit_override.`);
        }
      }

      let matchStatus = 'NOT_REQUIRED';
      let matchNotes: string[] = [];
      if (po) {
        matchNotes = matchAgainstOrder(doc.lines, po, (await this.settlement.accounts(user.organisationId, session)).matchTolerancePercent);
        if (!matchNotes.length) matchStatus = 'MATCHED';
        else if (opts.overrideMatch && hasPermission(user, PERMISSIONS.AP_MATCH_OVERRIDE)) matchStatus = 'OVERRIDDEN';
        else {
          throw new BadRequestException(
            `Three-way match failed: ${matchNotes.join('; ')}.${hasPermission(user, PERMISSIONS.AP_MATCH_OVERRIDE) ? ' Approve with override to accept the variance.' : ''}`,
          );
        }
      }

      // Spending control: bills not raised from a purchase order are checked against the budget here
      // (orders were checked when they were approved).
      const budgetNotes =
        kind === 'PURCHASE_BILL' && !doc.purchaseOrderId
          ? await this.budgets.enforce(user, { entityId: doc.entityId, date: doc.date, amounts: doc.lines.map((l) => ({ accountId: l.accountId, amount: dec(l.netAmount).times(dec(doc.exchangeRate)) })) }, session)
          : [];
      notes.push(...budgetNotes.map((n) => `over budget ${n}`));

      const control = await this.settlement.controlAccount(user.organisationId, partyType, session);
      const stockBranches = await this.stockBranches(user, doc, session);
      const { lines, controlFunctional } = this.ledgerLines(doc, taxCodes, control, fp, stockBranches);
      const stock = await this.applyStock(user, doc, taxCodes, stockBranches, fp, session, po);
      lines.push(...stock.lines);
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: doc.entityId, branchId: doc.branchId, journalDate: doc.date, description: `${LABEL[kind][0].toUpperCase()}${LABEL[kind].slice(1)} ${doc.number} · ${doc.partyName}`, reference: doc.reference || doc.supplierInvoiceNumber, lines },
        { sourceType: 'Invoice', sourceId: doc._id, sourceNumber: doc.number },
        session,
      );
      const now = new Date();
      const after = await transition(
        this.db.invoices,
        id,
        allowed,
        {
          status: 'POSTED',
          approvedBy: user.id,
          approvedAt: now,
          ...(!doc.submittedBy && { submittedBy: user.id, submittedAt: now }),
          journalId: journal._id,
          totalFunctional: toD128(controlFunctional),
          amountDue: doc.total,
          amountDueFunctional: toD128(controlFunctional),
          paymentStatus: 'UNPAID',
          matchStatus,
          matchNotes,
        },
        session,
      );
      await this.tax.record(this.taxRows(after, party, taxCodes, journal._id, fp), session);
      if (stock.costs.size || stock.grni.size || stock.lots.size) {
        await this.db.invoices.updateOne(
          { _id: id },
          {
            lines: after.lines.map((l) => ({
              ...l,
              costOfSales: stock.costs.has(l.lineNo) ? toD128(stock.costs.get(l.lineNo)!) : null,
              grniValue: stock.grni.has(l.lineNo) ? toD128(stock.grni.get(l.lineNo)!) : null,
              // The batches actually moved (sales pick the first to expire when none are named).
              lots: stock.lots.has(l.lineNo) ? lotsOf(stock.lots.get(l.lineNo)) : l.lots,
            })),
          },
          { session },
        );
      }
      if (po) await this.updateBilledQuantities(po, doc.lines.map((l) => ({ ...l, grniValue: stock.grni.get(l.lineNo) ?? null })), 1, session);
      await this.audit.log(
        user,
        {
          action: 'document.approve',
          recordType: 'Invoice',
          recordId: id,
          summary: `Approved and posted ${doc.number} (${journal.number})${notes.length ? ` with exceptions: ${notes.join('; ')}` : ''}${matchStatus === 'OVERRIDDEN' ? ` with match override: ${matchNotes.join('; ')}` : ''}${opts.comment ? ` — ${opts.comment}` : ''}`,
        },
        session,
      );

      // A credit note raised against a specific document settles it straight away.
      if (doc.appliesToId) {
        const target = await this.db.invoices.findById(doc.appliesToId).session(session).lean();
        const amount = target ? Decimal.min(dec(after.amountDue), dec(target.amountDue)) : new Decimal(0);
        if (amount.gt(0)) {
          await this.settlement.allocate(
            user,
            { partyType, partyId: doc.partyId, date: doc.date < target!.date ? target!.date : doc.date, requests: [{ documentId: target!._id, source: { type: 'CREDIT_NOTE', id: doc._id }, amount }] },
            session,
          );
        }
      }
      return this.db.invoices.findById(id).session(session).lean();
    });
  }

  private async stockBranches(user: AuthUser, doc: Invoice, session: ClientSession) {
    const out = new Map<number, Types.ObjectId>();
    for (const l of doc.lines) {
      if (!l.itemId || !l.warehouseId) continue;
      const w = await this.inventory.warehouse(user.organisationId, l.warehouseId, doc.entityId, session);
      out.set(l.lineNo, w.branchId);
    }
    return out;
  }

  /**
   * Moves stock for the document's stock lines and returns the extra ledger lines:
   * sales issue at weighted-average cost (cost of sales vs inventory); credit notes return stock at
   * average cost; supplier credits issue at average cost with any price difference to cost of sales.
   * Purchased stock is received at the bill's cost, already debited to inventory on the bill line, unless
   * it was received on a goods received note: then the bill clears GRNI at the received value and the
   * difference is a price variance (to the stock still on hand, the rest to cost of sales).
   */
  private async applyStock(user: AuthUser, doc: Invoice, taxCodes: Map<string, TaxCode>, branches: Map<number, Types.ObjectId>, fp: number, session: ClientSession, po?: PurchaseOrder | null) {
    const kind = doc.kind as DocumentKind;
    const lines: LineInput[] = [];
    const costs = new Map<number, Decimal>();
    const grni = new Map<number, Decimal>();
    const moved = new Map<number, LotInput[]>();
    const rate = dec(doc.exchangeRate);
    const source = { type: 'Invoice', id: doc._id, number: doc.number };
    const line = (debit: boolean, accountId: Types.ObjectId, branchId: Types.ObjectId, amount: Decimal, description: string): LineInput => ({
      accountId,
      branchId,
      currency: doc.functionalCurrency,
      description,
      debit: debit ? amount : null,
      credit: debit ? null : amount,
      functionalDebit: debit ? amount : new Decimal(0),
      functionalCredit: debit ? new Decimal(0) : amount,
    });
    // Billed quantities per order line so far in this bill (one order line can be split across bill lines).
    const billing = new Map<number, { qty: Decimal; value: Decimal }>();
    for (const l of doc.lines) {
      const pol = kind === 'PURCHASE_BILL' && po && l.poLineNo != null ? po.lines.find((p) => p.lineNo === l.poLineNo && p.itemId) : undefined;
      if (pol) {
        // Received on a goods received note: the stock is already in; clear GRNI at the received value.
        const item = await this.inventory.item(user.organisationId, pol.itemId!, session);
        const so = billing.get(pol.lineNo) ?? { qty: new Decimal(0), value: new Decimal(0) };
        const qty = dec(l.quantity);
        const received = dec(pol.quantityReceived);
        const billed = dec(pol.quantityBilled).plus(so.qty);
        if (qty.gt(received.minus(billed))) throw new BadRequestException(`Line ${l.lineNo}: ${item.code} can only be billed once received; ${received.minus(billed).toFixed()} received and not yet billed`);
        const clearedBefore = dec(pol.billedValue).plus(so.value);
        const clear = qty.eq(received.minus(billed)) ? dec(pol.receivedValue).minus(clearedBefore) : round(dec(pol.receivedValue).div(received).times(qty), fp);
        billing.set(pol.lineNo, { qty: so.qty.plus(qty), value: so.value.plus(clear) });
        grni.set(l.lineNo, clear);
        const code = l.taxCodeId ? taxCodes.get(l.taxCodeId.toHexString()) : undefined;
        const lineCost = round(dec(l.netAmount).plus(code && !code.inputAccountId ? dec(l.taxAmount) : 0).times(rate), fp);
        const debitBranch = branches.get(l.lineNo) ?? doc.branchId;
        const wh = await this.inventory.warehouse(user.organisationId, pol.warehouseId!, doc.entityId, session);
        const org = await this.db.organisations.findById(user.organisationId).session(session).lean();
        if (!org?.settings?.grniAccountId) throw new BadRequestException('Set the goods received not invoiced account in Organisation settings');
        // Undo the bill line's debit and clear GRNI instead.
        if (!lineCost.isZero()) lines.push(line(false, l.accountId, debitBranch, lineCost, `${item.code} received on goods received note`));
        if (!clear.isZero()) lines.push({ ...line(true, org.settings.grniAccountId, doc.branchId, clear, `Received not invoiced cleared: ${po!.number}`), partyType: 'SUPPLIER', partyId: doc.partyId });
        const variance = lineCost.minus(clear);
        if (!variance.isZero()) {
          const { applied, remainder } = await this.inventory.revalue(user, { entityId: doc.entityId, itemId: item._id, warehouseId: pol.warehouseId!, date: doc.date, type: 'PURCHASE', value: variance, basisQuantity: qty, source }, session);
          if (!applied.isZero()) lines.push(line(applied.gt(0), item.inventoryAccountId!, wh.branchId, applied.abs(), `Purchase price variance on ${item.code}`));
          if (!remainder.isZero()) lines.push(line(remainder.gt(0), item.cogsAccountId!, doc.branchId, remainder.abs(), `Purchase price variance on ${item.code} (already sold)`));
        }
        continue;
      }
      if (!l.itemId || !l.warehouseId) continue;
      const item = await this.inventory.item(user.organisationId, l.itemId, session);
      if (item.type !== 'STOCK') continue;
      const qty = dec(l.quantity);
      const wb = branches.get(l.lineNo)!;
      const code = l.taxCodeId ? taxCodes.get(l.taxCodeId.toHexString()) : undefined;
      const lineCost = round(dec(l.netAmount).plus(code && !code.inputAccountId ? dec(l.taxAmount) : 0).times(rate), fp);
      const foreign = doc.currency !== doc.functionalCurrency ? { currency: doc.currency, value: dec(l.netAmount).plus(code && !code.inputAccountId ? dec(l.taxAmount) : 0) } : null;
      const move = async (quantity: Decimal, type: 'SALE' | 'SALES_RETURN' | 'PURCHASE' | 'PURCHASE_RETURN', value?: Decimal) => {
        const res = await this.inventory.move(user, { entityId: doc.entityId, itemId: item._id, warehouseId: l.warehouseId!, date: doc.date, type, quantity, value, lots: lotInputs(l.lots), foreign: type === 'PURCHASE' ? foreign : null, source }, session);
        if (res.lots.length) moved.set(l.lineNo, res.lots);
        return res;
      };
      if (kind === 'SALES_INVOICE') {
        const { value } = await move(qty.neg(), 'SALE');
        const cost = value.abs();
        costs.set(l.lineNo, cost);
        if (!cost.isZero()) lines.push(line(true, item.cogsAccountId!, doc.branchId, cost, `Cost of ${item.code} sold`), line(false, item.inventoryAccountId!, wb, cost, `${item.code} issued`));
      } else if (kind === 'SALES_CREDIT') {
        const { value } = await move(qty, 'SALES_RETURN');
        costs.set(l.lineNo, value.neg());
        if (!value.isZero()) lines.push(line(true, item.inventoryAccountId!, wb, value, `${item.code} returned`), line(false, item.cogsAccountId!, doc.branchId, value, `Cost of ${item.code} returned`));
      } else if (kind === 'PURCHASE_BILL') {
        await move(qty, 'PURCHASE', lineCost);
      } else {
        const { value } = await move(qty.neg(), 'PURCHASE_RETURN');
        // The credit reduces inventory by its amount; stock leaves at average cost; the difference is a price variance.
        const variance = lineCost.minus(value.abs());
        if (!variance.isZero()) {
          const up = variance.gt(0);
          lines.push(line(up, item.inventoryAccountId!, wb, variance.abs(), `${item.code} return at average cost`), line(!up, item.cogsAccountId!, doc.branchId, variance.abs(), `Purchase price variance on ${item.code}`));
        }
      }
    }
    return { lines, costs, grni, lots: moved };
  }

  private async updateBilledQuantities(po: PurchaseOrder, lines: (Pick<DocumentLine, 'poLineNo' | 'quantity'> & { grniValue?: unknown })[], sign: 1 | -1, session: ClientSession) {
    const updated = po.lines.map((pol) => {
      const mine = lines.filter((l) => l.poLineNo === pol.lineNo);
      const billed = mine.reduce((a, l) => a.plus(dec(l.quantity)), new Decimal(0));
      const value = mine.reduce((a, l) => a.plus(dec(l.grniValue as never)), new Decimal(0));
      return { ...pol, quantityBilled: toD128(dec(pol.quantityBilled).plus(billed.times(sign))), ...(pol.itemId && { billedValue: toD128(dec(pol.billedValue).plus(value.times(sign))) }) };
    });
    await this.db.purchaseOrders.updateOne({ _id: po._id }, { lines: updated }, { session });
  }

  /** Voids a posted document by reversing its journal and tax. Allocations must be reversed first. */
  async void(user: AuthUser, id: Types.ObjectId, date: Date, reason: string) {
    return this.db.transaction(async (session) => {
      const doc = await this.load(user, id, session);
      const kind = doc.kind as DocumentKind;
      requirePermission(user, PARTY_OF[kind], 'approve');
      if (doc.status !== 'POSTED') throw new BadRequestException('Only posted documents can be voided');
      const active = await this.db.allocations.countDocuments({ organisationId: user.organisationId, status: 'ACTIVE', $or: [{ documentId: id }, { sourceId: id }] }).session(session);
      if (active) throw new BadRequestException(`${doc.number} has ${active} allocation(s); reverse them before voiding`);
      const refund = await this.db.refunds.findOne({ 'sources.id': id, status: 'POSTED' }, { number: 1 }).session(session).lean();
      if (refund) throw new BadRequestException(`${doc.number} was refunded on ${refund.number}; void the refund first`);
      if (date < doc.date) throw new BadRequestException('The void date cannot be before the document date');
      const reversal = await this.journals.reverseSystemJournal(user, doc.journalId!, date, `Void of ${doc.number}: ${reason}`, session);
      await this.inventory.reverseSource(user, doc._id, reversal.journalDate, session);
      await this.tax.reverse(user.organisationId, doc._id, reversal.journalDate, reversal._id, session);
      if (doc.purchaseOrderId) {
        const po = await this.db.purchaseOrders.findById(doc.purchaseOrderId).session(session).lean();
        if (po) await this.updateBilledQuantities(po, doc.lines, -1, session);
      }
      const after = await transition(
        this.db.invoices,
        id,
        ['POSTED'],
        {
          status: 'VOID',
          voidedBy: user.id,
          voidedAt: new Date(),
          voidReason: reason,
          voidJournalId: reversal._id,
          amountDue: toD128(0),
          amountDueFunctional: toD128(0),
        },
        session,
      );
      await this.audit.log(user, { action: 'document.void', recordType: 'Invoice', recordId: id, summary: `Voided ${doc.number} with ${reversal.number}: ${reason}` }, session);
      return after;
    });
  }
}
