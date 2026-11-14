import { InferSchemaType, Schema, Types } from 'mongoose';
import { ledgerSyncSchema as accountingSync, SYNC_STATUSES } from '@/platform/schemas';
import { READING_EXCEPTIONS } from './readings/consumption';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;

export const CUSTOMER_CATEGORIES = ['DOMESTIC', 'COMMERCIAL', 'INSTITUTIONAL', 'KIOSK', 'INDUSTRIAL', 'BULK'] as const;
export const CUSTOMER_STATUSES = ['APPLIED', 'APPROVED', 'ACTIVE', 'DISCONNECTED', 'CLOSED', 'REJECTED'] as const;
export const METER_STATUSES = ['IN_STORE', 'INSTALLED', 'FAULTY', 'REMOVED', 'SCRAPPED'] as const;
export const METER_TYPES = ['CUSTOMER', 'BULK', 'PRODUCTION'] as const;
export const CYCLE_STATUSES = ['OPEN', 'CLOSED', 'BILLED'] as const;
export const READING_TYPES = ['ACTUAL', 'ESTIMATED', 'CUSTOMER'] as const;
export const READING_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'BILLED'] as const;
export const BILL_RUN_STATUSES = ['DRAFT', 'APPROVING', 'APPROVED', 'CANCELLED'] as const;
export const PAYMENT_CHANNELS = ['MPESA', 'BANK', 'CASH', 'CHEQUE'] as const;
/** SPLIT: an M-Pesa or bank receipt shared between several accounts; the parts carry the money. */
export const PAYMENT_STATUSES = ['POSTED', 'UNMATCHED', 'REVERSED', 'SPLIT'] as const;
export const BILL_RUN_KINDS = ['REGULAR', 'SUPPLEMENTARY'] as const;
export const METER_TEST_RESULTS = ['PASS', 'FAIL'] as const;
export { SYNC_STATUSES };
export const DISCONNECTION_STATUSES = ['LISTED', 'NOTICE_SENT', 'DISCONNECTED', 'RECONNECTED', 'CANCELLED'] as const;
export const LEDGER_TYPES = ['OPENING', 'BILL', 'PAYMENT', 'ADJUSTMENT', 'PENALTY', 'RECONNECTION_FEE', 'REVERSAL'] as const;

/** Water settings of an organisation (one document each). */
export const waterSettingsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, unique: true },
    licenceArea: String,
    billing: {
      dueDays: { type: Number, default: 14 },
      penaltyPercent: { ...D128 },
      reconnectionFee: { ...D128 },
      disconnectionMinArrears: { ...D128 },
      disconnectionGraceDays: { type: Number, default: 30 },
      highFactor: { type: Number, default: 2 },
      lowFactor: { type: Number, default: 0.3 },
      paybill: String,
      billFooter: String,
      sendBillSms: { type: Boolean, default: false },
      emailBills: { type: Boolean, default: false },
      /** Text (and email) a receipt for every payment that reaches an account. */
      sendReceipts: { type: Boolean, default: false },
    },
    mpesa: {
      shortcode: String,
      /** Part of the C2B callback URL registered with Safaricom; identifies this organisation. */
      callbackToken: { type: String, index: { unique: true, partialFilterExpression: { 'mpesa.callbackToken': { $type: 'string' } } } },
    },
    /** Customer service: resolution targets, intake from outside systems and the self-service portal. */
    service: {
      /** Hours to resolve per complaint category; missing categories use DEFAULT_SLA_HOURS. */
      slaHours: { type: Schema.Types.Mixed, default: {} },
      /** Secret in the URLs given to the call centre, the SMS shortcode and the USSD gateway. */
      intakeToken: { type: String, index: { unique: true, partialFilterExpression: { 'service.intakeToken': { $type: 'string' } } } },
      portalEnabled: { type: Boolean, default: true },
      /** Resolved tickets close on their own after this many days without a reply. */
      autoCloseDays: { type: Number, default: 7 },
      /** Days after the due date when a reminder case is opened for an unpaid account. */
      reminderAfterDays: { type: Number, default: 14 },
      /**
       * Who new tickets go to: the most specific rule wins (category and zone, then category, then
       * zone). Tickets that match no rule wait for a supervisor to assign them.
       */
      routing: {
        type: [new Schema({ category: { type: String, default: null }, zoneId: { type: Schema.Types.ObjectId, default: null }, assignTo: { type: Schema.Types.ObjectId, required: true } }, { _id: false })],
        default: [],
      },
    },
    /** Figures for the WASREB indicators that the system cannot count itself. */
    regulatory: {
      populationInArea: Number,
      peoplePerConnection: { type: Number, default: 5 },
      peoplePerKiosk: { type: Number, default: 300 },
      staffCount: Number,
    },
    /** Ledger account ids that water transactions post to (see accounting/journals.ts). */
    accounts: { type: Schema.Types.Mixed, default: {} },
  },
  opts,
);

