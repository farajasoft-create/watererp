import { InferSchemaType, Schema, Types } from 'mongoose';

/**
 * Phase 4 (operational finance) data model: inventory, fixed assets, expense claims and budgets.
 * Every collection is tenant-scoped by organisationId.
 */

const ObjectId = Schema.Types.ObjectId;
const Decimal128 = Schema.Types.Decimal128;
const options = { timestamps: true, versionKey: false } as const;
const money = { type: Decimal128, required: true };

const workflow = {
  createdBy: { type: ObjectId, required: true },
  submittedBy: { type: ObjectId, default: null },
  submittedAt: { type: Date, default: null },
  approvedBy: { type: ObjectId, default: null },
  approvedAt: { type: Date, default: null },
  rejectedBy: { type: ObjectId, default: null },
  rejectedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: '' },
};

export const ITEM_TYPES = ['STOCK', 'SERVICE', 'NON_STOCK'] as const;
export const ITEM_TRACKING = ['NONE', 'BATCH', 'SERIAL'] as const;
export type ItemTracking = (typeof ITEM_TRACKING)[number];

/** A batch or serial number on a document line or movement. Movements store signed quantities. */
export const LotSpecSchema = new Schema(
  {
    number: { type: String, required: true },
    expiryDate: { type: Date, default: null },
    quantity: money,
  },
  { _id: false },
);

export const STOCK_MOVEMENT_TYPES = ['OPENING', 'PURCHASE', 'SALE', 'SALES_RETURN', 'PURCHASE_RETURN', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'REVERSAL', 'LANDED_COST', 'ISSUE'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export const DEPRECIATION_METHODS = ['STRAIGHT_LINE', 'REDUCING_BALANCE'] as const;
export const ASSET_STATUSES = ['ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED'] as const;
export const ASSET_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'UNSERVICEABLE'] as const;
export const ASSET_ACQUISITION_TYPES = ['PURCHASED', 'DONATED', 'CONSTRUCTED', 'TRANSFERRED_IN'] as const;
export const MAINTENANCE_KINDS = ['SERVICE', 'REPAIR', 'INSPECTION', 'INSURANCE_CLAIM'] as const;
export const CLAIM_STATUSES = ['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'PAID'] as const;
export const BUDGET_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

export const ItemSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ITEM_TYPES, default: 'STOCK' },
    category: { type: String, default: '' },
    /** Place in the multi-level category tree; `category` then holds the full path for display. */
    categoryId: { type: ObjectId, default: null },
    /** Barcode or QR value printed on the shelf label or the product, scanned at issue and counts. */
    barcode: { type: String, default: null },
    unit: { type: String, default: 'each' },
    /** KRA eTIMS item classification code, when the item is sold from an eTIMS branch. */
    etimsClassCode: { type: String, default: '' },
    /** Stock items: asset account holding inventory, and cost-of-sales account charged on sale. */
    inventoryAccountId: { type: ObjectId, default: null },
    cogsAccountId: { type: ObjectId, default: null },
    /** Defaults for document lines. */
    salesAccountId: { type: ObjectId, default: null },
    purchaseAccountId: { type: ObjectId, default: null },
    salesTaxCodeId: { type: ObjectId, default: null },
    purchaseTaxCodeId: { type: ObjectId, default: null },
    salesPrice: { type: Decimal128, default: null },
    /** Selling prices in other currencies (invoices in that currency default to them). */
    prices: {
      type: [new Schema({ currency: { type: String, required: true }, price: money }, { _id: false })],
      default: [],
    },
    reorderLevel: { type: Decimal128, default: null },
    /** How issues are costed: weighted average (default), first in first out, or last in first out. */
    valuation: { type: String, enum: ['AVERAGE', 'FIFO', 'LIFO'], default: 'AVERAGE' },
    /** Quantity to requisition when stock falls below the re-order level (blank: back up to twice the level). */
    reorderQty: { type: Decimal128, default: null },
    /** The last requisition raised automatically for this item, so a second one is not raised while it is open. */
    lastAutoRequisition: { type: new Schema({ id: ObjectId, number: String, at: Date }, { _id: false }), default: null },
    /** Stock items: tracked by batch (optionally with expiry dates) or by serial number. */
    tracking: { type: String, enum: ITEM_TRACKING, default: 'NONE' },
    trackExpiry: { type: Boolean, default: false },
    /** Last purchase price, in the currency it was bought in. */
    lastPurchase: {
      type: new Schema({ currency: String, unitPrice: Decimal128, date: Date }, { _id: false }),
      default: null,
    },
    isActive: { type: Boolean, default: true },
  },
  options,
);
ItemSchema.index({ organisationId: 1, code: 1 }, { unique: true });
ItemSchema.index({ organisationId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } });

