import { connect, Db } from './database/db.service';
import { AuditService } from './modules/audit/audit.service';
import { BankingService } from './modules/banking/banking.service';
import { ConsolidationService } from './modules/consolidation/consolidation.service';
import { CurrenciesService } from './modules/currencies/currencies.service';
import { DocumentsService } from './modules/documents/documents.service';
import { FxReportsService } from './modules/fx/fx-reports.service';
import { RevaluationService } from './modules/fx/revaluation.service';
import { JournalsService } from './modules/journals/journals.service';
import { InventoryService } from './modules/inventory/inventory.service';
import { RfqService } from './modules/procurement/rfq.service';
import { LandedCostsService } from './modules/inventory/landed-costs.service';
import { AssetsService } from './modules/assets/assets.service';
import { BudgetsService } from './modules/budgets/budgets.service';
import { ExpensesService } from './modules/expenses/expenses.service';
import { ImprestService } from './modules/expenses/imprest.service';
import { PettyCashService } from './modules/expenses/petty-cash.service';
import { RemittanceService } from './modules/payments/remittance.service';
import { ChequeSigningService } from './modules/payments/cheque-signing.service';
import { SponsorshipsService } from './modules/expenses/sponsorships.service';
import { StockControlService } from './modules/inventory/stock-control.service';
import { EmailTemplatesService } from './modules/communication/email-templates';
import { PaymentsService } from './modules/payments/payments.service';
import { VoucherService } from './modules/payments/voucher.service';
import { AssetCareService } from './modules/assets/asset-care.service';
import { SupplierManagementService } from './modules/procurement/supplier-management.service';
import { SupplierPortalService } from './modules/procurement/supplier-portal.service';
import { BudgetPlanningService } from './modules/budgets/budget-planning.service';
import { InvestmentsService } from './modules/banking/investments.service';
import { ProcurementPlanService } from './modules/procurement/procurement-plan.service';
import { ProgrammesService } from './modules/budgets/programmes.service';
import { RfqEvaluationService } from './modules/procurement/rfq-evaluation.service';
import { PoAmendmentsService } from './modules/procurement/po-amendments.service';
import { InspectionService } from './modules/procurement/inspection.service';
import { StoreRequisitionsService } from './modules/inventory/store-requisitions.service';
import { PeriodsService } from './modules/periods/periods.service';
import { ProcurementService } from './modules/procurement/procurement.service';
import { MigrationsService } from './modules/provisioning/migrations.service';
import { ProvisioningService } from './modules/provisioning/provisioning.service';
import { ReportsService } from './modules/reports/reports.service';
import { SubledgerReportsService } from './modules/reports/subledger-reports.service';
import { SettlementService } from './modules/settlement/settlement.service';
import { TaxService } from './modules/tax/tax.service';
import { ApiKeysService } from './modules/integrations/api-keys.service';
import { WebhooksService } from './modules/integrations/webhooks.service';
import { WorkflowService } from './modules/workflow/workflow.service';
import { AnalyticsService } from './modules/analytics/analytics.service';
import { WarehouseService } from './modules/analytics/warehouse.service';
import { AttachmentsService } from './modules/documents/attachments.service';
import { PackService } from './modules/reports/pack.service';
import { RecurringService } from './modules/automation/recurring.service';
import { CollectionsService } from './modules/automation/collections.service';
import { SuggestionsService } from './modules/automation/suggestions.service';
import { AiService } from './modules/automation/ai.service';
import { AccountService } from './modules/communication/account.service';
import { EmailService } from './modules/communication/email.service';
import { NotificationEmailService } from './modules/communication/notifications.service';
import { SsoService } from './modules/communication/sso.service';
import { SmsService } from './modules/communication/sms.service';
import { BillingService } from './modules/payments/billing.service';
import { MpesaService } from './modules/payments/mpesa.service';
import { PortalService } from './modules/payments/portal.service';
import { ScimService } from './modules/communication/scim.service';
import { RefundsService } from './modules/payments/refunds.service';
import { SalaryRunsService } from './modules/payments/salary-runs.service';
import { CardPaymentsService } from './modules/payments/cards.service';
import { BankFeedsService } from './modules/banking/feeds.service';
import { PayoutsService } from './modules/payments/payouts.service';
import { EtimsService } from './modules/compliance/etims.service';
import { EtimsPurchasesService } from './modules/compliance/etims-purchases.service';
import { EtimsStockService } from './modules/compliance/etims-stock.service';
import { EtimsImportsService } from './modules/compliance/etims-imports.service';

