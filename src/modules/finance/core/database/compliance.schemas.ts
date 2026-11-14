import { InferSchemaType, Schema, Types } from 'mongoose';

/**
 * Phase 10 (Kenya compliance) data model: KRA eTIMS devices (one Online Sales Control Unit per branch),
 * the items registered with KRA, and the queue of sales documents reported to KRA.
 */

const ObjectId = Schema.Types.ObjectId;
const options = { timestamps: true, versionKey: false } as const;

/** A branch's connection to KRA eTIMS (OSCU). */
export const EtimsDeviceSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    enabled: { type: Boolean, default: false },
    environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    /** KRA PIN of the taxpayer (e.g. P051234567A). */
    tin: { type: String, required: true },
    /** KRA branch office ID ("00" is the head office). */
    bhfId: { type: String, required: true },
    /** Device serial issued by KRA when the OSCU was approved. */
    dvcSrlNo: { type: String, required: true },
    /** Communication key returned by initialisation, encrypted. Re-initialising invalidates it. */
    cmcKey: { type: String, default: null },
    sdcId: { type: String, default: '' },
    mrcNo: { type: String, default: '' },
    tradeName: { type: String, default: '' },
    initialisedAt: { type: Date, default: null },
    /** The last invoice number sent to KRA: numbers run 1, 2, 3... per branch with no gaps. */
    lastInvcNo: { type: Number, default: 0 },
    /** Sequence for generated KRA item codes. */
    lastItemSeq: { type: Number, default: 0 },
    /** Purchases: the last purchase number reported to KRA, and how far supplier invoices have been fetched. */
    lastPurchaseInvcNo: { type: Number, default: 0 },
    lastPurchaseFetch: { type: String, default: '20200101000000' },
    purchasesFetchedAt: { type: Date, default: null },
    /** Imports: how far customs-declared items have been fetched. */
    lastImportFetch: { type: String, default: '20200101000000' },
    importsFetchedAt: { type: Date, default: null },
    /** Stock: movements from this time on are reported; the cursor is the last movement collected. */
    stockReportFrom: { type: Date, default: null },
    stockCursor: { type: ObjectId, default: null },
    lastSarNo: { type: Number, default: 0 },
    /** Classification used for lines whose item has none (a KRA item classification code). */
    defaultItemClassCode: { type: String, default: '' },
    /** eTIMS tax type for lines without a tax code (D: non-VAT). */
    defaultTaxType: { type: String, enum: ['A', 'B', 'C', 'D', 'E'], default: 'D' },
    lastError: { type: String, default: '' },
  },
  options,
);
EtimsDeviceSchema.index({ organisationId: 1, branchId: 1 }, { unique: true });

/** A product or service registered with KRA under an eTIMS item code (KRA requires this before sale). */
export const EtimsItemSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    deviceId: { type: ObjectId, required: true },
    /** What it stands for: an inventory item, or a revenue account for service lines. */
    key: { type: String, required: true },
    itemCd: { type: String, required: true },
    itemClsCd: { type: String, required: true },
    itemNm: { type: String, required: true },
    itemTyCd: { type: String, enum: ['1', '2', '3'], required: true },
    taxTyCd: { type: String, required: true },
    registeredAt: { type: Date, default: null },
  },
  options,
);
EtimsItemSchema.index({ deviceId: 1, key: 1, taxTyCd: 1 }, { unique: true });
EtimsItemSchema.index({ deviceId: 1, itemCd: 1 }, { unique: true });

export const ETIMS_STATUSES = ['PENDING', 'SENT', 'FAILED', 'CANCELLED'] as const;

/** A posted sales invoice or credit note on its way to KRA. Sent in order per device. */
export const EtimsSubmissionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    deviceId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    invoiceId: { type: ObjectId, required: true },
    documentNumber: { type: String, required: true },
    kind: { type: String, enum: ['SALE', 'CREDIT'], required: true },
    status: { type: String, enum: ETIMS_STATUSES, default: 'PENDING' },
    /** Assigned when first transmitted and reused on every retry. */
    invcNo: { type: Number, default: null },
    orgInvcNo: { type: Number, default: null },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    resultCd: { type: String, default: null },
    lastError: { type: String, default: '' },
    /** KRA's answer, printed on the document. */
    curRcptNo: { type: Number, default: null },
    totRcptNo: { type: Number, default: null },
    intrlData: { type: String, default: null },
    rcptSign: { type: String, default: null },
    sdcDateTime: { type: String, default: null },
    sentAt: { type: Date, default: null },
  },
  options,
);
EtimsSubmissionSchema.index({ invoiceId: 1 }, { unique: true });
EtimsSubmissionSchema.index({ deviceId: 1, status: 1, createdAt: 1 });
EtimsSubmissionSchema.index({ organisationId: 1, status: 1, createdAt: -1 });

export const ETIMS_PURCHASE_STATUSES = ['RECEIVED', 'MATCHED', 'ACCEPTED', 'REJECTED'] as const;

/**
 * A sales invoice a supplier registered in eTIMS against our PIN. It is matched to (or becomes) a supplier
 * bill, and our acceptance or rejection is reported back to KRA. Input VAT is claimable only on these.
 */
export const EtimsPurchaseSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    deviceId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    supplierTin: { type: String, required: true },
    supplierName: { type: String, default: '' },
    supplierBhfId: { type: String, default: '' },
    /** The supplier's eTIMS invoice number. */
    supplierInvcNo: { type: String, required: true },
    receiptType: { type: String, default: 'S' },
    paymentType: { type: String, default: null },
    date: { type: Date, required: true },
    confirmedAt: { type: String, default: null },
    taxableAmount: { type: Schema.Types.Decimal128, required: true },
    taxAmount: { type: Schema.Types.Decimal128, required: true },
    totalAmount: { type: Schema.Types.Decimal128, required: true },
    /** KRA's line detail, kept as sent. */
    items: { type: [Schema.Types.Mixed], default: [] },
    raw: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: ETIMS_PURCHASE_STATUSES, default: 'RECEIVED' },
    supplierId: { type: ObjectId, default: null },
    billId: { type: ObjectId, default: null },
    rejectionReason: { type: String, default: '' },
    /** Reporting our decision to KRA (insertTrnsPurchase). */
    report: {
      status: { type: String, enum: ['NONE', 'PENDING', 'SENT', 'FAILED'], default: 'NONE' },
      invcNo: { type: Number, default: null },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
      sentAt: { type: Date, default: null },
    },
  },
  options,
);
EtimsPurchaseSchema.index({ deviceId: 1, supplierTin: 1, supplierInvcNo: 1, receiptType: 1 }, { unique: true });
EtimsPurchaseSchema.index({ organisationId: 1, status: 1, date: -1 });
EtimsPurchaseSchema.index({ billId: 1 }, { sparse: true });
EtimsPurchaseSchema.index({ deviceId: 1, 'report.status': 1, updatedAt: 1 });

/** KRA stock in/out type codes for our movement types. */
export const SAR_TYPES = {
  IMPORT: '01',
  PURCHASE: '02',
  RETURN_IN: '03',
  TRANSFER_IN: '04',
  ADJUSTMENT_IN: '06',
  SALE: '11',
  RETURN_OUT: '12',
  TRANSFER_OUT: '13',
  ADJUSTMENT_OUT: '16',
} as const;

