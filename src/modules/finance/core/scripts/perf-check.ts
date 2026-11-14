/**
 * Performance check on a large ledger: adds synthetic volume to the demo organisation (seed it first)
 * and times the heavy reports. Never run against a production database: it writes test data.
 *
 *   MONGODB_URI=... npx tsx src/server/scripts/perf-check.ts [--journals 250000] [--invoices 40000] [--movements 100000] [--orders 5000] [--skip-load]
 */
import { Types } from 'mongoose';
import { actorFor } from '../common/auth';
import { createServices } from '../container';
import { connect, Db } from '../database/db.service';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const D = (v: number) => Types.Decimal128.fromString(v.toFixed(2));
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

async function load(db: Db, organisationId: Types.ObjectId, entityId: Types.ObjectId, journals: number, invoices: number) {
  const accounts = await db.accounts.find({ organisationId, isPostable: true, isControl: { $ne: true }, currency: null }).lean();
  const pick = (cls: string) => accounts.filter((a) => a.accountClass === cls);
  const expenses = pick('EXPENSE');
  const revenue = pick('REVENUE');
  const bank = accounts.find((a) => a.code === '1120')!;
  const branches = await db.branches.find({ organisationId, entityId }).lean();
  const periods = await db.periods.find({ organisationId, entityId }).sort({ startDate: 1 }).lean();
  const periodFor = (d: Date) => periods.find((p) => p.startDate <= d && p.endDate >= d)!._id;
  const user = (await db.users.findOne({ organisationId }).lean())!;

  console.log(`Loading ${journals.toLocaleString()} journals (${(journals * 2).toLocaleString()} ledger lines)…`);
  const batch = 10_000;
  for (let start = 0; start < journals; start += batch) {
    const rows: Record<string, unknown>[] = [];
    for (let i = start; i < Math.min(journals, start + batch); i++) {
      const date = day(i % 273);
      const income = i % 3 === 0;
      const account = income ? revenue[i % revenue.length] : expenses[i % expenses.length];
      const amount = 100 + ((i * 7919) % 250_000) / 10;
      const journalId = new Types.ObjectId();
      const common = { organisationId, entityId, journalId, journalNumber: `PERF-${i}`, date, periodId: periodFor(date), branchId: branches[i % branches.length]._id, description: 'Synthetic', currency: 'KES', exchangeRate: D(1), source: 'MANUAL', postedAt: date };
      const debitAccount = income ? bank : account;
      const creditAccount = income ? account : bank;
      rows.push({ ...common, lineNo: 1, accountId: debitAccount._id, accountClass: debitAccount.accountClass, debitTx: D(amount), creditTx: D(0), debit: D(amount), credit: D(0) });
      rows.push({ ...common, lineNo: 2, accountId: creditAccount._id, accountClass: creditAccount.accountClass, debitTx: D(0), creditTx: D(amount), debit: D(0), credit: D(amount) });
    }
    await db.ledger.collection.insertMany(rows, { ordered: false });
    process.stdout.write('.');
  }
  console.log();

  const customers = await db.customers.find({ organisationId, currency: 'KES', intercompanyEntityId: null }).lean();
  console.log(`Loading ${invoices.toLocaleString()} posted sales invoices…`);
  for (let start = 0; start < invoices; start += batch) {
    const rows: Record<string, unknown>[] = [];
    for (let i = start; i < Math.min(invoices, start + batch); i++) {
      const c = customers[i % customers.length];
      const date = day(i % 273);
      const total = 1000 + ((i * 104729) % 500_000) / 10;
      // Most invoices are long paid; a tenth are open, some partly.
      const due = i % 10 === 0 ? total : i % 25 === 0 ? total / 2 : 0;
      rows.push({
        organisationId,
        entityId,
        branchId: branches[i % branches.length]._id,
        kind: 'SALES_INVOICE',
        number: `PERF-INV-${String(i).padStart(7, '0')}`,
        partyId: c._id,
        partyName: c.name,
        date,
        dueDate: new Date(date.getTime() + 30 * 86_400_000),
        reference: '',
        supplierInvoiceNumber: '',
        currency: 'KES',
        exchangeRate: D(1),
        functionalCurrency: 'KES',
        priceIncludesTax: false,
        lines: [],
        subtotal: D(total / 1.16),
        taxTotal: D(total - total / 1.16),
        total: D(total),
        totalFunctional: D(total),
        amountDue: D(due),
        amountDueFunctional: D(due),
        status: 'POSTED',
        paymentStatus: due === 0 ? 'PAID' : due < total ? 'PARTIAL' : 'UNPAID',
        matchStatus: 'NOT_REQUIRED',
        matchNotes: [],
        notes: '',
        createdBy: user._id,
        createdAt: date,
        updatedAt: date,
      });
    }
    await db.invoices.collection.insertMany(rows, { ordered: false });
    process.stdout.write('.');
  }
  console.log();
}