/** A supply zone, or a District Metered Area within one (for NRW). */
export const zoneSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ['ZONE', 'DMA'], default: 'ZONE' },
    parentId: { type: ObjectId, default: null },
    active: { type: Boolean, default: true },
  },
  opts,
);
zoneSchema.index({ organisationId: 1, code: 1 }, { unique: true });

const tariffBlock = new Schema({ upTo: { type: Decimal128, default: null }, rate: { ...D128 }, fixedAmount: { type: Decimal128, default: null } }, { _id: false });

export const tariffSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, enum: CUSTOMER_CATEGORIES, required: true },
    effectiveFrom: { type: Date, required: true },
    /** Gazette notice or WASREB approval reference. */
    approvalReference: String,
    blocks: { type: [tariffBlock], required: true },
    meterRent: { ...D128 },
    sewerPercent: { ...D128 },
    minimumCharge: { ...D128 },
    /** Units billed when a connection cannot be read and has no history. */
    defaultEstimate: { ...D128 },
    active: { type: Boolean, default: true },
  },
  opts,
);
tariffSchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const customerSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    accountNo: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, enum: CUSTOMER_CATEGORIES, required: true },
    idType: { type: String, enum: ['NATIONAL_ID', 'PASSPORT', 'ALIEN_ID', 'COMPANY_REG', 'OTHER'], default: 'NATIONAL_ID' },
    idNumber: String,
    kraPin: String,
    phone: String,
    altPhone: String,
    email: String,
    postalAddress: String,
    zoneId: { type: ObjectId, required: true },
    location: String,
    plotNo: String,
    gps: { lat: Number, lng: Number },
    tariffId: { type: ObjectId, required: true },
    sewered: { type: Boolean, default: false },
    status: { type: String, enum: CUSTOMER_STATUSES, default: 'APPLIED' },
    applicationDate: { type: Date, default: () => new Date() },
    connectionDate: Date,
    depositPaid: { ...D128 },
    meterId: { type: ObjectId, default: null },
    /** Running balance owed (positive) or in credit (negative); kept in step with the statement. */
    balance: { ...D128 },
    /** Due date of the oldest bill not yet fully paid; drives ageing and disconnection. */
    oldestUnpaidDueDate: { type: Date, default: null },
    kycVerified: { type: Boolean, default: false },
    notes: String,
    statusHistory: [{ status: String, at: Date, by: ObjectId, reason: String, _id: false }],
  },
  opts,
);
customerSchema.index({ organisationId: 1, accountNo: 1 }, { unique: true });
customerSchema.index({ organisationId: 1, zoneId: 1, status: 1 });
customerSchema.index({ organisationId: 1, phone: 1 });
customerSchema.index({ organisationId: 1, name: 'text', accountNo: 'text', plotNo: 'text' });

export const meterSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    serialNo: { type: String, required: true },
    make: String,
    sizeMm: { type: Number, default: 15 },
    dials: { type: Number, default: 5 },
    type: { type: String, enum: METER_TYPES, default: 'CUSTOMER' },
    status: { type: String, enum: METER_STATUSES, default: 'IN_STORE' },
    customerId: { type: ObjectId, default: null },
    /** Bulk and production meters measure the inflow to this zone. */
    zoneId: { type: ObjectId, default: null },
    installedAt: Date,
    initialReading: { ...D128 },
    lastReading: { ...D128 },
    lastReadingDate: Date,
    calibrationDue: Date,
    /** Bench or field accuracy tests (WASREB / KEBS: within ±2% at normal flow). */
    tests: [
      {
        at: Date,
        by: ObjectId,
        result: { type: String, enum: METER_TEST_RESULTS },
        errorPercent: Decimal128,
        testFlow: String,
        certificateNo: String,
        testedBy: String,
        note: String,
      },
    ],
    history: [
      {
        event: { type: String, enum: ['RECEIVED', 'INSTALLED', 'REMOVED', 'REPLACED', 'FAULTY', 'TESTED', 'SCRAPPED'] },
        at: Date,
        reading: Decimal128,
        customerId: ObjectId,
        by: ObjectId,
        note: String,
        _id: false,
      },
    ],
  },
  opts,
);
meterSchema.index({ organisationId: 1, serialNo: 1 }, { unique: true });
meterSchema.index({ organisationId: 1, customerId: 1 });