/** Multi-level item categories (e.g. Chemicals → Coagulants → Aluminium sulphate). */
export const ItemCategorySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    parentId: { type: ObjectId, default: null },
    isActive: { type: Boolean, default: true },
  },
  options,
);
ItemCategorySchema.index({ organisationId: 1, code: 1 }, { unique: true });
export type ItemCategory = WithId<InferSchemaType<typeof ItemCategorySchema>>;

export const WarehouseSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  options,
);
WarehouseSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** Quantity and value on hand per item and warehouse (weighted average cost = value / quantity). */
export const StockBalanceSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    itemId: { type: ObjectId, required: true },
    warehouseId: { type: ObjectId, required: true },
    quantity: money,
    value: money,
    lastReceiptDate: { type: Date, default: null },
  },
  { versionKey: false, timestamps: { createdAt: false, updatedAt: true } },
);
StockBalanceSchema.index({ organisationId: 1, itemId: 1, warehouseId: 1 }, { unique: true });

/** Immutable stock ledger: every change in quantity and value, linked to its source. */
export const StockMovementSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    itemId: { type: ObjectId, required: true },
    warehouseId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    type: { type: String, enum: STOCK_MOVEMENT_TYPES, required: true },
    /** Signed: receipts positive, issues negative. */
    quantity: money,
    value: money,
    unitCost: money,
    balanceQuantity: money,
    balanceValue: money,
    sourceType: { type: String, required: true },
    sourceId: { type: ObjectId, required: true },
    sourceNumber: { type: String, required: true },
    reversedById: { type: ObjectId, default: null },
    /** Batches or serials moved, with signed quantities. */
    lots: { type: [LotSpecSchema], default: [] },
    /** Purchases in another currency: what was paid, in that currency. */
    foreignCurrency: { type: String, default: null },
    foreignValue: { type: Decimal128, default: null },
    createdBy: { type: ObjectId, required: true },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
StockMovementSchema.index({ organisationId: 1, itemId: 1, date: 1 });
StockMovementSchema.index({ organisationId: 1, sourceId: 1 });
StockMovementSchema.index({ organisationId: 1, itemId: 1, 'lots.number': 1 });

/** Quantity on hand per batch or serial number, item and warehouse. */
export const StockLotSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    itemId: { type: ObjectId, required: true },
    warehouseId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    expiryDate: { type: Date, default: null },
    quantity: money,
    receivedDate: { type: Date, required: true },
  },
  { versionKey: false, timestamps: true },
);
StockLotSchema.index({ organisationId: 1, itemId: 1, warehouseId: 1, number: 1 }, { unique: true });
StockLotSchema.index({ organisationId: 1, itemId: 1, number: 1 });
StockLotSchema.index({ organisationId: 1, entityId: 1, expiryDate: 1 });

