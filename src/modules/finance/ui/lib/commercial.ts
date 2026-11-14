/** Types and per-side configuration for commercial finance (receivables, payables, banking, procurement). */

export type PartyType = 'CUSTOMER' | 'SUPPLIER';
export type DocumentKind = 'SALES_INVOICE' | 'SALES_CREDIT' | 'PURCHASE_BILL' | 'PURCHASE_CREDIT';
export type DocumentStatus = 'DRAFT' | 'SUBMITTED' | 'REJECTED' | 'POSTED' | 'VOID';
export type PaymentKind = 'RECEIPT' | 'PAYMENT';

export interface TaxCode {
  id: string;
  code: string;
  name: string;
  description: string;
  kind: 'VAT' | 'WITHHOLDING';
  country: string;
  rates: { rate: string; effectiveFrom: string }[];
  outputAccountId: string;
  inputAccountId: string | null;
  /** Kenya eTIMS tax type (A exempt, B 16%, C zero-rated, D non-VAT, E 8%). */
  etimsTaxType?: 'A' | 'B' | 'C' | 'D' | 'E' | null;
  isActive: boolean;
}

export interface Party {
  id: string;
  code: string;
  name: string;
  legalName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  taxId: string;
  currency: string;
  paymentTermsDays: number;
  defaultAccountId: string | null;
  defaultTaxCodeId: string | null;
  creditLimit: string | null;
  onHold: boolean;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankBranch: string;
  withholdingTaxCodeId: string | null;
  /** Customers: taxes they withhold from payments to us. */
  withholdingTaxCodeIds?: string[];
  /** Suppliers paid through M-Pesa. */
  mpesaPayee?: { type: 'PHONE' | 'PAYBILL' | 'TILL'; number: string; accountReference: string } | null;
  intercompanyEntityId: string | null;
  notes: string;
  isActive: boolean;
  outstanding: string;
  overdue: string;
  unappliedCredits: string;
}

export interface DocumentLine {
  lineNo: number;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string | null;
  taxCodeId: string | null;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  poLineNo: number | null;
  itemId: string | null;
  warehouseId: string | null;
  /** Tracked stock: the batches or serial numbers moved. */
  lots?: { number: string; expiryDate: string | null; quantity: string }[];
  costOfSales: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  projectId: string | null;
}

export interface Allocation {
  id: string;
  date: string;
  documentId: string;
  documentNumber: string;
  sourceType: 'PAYMENT' | 'CREDIT_NOTE';
  sourceId: string;
  sourceNumber: string;
  currency: string;
  amount: string;
  fxAmount: string;
  journalId: string | null;
  status: 'ACTIVE' | 'REVERSED';
}

export interface Trail {
  createdBy: string;
  createdAt: string;
  createdByName?: string | null;
  submittedBy?: string | null;
  submittedAt: string | null;
  submittedByName?: string | null;
  approvedAt: string | null;
  approvedByName?: string | null;
  rejectedAt: string | null;
  rejectedByName?: string | null;
  rejectionReason: string;
  voidedAt?: string | null;
  voidedByName?: string | null;
  voidReason?: string;
}

export interface CommercialDocument extends Trail {
  id: string;
  /** Sales documents: when last emailed to the customer. */
  emailedAt?: string | null;
  /** Sales documents in a KRA eTIMS branch. */
  etims?: { status: string; invcNo: number | null; rcptSign: string | null; qrUrl: string | null } | null;
  entityId: string;
  branchId: string;
  kind: DocumentKind;
  number: string;
  partyId: string;
  partyName: string;
  date: string;
  dueDate: string;
  reference: string;
  supplierInvoiceNumber: string;
  purchaseOrderId: string | null;
  appliesToId: string | null;
  currency: string;
  exchangeRate: string;
  functionalCurrency: string;
  priceIncludesTax: boolean;
  lines: DocumentLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
  totalFunctional: string;
  amountDue: string;
  amountDueFunctional: string;
  status: DocumentStatus;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID';
  matchStatus: 'NOT_REQUIRED' | 'MATCHED' | 'VARIANCE' | 'OVERRIDDEN';
  matchNotes: string[];
  notes: string;
  journalId: string | null;
  voidJournalId: string | null;
}