export const cycleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    period: { type: String, required: true },
    status: { type: String, enum: CYCLE_STATUSES, default: 'OPEN' },
    readingFrom: Date,
    readingTo: Date,
    openedBy: ObjectId,
  },
  opts,
);
cycleSchema.index({ organisationId: 1, period: 1 }, { unique: true });

export const readingSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    period: { type: String, required: true },
    meterId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, default: null },
    zoneId: { type: ObjectId, default: null },
    meterType: { type: String, enum: METER_TYPES, default: 'CUSTOMER' },
    previousValue: { ...D128 },
    value: { type: Decimal128, default: null },
    /** Movement on the register since the last actual reading. */
    registerUnits: { ...D128 },
    /** Units to bill: the register movement less anything already billed on estimates since the last actual reading. */
    units: { ...D128 },
    type: { type: String, enum: READING_TYPES, default: 'ACTUAL' },
    exception: { type: String, enum: READING_EXCEPTIONS, default: 'NONE' },
    status: { type: String, enum: READING_STATUSES, default: 'PENDING' },
    readAt: { type: Date, required: true },
    readerId: ObjectId,
    gps: { lat: Number, lng: Number, accuracy: Number },
    photoId: { type: ObjectId, default: null },
    note: String,
    /** Generated on the device, so a reading synced twice from an offline phone is stored once. */
    clientId: String,
    reviewedBy: ObjectId,
    reviewedAt: Date,
    reviewNote: String,
  },
  opts,
);
readingSchema.index({ organisationId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
readingSchema.index({ organisationId: 1, period: 1, meterId: 1, status: 1 });
readingSchema.index({ organisationId: 1, meterId: 1, readAt: -1 });

export const billRunSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    period: { type: String, required: true },
    /** SUPPLEMENTARY: a one-off bill for one account (missed charges, back-billing, bowser water…). */
    kind: { type: String, enum: BILL_RUN_KINDS, default: 'REGULAR' },
    customerId: { type: ObjectId, default: null },
    reason: String,
    zoneId: { type: ObjectId, default: null },
    status: { type: String, enum: BILL_RUN_STATUSES, default: 'DRAFT' },
    billDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    billCount: { type: Number, default: 0 },
    totalUnits: { ...D128 },
    totalAmount: { ...D128 },
    totals: { type: Map, of: Decimal128, default: {} },
    createdBy: ObjectId,
    approvedBy: ObjectId,
    approvedAt: Date,
    accounting: { type: accountingSync, default: () => ({}) },
  },
  opts,
);
billRunSchema.index({ organisationId: 1, period: 1, zoneId: 1, status: 1 });

const billLine = new Schema(
  { code: String, description: String, quantity: { ...D128 }, rate: { type: Decimal128, default: null }, amount: { ...D128 } },
  { _id: false },
);

export const billSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    billRunId: { type: ObjectId, required: true },
    billNo: { type: String, default: null },
    customerId: { type: ObjectId, required: true },
    accountNo: { type: String, required: true },
    customerName: String,
    zoneId: { type: ObjectId, default: null },
    category: String,
    period: { type: String, required: true },
    status: { type: String, enum: ['DRAFT', 'ISSUED', 'CANCELLED'], default: 'DRAFT' },
    readingIds: [{ type: ObjectId }],
    meterSerial: String,
    previousReading: { ...D128 },
    currentReading: { ...D128 },
    units: { ...D128 },
    estimated: { type: Boolean, default: false },
    /** A supplementary bill does not stop the account's regular bill for the same period. */
    supplementary: { type: Boolean, default: false },
    reason: String,
    tariffCode: String,
    lines: [billLine],
    currentCharges: { ...D128 },
    balanceBroughtForward: { ...D128 },
    amountDue: { ...D128 },
    billDate: Date,
    dueDate: Date,
    smsStatus: { type: String, enum: SYNC_STATUSES, default: 'NOT_SENT' },
  },
  opts,
);
billSchema.index({ organisationId: 1, billNo: 1 }, { unique: true, partialFilterExpression: { billNo: { $type: 'string' } } });
billSchema.index({ organisationId: 1, billRunId: 1 });
billSchema.index({ organisationId: 1, customerId: 1, period: -1 });
billSchema.index({ organisationId: 1, period: 1, status: 1, zoneId: 1 });