/** Stock adjustments (counts, write-offs) and transfers between warehouses, approved before posting. */
export const StockDocumentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    kind: { type: String, enum: ['ADJUSTMENT', 'TRANSFER'], required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    reason: { type: String, required: true },
    /** Adjustments: the account charged or credited for the change in value. */
    adjustmentAccountId: { type: ObjectId, default: null },
    warehouseId: { type: ObjectId, required: true },
    toWarehouseId: { type: ObjectId, default: null },
    lines: {
      type: [
        new Schema(
          {
            itemId: { type: ObjectId, required: true },
            /** Adjustments: signed change in quantity. Transfers: quantity moved. */
            quantity: money,
            /** Adjustments that add stock: unit cost of the stock found (defaults to average cost). */
            unitCost: { type: Decimal128, default: null },
            value: { type: Decimal128, default: null },
            /** Batch or serial numbers for tracked items (quantities positive). */
            lots: { type: [LotSpecSchema], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'REJECTED', 'POSTED'], default: 'DRAFT' },
    journalId: { type: ObjectId, default: null },
    ...workflow,
  },
  options,
);
StockDocumentSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Fixed assets
// ---------------------------------------------------------------------------------------------

export const AssetCategorySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    assetAccountId: { type: ObjectId, required: true },
    accumulatedDepreciationAccountId: { type: ObjectId, required: true },
    depreciationExpenseAccountId: { type: ObjectId, required: true },
    disposalAccountId: { type: ObjectId, required: true },
    method: { type: String, enum: DEPRECIATION_METHODS, default: 'STRAIGHT_LINE' },
    usefulLifeMonths: { type: Number, default: 60 },
    /** Reducing balance: annual rate in percent. */
    annualRatePercent: { type: Decimal128, default: null },
    residualPercent: { type: Decimal128, default: null },
    isActive: { type: Boolean, default: true },
  },
  options,
);
AssetCategorySchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const FixedAssetSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    categoryId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    serialNumber: { type: String, default: '' },
    location: { type: String, default: '' },
    /** The label stuck on the asset (printed as a QR code); defaults to the asset number. */
    tagNumber: { type: String, default: '' },
    /** Who holds or is answerable for the asset. */
    custodian: { type: String, default: '' },
    condition: { type: String, enum: ASSET_CONDITIONS, default: 'GOOD' },
    acquisitionType: { type: String, enum: ASSET_ACQUISITION_TYPES, default: 'PURCHASED' },
    /** Donated or grant-funded assets: who gave it. */
    donor: { type: String, default: '' },
    supplierName: { type: String, default: '' },
    makeModel: { type: String, default: '' },
    /** Payment voucher (or LPO) the asset was paid on, for the National Treasury register. */
    pvNumber: { type: String, default: '' },
    deliveryDate: { type: Date, default: null },
    originalLocation: { type: String, default: '' },
    warranty: {
      provider: { type: String, default: '' },
      expiresOn: { type: Date, default: null },
      terms: { type: String, default: '' },
    },
    insurance: {
      insurer: { type: String, default: '' },
      policyNumber: { type: String, default: '' },
      sumInsured: { type: Decimal128, default: null },
      premium: { type: Decimal128, default: null },
      startsOn: { type: Date, default: null },
      expiresOn: { type: Date, default: null },
    },
    /** Servicing, repairs and inspections, with what they cost and the supplier bill that paid for them. */
    maintenance: {
      type: [
        new Schema({
          date: { type: Date, required: true },
          kind: { type: String, enum: MAINTENANCE_KINDS, required: true },
          description: { type: String, required: true },
          vendor: { type: String, default: '' },
          cost: money,
          invoiceId: { type: ObjectId, default: null },
          invoiceNumber: { type: String, default: '' },
          nextDue: { type: Date, default: null },
          recordedBy: { type: ObjectId, required: true },
        }),
      ],
      default: [],
    },
    /** Physical verification: the last time someone scanned the tag and confirmed where the asset is. */
    lastVerified: {
      date: { type: Date, default: null },
      by: { type: ObjectId, default: null },
      byName: { type: String, default: '' },
      location: { type: String, default: '' },
      condition: { type: String, default: '' },
    },
    departmentId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
    acquisitionDate: { type: Date, required: true },
    depreciationStart: { type: Date, required: true },
    cost: money,
    residualValue: money,
    method: { type: String, enum: DEPRECIATION_METHODS, required: true },
    usefulLifeMonths: { type: Number, required: true },
    annualRatePercent: { type: Decimal128, default: null },
    /** Depreciation already charged before the asset was registered (opening registers). */
    openingAccumulated: money,
    accumulatedDepreciation: money,
    depreciatedTo: { type: Date, default: null },
    status: { type: String, enum: ASSET_STATUSES, default: 'ACTIVE' },
    /** How the asset reached the ledger: posted now against a contra account, or already in it. */
    capitalisationJournalId: { type: ObjectId, default: null },
    sourceInvoiceId: { type: ObjectId, default: null },
    disposal: {
      date: { type: Date, default: null },
      proceeds: { type: Decimal128, default: null },
      gainLoss: { type: Decimal128, default: null },
      journalId: { type: ObjectId, default: null },
      reason: { type: String, default: '' },
    },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
FixedAssetSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
FixedAssetSchema.index({ organisationId: 1, entityId: 1, status: 1 });
FixedAssetSchema.index({ organisationId: 1, tagNumber: 1 }, { unique: true, partialFilterExpression: { tagNumber: { $gt: '' } } });

export const DepreciationRunSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    periodEnd: { type: Date, required: true },
    lines: {
      type: [new Schema({ assetId: ObjectId, assetNumber: String, branchId: ObjectId, from: Date, to: Date, months: Number, amount: Decimal128 }, { _id: false })],
      default: [],
    },
    total: money,
    journalId: { type: ObjectId, default: null },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