/** Wires the domain services together over one database connection. */
export function createServices(db: Db) {
  const audit = new AuditService(db);
  const webhooks = new WebhooksService(db);
  audit.subscribe((organisationId, event, session) => webhooks.record(organisationId, event, session));
  const etims = new EtimsService(db, audit);
  audit.subscribe((organisationId, event, session) => etims.onAudit(organisationId, event, session));
  const etimsPurchases = new EtimsPurchasesService(db, audit);
  const etimsStock = new EtimsStockService(db, audit, etims);
  const etimsImports = new EtimsImportsService(db, audit, etims);
  audit.subscribe((organisationId, event, session) => etimsPurchases.onAudit(organisationId, event, session));
  const workflow = new WorkflowService(db, audit);
  const currencies = new CurrenciesService(db);
  const periods = new PeriodsService(db, audit);
  const warehouse = new WarehouseService(db);
  const journals = new JournalsService(db, audit, currencies, periods, workflow, warehouse);
  const tax = new TaxService(db);
  const settlement = new SettlementService(db, audit, currencies, journals, periods);
  const provisioning = new ProvisioningService(db, audit, currencies, periods);
  const revaluation = new RevaluationService(db, audit, currencies, journals, settlement);
  const inventory = new InventoryService(db, audit, currencies, journals, workflow);
  const budgets = new BudgetsService(db, audit, currencies, workflow);
  const fxReports = new FxReportsService(db, revaluation);
  const reports = new ReportsService(db, warehouse);
  const subledgerReports = new SubledgerReportsService(db, settlement);
  const banking = new BankingService(db, audit, currencies, journals, settlement);
  const assets = new AssetsService(db, audit, currencies, journals);
  const expenses = new ExpensesService(db, audit, currencies, journals, tax, workflow);
  const analytics = new AnalyticsService(db, currencies, warehouse, budgets, fxReports);
  const attachments = new AttachmentsService(db, audit);
  const suggestions = new SuggestionsService(db);
  const email = new EmailService(db);
  const procurement = new ProcurementService(db, audit, currencies, tax, budgets, workflow, inventory, journals);
  const storeRequisitions = new StoreRequisitionsService(db, audit, inventory, journals);
  const rfqs = new RfqService(db, audit, currencies, inventory, procurement, email);
  const sms = new SmsService(db, audit);
  const imprest = new ImprestService(db, audit, currencies, journals, workflow, email, sms);
  const pack = new PackService(db, reports, subledgerReports, analytics, budgets, banking, fxReports, inventory);
  const notificationEmails = new NotificationEmailService(db, audit, email, pack, sms);
  workflow.onNotify((organisationId, userIds, n, session) => notificationEmails.onNotify(organisationId, userIds, n, session));
  const payments = new PaymentsService(db, audit, currencies, journals, periods, settlement, tax, workflow);
  const mpesa = new MpesaService(db, audit, payments, banking, sms);
  const billing = new BillingService(db);
  const payouts = new PayoutsService(db, audit, mpesa, banking, workflow, journals);
  const cards = new CardPaymentsService(db, audit, payments);
  audit.subscribe((organisationId, event, session) => payouts.onAudit(organisationId, event, session));
  return {
    db,
    audit,
    currencies,
    periods,
    journals,
    tax,
    settlement,
    provisioning,
    migrations: new MigrationsService(db, provisioning, workflow, warehouse),
    reports,
    subledgerReports,
    documents: new DocumentsService(db, audit, currencies, journals, periods, settlement, tax, inventory, budgets, workflow),
    inventory,
    landedCosts: new LandedCostsService(db, audit, currencies, journals, inventory),
    budgets,
    assets,
    assetCare: new AssetCareService(db, audit, assets),
    expenses,
    imprest,
    pettyCash: new PettyCashService(db, audit, banking, journals, workflow),
    remittance: new RemittanceService(db, audit, email),
    chequeSigning: new ChequeSigningService(db, audit),
    sponsorships: new SponsorshipsService(db, audit),
    emailTemplates: new EmailTemplatesService(db, audit),
    vouchers: new VoucherService(db, payments, imprest, expenses),
    supplierManagement: new SupplierManagementService(db, audit),
    supplierPortal: new SupplierPortalService(db, audit),
    budgetPlanning: new BudgetPlanningService(db, audit, currencies, workflow, budgets),
    investments: new InvestmentsService(db, audit, currencies, journals, workflow),
    procurementPlans: new ProcurementPlanService(db, audit, currencies),
    programmes: new ProgrammesService(db, audit),
    rfqEvaluation: new RfqEvaluationService(db, audit, rfqs),
    poAmendments: new PoAmendmentsService(db, audit, procurement, budgets, email),
    inspections: new InspectionService(db, audit, workflow, procurement),
    storeRequisitions,
    stockControl: new StockControlService(db, audit, inventory, procurement, storeRequisitions),
    payments,
    mpesa,
    payouts,
    billing,
    portal: new PortalService(db, audit, email, billing, mpesa, sms, cards),
    sms,
    etims,
    etimsPurchases,
    etimsStock,
    etimsImports,
    banking,
    scim: new ScimService(db, audit),
    refunds: new RefundsService(db, audit, currencies, journals, periods, settlement),
    salaryRuns: new SalaryRunsService(db, audit, currencies, journals, periods),
    cards,
    feeds: new BankFeedsService(db, audit, currencies, banking),
    procurement,
    rfqs,
    revaluation,
    fxReports,
    consolidation: new ConsolidationService(db, audit, currencies, workflow),
    webhooks,
    workflow,
    warehouse,
    attachments,
    recurring: new RecurringService(db, audit, journals, workflow),
    collections: new CollectionsService(db, audit, subledgerReports, email, sms),
    suggestions,
    ai: new AiService(db, attachments, suggestions, reports, subledgerReports, analytics, budgets),
    analytics,
    pack,
    email,
    notificationEmails,
    account: new AccountService(db, audit, email),
    sso: new SsoService(db, audit),
    apiKeys: new ApiKeysService(db, audit),
  };
}

export type Services = ReturnType<typeof createServices>;

/**
 * The finance services of the running platform (built by the finance module on the platform's
 * connection). FINANCE_STANDALONE=true keeps the old stand-alone database for finance's own scripts.
 */
export async function getServices(): Promise<Services> {
  if (process.env.FINANCE_STANDALONE === 'true') return standaloneServices();
  const { getPlatform } = await import('@/platform/container');
  const s = (await getPlatform()).modules.finance as (Services & { ready: () => Promise<void> }) | undefined;
  if (!s) throw new Error('The finance module is not installed');
  await s.ready();
  return s;
}

const globalForDb = globalThis as unknown as { __farajasoftDb?: Promise<Db> };
let services: Services | null = null;

async function standaloneServices(): Promise<Services> {
  if (!globalForDb.__farajasoftDb) {
    globalForDb.__farajasoftDb = (async () => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI is not set');
      const db = new Db(await connect(uri));
      await db.ensureSchema();
      await createServices(db).migrations.run((m) => console.log(m));
      return db;
    })().catch((err) => {
      globalForDb.__farajasoftDb = undefined;
      throw err;
    });
  }
  const db = await globalForDb.__farajasoftDb;
  if (!services || services.db !== db) services = createServices(db);
  return services;
}