/** Batch-tracked stock movements and lots, and purchase orders with stock received but not billed. */
async function loadOperations(db: Db, organisationId: Types.ObjectId, entityId: Types.ObjectId, movements: number, orders: number) {
  const user = (await db.users.findOne({ organisationId }).lean())!;
  const warehouse = (await db.warehouses.findOne({ organisationId, entityId }).lean())!;
  const inventory = (await db.accounts.findOne({ organisationId, code: '1300' }).lean())!;
  const cogs = (await db.accounts.findOne({ organisationId, code: '5100' }).lean())!;
  const items = Array.from({ length: 200 }, (_, i) => ({ _id: new Types.ObjectId(), organisationId, code: `PERF-LOT-${i}`, name: `Batch item ${i}`, type: 'STOCK', unit: 'each', tracking: 'BATCH', trackExpiry: true, inventoryAccountId: inventory._id, cogsAccountId: cogs._id }));
  await db.items.collection.insertMany(items);
  console.log(`Loading ${movements.toLocaleString()} batch movements and ${orders.toLocaleString()} purchase orders…`);
  const batch = 10_000;
  for (let start = 0; start < movements; start += batch) {
    const rows: Record<string, unknown>[] = [];
    const lots: Record<string, unknown>[] = [];
    for (let i = start; i < Math.min(movements, start + batch); i++) {
      const item = items[i % items.length];
      const number = `B${String(Math.floor(i / items.length)).padStart(6, '0')}`;
      const date = day(i % 273);
      rows.push({ organisationId, entityId, branchId: warehouse.branchId, itemId: item._id, warehouseId: warehouse._id, date, type: 'PURCHASE', quantity: D(10), value: D(1000), unitCost: D(100), balanceQuantity: D(10), balanceValue: D(1000), sourceType: 'Synthetic', sourceId: new Types.ObjectId(), sourceNumber: `PERF-MV-${i}`, lots: [{ number, expiryDate: day(300 + (i % 400)), quantity: D(10) }], reversedById: null, createdBy: user._id, createdAt: date });
      lots.push({ organisationId, entityId, itemId: item._id, warehouseId: warehouse._id, number, expiryDate: day(300 + (i % 400)), quantity: D(10), receivedDate: date, createdAt: date, updatedAt: date });
    }
    await db.stockMovements.collection.insertMany(rows, { ordered: false });
    await db.stockLots.collection.insertMany(lots, { ordered: false }).catch(() => undefined);
    process.stdout.write('.');
  }
  const supplier = (await db.suppliers.findOne({ organisationId }).lean())!;
  const branch = warehouse.branchId;
  const poRows = Array.from({ length: orders }, (_, i) => ({
    organisationId,
    entityId,
    branchId: branch,
    number: `PERF-PO-${String(i).padStart(6, '0')}`,
    supplierId: supplier._id,
    supplierName: supplier.name,
    date: day(i % 273),
    currency: 'KES',
    exchangeRate: D(1),
    status: 'PARTIALLY_RECEIVED',
    lines: [
      { lineNo: 1, description: 'Stock', accountId: inventory._id, quantity: D(10), unitPrice: D(100), netAmount: D(1000), taxAmount: D(0), quantityReceived: D(5), quantityBilled: D(i % 2 ? 5 : 0), itemId: items[i % items.length]._id, warehouseId: warehouse._id, receivedValue: D(500), billedValue: D(i % 2 ? 500 : 0) },
      { lineNo: 2, description: 'Delivery', accountId: inventory._id, quantity: D(1), unitPrice: D(50), netAmount: D(50), taxAmount: D(0), quantityReceived: D(1), quantityBilled: D(0) },
    ],
    subtotal: D(1050),
    taxTotal: D(0),
    total: D(1050),
    createdBy: user._id,
    createdAt: day(i % 273),
    updatedAt: day(i % 273),
  }));
  for (let i = 0; i < poRows.length; i += batch) await db.purchaseOrders.collection.insertMany(poRows.slice(i, i + batch), { ordered: false });
  console.log();
}

