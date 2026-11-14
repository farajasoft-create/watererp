import { InferSchemaType, Schema, Types } from 'mongoose';
import { LotSpecSchema } from './operational.schemas';

/**
 * Phase 2 (commercial finance) data model: tax, customers and suppliers, sales and purchase
 * documents, receipts and payments with their allocations, banking and procurement.
 * Every collection is tenant-scoped by organisationId.
 */

const ObjectId = Schema.Types.ObjectId;
const Decimal128 = Schema.Types.Decimal128;
const options = { timestamps: true, versionKey: false } as const;
const money = { type: Decimal128, required: true };

export const TAX_KINDS = ['VAT', 'WITHHOLDING'] as const;
export type TaxKind = (typeof TAX_KINDS)[number];
/** WITHHOLDING: tax we withheld from suppliers (payable). WITHHELD: tax customers withheld from us (recoverable). */
export const TAX_DIRECTIONS = ['OUTPUT', 'INPUT', 'WITHHOLDING', 'WITHHELD'] as const;

export const DOCUMENT_KINDS = ['SALES_INVOICE', 'SALES_CREDIT', 'PURCHASE_BILL', 'PURCHASE_CREDIT'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_STATUSES = ['DRAFT', 'SUBMITTED', 'REJECTED', 'POSTED', 'VOID'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID'] as const;
export const MATCH_STATUSES = ['NOT_REQUIRED', 'MATCHED', 'VARIANCE', 'OVERRIDDEN'] as const;

export const PAYMENT_KINDS = ['RECEIPT', 'PAYMENT'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CHEQUE', 'CASH', 'CARD', 'MOBILE_MONEY', 'OTHER'] as const;

export const BANK_ACCOUNT_TYPES = ['BANK', 'CASH', 'MOBILE_MONEY', 'PETTY_CASH'] as const;

export const REQUISITION_STATUSES = ['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'ORDERED', 'CANCELLED'] as const;
export const PO_STATUSES = ['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

/** Who did what and when, shared by every approvable document. */
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

const voiding = {
  voidedBy: { type: ObjectId, default: null },
  voidedAt: { type: Date, default: null },
  voidReason: { type: String, default: '' },
  voidJournalId: { type: ObjectId, default: null },
};

const dimensions = {
  departmentId: { type: ObjectId, default: null },
  costCentreId: { type: ObjectId, default: null },
  projectId: { type: ObjectId, default: null },
};

// ---------------------------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------------------------

/** A tax code with effective-dated rates. Jurisdiction rules are data, never hard-coded. */
export const TaxCodeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    kind: { type: String, enum: TAX_KINDS, default: 'VAT' },
    /** Country the code applies to; empty means any jurisdiction. */
    country: { type: String, default: '' },
    rates: {
      type: [new Schema({ rate: money, effectiveFrom: { type: Date, required: true } }, { _id: false })],
      default: [],
    },
    /** Output VAT payable, or the withholding tax liability. */
    outputAccountId: { type: ObjectId, required: true },
    /**
     * VAT: recoverable input VAT; null when input tax is not recoverable (it is then expensed with the line).
     * Withholding: tax customers withheld from our receipts, recoverable from the tax authority.
     */
    inputAccountId: { type: ObjectId, default: null },
    /** Kenya eTIMS tax type for sales: A exempt, B standard 16%, C zero-rated, D non-VAT, E 8%. */
    etimsTaxType: { type: String, enum: ['A', 'B', 'C', 'D', 'E', null], default: null },
    isActive: { type: Boolean, default: true },
  },
  options,
);
TaxCodeSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** One row per tax code per posted document or payment; the basis for tax returns. */
export const TaxTransactionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    direction: { type: String, enum: TAX_DIRECTIONS, required: true },
    sourceType: { type: String, required: true },
    sourceId: { type: ObjectId, required: true },
    documentNumber: { type: String, required: true },
    partyType: { type: String, default: null },
    partyId: { type: ObjectId, default: null },
    partyName: { type: String, default: '' },
    partyTaxId: { type: String, default: '' },
    taxCodeId: { type: ObjectId, required: true },
    taxCode: { type: String, required: true },
    rate: money,
    currency: { type: String, required: true },
    exchangeRate: money,
    /** Signed: credit notes and voids are negative. */
    taxableAmountTx: money,
    taxAmountTx: money,
    taxableAmount: money,
    taxAmount: money,
    journalId: { type: ObjectId, default: null },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
TaxTransactionSchema.index({ organisationId: 1, entityId: 1, date: 1 });
TaxTransactionSchema.index({ organisationId: 1, sourceId: 1 });

// ---------------------------------------------------------------------------------------------
// Customers & suppliers
// ---------------------------------------------------------------------------------------------

/**
 * Shared shape for customers and suppliers. Each party trades in a single currency, which keeps
 * statements, ageing, credit limits and FX exposure unambiguous.
 */
/** Suppliers: PENDING until onboarding is approved (when the organisation requires it); SUSPENDED and BLACKLISTED stop new orders. */
export const SUPPLIER_STATUSES = ['PENDING', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'BLACKLISTED'] as const;
export const SUPPLIER_COMPLIANCE_TYPES = ['TAX_COMPLIANCE', 'REGISTRATION', 'AGPO', 'NCA', 'PROFESSIONAL', 'OTHER'] as const;

export const PartySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    legalName: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    country: { type: String, default: '' },
    taxId: { type: String, default: '' },
    currency: { type: String, required: true },
    paymentTermsDays: { type: Number, default: 30 },
    /** Default revenue (customers) or expense (suppliers) account for new lines. */
    defaultAccountId: { type: ObjectId, default: null },
    defaultTaxCodeId: { type: ObjectId, default: null },
    /** Customers: maximum outstanding balance in the customer's currency. Null means no limit. */
    creditLimit: { type: Decimal128, default: null },
    /** Customers on hold cannot have new invoices approved. */
    onHold: { type: Boolean, default: false },
    /** Suppliers: payment details and default withholding tax. */
    bankName: { type: String, default: '' },
    bankAccountName: { type: String, default: '' },
    bankAccountNumber: { type: String, default: '' },
    bankBranch: { type: String, default: '' },
    withholdingTaxCodeId: { type: ObjectId, default: null },
    /** Customers who are withholding agents: the taxes they deduct from what they pay us. */
    withholdingTaxCodeIds: { type: [ObjectId], default: [] },
    /** Suppliers paid through M-Pesa: to a phone, a paybill (with account number) or a till. */
    mpesaPayee: {
      type: new Schema(
        {
          type: { type: String, enum: ['PHONE', 'PAYBILL', 'TILL'], required: true },
          number: { type: String, required: true },
          accountReference: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Set when the customer or supplier is another entity in the group (intercompany). */
    intercompanyEntityId: { type: ObjectId, default: null },
    notes: { type: String, default: '' },
    /** Suppliers: procurement categories (goods, works, services…), each tied to a default ledger account. */
    categoryIds: { type: [ObjectId], default: [] },
    status: { type: String, enum: SUPPLIER_STATUSES, default: 'ACTIVE' },
    statusReason: { type: String, default: '' },
    /** A suspension lifts itself on this date. */
    statusUntil: { type: Date, default: null },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: ObjectId, default: null },
    onboarding: {
      submittedBy: { type: ObjectId, default: null },
      submittedAt: { type: Date, default: null },
      approvedBy: { type: ObjectId, default: null },
      approvedAt: { type: Date, default: null },
      comment: { type: String, default: '' },
    },
    /** Tax compliance certificate, registration, AGPO and similar, with expiry dates. */
    compliance: {
      type: [
        new Schema(
          {
            type: { type: String, enum: SUPPLIER_COMPLIANCE_TYPES, required: true },
            number: { type: String, required: true },
            issuedOn: { type: Date, default: null },
            expiresOn: { type: Date, default: null },
            note: { type: String, default: '' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, default: null },
  },
  options,
);
PartySchema.index({ organisationId: 1, code: 1 }, { unique: true });
PartySchema.index({ organisationId: 1, name: 1 });

// ---------------------------------------------------------------------------------------------
// Sales & purchase documents
// ---------------------------------------------------------------------------------------------

const DocumentLineSchema = new Schema(
  {
    lineNo: { type: Number, required: true },
    description: { type: String, required: true },
    accountId: { type: ObjectId, required: true },
    quantity: money,
    unitPrice: money,
    discountPercent: { type: Decimal128, default: null },
    taxCodeId: { type: ObjectId, default: null },
    taxRate: money,
    netAmount: money,
    taxAmount: money,
    /** Purchase-order line this bill line is matched to. */
    poLineNo: { type: Number, default: null },
    /** Inventory: the item and warehouse for stock lines (Phase 4). */
    itemId: { type: ObjectId, default: null },
    warehouseId: { type: ObjectId, default: null },
    /** Cost of stock issued (sales) at weighted average, functional currency; set on posting. */
    costOfSales: { type: Decimal128, default: null },
    /** Bills of stock received on a goods received note: the GRNI value this line cleared. */
    grniValue: { type: Decimal128, default: null },
    /** Batch or serial numbers for tracked items (quantities positive). */
    lots: { type: [LotSpecSchema], default: [] },
    ...dimensions,
  },
  { _id: false },
);

/** Sales invoices, customer credit notes, supplier bills and supplier credit notes. */
export const InvoiceSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    kind: { type: String, enum: DOCUMENT_KINDS, required: true },
    number: { type: String, required: true },
    partyId: { type: ObjectId, required: true },
    partyName: { type: String, required: true },
    date: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    reference: { type: String, default: '' },
    /** The supplier's own invoice number; duplicates per supplier are rejected. */
    supplierInvoiceNumber: { type: String, default: '' },
    purchaseOrderId: { type: ObjectId, default: null },
    /** Credit notes: the invoice or bill they are applied against on posting. */
    appliesToId: { type: ObjectId, default: null },
    currency: { type: String, required: true },
    exchangeRate: money,
    functionalCurrency: { type: String, required: true },
    priceIncludesTax: { type: Boolean, default: false },
    lines: { type: [DocumentLineSchema], default: [] },
    subtotal: money,
    taxTotal: money,
    total: money,
    /** Carrying value of the total in functional currency, fixed at posting. */
    totalFunctional: money,
    /** Open balance in transaction and (carrying) functional currency. */
    amountDue: money,
    amountDueFunctional: money,
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'DRAFT' },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'UNPAID' },
    matchStatus: { type: String, enum: MATCH_STATUSES, default: 'NOT_REQUIRED' },
    matchNotes: { type: [String], default: [] },
    notes: { type: String, default: '' },
    journalId: { type: ObjectId, default: null },
    idempotencyKey: { type: String, default: undefined },
    /** Sales documents: when the document was last emailed to the customer. */
    emailedAt: { type: Date, default: null },
    /** Supplier bills receiving customs-cleared goods: stock on them is reported to KRA as an import. */
    etimsImport: { type: Boolean, default: false },
    /** Supplier bills: the supplier's invoice as registered in KRA eTIMS (input VAT is claimable on it). */
    etimsPurchaseId: { type: ObjectId, default: null },
    /** Sales documents in an eTIMS branch: KRA's signature, printed on the document. */
    etims: {
      type: new Schema(
        {
          status: { type: String, default: 'PENDING' },
          invcNo: { type: Number, default: null },
          curRcptNo: { type: Number, default: null },
          totRcptNo: { type: Number, default: null },
          intrlData: { type: String, default: null },
          rcptSign: { type: String, default: null },
          sdcId: { type: String, default: null },
          mrcNo: { type: String, default: null },
          sdcDateTime: { type: String, default: null },
          qrUrl: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    ...workflow,
    ...voiding,
  },
  options,
);
InvoiceSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
InvoiceSchema.index({ organisationId: 1, kind: 1, status: 1, date: -1 });
InvoiceSchema.index({ organisationId: 1, partyId: 1, status: 1 });
// Ageing reads only open items.
InvoiceSchema.index({ organisationId: 1, entityId: 1, kind: 1, status: 1, amountDue: 1 });
InvoiceSchema.index({ organisationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

// ---------------------------------------------------------------------------------------------
// Receipts, payments & allocations
// ---------------------------------------------------------------------------------------------

/** Customer receipts and supplier payments. */
export const PaymentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    kind: { type: String, enum: PAYMENT_KINDS, required: true },
    number: { type: String, required: true },
    partyType: { type: String, required: true },
    partyId: { type: ObjectId, required: true },
    partyName: { type: String, required: true },
    date: { type: Date, required: true },
    bankAccountId: { type: ObjectId, required: true },
    method: { type: String, enum: PAYMENT_METHODS, default: 'BANK_TRANSFER' },
    reference: { type: String, default: '' },
    description: { type: String, default: '' },
    currency: { type: String, required: true },
    exchangeRate: money,
    functionalCurrency: { type: String, required: true },
    /** Cash moved through the bank account. */
    amount: money,
    amountFunctional: money,
    /** Tax withheld from a supplier payment; settles the bill together with the cash. */
    withholdingTaxCodeId: { type: ObjectId, default: null },
    /** Total tax withheld (by us on a payment, or by the customer on a receipt). */
    withholdingAmount: money,
    withholdingAmountFunctional: money,
    /** Receipts: the tax codes the customer withheld under (e.g. income tax 5% and VAT 2%). */
    withholdingTaxCodeIds: { type: [ObjectId], default: [] },
    /** Receipts: each tax the customer withheld, recoverable once their certificate arrives. */
    customerWithholdings: {
      type: [
        new Schema(
          {
            taxCodeId: { type: ObjectId, required: true },
            taxCode: { type: String, required: true },
            rate: money,
            base: money,
            amount: money,
            amountFunctional: money,
            certificateNumber: { type: String, default: '' },
            certificateDate: { type: Date, default: null },
            certificateRecordedBy: { type: ObjectId, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Settlement value (amount + withholding) not yet applied to documents, held on account. */
    unallocated: money,
    unallocatedFunctional: money,
    /** Remittance advice emailed to the supplier after posting. */
    remittanceSentAt: { type: Date, default: null },
    remittanceSentTo: { type: String, default: '' },
    /** Electronic signatures of the cheque by the account's signatories. */
    chequeSignatures: { type: [new Schema({ userId: ObjectId, name: String, at: Date, signatureHash: String, ip: String }, { _id: false })], default: [] },
    /** Times the cheque has been printed (a reprint is visible in the audit). */
    chequePrints: { type: Number, default: 0 },
    /** Allocations requested on a draft; applied when the payment is posted. */
    plannedAllocations: {
      type: [new Schema({ documentId: { type: ObjectId, required: true }, amount: money }, { _id: false })],
      default: [],
    },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'DRAFT' },
    journalId: { type: ObjectId, default: null },
    /** Payment run that proposed this payment. */
    batchId: { type: ObjectId, default: null },
    idempotencyKey: { type: String, default: undefined },
    ...workflow,
    ...voiding,
  },
  options,
);
PaymentSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
PaymentSchema.index({ organisationId: 1, kind: 1, status: 1, date: -1 });
PaymentSchema.index({ organisationId: 1, partyId: 1, status: 1 });
PaymentSchema.index({ organisationId: 1, entityId: 1, partyType: 1, status: 1, unallocated: 1 });
PaymentSchema.index({ organisationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

/**
 * Settles part of an open document (invoice or bill) with a payment or credit note. Carrying values
 * removed from both sides are kept so the realised FX difference and any later reversal are exact.
 */
export const AllocationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    partyType: { type: String, required: true },
    partyId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    documentId: { type: ObjectId, required: true },
    documentNumber: { type: String, required: true },
    sourceType: { type: String, enum: ['PAYMENT', 'CREDIT_NOTE'], required: true },
    sourceId: { type: ObjectId, required: true },
    sourceNumber: { type: String, required: true },
    currency: { type: String, required: true },
    amount: money,
    documentFunctional: money,
    sourceFunctional: money,
    /** Realised FX result in functional currency: positive is a gain, negative a loss. */
    fxAmount: money,
    journalId: { type: ObjectId, default: null },
    status: { type: String, enum: ['ACTIVE', 'REVERSED'], default: 'ACTIVE' },
    reversedBy: { type: ObjectId, default: null },
    reversedAt: { type: Date, default: null },
    reversalJournalId: { type: ObjectId, default: null },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
AllocationSchema.index({ organisationId: 1, documentId: 1, status: 1 });
AllocationSchema.index({ organisationId: 1, sourceId: 1, status: 1 });
AllocationSchema.index({ organisationId: 1, partyId: 1, date: 1 });

// ---------------------------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------------------------

export const BankAccountSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: BANK_ACCOUNT_TYPES, default: 'BANK' },
    bankName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    currency: { type: String, required: true },
    /** The general-ledger account (type BANK or CASH) this account posts to. */
    glAccountId: { type: ObjectId, required: true },
    isActive: { type: Boolean, default: true },
    /** Ledger entries before this date are treated as already cleared when reconciling. */
    reconcileFrom: { type: Date, default: null },
    lastReconciledDate: { type: Date, default: null },
    lastReconciledBalance: { type: Decimal128, default: null },
    /** Users who sign cheques on this account electronically, and how many must sign each cheque. */
    chequeSignatories: { type: [ObjectId], default: [] },
    chequeSignaturesRequired: { type: Number, default: 0 },
    /** Safaricom Daraja (M-Pesa) connection for a mobile-money account. Secrets are encrypted. */
    mpesa: {
      enabled: { type: Boolean, default: false },
      environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
      shortCode: { type: String, default: '' },
      /** Paybill (customers enter an account number) or Buy Goods till. */
      shortCodeType: { type: String, enum: ['PAYBILL', 'TILL'], default: 'PAYBILL' },
      /** For tills, the store number that prompts are sent to (if different from the till number). */
      partyB: { type: String, default: '' },
      consumerKey: { type: String, default: null },
      consumerSecret: { type: String, default: null },
      passkey: { type: String, default: null },
      /** Random secret in the callback URLs; Safaricom does not sign callbacks. */
      callbackSecret: { type: String, default: null },
      /** Receipts are recorded in this user's name. */
      postAsUserId: { type: ObjectId, default: null },
      registeredAt: { type: Date, default: null },
      /** Paying out (B2C to phones, B2B to paybills and tills) from this account. */
      payouts: {
        enabled: { type: Boolean, default: false },
        /** The disbursement short code holding the float (often not the collection paybill). */
        shortCode: { type: String, default: '' },
        initiatorName: { type: String, default: '' },
        /** The initiator password encrypted with Safaricom's certificate (from the Daraja portal), encrypted again here. */
        securityCredential: { type: String, default: null },
        /** Most that may be paid out per day (KES); null means no limit. */
        dailyLimit: { type: Decimal128, default: null },
        /** Approvers are alerted when the float falls below this (KES). */
        lowBalanceAlert: { type: Decimal128, default: null },
        /** The last balance M-Pesa reported for the disbursement short code. */
        balance: {
          available: { type: Decimal128, default: null },
          accounts: { type: [new Schema({ name: String, currency: String, available: String }, { _id: false })], default: [] },
          checkedAt: { type: Date, default: null },
          requestedAt: { type: Date, default: null },
          alertedAt: { type: Date, default: null },
        },
        /** Transaction charges by amount band (KES): each payout's charge is booked automatically. */
        tariff: {
          type: [new Schema({ upTo: { type: Decimal128, required: true }, charge: { type: Decimal128, required: true } }, { _id: false })],
          default: [],
        },
        chargesAccountId: { type: ObjectId, default: null },
      },
    },
    /** Card payments on the customer portal (hosted checkout); receipts land in this account. */
    card: {
      enabled: { type: Boolean, default: false },
      provider: { type: String, enum: ['STRIPE'], default: 'STRIPE' },
      /** Secret API key and webhook signing secret, encrypted. */
      secretKey: { type: String, default: null },
      webhookSecret: { type: String, default: null },
      /** Random secret in the webhook URL. */
      callbackSecret: { type: String, default: null },
      postAsUserId: { type: ObjectId, default: null },
    },
    /** Bank feed: transactions arrive as statement lines without a file import. */
    feed: {
      enabled: { type: Boolean, default: false },
      /** MONO pulls from an open-banking aggregator; PUSH accepts transactions posted by the bank or a connector. */
      provider: { type: String, enum: ['MONO', 'PUSH'], default: 'PUSH' },
      /** The aggregator's id for the connected account. */
      externalAccountId: { type: String, default: '' },
      secretKey: { type: String, default: null },
      /** Bearer token the push endpoint expects (hash only). */
      pushTokenHash: { type: String, default: null },
      lastSyncAt: { type: Date, default: null },
      /** Transactions on or after this date are fetched on the next pull. */
      syncFrom: { type: Date, default: null },
      lastError: { type: String, default: '' },
      postAsUserId: { type: ObjectId, default: null },
    },
  },
  options,
);
BankAccountSchema.index({ organisationId: 1, entityId: 1, glAccountId: 1 }, { unique: true });

/** An imported bank statement (file or feed batch). */
export const BankStatementSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    name: { type: String, default: '' },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    closingBalance: { type: Decimal128, default: null },
    lineCount: { type: Number, required: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
BankStatementSchema.index({ organisationId: 1, bankAccountId: 1, toDate: -1 });

export const BankStatementLineSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    statementId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    description: { type: String, default: '' },
    reference: { type: String, default: '' },
    /** Signed: money in is positive, money out negative. */
    amount: money,
    status: { type: String, enum: ['UNMATCHED', 'MATCHED'], default: 'UNMATCHED' },
    matchId: { type: ObjectId, default: null },
    /** Bank feeds: the provider's transaction id, so a transaction is never imported twice. */
    externalId: { type: String, default: undefined },
  },
  options,
);
BankStatementLineSchema.index({ organisationId: 1, bankAccountId: 1, status: 1, date: 1 });
BankStatementLineSchema.index({ bankAccountId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } });

/** Links statement lines to ledger entries on the bank's GL account. Each side can be matched once. */
export const BankMatchSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    statementLineIds: { type: [ObjectId], required: true },
    ledgerEntryIds: { type: [ObjectId], required: true },
    kind: { type: String, enum: ['MANUAL', 'AUTO', 'ADJUSTMENT'], default: 'MANUAL' },
    reconciliationId: { type: ObjectId, default: null },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
BankMatchSchema.index({ statementLineIds: 1 }, { unique: true });
BankMatchSchema.index({ ledgerEntryIds: 1 }, { unique: true });
BankMatchSchema.index({ organisationId: 1, bankAccountId: 1 });

/** A completed, locked reconciliation with its report snapshot. */
export const BankReconciliationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    statementDate: { type: Date, required: true },
    statementBalance: money,
    bookBalance: money,
    unpresentedTotal: money,
    outstanding: {
      type: [
        new Schema(
          { ledgerEntryId: ObjectId, date: Date, journalNumber: String, description: String, amount: Decimal128 },
          { _id: false },
        ),
      ],
      default: [],
    },
    matchedCount: { type: Number, default: 0 },
    notes: { type: String, default: '' },
    completedBy: { type: ObjectId, required: true },
    completedAt: { type: Date, required: true },
  },
  options,
);
BankReconciliationSchema.index({ organisationId: 1, bankAccountId: 1, statementDate: -1 }, { unique: true });

export const BankTransferSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    fromBankAccountId: { type: ObjectId, required: true },
    toBankAccountId: { type: ObjectId, required: true },
    fromAmount: money,
    toAmount: money,
    fromRate: money,
    toRate: money,
    reference: { type: String, default: '' },
    description: { type: String, default: '' },
    journalId: { type: ObjectId, required: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
BankTransferSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------------------------

export const PurchaseRequisitionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    requiredBy: { type: Date, default: null },
    description: { type: String, required: true },
    currency: { type: String, required: true },
    lines: {
      type: [
        new Schema(
          {
            lineNo: { type: Number, required: true },
            description: { type: String, required: true },
            accountId: { type: ObjectId, default: null },
            quantity: money,
            estimatedUnitPrice: money,
            /** The item of the approved annual procurement plan this line draws on. */
            planItemId: { type: ObjectId, default: null },
            ...dimensions,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    estimatedTotal: money,
    status: { type: String, enum: REQUISITION_STATUSES, default: 'DRAFT' },
    purchaseOrderIds: { type: [ObjectId], default: [] },
    ...workflow,
  },
  options,
);
PurchaseRequisitionSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
PurchaseRequisitionSchema.index({ organisationId: 1, status: 1, date: -1 });

const PurchaseOrderLineSchema = new Schema(
  {
    lineNo: { type: Number, required: true },
    description: { type: String, required: true },
    accountId: { type: ObjectId, required: true },
    quantity: money,
    unitPrice: money,
    taxCodeId: { type: ObjectId, default: null },
    netAmount: money,
    taxAmount: money,
    quantityReceived: money,
    quantityBilled: money,
    /** Stock lines: the item and warehouse. They are received into stock on the goods received note. */
    itemId: { type: ObjectId, default: null },
    warehouseId: { type: ObjectId, default: null },
    /** Functional value of the stock received so far (cleared from GRNI as it is billed). */
    receivedValue: { type: Decimal128, default: null },
    /** Functional GRNI value cleared by bills so far. */
    billedValue: { type: Decimal128, default: null },
    planItemId: { type: ObjectId, default: null },
    ...dimensions,
  },
  { _id: false },
);

export const PurchaseOrderSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    supplierId: { type: ObjectId, required: true },
    supplierName: { type: String, required: true },
    date: { type: Date, required: true },
    expectedDate: { type: Date, default: null },
    reference: { type: String, default: '' },
    notes: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    requisitionId: { type: ObjectId, default: null },
    currency: { type: String, required: true },
    /** Rate used to value the order for approval limits; bills use the rate on the bill date. */
    exchangeRate: money,
    priceIncludesTax: { type: Boolean, default: false },
    lines: { type: [PurchaseOrderLineSchema], default: [] },
    subtotal: money,
    taxTotal: money,
    total: money,
    totalFunctional: money,
    status: { type: String, enum: PO_STATUSES, default: 'DRAFT' },
    closedBy: { type: ObjectId, default: null },
    closedAt: { type: Date, default: null },
    /** Amendments approved since the original (1 = original). */
    version: { type: Number, default: 1 },
    /** A proposed new version awaiting approval. */
    amendment: {
      type: new Schema(
        {
          reason: { type: String, required: true },
          proposed: {
            expectedDate: { type: Date, default: null },
            notes: { type: String, default: '' },
            deliveryAddress: { type: String, default: '' },
            lines: { type: [PurchaseOrderLineSchema], default: [] },
            subtotal: money,
            taxTotal: money,
            total: money,
            totalFunctional: money,
          },
          requestedBy: { type: ObjectId, required: true },
          requestedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Earlier versions, as they were before each approved amendment. */
    revisions: {
      type: [
        new Schema(
          {
            version: { type: Number, required: true },
            reason: { type: String, default: '' },
            requestedBy: { type: ObjectId, default: null },
            requestedAt: { type: Date, default: null },
            approvedBy: { type: ObjectId, default: null },
            approvedAt: { type: Date, default: null },
            total: money,
            newTotal: money,
            expectedDate: { type: Date, default: null },
            lines: { type: [PurchaseOrderLineSchema], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    sentTo: {
      type: [new Schema({ email: { type: String, required: true }, version: { type: Number, default: 1 }, at: { type: Date, required: true }, by: { type: ObjectId, default: null } }, { _id: false })],
      default: [],
    },
    ...workflow,
  },
  options,
);
PurchaseOrderSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
PurchaseOrderSchema.index({ organisationId: 1, status: 1, date: -1 });
PurchaseOrderSchema.index({ organisationId: 1, supplierId: 1 });

export const GoodsReceiptSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    purchaseOrderId: { type: ObjectId, required: true },
    purchaseOrderNumber: { type: String, required: true },
    supplierId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    reference: { type: String, default: '' },
    notes: { type: String, default: '' },
    lines: {
      type: [
        new Schema(
          {
            poLineNo: { type: Number, required: true },
            description: String,
            quantity: money,
            itemId: { type: ObjectId, default: null },
            warehouseId: { type: ObjectId, default: null },
            /** Stock lines: functional value received into stock (Dr inventory, Cr GRNI). */
            value: { type: Decimal128, default: null },
            lots: { type: [LotSpecSchema], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** The GRNI journal for stock lines, if any. */
    journalId: { type: ObjectId, default: null },
    status: { type: String, enum: ['POSTED', 'REVERSED'], default: 'POSTED' },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: ObjectId, default: null },
    reversalReason: { type: String, default: '' },
    reversalJournalId: { type: ObjectId, default: null },
    /** Inspection and acceptance committee: each member accepts or rejects the delivery. */
    inspection: {
      type: new Schema(
        {
          committee: { type: [new Schema({ userId: { type: ObjectId, required: true }, name: { type: String, required: true } }, { _id: false })], default: [] },
          appointedBy: { type: ObjectId, required: true },
          appointedAt: { type: Date, required: true },
          decisions: {
            type: [new Schema({ userId: { type: ObjectId, required: true }, name: { type: String, required: true }, decision: { type: String, enum: ['ACCEPT', 'REJECT'], required: true }, remarks: { type: String, default: '' }, at: { type: Date, required: true } }, { _id: false })],
            default: [],
          },
          status: { type: String, enum: ['PENDING', 'ACCEPTED', 'REJECTED'], default: 'PENDING' },
          completedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
GoodsReceiptSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
GoodsReceiptSchema.index({ organisationId: 1, purchaseOrderId: 1 });

export const RFQ_STATUSES = ['DRAFT', 'SENT', 'CLOSED', 'AWARDED', 'CANCELLED'] as const;

/**
 * Request for quotes: what is wanted, the suppliers asked, the prices each quoted (in its own currency)
 * and which supplier won each line. Awarding raises a draft purchase order per winning supplier.
 */
export const RequestForQuoteSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    title: { type: String, required: true },
    date: { type: Date, required: true },
    /** Quotes are due by. */
    dueDate: { type: Date, required: true },
    notes: { type: String, default: '' },
    deliveryAddress: { type: String, default: '' },
    requisitionId: { type: ObjectId, default: null },
    status: { type: String, enum: RFQ_STATUSES, default: 'DRAFT' },
    lines: {
      type: [
        new Schema(
          {
            lineNo: { type: Number, required: true },
            description: { type: String, required: true },
            quantity: money,
            accountId: { type: ObjectId, default: null },
            itemId: { type: ObjectId, default: null },
            warehouseId: { type: ObjectId, default: null },
            taxCodeId: { type: ObjectId, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    suppliers: {
      type: [
        new Schema(
          {
            supplierId: { type: ObjectId, required: true },
            supplierName: { type: String, required: true },
            email: { type: String, default: '' },
            currency: { type: String, required: true },
            sentAt: { type: Date, default: null },
            respondedAt: { type: Date, default: null },
            validUntil: { type: Date, default: null },
            reference: { type: String, default: '' },
            /** Net unit prices quoted, in the supplier's currency; a line not quoted is left out. */
            quotes: {
              type: [new Schema({ lineNo: { type: Number, required: true }, unitPrice: money, leadTimeDays: { type: Number, default: null }, notes: { type: String, default: '' } }, { _id: false })],
              default: [],
            },
            declined: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    awards: {
      type: [
        new Schema(
          {
            lineNo: { type: Number, required: true },
            supplierId: { type: ObjectId, required: true },
            unitPrice: money,
            /** Why the cheapest quote was not chosen. */
            reason: { type: String, default: '' },
            purchaseOrderId: { type: ObjectId, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    awardedBy: { type: ObjectId, default: null },
    awardedAt: { type: Date, default: null },
    /** Evaluation committee, weighted criteria and each member's scores for each bidder. */
    evaluation: {
      type: new Schema(
        {
          committee: {
            type: [new Schema({ userId: { type: ObjectId, required: true }, name: { type: String, required: true }, role: { type: String, enum: ['CHAIR', 'SECRETARY', 'MEMBER'], required: true }, appointedAt: { type: Date, required: true } }, { _id: false })],
            default: [],
          },
          criteria: { type: [new Schema({ name: { type: String, required: true }, weight: { type: Number, required: true } }, { _id: false })], default: [] },
          /** Minimum technical score (out of 100) to be responsive. */
          passMark: { type: Number, default: 70 },
          /** Share of the combined score given to price; 0 means lowest evaluated responsive price wins. */
          financialWeight: { type: Number, default: 0 },
          scores: {
            type: [
              new Schema(
                { userId: { type: ObjectId, required: true }, supplierId: { type: ObjectId, required: true }, criterion: { type: String, required: true }, score: { type: Number, required: true }, comment: { type: String, default: '' }, at: { type: Date, required: true } },
                { _id: false },
              ),
            ],
            default: [],
          },
          status: { type: String, enum: ['OPEN', 'COMPLETED'], default: 'OPEN' },
          appointedBy: { type: ObjectId, required: true },
          appointedAt: { type: Date, required: true },
          recommendedSupplierId: { type: ObjectId, default: null },
          recommendation: { type: String, default: '' },
          completedBy: { type: ObjectId, default: null },
          completedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
RequestForQuoteSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
RequestForQuoteSchema.index({ organisationId: 1, status: 1, date: -1 });

// ---------------------------------------------------------------------------------------------
// Phase 3: FX revaluation and consolidation
// ---------------------------------------------------------------------------------------------

/** A period-end revaluation run: the lines it computed and the journal (auto-reversing) it posted. */
export const FxRevaluationSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    reverseOn: { type: Date, required: true },
    rateType: { type: String, required: true },
    rates: { type: [new Schema({ currency: String, rate: Decimal128, rateType: String, effectiveDate: Date }, { _id: false })], default: [] },
    lines: {
      type: [
        new Schema(
          {
            kind: { type: String, enum: ['ACCOUNT', 'OPEN_ITEM'], required: true },
            accountId: { type: ObjectId, required: true },
            branchId: { type: ObjectId, required: true },
            currency: { type: String, required: true },
            partyType: { type: String, default: null },
            partyId: { type: ObjectId, default: null },
            documentId: { type: ObjectId, default: null },
            documentNumber: { type: String, default: '' },
            balanceTx: money,
            carrying: money,
            revalued: money,
            /** Positive is a gain. */
            difference: money,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    totalGain: money,
    totalLoss: money,
    journalId: { type: ObjectId, default: null },
    status: { type: String, enum: ['POSTED', 'REVERSED'], default: 'POSTED' },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
FxRevaluationSchema.index({ organisationId: 1, entityId: 1, date: -1 });

/** A group-level consolidation adjustment in the reporting currency, approved by a second person. */
export const ConsolidationAdjustmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    currency: { type: String, required: true },
    /** Entity the adjustment relates to (traceability); null for group-wide adjustments. */
    entityId: { type: ObjectId, default: null },
    lines: {
      type: [new Schema({ accountId: { type: ObjectId, required: true }, description: String, debit: money, credit: money }, { _id: false })],
      default: [],
    },
    total: money,
    status: { type: String, enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'VOID'], default: 'DRAFT' },
    ...workflow,
  },
  options,
);
ConsolidationAdjustmentSchema.index({ organisationId: 1, number: 1 }, { unique: true });
ConsolidationAdjustmentSchema.index({ organisationId: 1, status: 1, date: -1 });

/**
 * A parent's investment in a subsidiary of the group. On consolidation the cost (in the parent's books)
 * is eliminated against the subsidiary's equity at acquisition; the difference is goodwill, and the outside
 * shareholders' share of those net assets is non-controlling interest at acquisition.
 */
export const GroupInvestmentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    parentEntityId: { type: ObjectId, required: true },
    subsidiaryEntityId: { type: ObjectId, required: true },
    acquisitionDate: { type: Date, required: true },
    /** The parent's account holding the investment, and its cost in the parent's functional currency. */
    investmentAccountId: { type: ObjectId, required: true },
    cost: money,
    ownershipPercent: money,
    goodwillAccountId: { type: ObjectId, required: true },
    notes: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: ObjectId, required: true },
  },
  options,
);
GroupInvestmentSchema.index({ organisationId: 1, subsidiaryEntityId: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------

type WithId<T> = T & { _id: Types.ObjectId };
export type TaxCode = WithId<InferSchemaType<typeof TaxCodeSchema>>;
export type TaxTransaction = WithId<InferSchemaType<typeof TaxTransactionSchema>>;
export type Party = WithId<InferSchemaType<typeof PartySchema>>;
export type DocumentLine = InferSchemaType<typeof DocumentLineSchema>;
export type Invoice = WithId<InferSchemaType<typeof InvoiceSchema>>;
export type Payment = WithId<InferSchemaType<typeof PaymentSchema>>;
export type Allocation = WithId<InferSchemaType<typeof AllocationSchema>>;
export type BankAccount = WithId<InferSchemaType<typeof BankAccountSchema>>;
export type BankStatement = WithId<InferSchemaType<typeof BankStatementSchema>>;
export type BankStatementLine = WithId<InferSchemaType<typeof BankStatementLineSchema>>;
export type BankMatch = WithId<InferSchemaType<typeof BankMatchSchema>>;
export type BankReconciliation = WithId<InferSchemaType<typeof BankReconciliationSchema>>;
export type BankTransfer = WithId<InferSchemaType<typeof BankTransferSchema>>;
export type PurchaseRequisition = WithId<InferSchemaType<typeof PurchaseRequisitionSchema>>;
export type PurchaseOrderLine = InferSchemaType<typeof PurchaseOrderLineSchema>;
export type PurchaseOrder = WithId<InferSchemaType<typeof PurchaseOrderSchema>>;
export type GoodsReceipt = WithId<InferSchemaType<typeof GoodsReceiptSchema>>;
export type RequestForQuote = WithId<InferSchemaType<typeof RequestForQuoteSchema>>;
export type GroupInvestment = WithId<InferSchemaType<typeof GroupInvestmentSchema>>;
export type FxRevaluation = WithId<InferSchemaType<typeof FxRevaluationSchema>>;
export type ConsolidationAdjustment = WithId<InferSchemaType<typeof ConsolidationAdjustmentSchema>>;

export const SupplierCategorySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    /** Default expense (or asset) account for bills from suppliers in this category. */
    expenseAccountId: { type: ObjectId, default: null },
    isActive: { type: Boolean, default: true },
  },
  options,
);
SupplierCategorySchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** A score of a supplier's performance (1–5 on each measure), usually after goods were received on an order. */
export const SupplierRatingSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    supplierId: { type: ObjectId, required: true },
    purchaseOrderId: { type: ObjectId, default: null },
    purchaseOrderNumber: { type: String, default: '' },
    date: { type: Date, required: true },
    quality: { type: Number, required: true, min: 1, max: 5 },
    delivery: { type: Number, required: true, min: 1, max: 5 },
    price: { type: Number, required: true, min: 1, max: 5 },
    service: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
    ratedBy: { type: ObjectId, required: true },
    ratedByName: { type: String, default: '' },
  },
  options,
);
SupplierRatingSchema.index({ organisationId: 1, supplierId: 1, date: -1 });
SupplierRatingSchema.index({ organisationId: 1, purchaseOrderId: 1 }, { unique: true, partialFilterExpression: { purchaseOrderId: { $type: 'objectId' } } });

export type SupplierCategory = WithId<InferSchemaType<typeof SupplierCategorySchema>>;
export type SupplierRating = WithId<InferSchemaType<typeof SupplierRatingSchema>>;

// ---------------------------------------------------------------------------------------------
// Annual procurement plan
// ---------------------------------------------------------------------------------------------

export const PROCUREMENT_CATEGORIES = ['GOODS', 'WORKS', 'SERVICES', 'CONSULTANCY'] as const;
export const PROCUREMENT_METHODS = ['OPEN_TENDER', 'RESTRICTED_TENDER', 'REQUEST_FOR_QUOTATION', 'DIRECT', 'LOW_VALUE', 'FRAMEWORK', 'SPECIALLY_PERMITTED', 'REQUEST_FOR_PROPOSAL'] as const;
export const PLAN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;

/** One version of an entity's annual procurement plan; approving a revision supersedes the previous one. */
export const ProcurementPlanSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    fiscalYearId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    version: { type: Number, default: 1 },
    revisionOf: { type: ObjectId, default: null },
    notes: { type: String, default: '' },
    items: {
      type: [
        new Schema({
          itemNo: { type: Number, required: true },
          description: { type: String, required: true, trim: true },
          category: { type: String, enum: PROCUREMENT_CATEGORIES, required: true },
          method: { type: String, enum: PROCUREMENT_METHODS, required: true },
          departmentId: { type: ObjectId, default: null },
          accountId: { type: ObjectId, required: true },
          quantity: money,
          unit: { type: String, default: '' },
          estimatedCost: money,
          /** Quarter (1-4) in which the procurement starts. */
          quarter: { type: Number, required: true },
          sourceOfFunds: { type: String, default: '' },
          /** Set aside for youth, women and persons with disabilities (AGPO). */
          agpo: { type: Boolean, default: false },
        }),
      ],
      default: [],
    },
    total: money,
    status: { type: String, enum: PLAN_STATUSES, default: 'DRAFT' },
    createdBy: { type: ObjectId, required: true },
    submittedBy: { type: ObjectId, default: null },
    submittedAt: { type: Date, default: null },
    approvedBy: { type: ObjectId, default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: ObjectId, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
);
ProcurementPlanSchema.index({ organisationId: 1, entityId: 1, fiscalYearId: 1, status: 1 });
ProcurementPlanSchema.index({ organisationId: 1, number: 1 }, { unique: true });

export type ProcurementPlan = WithId<InferSchemaType<typeof ProcurementPlanSchema>>;

export const COMMERCIAL_MODELS = {
  ProcurementPlan: ProcurementPlanSchema,
  SupplierCategory: SupplierCategorySchema,
  SupplierRating: SupplierRatingSchema,
  TaxCode: TaxCodeSchema,
  TaxTransaction: TaxTransactionSchema,
  Customer: PartySchema,
  Supplier: PartySchema.clone(),
  Invoice: InvoiceSchema,
  Payment: PaymentSchema,
  Allocation: AllocationSchema,
  BankAccount: BankAccountSchema,
  BankStatement: BankStatementSchema,
  BankStatementLine: BankStatementLineSchema,
  BankMatch: BankMatchSchema,
  BankReconciliation: BankReconciliationSchema,
  BankTransfer: BankTransferSchema,
  PurchaseRequisition: PurchaseRequisitionSchema,
  PurchaseOrder: PurchaseOrderSchema,
  GoodsReceipt: GoodsReceiptSchema,
  RequestForQuote: RequestForQuoteSchema,
  FxRevaluation: FxRevaluationSchema,
  ConsolidationAdjustment: ConsolidationAdjustmentSchema,
  GroupInvestment: GroupInvestmentSchema,
} as const;