export const paymentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    receiptNo: { type: String, required: true },
    channel: { type: String, enum: PAYMENT_CHANNELS, required: true },
    /** M-Pesa transaction id, bank reference or cash receipt book number. */
    reference: { type: String, required: true },
    amount: { ...D128 },
    paidAt: { type: Date, required: true },
    customerId: { type: ObjectId, default: null },
    accountNo: String,
    /** What the payer typed as the account (M-Pesa BillRefNumber), kept for unmatched payments. */
    accountRef: String,
    payerName: String,
    payerPhone: String,
    status: { type: String, enum: PAYMENT_STATUSES, default: 'POSTED' },
    recordedBy: ObjectId,
    reversedBy: ObjectId,
    reversalReason: String,
    /** The receipt this part was split from (status SPLIT); parts share the payer and date. */
    splitFrom: { type: ObjectId, default: null },
    chequeNo: String,
    drawerBank: String,
    raw: Schema.Types.Mixed,
    accounting: { type: accountingSync, default: () => ({}) },
    reversalAccounting: { type: accountingSync, default: () => ({}) },
  },
  opts,
);
paymentSchema.index({ organisationId: 1, channel: 1, reference: 1 }, { unique: true });
paymentSchema.index({ organisationId: 1, receiptNo: 1 }, { unique: true });
paymentSchema.index({ organisationId: 1, customerId: 1, paidAt: -1 });
paymentSchema.index({ organisationId: 1, status: 1, paidAt: -1 });

/** The customer statement: every movement on an account, in order. */
export const ledgerEntrySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    reference: String,
    description: String,
    debit: { ...D128 },
    credit: { ...D128 },
    balance: { ...D128 },
    sourceId: ObjectId,
  },
  opts,
);
ledgerEntrySchema.index({ organisationId: 1, customerId: 1, createdAt: 1 });

export const adjustmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, required: true },
    /** Negative credits the customer; positive charges them. */
    amount: { ...D128 },
    reason: { type: String, required: true },
    category: { type: String, enum: ['BILLING_ERROR', 'LEAK_ALLOWANCE', 'METER_FAULT', 'WAIVER', 'DEBIT_NOTE', 'OTHER'], default: 'OTHER' },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    requestedBy: ObjectId,
    reviewedBy: ObjectId,
    reviewedAt: Date,
    reviewNote: String,
    accounting: { type: accountingSync, default: () => ({}) },
  },
  opts,
);
adjustmentSchema.index({ organisationId: 1, status: 1 });

export const disconnectionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, required: true },
    accountNo: String,
    status: { type: String, enum: DISCONNECTION_STATUSES, default: 'LISTED' },
    arrears: { ...D128 },
    listedAt: { type: Date, default: () => new Date() },
    noticeSentAt: Date,
    disconnectedAt: Date,
    disconnectedBy: ObjectId,
    reconnectedAt: Date,
    reconnectedBy: ObjectId,
    meterReading: Decimal128,
    reconnectionFee: Decimal128,
    note: String,
    feeAccounting: { type: accountingSync, default: () => ({}) },
  },
  opts,
);
disconnectionSchema.index({ organisationId: 1, status: 1 });
disconnectionSchema.index({ organisationId: 1, customerId: 1, status: 1 });

export type WaterSettingsDoc = InferSchemaType<typeof waterSettingsSchema> & { _id: Types.ObjectId };
export type ZoneDoc = InferSchemaType<typeof zoneSchema> & { _id: Types.ObjectId };
export type TariffDoc = InferSchemaType<typeof tariffSchema> & { _id: Types.ObjectId };
export type CustomerDoc = InferSchemaType<typeof customerSchema> & { _id: Types.ObjectId };
export type MeterDoc = InferSchemaType<typeof meterSchema> & { _id: Types.ObjectId };
export type ReadingDoc = InferSchemaType<typeof readingSchema> & { _id: Types.ObjectId };
export type BillRunDoc = InferSchemaType<typeof billRunSchema> & { _id: Types.ObjectId };
export type BillDoc = InferSchemaType<typeof billSchema> & { _id: Types.ObjectId };
export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };
