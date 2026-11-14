import mongoose, { ClientSession, Connection, Model } from 'mongoose';
import {
  Account,
  AuditEvent,
  Branch,
  Counter,
  Currency,
  DimensionValue,
  ExchangeRate,
  FiscalYear,
  Journal,
  LedgerEntry,
  LegalEntity,
  MODELS,
  Organisation,
  Period,
  Role,
  User,
} from './schemas';
import {
  Allocation,
  BankAccount,
  BankMatch,
  BankReconciliation,
  BankStatement,
  BankStatementLine,
  BankTransfer,
  COMMERCIAL_MODELS,
  ConsolidationAdjustment,
  FxRevaluation,
  GoodsReceipt,
  GroupInvestment,
  Invoice,
  Party, SupplierCategory, SupplierRating, ProcurementPlan,
  Payment,
  PurchaseOrder,
  PurchaseRequisition,
  RequestForQuote,
  TaxCode,
  TaxTransaction,
} from './commercial.schemas';
import {
  AssetCategory,
  Budget,
  BudgetReallocation,
  BudgetSubmission,
  Investment,
  Programme,
  StoreRequisition,
  DepreciationRun,
  ExpenseCategory,
  ExpenseClaim,
  Imprest,
  ImprestType,
  FixedAsset,
  Item,
  LandedCost,
  OPERATIONAL_MODELS,
  PettyCashLimit,
  PettyCashVoucher,
  ItemCategory,
  StockLayer,
  EmailTemplate,
  Sponsorship,
  StockBalance,
  StockDocument,
  StockLot,
  StockMovement,
  Warehouse,
} from './operational.schemas';
import {
  ApiKey,
  ApprovalRequest,
  ApprovalRule,
  Delegation,
  IdempotencyRecord,
  LedgerFact,
  Notification,
  PLATFORM_MODELS,
  WarehouseState,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEvent,
} from './platform.schemas';
import { Attachment, GOVERNANCE_MODELS, Session } from './governance.schemas';
import { AiRequest, AUTOMATION_MODELS, CollectionActivity, RecurringJournal } from './automation.schemas';
import { AuthToken, COMMUNICATION_MODELS, EmailMessage, ReportSubscription, SmsMessage } from './communication.schemas';
import { CardPayment, MobileMoneyPayout, MobileMoneyTransaction, PAYMENTS_MODELS, PortalLink, Refund, SalaryRun, SupplierInvoiceSubmission, SupplierPortalLink } from './payments.schemas';
import { COMPLIANCE_MODELS, EtimsDevice, EtimsImport, EtimsItem, EtimsPurchase, EtimsStockReport, EtimsSubmission } from './compliance.schemas';

export const ALL_MODELS = { ...MODELS, ...COMMERCIAL_MODELS, ...OPERATIONAL_MODELS, ...PLATFORM_MODELS, ...GOVERNANCE_MODELS, ...AUTOMATION_MODELS, ...COMMUNICATION_MODELS, ...PAYMENTS_MODELS, ...COMPLIANCE_MODELS } as const;

/** Finance models are registered on the platform connection with this prefix (FinJournal → finance_journals). */
export const MODEL_PREFIX = 'Fin';

export function financeModelName(name: string): string {
  return `${MODEL_PREFIX}${name}`;
}

/** finance_ + mongoose's own pluralisation, so collection names read like the originals (finance_journals). */
export function financeCollection(name: string): string {
  return `finance_${mongoose.pluralize()!(name)}`;
}

/**
 * Registers every finance model on the platform's connection. Autoindexing is off: indexes are created
 * by ensureSchema() when the module first starts.
 */
export function registerFinanceModels(connection: Connection): Connection {
  for (const [name, schema] of Object.entries(ALL_MODELS)) {
    schema.set('autoIndex', false);
    schema.set('autoCreate', false);
    if (!connection.models[financeModelName(name)]) connection.model(financeModelName(name), schema, financeCollection(name));
  }
  return connection;
}

/** Opens a stand-alone connection (scripts and tests that run finance on its own database). */
export async function connect(uri: string): Promise<Connection> {
  const connection = mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, maxPoolSize: 10, serverSelectionTimeoutMS: 10_000 });
  registerFinanceModels(connection);
  await connection.asPromise();
  return connection;
}

/** Typed access to every collection plus a transaction helper. */
export class Db {
  constructor(readonly connection: Connection) {}

  /**
   * Creates collections and indexes. Collections must exist before they are touched inside a
   * transaction, and indexes enforce uniqueness rules. Idempotent.
   */
  async ensureSchema() {
    // Indexes replaced by later phases; dropped before the new ones are built.
    const obsolete: Record<string, string[]> = { MobileMoneyPayout: ['sourceId_1'] };
    for (const [name, indexes] of Object.entries(obsolete)) {
      for (const index of indexes) await this.connection.model(financeModelName(name)).collection.dropIndex(index).catch(() => undefined);
    }
    // Short-lived SAML sign-in state (not models): expired after an hour.
    for (const name of ['finance_samlflows', 'finance_samlrequests']) await this.connection.collection(name).createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
    await Promise.all(
      Object.keys(ALL_MODELS).map(async (name) => {
        const model = this.connection.model(financeModelName(name));
        await model.createCollection();
        await model.createIndexes();
      }),
    );
  }

  /**
   * Runs fn inside a multi-document ACID transaction, retrying on transient errors.
   * Financial postings always go through here so there are never partial accounting transactions.
   */
  transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.connection.transaction(fn);
  }

  private m<T>(name: keyof typeof ALL_MODELS): Model<T> {
    return this.connection.model<T>(financeModelName(name));
  }

  get organisations() {
    return this.m<Organisation>('Organisation');
  }
  get users() {
    return this.m<User>('User');
  }
  get roles() {
    return this.m<Role>('Role');
  }
  get currencies() {
    return this.m<Currency>('Currency');
  }
  get exchangeRates() {
    return this.m<ExchangeRate>('ExchangeRate');
  }
  get entities() {
    return this.m<LegalEntity>('LegalEntity');
  }
  get branches() {
    return this.m<Branch>('Branch');
  }
  get dimensions() {
    return this.m<DimensionValue>('DimensionValue');
  }
  get accounts() {
    return this.m<Account>('Account');
  }
  get fiscalYears() {
    return this.m<FiscalYear>('FiscalYear');
  }
  get periods() {
    return this.m<Period>('Period');
  }
  get journals() {
    return this.m<Journal>('Journal');
  }
  get ledger() {
    return this.m<LedgerEntry>('LedgerEntry');
  }
  get counters() {
    return this.m<Counter>('Counter');
  }
  get auditEvents() {
    return this.m<AuditEvent>('AuditEvent');
  }
  get taxCodes() {
    return this.m<TaxCode>('TaxCode');
  }
  get taxTransactions() {
    return this.m<TaxTransaction>('TaxTransaction');
  }
  get customers() {
    return this.m<Party>('Customer');
  }
  get suppliers() {
    return this.m<Party>('Supplier');
  }
  get supplierCategories() {
    return this.m<SupplierCategory>('SupplierCategory');
  }
  get supplierRatings() {
    return this.m<SupplierRating>('SupplierRating');
  }
  get invoices() {
    return this.m<Invoice>('Invoice');
  }
  get payments() {
    return this.m<Payment>('Payment');
  }
  get allocations() {
    return this.m<Allocation>('Allocation');
  }
  get bankAccounts() {
    return this.m<BankAccount>('BankAccount');
  }
  get bankStatements() {
    return this.m<BankStatement>('BankStatement');
  }
  get bankStatementLines() {
    return this.m<BankStatementLine>('BankStatementLine');
  }
  get bankMatches() {
    return this.m<BankMatch>('BankMatch');
  }
  get bankReconciliations() {
    return this.m<BankReconciliation>('BankReconciliation');
  }
  get bankTransfers() {
    return this.m<BankTransfer>('BankTransfer');
  }
  get requisitions() {
    return this.m<PurchaseRequisition>('PurchaseRequisition');
  }
  get purchaseOrders() {
    return this.m<PurchaseOrder>('PurchaseOrder');
  }
  get groupInvestments() {
    return this.m<GroupInvestment>('GroupInvestment');
  }
  get goodsReceipts() {
    return this.m<GoodsReceipt>('GoodsReceipt');
  }
  get rfqs() {
    return this.m<RequestForQuote>('RequestForQuote');
  }
  get fxRevaluations() {
    return this.m<FxRevaluation>('FxRevaluation');
  }
  get consolidationAdjustments() {
    return this.m<ConsolidationAdjustment>('ConsolidationAdjustment');
  }
  get items() {
    return this.m<Item>('Item');
  }
  get warehouses() {
    return this.m<Warehouse>('Warehouse');
  }
  get stockBalances() {
    return this.m<StockBalance>('StockBalance');
  }
  get stockMovements() {
    return this.m<StockMovement>('StockMovement');
  }
  get stockLots() {
    return this.m<StockLot>('StockLot');
  }
  get stockDocuments() {
    return this.m<StockDocument>('StockDocument');
  }
  get landedCosts() {
    return this.m<LandedCost>('LandedCost');
  }
  get assetCategories() {
    return this.m<AssetCategory>('AssetCategory');
  }
  get fixedAssets() {
    return this.m<FixedAsset>('FixedAsset');
  }
  get depreciationRuns() {
    return this.m<DepreciationRun>('DepreciationRun');
  }
  get expenseCategories() {
    return this.m<ExpenseCategory>('ExpenseCategory');
  }
  get expenseClaims() {
    return this.m<ExpenseClaim>('ExpenseClaim');
  }
  get imprestTypes() {
    return this.m<ImprestType>('ImprestType');
  }
  get imprests() {
    return this.m<Imprest>('Imprest');
  }
  get pettyCashLimits() {
    return this.m<PettyCashLimit>('PettyCashLimit');
  }
  get pettyCashVouchers() {
    return this.m<PettyCashVoucher>('PettyCashVoucher');
  }
  get emailTemplates() {
    return this.m<EmailTemplate>('EmailTemplate');
  }
  get stockLayers() {
    return this.m<StockLayer>('StockLayer');
  }
  get itemCategories() {
    return this.m<ItemCategory>('ItemCategory');
  }
  get sponsorships() {
    return this.m<Sponsorship>('Sponsorship');
  }
  get budgets() {
    return this.m<Budget>('Budget');
  }
  get budgetSubmissions() {
    return this.m<BudgetSubmission>('BudgetSubmission');
  }
  get budgetReallocations() {
    return this.m<BudgetReallocation>('BudgetReallocation');
  }
  get investments() {
    return this.m<Investment>('Investment');
  }
  get programmes() {
    return this.m<Programme>('Programme');
  }
  get storeRequisitions() {
    return this.m<StoreRequisition>('StoreRequisition');
  }
  get procurementPlans() {
    return this.m<ProcurementPlan>('ProcurementPlan');
  }
  get apiKeys() {
    return this.m<ApiKey>('ApiKey');
  }
  get idempotency() {
    return this.m<IdempotencyRecord>('IdempotencyRecord');
  }
  get webhookEndpoints() {
    return this.m<WebhookEndpoint>('WebhookEndpoint');
  }
  get webhookEvents() {
    return this.m<WebhookEvent>('WebhookEvent');
  }
  get webhookDeliveries() {
    return this.m<WebhookDelivery>('WebhookDelivery');
  }
  get approvalRules() {
    return this.m<ApprovalRule>('ApprovalRule');
  }
  get approvalRequests() {
    return this.m<ApprovalRequest>('ApprovalRequest');
  }
  get delegations() {
    return this.m<Delegation>('Delegation');
  }
  get notifications() {
    return this.m<Notification>('Notification');
  }
  get ledgerFacts() {
    return this.m<LedgerFact>('LedgerFact');
  }
  get attachments() {
    return this.m<Attachment>('Attachment');
  }
  get sessions() {
    return this.m<Session>('Session');
  }
  get recurringJournals() {
    return this.m<RecurringJournal>('RecurringJournal');
  }
  get collectionActivities() {
    return this.m<CollectionActivity>('CollectionActivity');
  }
  get aiRequests() {
    return this.m<AiRequest>('AiRequest');
  }
  get emails() {
    return this.m<EmailMessage>('EmailMessage');
  }
  get sms() {
    return this.m<SmsMessage>('SmsMessage');
  }
  get authTokens() {
    return this.m<AuthToken>('AuthToken');
  }
  get reportSubscriptions() {
    return this.m<ReportSubscription>('ReportSubscription');
  }
  get mobileMoney() {
    return this.m<MobileMoneyTransaction>('MobileMoneyTransaction');
  }
  get payouts() {
    return this.m<MobileMoneyPayout>('MobileMoneyPayout');
  }
  get refunds() {
    return this.m<Refund>('Refund');
  }
  get salaryRuns() {
    return this.m<SalaryRun>('SalaryRun');
  }
  get cardPayments() {
    return this.m<CardPayment>('CardPayment');
  }
  get portalLinks() {
    return this.m<PortalLink>('PortalLink');
  }
  get supplierPortalLinks() {
    return this.m<SupplierPortalLink>('SupplierPortalLink');
  }
  get supplierInvoiceSubmissions() {
    return this.m<SupplierInvoiceSubmission>('SupplierInvoiceSubmission');
  }
  get etimsDevices() {
    return this.m<EtimsDevice>('EtimsDevice');
  }
  get etimsItems() {
    return this.m<EtimsItem>('EtimsItem');
  }
  get etimsPurchases() {
    return this.m<EtimsPurchase>('EtimsPurchase');
  }
  get etimsImports() {
    return this.m<EtimsImport>('EtimsImport');
  }
  get etimsStockReports() {
    return this.m<EtimsStockReport>('EtimsStockReport');
  }
  get etimsSubmissions() {
    return this.m<EtimsSubmission>('EtimsSubmission');
  }
  get warehouseState() {
    return this.m<WarehouseState>('WarehouseState');
  }

  /** Atomically allocates the next number in a sequence (e.g. journal numbers per entity). */
  async nextSequence(
    organisationId: unknown,
    entityId: unknown,
    key: string,
    session?: ClientSession,
  ): Promise<number> {
    const counter = await this.counters.findOneAndUpdate(
      { organisationId, entityId, key },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session },
    );
    return counter!.seq;
  }

  /** Allocates a document number such as INV-KE01-000042. */
  async nextNumber(
    organisationId: unknown,
    entity: { _id: unknown; code: string },
    prefix: string,
    session?: ClientSession,
  ): Promise<string> {
    const seq = await this.nextSequence(organisationId, entity._id, prefix.toLowerCase(), session);
    return `${prefix}-${entity.code}-${String(seq).padStart(6, '0')}`;
  }
}
