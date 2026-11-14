import { InferSchemaType, Schema, Types } from 'mongoose';

/**
 * Phase 9 (getting paid) data model: mobile-money transactions (M-Pesa) and customer portal links.
 */

const ObjectId = Schema.Types.ObjectId;
const Decimal128 = Schema.Types.Decimal128;
const options = { timestamps: true, versionKey: false } as const;

export const MOBILE_MONEY_STATUSES = ['PENDING', 'FAILED', 'UNMATCHED', 'RECEIPTED', 'IGNORED'] as const;

/**
 * One payment through M-Pesa: a paybill/till payment (C2B) or a payment prompt sent to a phone (STK).
 * STK requests start PENDING and become a payment when Safaricom confirms them.
 */
export const MobileMoneyTransactionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    provider: { type: String, enum: ['MPESA'], default: 'MPESA' },
    kind: { type: String, enum: ['C2B', 'STK'], required: true },
    /** The M-Pesa receipt number (e.g. QJK3H2XYZ1); unique per account once known. */
    transactionId: { type: String, default: null },
    amount: { type: Decimal128, default: null },
    phone: { type: String, default: '' },
    payerName: { type: String, default: '' },
    /** What the payer typed as the account number, or the reference sent with a prompt. */
    accountReference: { type: String, default: '' },
    transactionDate: { type: Date, default: null },
    status: { type: String, enum: MOBILE_MONEY_STATUSES, required: true },
    resultDescription: { type: String, default: '' },
    customerId: { type: ObjectId, default: null },
    invoiceId: { type: ObjectId, default: null },
    paymentId: { type: ObjectId, default: null },
    statementLineId: { type: ObjectId, default: null },
    /** STK only: Safaricom's request identifiers and who asked. */
    checkoutRequestId: { type: String, default: null },
    merchantRequestId: { type: String, default: null },
    requestedBy: { type: ObjectId, default: null },
    requestedVia: { type: String, enum: ['app', 'portal', null], default: null },
    /** STK only: when M-Pesa was last asked whether the prompt was completed. */
    queriedAt: { type: Date, default: null },
    note: { type: String, default: '' },
  },
  options,
);
MobileMoneyTransactionSchema.index({ bankAccountId: 1, transactionId: 1 }, { unique: true, partialFilterExpression: { transactionId: { $type: 'string' } } });
MobileMoneyTransactionSchema.index({ checkoutRequestId: 1 }, { unique: true, partialFilterExpression: { checkoutRequestId: { $type: 'string' } } });
MobileMoneyTransactionSchema.index({ organisationId: 1, status: 1, createdAt: -1 });

/** A private link that lets a customer see their invoices and pay, without signing in. */
export const PortalLinkSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, required: true },
    lastViewedAt: { type: Date, default: null },
    views: { type: Number, default: 0 },
  },
  options,
);
PortalLinkSchema.index({ organisationId: 1, customerId: 1, revokedAt: 1 });

export const PAYOUT_STATUSES = ['QUEUED', 'SENT', 'COMPLETED', 'FAILED', 'CHECK', 'CANCELLED'] as const;

/**
 * Money paid out through M-Pesa for a released supplier payment or a reimbursed expense claim.
 * QUEUED → SENT (accepted by Safaricom) → COMPLETED or FAILED (result callback). CHECK means M-Pesa
 * did not answer: the money may or may not have gone, so it is never resent automatically.
 */