async function time<T>(label: string, fn: () => Promise<T>) {
  await fn(); // warm the cache
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await fn();
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  console.log(`${label.padEnd(36)} ${runs[1].toFixed(0).padStart(7)} ms`);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (/mongodb\.net|prod/i.test(uri)) throw new Error('Refusing to write synthetic data to what looks like a production database');
  const db = new Db(await connect(uri));
  await db.ensureSchema();
  const s = createServices(db);
  const org = await db.organisations.findOne({ slug: /faraja/i }).lean();
  if (!org) throw new Error('Seed the demo organisation first (npm run db:seed)');
  const ke = (await db.entities.findOne({ organisationId: org._id, code: 'KE01' }).lean())!;
  if (!process.argv.includes('--skip-load')) {
    await load(db, org._id, ke._id, arg('journals', 250_000), arg('invoices', 40_000));
    await loadOperations(db, org._id, ke._id, arg('movements', 100_000), arg('orders', 5_000));
    // The synthetic lines bypass posting, so the monthly totals are rebuilt from the ledger.
    const t = performance.now();
    await s.warehouse.rebuild(org._id);
    console.log(`Rebuilt monthly totals in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  }

  const [ledger, invoices] = await Promise.all([db.ledger.estimatedDocumentCount(), db.invoices.estimatedDocumentCount()]);
  console.log(`\nLedger lines: ${ledger.toLocaleString()} · invoices: ${invoices.toLocaleString()}\n`);
  const director = (await actorFor(db, (await db.users.findOne({ email: 'admin@farajasoft.demo' }).lean())!._id))!;
  const f = { entityId: ke._id };
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-09-30T00:00:00Z');
  const bank = (await db.accounts.findOne({ organisationId: org._id, code: '1120' }).lean())!;
  const sales = (await db.accounts.findOne({ organisationId: org._id, code: '4100' }).lean())!;

  await time('Trial balance (9 months)', () => s.reports.trialBalance(director, f, from, to));
  await time('Profit & loss', () => s.reports.profitAndLoss(director, f, from, to, false));
  await time('Profit & loss by branch', () => s.reports.profitAndLoss(director, f, from, to, true));
  await time('Balance sheet', () => s.reports.balanceSheet(director, f, to));
  await time('Dashboard', () => s.reports.dashboard(director, f, to));
  await time('Account activity: bank (9 months)', () => s.reports.accountActivity(director, f, bank._id, from, to));
  await time('Account activity: sales', () => s.reports.accountActivity(director, f, sales._id, from, to));
  await time('Aged receivables', () => s.subledgerReports.aging(director, 'CUSTOMER', ke._id, to));
  await time('Subledger control check', () => s.subledgerReports.controlCheck(director, ke._id));
  await time('Invoice list (page 1)', () => s.documents.list(director, { kinds: ['SALES_INVOICE'], entityId: ke._id, page: 1, pageSize: 25 }));
  await time('Invoice list (open, search)', () => s.documents.list(director, { kinds: ['SALES_INVOICE'], entityId: ke._id, open: true, search: 'PERF-INV-00123', page: 1, pageSize: 25 }));
  await time('Cash flow statement', () => s.analytics.cashFlow(director, ke._id, from, to));
  await time('Budget vs actual (YTD)', () => s.budgets.vsActual(director, { entityId: ke._id, from, to }));
  await time('FX exposure', () => s.fxReports.exposure(director, ke._id, to));
  await time('Exceptions (3 months)', () => s.analytics.exceptions(director, ke._id, new Date('2026-07-01T00:00:00Z'), to));
  await time('Cash forecast (13 weeks)', () => s.analytics.forecast(director, ke._id, { weeks: 13, today: to }));
  await time('Executive dashboard', () => s.analytics.executive(director, ke._id, to));
  // Phases 15–20.
  const customer = (await db.customers.findOne({ organisationId: org._id }).lean())!;
  await time('Consolidation (with acquisition)', () => s.consolidation.report(director, { from, asOf: to }));
  await time('Received not invoiced', () => s.procurement.receivedNotInvoiced(director, ke._id));
  await time('Batches on hand (all)', () => s.inventory.lots(director, { entityId: ke._id }));
  await time('Batches expiring in 30 days', () => s.inventory.lots(director, { entityId: ke._id, expiringWithinDays: 30 }));
  await time('Trace a batch number', () => s.inventory.trace(director, { entityId: ke._id, number: 'B000123' }));
  await time('Stock on hand in USD', () => s.inventory.onHand(director, ke._id, { currency: 'USD', date: to }));
  await time('Refundable credits (customer)', () => s.refunds.credits(director, customer._id, ke._id));
  await db.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