export interface PurchaseOrderLine {
  lineNo: number;
  description: string;
  accountId: string;
  planItemId?: string | null;
  quantity: string;
  unitPrice: string;
  taxCodeId: string | null;
  netAmount: string;
  taxAmount: string;
  quantityReceived: string;
  quantityBilled: string;
  /** Stock lines: received into this warehouse on the goods received note. */
  itemId?: string | null;
  warehouseId?: string | null;
  receivedValue?: string | null;
  billedValue?: string | null;
  departmentId: string | null;
  costCentreId: string | null;
  projectId: string | null;
}

export interface DocumentDetail extends CommercialDocument {
  party: {
    id: string;
    code: string;
    name: string;
    email: string;
    phone: string;
    address: string;
    city: string;
    country: string;
    taxId: string;
    creditLimit: string | null;
    onHold: boolean;
    outstanding: string;
  } | null;
  allocations: Allocation[];
  journalNumber: string | null;
  voidJournalNumber: string | null;
  purchaseOrder: { id: string; number: string; lines: PurchaseOrderLine[] } | null;
  appliesToNumber: string | null;
  creditNotes: { id: string; number: string; status: DocumentStatus; total: string }[];
  matchPreview: string[] | null;
}

export interface Payment extends Trail {
  id: string;
  entityId: string;
  branchId: string;
  kind: PaymentKind;
  number: string;
  partyType: PartyType;
  partyId: string;
  partyName: string;
  date: string;
  bankAccountId: string;
  bankAccountName?: string;
  method: string;
  reference: string;
  description: string;
  currency: string;
  exchangeRate: string;
  functionalCurrency: string;
  amount: string;
  amountFunctional: string;
  withholdingTaxCodeId: string | null;
  withholdingAmount: string;
  /** Receipts: taxes the customer withheld, each recoverable with its certificate. */
  withholdingTaxCodeIds?: string[];
  customerWithholdings?: { taxCodeId: string; taxCode: string; rate: string; base: string; amount: string; amountFunctional: string; certificateNumber: string; certificateDate: string | null }[];
  unallocated: string;
  plannedAllocations: { documentId: string; amount: string }[];
  status: DocumentStatus;
  journalId: string | null;
  batchId: string | null;
}

export interface PaymentDetail extends Payment {
  bankAccount: { id: string; name: string; accountNumber: string; currency: string } | null;
  allocations: Allocation[];
  plannedDocuments: { id: string; number: string; date: string; dueDate: string; total: string; amountDue: string; subtotal: string; supplierInvoiceNumber: string }[];
  withholdingTaxCode: { id: string; code: string; name: string } | null;
  journalNumber: string | null;
  voidJournalNumber: string | null;
  remittanceSentTo?: string;
  remittanceSentAt?: string | null;
}

export interface OpenCredit {
  type: 'PAYMENT' | 'CREDIT_NOTE';
  id: string;
  number: string;
  date: string;
  currency: string;
  available: string;
  reference: string;
}

export interface OpenItems {
  documents: CommercialDocument[];
  credits: OpenCredit[];
}

export interface BankAccount {
  id: string;
  entityId: string;
  branchId: string;
  name: string;
  type: 'BANK' | 'CASH' | 'MOBILE_MONEY' | 'PETTY_CASH';
  bankName: string;
  accountNumber: string;
  currency: string;
  glAccountId: string;
  glAccountCode?: string;
  glAccountName?: string;
  isActive: boolean;
  reconcileFrom: string | null;
  lastReconciledDate: string | null;
  lastReconciledBalance: string | null;
  balance: string;
  unmatchedStatementLines: number;
  /** The M-Pesa connection, without credentials. */
  mpesa?: { enabled: boolean; environment?: 'sandbox' | 'production'; shortCode?: string; shortCodeType?: 'PAYBILL' | 'TILL' };
}