DepreciationRunSchema.index({ organisationId: 1, entityId: 1, periodEnd: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Expense claims
// ---------------------------------------------------------------------------------------------

export const ExpenseCategorySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    accountId: { type: ObjectId, required: true },
    taxCodeId: { type: ObjectId, default: null },
    /** Policy: maximum per claim line in the entity's functional currency. Null means no limit. */
    limitPerLine: { type: Decimal128, default: null },
    requiresReceipt: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  options,
);
ExpenseCategorySchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const ExpenseClaimSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    claimantId: { type: ObjectId, required: true },
    claimantName: { type: String, required: true },
    title: { type: String, required: true },
    currency: { type: String, required: true },
    lines: {
      type: [
        new Schema(
          {
            lineNo: { type: Number, required: true },
            date: { type: Date, required: true },
            categoryId: { type: ObjectId, required: true },
            accountId: { type: ObjectId, required: true },
            description: { type: String, required: true },
            merchant: { type: String, default: '' },
            receiptReference: { type: String, default: '' },
            /** Functional-currency amount (what the claim reimburses). */
            amount: money,
            /** Spent in another currency: the receipt's currency and amount, and the rate used. */
            currency: { type: String, default: null },
            originalAmount: { type: Decimal128, default: null },
            exchangeRate: { type: Decimal128, default: null },
            taxCodeId: { type: ObjectId, default: null },
            taxAmount: money,
            departmentId: { type: ObjectId, default: null },
            projectId: { type: ObjectId, default: null },
            policyNotes: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    total: money,
    policyBreaches: { type: Number, default: 0 },
    status: { type: String, enum: CLAIM_STATUSES, default: 'DRAFT' },
    journalId: { type: ObjectId, default: null },
    payment: {
      date: { type: Date, default: null },
      bankAccountId: { type: ObjectId, default: null },
      reference: { type: String, default: '' },
      journalId: { type: ObjectId, default: null },
      paidBy: { type: ObjectId, default: null },
      /** Reimbursed from an account in another currency: what was paid in that currency, and the rate. */
      currency: { type: String, default: null },
      amount: { type: Decimal128, default: null },
      exchangeRate: { type: Decimal128, default: null },
    },
    ...workflow,
  },
  options,
);
ExpenseClaimSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
ExpenseClaimSchema.index({ organisationId: 1, claimantId: 1, status: 1 });

// ---------------------------------------------------------------------------------------------
// Staff imprest
// ---------------------------------------------------------------------------------------------

/**
 * Imprest life cycle: the applicant requests an advance, it is approved, finance issues the cash, and the
 * applicant surrenders it with receipts (and any cash left over). Overdue imprest is chased and, if still
 * unaccounted for, recovered through the payroll.
 */
export const IMPREST_STATUSES = ['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'ISSUED', 'SURRENDER_SUBMITTED', 'SURRENDERED', 'RECOVERING', 'CANCELLED'] as const;

/** Kinds of imprest (safari, special, standing), each with its own surrender period and ceiling. */
export const ImprestTypeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    /** Ceiling per imprest in functional currency; null means none. */
    maxAmount: { type: Decimal128, default: null },
    /** Days after the activity ends (or the issue date, if later) within which it must be surrendered. */
    surrenderDays: { type: Number, default: 7 },
    isActive: { type: Boolean, default: true },
  },
  options,
);
ImprestTypeSchema.index({ organisationId: 1, code: 1 }, { unique: true });

const imprestSpendLine = new Schema(
  {
    lineNo: { type: Number, required: true },
    date: { type: Date, required: true },
    categoryId: { type: ObjectId, required: true },
    accountId: { type: ObjectId, required: true },
    description: { type: String, required: true },
    receiptReference: { type: String, default: '' },
    amount: money,
    departmentId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
  },
  { _id: false },
);

export const ImprestSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    typeId: { type: ObjectId, required: true },
    typeName: { type: String, required: true },
    applicantId: { type: ObjectId, required: true },
    applicantName: { type: String, required: true },
    purpose: { type: String, required: true },
    destination: { type: String, default: '' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    departmentId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
    currency: { type: String, required: true },
    /** The estimate the advance is based on (per diem, fuel, fares...). */
    lines: { type: [new Schema({ description: { type: String, required: true }, amount: money }, { _id: false })], default: [] },
    amount: money,
    status: { type: String, enum: IMPREST_STATUSES, default: 'DRAFT' },
    /** Set when the advance is paid out. */
    surrenderDue: { type: Date, default: null },
    issue: {
      date: { type: Date, default: null },
      bankAccountId: { type: ObjectId, default: null },
      reference: { type: String, default: '' },
      journalId: { type: ObjectId, default: null },
      issuedBy: { type: ObjectId, default: null },
    },
    /** What the applicant accounts for: spending with receipts and cash handed back. */
    surrender: {
      date: { type: Date, default: null },
      lines: { type: [imprestSpendLine], default: [] },
      spent: { type: Decimal128, default: null },
      cashReturned: { type: Decimal128, default: null },
      refundBankAccountId: { type: ObjectId, default: null },
      refundReference: { type: String, default: '' },
      notes: { type: String, default: '' },
      submittedBy: { type: ObjectId, default: null },
      submittedAt: { type: Date, default: null },
      approvedBy: { type: ObjectId, default: null },
      approvedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: '' },
      journalId: { type: ObjectId, default: null },
    },
    /** Advance not yet accounted for (receipts, cash back or payroll recovery). */
    outstanding: { type: Decimal128, default: null },
    /** Spent beyond the advance, owed to the applicant, and its payment. */
    owedToApplicant: { type: Decimal128, default: null },
    balancePayment: {
      date: { type: Date, default: null },
      bankAccountId: { type: ObjectId, default: null },
      journalId: { type: ObjectId, default: null },
    },
    reminders: {
      count: { type: Number, default: 0 },
      lastAt: { type: Date, default: null },
    },
    /** Unaccounted imprest sent to payroll as a deduction. */
    recovery: {
      employeeId: { type: ObjectId, default: null },
      payItemId: { type: ObjectId, default: null },
      fromPeriod: { type: String, default: null },
      installment: { type: Decimal128, default: null },
      amount: { type: Decimal128, default: null },
      journalId: { type: ObjectId, default: null },
      by: { type: ObjectId, default: null },
      at: { type: Date, default: null },
    },
    ...workflow,
  },
  options,
);
ImprestSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
ImprestSchema.index({ organisationId: 1, applicantId: 1, status: 1 });
ImprestSchema.index({ organisationId: 1, status: 1, surrenderDue: 1 });