export const MobileMoneyPayoutSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    sourceType: { type: String, enum: ['Payment', 'ExpenseClaim', 'Refund', 'SalaryRun'], required: true },
    sourceId: { type: ObjectId, required: true },
    /** Salary runs: the employee line paid (one payout each); 0 otherwise. */
    sourceLine: { type: Number, default: 0 },
    sourceNumber: { type: String, required: true },
    journalId: { type: ObjectId, required: true },
    payeeName: { type: String, required: true },
    payeeType: { type: String, enum: ['PHONE', 'PAYBILL', 'TILL'], required: true },
    payeeNumber: { type: String, required: true },
    accountReference: { type: String, default: '' },
    amount: { type: Decimal128, required: true },
    status: { type: String, enum: PAYOUT_STATUSES, default: 'QUEUED' },
    /** Ours, sent with the request; a new one on each deliberate retry. */
    originatorConversationId: { type: String, required: true },
    conversationId: { type: String, default: null },
    transactionId: { type: String, default: null },
    resultCode: { type: String, default: null },
    resultDescription: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    statementLineId: { type: ObjectId, default: null },
    /** Transaction-status queries sent to resolve an unconfirmed payout. */
    statusQueriedAt: { type: Date, default: null },
    statusQueries: { type: Number, default: 0 },
    requestedBy: { type: ObjectId, required: true },
    /** The M-Pesa charge booked for this payout (from the account's tariff), and its journal. */
    charge: { type: Decimal128, default: null },
    chargeJournalId: { type: ObjectId, default: null },
    note: { type: String, default: '' },
  },
  options,
);
MobileMoneyPayoutSchema.index({ originatorConversationId: 1 }, { unique: true });
MobileMoneyPayoutSchema.index({ sourceId: 1, sourceLine: 1 }, { unique: true });
MobileMoneyPayoutSchema.index({ organisationId: 1, status: 1, createdAt: -1 });
MobileMoneyPayoutSchema.index({ bankAccountId: 1, createdAt: -1 });

const approval = {
  createdBy: { type: ObjectId, required: true },
  approvedBy: { type: ObjectId, default: null },
  approvedAt: { type: Date, default: null },
  voidedBy: { type: ObjectId, default: null },
  voidedAt: { type: Date, default: null },
  voidReason: { type: String, default: '' },
  voidJournalId: { type: ObjectId, default: null },
};

/**
 * Money paid back to a customer out of what they hold with us: receipts not applied to invoices and
 * credit notes not yet used. Posting debits receivables (clearing those credits) and credits the bank;
 * from an account with M-Pesa payouts, the money is sent to the customer's phone.
 */