export interface PurchaseOrder extends Trail {
  id: string;
  entityId: string;
  branchId: string;
  number: string;
  supplierId: string;
  supplierName: string;
  date: string;
  expectedDate: string | null;
  reference: string;
  notes: string;
  deliveryAddress: string;
  requisitionId: string | null;
  currency: string;
  exchangeRate: string;
  priceIncludesTax: boolean;
  lines: PurchaseOrderLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
  totalFunctional: string;
  status: string;
  receivedPercent: string;
  billedPercent: string;
}

export interface Requisition extends Trail {
  id: string;
  entityId: string;
  branchId: string;
  number: string;
  date: string;
  requiredBy: string | null;
  description: string;
  currency: string;
  lines: { lineNo: number; description: string; accountId: string | null; quantity: string; estimatedUnitPrice: string; departmentId: string | null; costCentreId: string | null; projectId: string | null; planItemId?: string | null }[];
  estimatedTotal: string;
  status: string;
  purchaseOrderIds: string[];
  createdByName?: string;
}

// ---------------------------------------------------------------------------------------------
// Sales vs purchases: one set of screens, configured per side
// ---------------------------------------------------------------------------------------------

export interface SideConfig {
  partyType: PartyType;
  party: string;
  parties: string;
  partiesPath: string;
  documentKind: DocumentKind;
  creditKind: DocumentKind;
  documentsPath: string;
  paymentKind: PaymentKind;
  paymentsPath: string;
  payment: string;
  payments: string;
  perms: { view: string; manage: string; approve: string };
  accountClasses: string[];
}

export const SALES: SideConfig = {
  partyType: 'CUSTOMER',
  party: 'Customer',
  parties: 'Customers',
  partiesPath: '/sales/customers',
  documentKind: 'SALES_INVOICE',
  creditKind: 'SALES_CREDIT',
  documentsPath: '/sales/invoices',
  paymentKind: 'RECEIPT',
  paymentsPath: '/sales/receipts',
  payment: 'Receipt',
  payments: 'Receipts',
  perms: { view: 'ar.view', manage: 'ar.manage', approve: 'ar.approve' },
  accountClasses: ['REVENUE', 'LIABILITY', 'EQUITY', 'ASSET'],
};

export const PURCHASES: SideConfig = {
  partyType: 'SUPPLIER',
  party: 'Supplier',
  parties: 'Suppliers',
  partiesPath: '/purchases/suppliers',
  documentKind: 'PURCHASE_BILL',
  creditKind: 'PURCHASE_CREDIT',
  documentsPath: '/purchases/bills',
  paymentKind: 'PAYMENT',
  paymentsPath: '/purchases/payments',
  payment: 'Payment',
  payments: 'Payments',
  perms: { view: 'ap.view', manage: 'ap.manage', approve: 'ap.approve' },
  accountClasses: ['EXPENSE', 'COST_OF_SALES', 'ASSET', 'LIABILITY'],
};

export const sideOf = (kind: DocumentKind | PaymentKind | PartyType): SideConfig =>
  ['SALES_INVOICE', 'SALES_CREDIT', 'RECEIPT', 'CUSTOMER'].includes(kind) ? SALES : PURCHASES;

export const KIND_LABEL: Record<DocumentKind, string> = {
  SALES_INVOICE: 'Invoice',
  SALES_CREDIT: 'Credit note',
  PURCHASE_BILL: 'Bill',
  PURCHASE_CREDIT: 'Supplier credit',
};

export const PAYMENT_METHODS: [string, string][] = [
  ['BANK_TRANSFER', 'Bank transfer'],
  ['CHEQUE', 'Cheque'],
  ['CASH', 'Cash'],
  ['CARD', 'Card'],
  ['MOBILE_MONEY', 'Mobile money'],
  ['OTHER', 'Other'],
];

/** Tax rate (percent) in force on a date, as the server computes it. */
export function rateOn(code: TaxCode | undefined, date: string): string {
  if (!code) return '0';
  const applicable = code.rates.filter((r) => r.effectiveFrom.slice(0, 10) <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return applicable?.rate ?? '0';
}