// ---------------------------------------------------------------------------------------------
// Budgets & forecasts
// ---------------------------------------------------------------------------------------------

const budgetLine = new Schema(
  {
    accountId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, default: null },
    departmentId: { type: ObjectId, default: null },
    projectId: { type: ObjectId, default: null },
    /** One amount per period of the fiscal year, in the account's natural direction. */
    amounts: { type: [Decimal128], default: [] },
  },
  { _id: false },
);

export const BudgetSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    fiscalYearId: { type: ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ['BUDGET', 'FORECAST'], default: 'BUDGET' },
    currency: { type: String, required: true },
    notes: { type: String, default: '' },
    lines: { type: [budgetLine], default: [] },
    total: money,
    status: { type: String, enum: BUDGET_STATUSES, default: 'DRAFT' },
    /** The lines as first approved, kept when changes alter them (original vs final budget). */
    original: {
      type: new Schema({ lines: { type: [budgetLine], default: [] }, total: money }, { _id: false }),
      default: null,
    },
    revisions: { type: Number, default: 0 },
    ...workflow,
  },
  options,
);
BudgetSchema.index({ organisationId: 1, entityId: 1, fiscalYearId: 1, kind: 1, status: 1 });

export const BUDGET_SUBMISSION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONSOLIDATED'] as const;