export const RefundSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    partyId: { type: ObjectId, required: true },
    partyName: { type: String, required: true },
    date: { type: Date, required: true },
    bankAccountId: { type: ObjectId, required: true },
    method: { type: String, enum: ['BANK_TRANSFER', 'CHEQUE', 'CASH', 'MOBILE_MONEY', 'CARD', 'OTHER'], default: 'BANK_TRANSFER' },
    /** M-Pesa refunds: the phone the money goes to. */
    payeePhone: { type: String, default: '' },
    reference: { type: String, default: '' },
    description: { type: String, default: '' },
    currency: { type: String, required: true },
    exchangeRate: { type: Decimal128, required: true },
    functionalCurrency: { type: String, required: true },
    amount: { type: Decimal128, required: true },
    amountFunctional: { type: Decimal128, required: true },
    /** The credits refunded, with the carrying value cleared from receivables. */
    sources: {
      type: [
        new Schema(
          {
            type: { type: String, enum: ['PAYMENT', 'CREDIT_NOTE'], required: true },
            id: { type: ObjectId, required: true },
            number: { type: String, required: true },
            branchId: { type: ObjectId, required: true },
            amount: { type: Decimal128, required: true },
            functional: { type: Decimal128, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    status: { type: String, enum: ['DRAFT', 'POSTED', 'VOID'], default: 'DRAFT' },
    journalId: { type: ObjectId, default: null },
    ...approval,
  },
  options,
);
RefundSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
RefundSchema.index({ organisationId: 1, partyId: 1, date: -1 });
RefundSchema.index({ 'sources.id': 1, status: 1 });

/**
 * Net pay for a period paid to employees (payroll itself is run elsewhere): each line clears net salaries
 * payable and leaves the bank; from an account with M-Pesa payouts each employee is paid to their phone.
 */
export const SalaryRunSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    branchId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    /** Pay period, YYYY-MM. */
    period: { type: String, required: true },
    date: { type: Date, required: true },
    description: { type: String, default: '' },
    bankAccountId: { type: ObjectId, required: true },
    payableAccountId: { type: ObjectId, required: true },
    lines: {
      type: [
        new Schema(
          {
            lineNo: { type: Number, required: true },
            employeeNumber: { type: String, default: '' },
            employeeName: { type: String, required: true },
            phone: { type: String, default: '' },
            amount: { type: Decimal128, required: true },
            departmentId: { type: ObjectId, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    total: { type: Decimal128, required: true },
    status: { type: String, enum: ['DRAFT', 'POSTED', 'VOID'], default: 'DRAFT' },
    journalId: { type: ObjectId, default: null },
    ...approval,
  },
  options,
);
SalaryRunSchema.index({ organisationId: 1, entityId: 1, number: 1 }, { unique: true });
SalaryRunSchema.index({ organisationId: 1, entityId: 1, period: 1 });

/** A card payment started from the customer portal (hosted checkout); becomes a receipt when the gateway confirms it. */
export const CardPaymentSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    entityId: { type: ObjectId, required: true },
    bankAccountId: { type: ObjectId, required: true },
    customerId: { type: ObjectId, required: true },
    invoiceId: { type: ObjectId, required: true },
    portalLinkId: { type: ObjectId, default: null },
    provider: { type: String, required: true },
    /** The gateway's checkout session and payment ids. */
    sessionId: { type: String, required: true },
    paymentReference: { type: String, default: '' },
    currency: { type: String, required: true },
    amount: { type: Decimal128, required: true },
    status: { type: String, enum: ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'UNMATCHED'], default: 'PENDING' },
    paymentId: { type: ObjectId, default: null },
    note: { type: String, default: '' },
  },
  options,
);
CardPaymentSchema.index({ provider: 1, sessionId: 1 }, { unique: true });
CardPaymentSchema.index({ organisationId: 1, status: 1, createdAt: -1 });

/** A supplier's private link to the vendor portal: orders, invoices, payments, and sending invoices. */
export const SupplierPortalLinkSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    supplierId: { type: ObjectId, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    createdBy: { type: ObjectId, required: true },
    lastViewedAt: { type: Date, default: null },
    views: { type: Number, default: 0 },
  },
  options,
);
SupplierPortalLinkSchema.index({ organisationId: 1, supplierId: 1, revokedAt: 1 });

/** An invoice a supplier sent through the vendor portal, waiting for accounts payable to enter it. */
export const SupplierInvoiceSubmissionSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    supplierId: { type: ObjectId, required: true },
    purchaseOrderId: { type: ObjectId, default: null },
    invoiceNumber: { type: String, required: true },
    invoiceDate: { type: Date, required: true },
    amount: { type: Decimal128, required: true },
    currency: { type: String, default: 'KES' },
    etimsNumber: { type: String, default: '' },
    note: { type: String, default: '' },
    status: { type: String, enum: ['SUBMITTED', 'ENTERED', 'REJECTED'], default: 'SUBMITTED' },
    billId: { type: ObjectId, default: null },
    decidedBy: { type: ObjectId, default: null },
    decidedAt: { type: Date, default: null },
    reason: { type: String, default: '' },
  },
  options,
);
SupplierInvoiceSubmissionSchema.index({ organisationId: 1, supplierId: 1, invoiceNumber: 1 }, { unique: true });
SupplierInvoiceSubmissionSchema.index({ organisationId: 1, status: 1, createdAt: -1 });

export const PAYMENTS_MODELS = {
  SupplierPortalLink: SupplierPortalLinkSchema,
  SupplierInvoiceSubmission: SupplierInvoiceSubmissionSchema,
  MobileMoneyPayout: MobileMoneyPayoutSchema,
  MobileMoneyTransaction: MobileMoneyTransactionSchema,
  PortalLink: PortalLinkSchema,
  Refund: RefundSchema,
  SalaryRun: SalaryRunSchema,
  CardPayment: CardPaymentSchema,
} as const;

type WithId<T> = T & { _id: Types.ObjectId };
export type MobileMoneyTransaction = WithId<InferSchemaType<typeof MobileMoneyTransactionSchema>>;
export type MobileMoneyPayout = WithId<InferSchemaType<typeof MobileMoneyPayoutSchema>>;
export type PortalLink = WithId<InferSchemaType<typeof PortalLinkSchema>>;
export type SupplierPortalLink = WithId<InferSchemaType<typeof SupplierPortalLinkSchema>>;
export type SupplierInvoiceSubmission = WithId<InferSchemaType<typeof SupplierInvoiceSubmissionSchema>>;
export type Refund = WithId<InferSchemaType<typeof RefundSchema>>;
export type SalaryRun = WithId<InferSchemaType<typeof SalaryRunSchema>>;
export type CardPayment = WithId<InferSchemaType<typeof CardPaymentSchema>>;