/** One stock movement report (insertStockIO): a source document's movements at a branch, in or out. */
export const EtimsStockReportSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    deviceId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    sourceType: { type: String, required: true },
    sourceId: { type: ObjectId, required: true },
    sourceNumber: { type: String, required: true },
    sarTyCd: { type: String, required: true },
    date: { type: Date, required: true },
    movementIds: { type: [ObjectId], default: [] },
    /** Per item: quantity (positive) and value at cost, in KES. */
    lines: {
      type: [new Schema({ itemId: { type: ObjectId, required: true }, quantity: { type: Schema.Types.Decimal128, required: true }, value: { type: Schema.Types.Decimal128, required: true } }, { _id: false })],
      default: [],
    },
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING' },
    sarNo: { type: Number, default: null },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError: { type: String, default: '' },
    sentAt: { type: Date, default: null },
  },
  options,
);
EtimsStockReportSchema.index({ deviceId: 1, sourceId: 1, sarTyCd: 1 });
EtimsStockReportSchema.index({ deviceId: 1, status: 1, createdAt: 1 });
EtimsStockReportSchema.index({ organisationId: 1, status: 1, createdAt: -1 });

export const ETIMS_IMPORT_STATUSES = ['RECEIVED', 'APPROVED', 'REJECTED'] as const;

/**
 * An item declared at customs for our PIN (KRA lists these after clearance). We map it to our own
 * item and the supplier bill that receives it, then approve or reject it with KRA; stock received on that
 * bill is then reported to KRA as an import.
 */
export const EtimsImportSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    deviceId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    /** KRA's task code and the customs declaration. */
    taskCd: { type: String, required: true },
    declarationNumber: { type: String, default: '' },
    declarationDate: { type: String, required: true },
    itemSeq: { type: Number, required: true },
    hsCode: { type: String, default: '' },
    itemName: { type: String, required: true },
    originCountry: { type: String, default: '' },
    exportCountry: { type: String, default: '' },
    quantity: { type: Number, required: true },
    quantityUnit: { type: String, default: '' },
    packages: { type: Number, default: null },
    packageUnit: { type: String, default: '' },
    grossWeight: { type: Number, default: null },
    netWeight: { type: Number, default: null },
    supplierName: { type: String, default: '' },
    agentName: { type: String, default: '' },
    invoiceAmount: { type: Number, default: null },
    invoiceCurrency: { type: String, default: '' },
    invoiceExchangeRate: { type: Number, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: ETIMS_IMPORT_STATUSES, default: 'RECEIVED' },
    itemId: { type: ObjectId, default: null },
    billId: { type: ObjectId, default: null },
    rejectionReason: { type: String, default: '' },
    decidedBy: { type: ObjectId, default: null },
    report: {
      status: { type: String, enum: ['NONE', 'PENDING', 'SENT', 'FAILED'], default: 'NONE' },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
      sentAt: { type: Date, default: null },
    },
  },
  options,
);
EtimsImportSchema.index({ deviceId: 1, taskCd: 1, declarationDate: 1, itemSeq: 1 }, { unique: true });
EtimsImportSchema.index({ organisationId: 1, status: 1, createdAt: -1 });
EtimsImportSchema.index({ billId: 1 }, { sparse: true });
EtimsImportSchema.index({ deviceId: 1, 'report.status': 1, updatedAt: 1 });

export const COMPLIANCE_MODELS = {
  EtimsImport: EtimsImportSchema,
  EtimsStockReport: EtimsStockReportSchema,
  EtimsPurchase: EtimsPurchaseSchema,
  EtimsDevice: EtimsDeviceSchema,
  EtimsItem: EtimsItemSchema,
  EtimsSubmission: EtimsSubmissionSchema,
} as const;

type WithId<T> = T & { _id: Types.ObjectId };
export type EtimsDevice = WithId<InferSchemaType<typeof EtimsDeviceSchema>>;
export type EtimsItem = WithId<InferSchemaType<typeof EtimsItemSchema>>;
export type EtimsPurchase = WithId<InferSchemaType<typeof EtimsPurchaseSchema>>;
export type EtimsImport = WithId<InferSchemaType<typeof EtimsImportSchema>>;
export type EtimsStockReport = WithId<InferSchemaType<typeof EtimsStockReportSchema>>;
export type EtimsSubmission = WithId<InferSchemaType<typeof EtimsSubmissionSchema>>;