/** A department's budget proposal for a fiscal year, backed by its workplan, before consolidation. */
export const BudgetSubmissionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    fiscalYearId: { type: ObjectId, required: true },
    departmentId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    objectives: { type: String, default: '' },
    workplan: {
      type: [
        new Schema(
          {
            activity: { type: String, required: true, trim: true },
            output: { type: String, default: '' },
            indicator: { type: String, default: '' },
            target: { type: String, default: '' },
            /** Quarters (1-4) in which the activity runs. */
            quarters: { type: [Number], default: [] },
            cost: money,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    lines: { type: [budgetLine], default: [] },
    total: money,
    status: { type: String, enum: BUDGET_SUBMISSION_STATUSES, default: 'DRAFT' },
    budgetId: { type: ObjectId, default: null },
    consolidatedAt: { type: Date, default: null },
    ...workflow,
  },
  options,
);
BudgetSubmissionSchema.index({ organisationId: 1, entityId: 1, fiscalYearId: 1, departmentId: 1, status: 1 });
BudgetSubmissionSchema.index({ organisationId: 1, number: 1 }, { unique: true });

export const BUDGET_CHANGE_KINDS = ['REALLOCATION', 'SUPPLEMENTARY', 'REDUCTION'] as const;

/**
 * A change to an approved budget: a reallocation (virement) moves amounts between lines and nets to
 * zero; a supplementary budget adds and a reduction takes away. Applied to the budget on approval.
 */
export const BudgetReallocationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    budgetId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    kind: { type: String, enum: BUDGET_CHANGE_KINDS, required: true },
    reason: { type: String, required: true, trim: true },
    lines: {
      type: [
        new Schema(
          {
            accountId: { type: ObjectId, required: true },
            branchId: { type: ObjectId, default: null },
            departmentId: { type: ObjectId, default: null },
            projectId: { type: ObjectId, default: null },
            /** Zero-based period of the fiscal year. */
            period: { type: Number, required: true },
            /** Negative takes from the line, positive adds to it. */
            change: money,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    increase: money,
    decrease: money,
    status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'], default: 'DRAFT' },
    ...workflow,
  },
  options,
);
BudgetReallocationSchema.index({ organisationId: 1, budgetId: 1, status: 1 });
BudgetReallocationSchema.index({ organisationId: 1, number: 1 }, { unique: true });

/**
 * Landed cost: freight, duty and clearing charges (booked to a clearing account) added to the cost of the
 * stock received on the chosen goods received notes or bills, by value or quantity.
 */
export const LandedCostSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    clearingAccountId: { type: ObjectId, required: true },
    /** Functional currency. */
    amount: money,
    method: { type: String, enum: ['VALUE', 'QUANTITY'], required: true },
    receipts: {
      type: [new Schema({ type: { type: String, enum: ['GoodsReceipt', 'Invoice'], required: true }, id: { type: ObjectId, required: true }, number: String }, { _id: false })],
      default: [],
    },
    status: { type: String, enum: ['DRAFT', 'POSTED', 'REVERSED', 'CANCELLED'], default: 'DRAFT' },
    /** Set on posting: each item's share, how much went into stock and how much to cost of sales. */
    allocations: {
      type: [
        new Schema(
          { itemId: { type: ObjectId, required: true }, warehouseId: { type: ObjectId, required: true }, quantity: money, basisValue: money, amount: money, capitalised: money, expensed: money },
          { _id: false },
        ),
      ],
      default: [],
    },
    journalId: { type: ObjectId, default: null },
    postedBy: { type: ObjectId, default: null },
    postedAt: { type: Date, default: null },
    reversedBy: { type: ObjectId, default: null },
    reversedAt: { type: Date, default: null },
    reversalReason: { type: String, default: '' },
    reversalJournalId: { type: ObjectId, default: null },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
LandedCostSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
LandedCostSchema.index({ organisationId: 1, entityId: 1, date: -1 });

// ---------------------------------------------------------------------------------------------

type WithId<T> = T & { _id: Types.ObjectId };
export type Item = WithId<InferSchemaType<typeof ItemSchema>>;
export type Warehouse = WithId<InferSchemaType<typeof WarehouseSchema>>;
export type StockBalance = WithId<InferSchemaType<typeof StockBalanceSchema>>;
export type StockLot = WithId<InferSchemaType<typeof StockLotSchema>>;
export type StockMovement = WithId<InferSchemaType<typeof StockMovementSchema>>;
export type StockDocument = WithId<InferSchemaType<typeof StockDocumentSchema>>;
export type AssetCategory = WithId<InferSchemaType<typeof AssetCategorySchema>>;
export type FixedAsset = WithId<InferSchemaType<typeof FixedAssetSchema>>;
export type DepreciationRun = WithId<InferSchemaType<typeof DepreciationRunSchema>>;
export type ExpenseCategory = WithId<InferSchemaType<typeof ExpenseCategorySchema>>;
export type ExpenseClaim = WithId<InferSchemaType<typeof ExpenseClaimSchema>>;
export type ImprestType = WithId<InferSchemaType<typeof ImprestTypeSchema>>;
export type Imprest = WithId<InferSchemaType<typeof ImprestSchema>>;
export type Budget = WithId<InferSchemaType<typeof BudgetSchema>>;
export type BudgetSubmission = WithId<InferSchemaType<typeof BudgetSubmissionSchema>>;
export type BudgetReallocation = WithId<InferSchemaType<typeof BudgetReallocationSchema>>;
export type LandedCost = WithId<InferSchemaType<typeof LandedCostSchema>>;

// ---------------------------------------------------------------------------------------------
// Treasury: short-term investments
// ---------------------------------------------------------------------------------------------

export const INVESTMENT_TYPES = ['FIXED_DEPOSIT', 'CALL_DEPOSIT', 'TREASURY_BILL', 'TREASURY_BOND', 'MONEY_MARKET', 'OTHER'] as const;
export const INVESTMENT_STATUSES = ['DRAFT', 'SUBMITTED', 'REJECTED', 'ACTIVE', 'MATURED', 'CANCELLED'] as const;

export const InvestmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    type: { type: String, enum: INVESTMENT_TYPES, required: true },
    institution: { type: String, required: true, trim: true },
    reference: { type: String, default: '' },
    description: { type: String, default: '' },
    principal: money,
    /** Annual simple interest rate, per cent. */
    ratePercent: money,
    dayCount: { type: String, enum: ['ACT_365', 'ACT_360'], default: 'ACT_365' },
    startDate: { type: Date, required: true },
    maturityDate: { type: Date, required: true },
    /** Withholding tax deducted from interest at source, per cent. */
    withholdingPercent: { type: Decimal128, default: () => Types.Decimal128.fromString('0') },
    bankAccountId: { type: ObjectId, required: true },
    investmentAccountId: { type: ObjectId, required: true },
    interestIncomeAccountId: { type: ObjectId, required: true },
    interestReceivableAccountId: { type: ObjectId, required: true },
    withholdingAccountId: { type: ObjectId, default: null },
    status: { type: String, enum: INVESTMENT_STATUSES, default: 'DRAFT' },
    placementJournalId: { type: ObjectId, default: null },
    accruedInterest: { type: Decimal128, default: () => Types.Decimal128.fromString('0') },
    accruedTo: { type: Date, default: null },
    accruals: {
      type: [new Schema({ date: { type: Date, required: true }, amount: money, journalId: { type: ObjectId, required: true } }, { _id: false })],
      default: [],
    },
    settlement: {
      type: new Schema(
        {
          date: { type: Date, required: true },
          bankAccountId: { type: ObjectId, required: true },
          interest: money,
          withholding: money,
          net: money,
          journalId: { type: ObjectId, required: true },
          rolledOverToId: { type: ObjectId, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    rolledOverFromId: { type: ObjectId, default: null },
    maturityReminderAt: { type: Date, default: null },
    ...workflow,
  },
  options,
);
InvestmentSchema.index({ organisationId: 1, entityId: 1, status: 1, maturityDate: 1 });
InvestmentSchema.index({ organisationId: 1, number: 1 }, { unique: true });
InvestmentSchema.index({ status: 1, maturityDate: 1 });

export type Investment = WithId<InferSchemaType<typeof InvestmentSchema>>;

// ---------------------------------------------------------------------------------------------
// Programme-based budgeting
// ---------------------------------------------------------------------------------------------

/**
 * A programme or sub-programme (parentId set): what it aims at, the delivery units (departments and
 * projects) whose budget and spending make it up, and the key performance indicators it reports on.
 */
export const ProgrammeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, default: null },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    parentId: { type: ObjectId, default: null },
    objective: { type: String, default: '' },
    outcome: { type: String, default: '' },
    departmentIds: { type: [ObjectId], default: [] },
    projectIds: { type: [ObjectId], default: [] },
    kpis: {
      type: [
        new Schema({
          indicator: { type: String, required: true, trim: true },
          unit: { type: String, default: '' },
          baseline: { type: String, default: '' },
          target: { type: String, default: '' },
          /** Achievement reported per fiscal year and quarter. */
          actuals: {
            type: [new Schema({ fiscalYearId: { type: ObjectId, required: true }, quarter: { type: Number, required: true }, value: { type: String, required: true }, note: { type: String, default: '' } }, { _id: false })],
            default: [],
          },
        }),
      ],
      default: [],
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
ProgrammeSchema.index({ organisationId: 1, code: 1 }, { unique: true });

export type Programme = WithId<InferSchemaType<typeof ProgrammeSchema>>;

// ---------------------------------------------------------------------------------------------
// Store requisitions: internal issues (S11), counter issues and branch dispatches
// ---------------------------------------------------------------------------------------------

export const STORE_REQUISITION_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ISSUED', 'DISPATCHED', 'RECEIVED', 'CANCELLED'] as const;

export const StoreRequisitionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    /** ISSUE: a department draws stock for use. BRANCH: a branch store is supplied from another store. */
    kind: { type: String, enum: ['ISSUE', 'BRANCH'], required: true },
    /** Issued over the counter on the spot by the storekeeper. */
    counter: { type: Boolean, default: false },
    date: { type: Date, required: true },
    purpose: { type: String, required: true, trim: true },
    /** The issuing store. */
    warehouseId: { type: ObjectId, required: true },
    /** BRANCH: the receiving store. */
    toWarehouseId: { type: ObjectId, default: null },
    departmentId: { type: ObjectId, default: null },
    lines: {
      type: [
        new Schema(
          {
            lineNo: { type: Number, required: true },
            itemId: { type: ObjectId, required: true },
            /** ISSUE: the expense account charged (defaults to the item's cost account). */
            accountId: { type: ObjectId, default: null },
            requested: money,
            approved: { type: Decimal128, default: null },
            issued: { type: Decimal128, default: null },
            received: { type: Decimal128, default: null },
            value: { type: Decimal128, default: null },
            lots: { type: [LotSpecSchema], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    status: { type: String, enum: STORE_REQUISITION_STATUSES, default: 'DRAFT' },
    issuedBy: { type: ObjectId, default: null },
    issuedAt: { type: Date, default: null },
    collectedBy: { type: String, default: '' },
    reference: { type: String, default: '' },
    receivedBy: { type: ObjectId, default: null },
    receivedAt: { type: Date, default: null },
    receiptNotes: { type: String, default: '' },
    journalIds: { type: [ObjectId], default: [] },
    ...workflow,
  },
  options,
);
StoreRequisitionSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
StoreRequisitionSchema.index({ organisationId: 1, status: 1, date: -1 });

export type StoreRequisition = WithId<InferSchemaType<typeof StoreRequisitionSchema>>;

/** Petty cash: the float held in a PETTY_CASH account and, per expense category, the most one voucher and one month may spend. */
export const PettyCashLimitSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    /** Null for the account-wide row that carries the float. */
    categoryId: { type: ObjectId, default: null },
    float: { type: Decimal128, default: null },
    perVoucher: { type: Decimal128, default: null },
    perMonth: { type: Decimal128, default: null },
  },
  { timestamps: true },
);
PettyCashLimitSchema.index({ organisationId: 1, bankAccountId: 1, categoryId: 1 }, { unique: true });

export const PETTY_CASH_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED'] as const;

/** A petty cash request raised online, approved, and paid out of the petty cash box. */
export const PettyCashVoucherSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    bankAccountId: { type: ObjectId, required: true },
    categoryId: { type: ObjectId, required: true },
    categoryName: { type: String, required: true },
    accountId: { type: ObjectId, required: true },
    currency: { type: String, required: true },
    amount: money,
    purpose: { type: String, required: true },
    payee: { type: String, default: '' },
    departmentId: { type: ObjectId, default: null },
    status: { type: String, enum: PETTY_CASH_STATUSES, default: 'SUBMITTED' },
    requesterId: { type: ObjectId, required: true },
    requesterName: { type: String, required: true },
    createdBy: { type: ObjectId, required: true },
    submittedBy: { type: ObjectId, default: null },
    approvedBy: { type: ObjectId, default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    paidBy: { type: ObjectId, default: null },
    paidAt: { type: Date, default: null },
    receiptReference: { type: String, default: '' },
    journalId: { type: ObjectId, default: null },
  },
  { timestamps: true },
);
PettyCashVoucherSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
PettyCashVoucherSchema.index({ organisationId: 1, bankAccountId: 1, categoryId: 1, createdAt: -1 });

export type PettyCashLimit = WithId<InferSchemaType<typeof PettyCashLimitSchema>>;
export type PettyCashVoucher = WithId<InferSchemaType<typeof PettyCashVoucherSchema>>;

export const SPONSORSHIP_KINDS = ['SPONSORSHIP', 'DONATION', 'CSR', 'BURSARY'] as const;
export const SPONSORSHIP_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED'] as const;

/** Sponsorships, donations, bursaries and CSR commitments: requested, approved, paid and reported on. */
export const SponsorshipSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    kind: { type: String, enum: SPONSORSHIP_KINDS, required: true },
    beneficiary: { type: String, required: true },
    beneficiaryContact: { type: String, default: '' },
    category: { type: String, default: 'COMMUNITY' },
    purpose: { type: String, required: true },
    eventDate: { type: Date, default: null },
    currency: { type: String, required: true },
    amount: money,
    /** In-kind support (water bowsers, branded items, staff time) described in words and valued. */
    inKind: { type: String, default: '' },
    inKindValue: { type: Decimal128, default: null },
    /** What the organisation gets: branding, airtime, a report, a certificate. */
    benefits: { type: String, default: '' },
    status: { type: String, enum: SPONSORSHIP_STATUSES, default: 'PROPOSED' },
    createdBy: { type: ObjectId, required: true },
    approvedBy: { type: ObjectId, default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
    paymentId: { type: ObjectId, default: null },
    paymentNumber: { type: String, default: '' },
    paidAt: { type: Date, default: null },
    /** Acknowledgement or accountability report received from the beneficiary. */
    acknowledgement: { type: String, default: '' },
  },
  options,
);
SponsorshipSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });

export type Sponsorship = WithId<InferSchemaType<typeof SponsorshipSchema>>;

/** An organisation's own wording for a standard email (RFQ, LPO, remittance advice). */
export const EmailTemplateSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    key: { type: String, required: true },
    subject: { type: String, required: true },
    intro: { type: String, default: '' },
    body: { type: String, default: '' },
    footer: { type: String, default: '' },
    updatedBy: { type: ObjectId, default: null },
  },
  options,
);
EmailTemplateSchema.index({ organisationId: 1, key: 1 }, { unique: true });
export type EmailTemplate = WithId<InferSchemaType<typeof EmailTemplateSchema>>;

/** FIFO/LIFO cost layers: what is left of each receipt of an item in a warehouse, at its unit cost. */
export const StockLayerSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    itemId: { type: ObjectId, required: true },
    warehouseId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    quantity: money,
    unitCost: money,
    sourceNumber: { type: String, default: '' },
  },
  options,
);
StockLayerSchema.index({ organisationId: 1, itemId: 1, warehouseId: 1, date: 1, createdAt: 1 });
export type StockLayer = WithId<InferSchemaType<typeof StockLayerSchema>>;

export const OPERATIONAL_MODELS = {
  StockLayer: StockLayerSchema,
  EmailTemplate: EmailTemplateSchema,
  ItemCategory: ItemCategorySchema,
  Sponsorship: SponsorshipSchema,
  PettyCashLimit: PettyCashLimitSchema,
  PettyCashVoucher: PettyCashVoucherSchema,
  StoreRequisition: StoreRequisitionSchema,
  Programme: ProgrammeSchema,
  Item: ItemSchema,
  Warehouse: WarehouseSchema,
  StockBalance: StockBalanceSchema,
  StockMovement: StockMovementSchema,
  StockLot: StockLotSchema,
  StockDocument: StockDocumentSchema,
  AssetCategory: AssetCategorySchema,
  FixedAsset: FixedAssetSchema,
  DepreciationRun: DepreciationRunSchema,
  ExpenseCategory: ExpenseCategorySchema,
  ExpenseClaim: ExpenseClaimSchema,
  ImprestType: ImprestTypeSchema,
  Imprest: ImprestSchema,
  Budget: BudgetSchema,
  BudgetSubmission: BudgetSubmissionSchema,
  BudgetReallocation: BudgetReallocationSchema,
  Investment: InvestmentSchema,
  LandedCost: LandedCostSchema,
} as const;
