/**
 * Seeds a demo tenant through the real services, so every journal goes through validation,
 * approval and posting exactly as it would from the UI.
 *
 *   npm run db:seed            # adds the demo tenant if missing
 *   npm run db:reset           # drops the database first
 */
import bcrypt from 'bcryptjs';
import { AuthUser } from '../common/auth';
import { Decimal, toD128 } from '../common/money';
import { createServices } from '../container';
import { connect, Db } from '../database/db.service';
import { JournalInput, LineInput } from '../modules/journals/journals.service';
import { PASSWORD_ROUNDS } from '../modules/provisioning/provisioning.service';
import { seedCommercial } from './seed-commercial';
import { seedGroup } from './seed-group';
import { seedOperations } from './seed-operations';
import { seedPlatform } from './seed-platform';
import { seedGovernance } from './seed-governance';
import { seedAutomation } from './seed-automation';
import { seedPayments } from './seed-payments';
import { seedCompliance } from './seed-compliance';

const PASSWORD = 'Password123!';
const ADMIN_EMAIL = 'admin@farajasoft.demo';
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Small deterministic PRNG so the demo data is identical on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

async function main() {
  const reset = process.argv.includes('--reset');
  const db = new Db(await connect(process.env.MONGODB_URI!));
  if (reset) {
    await db.connection.dropDatabase();
    console.log('Database dropped');
  }
  await db.ensureSchema();
  const services = createServices(db);
  if (await db.users.exists({ email: ADMIN_EMAIL })) {
    console.log('Demo tenant already exists; run "npm run db:reset" to recreate it.');
    await db.connection.close();
    return;
  }
  const { provisioning, periods, journals } = services;

  const { organisation, entity: ke } = await provisioning.provision({
    organisationName: 'Faraja Demo Group',
    adminName: 'Amina Odhiambo',
    email: ADMIN_EMAIL,
    password: PASSWORD,
    entityCode: 'KE01',
    entityName: 'Faraja Kenya Ltd',
    country: 'Kenya',
    functionalCurrency: 'KES',
    fiscalYearStart: d('2026-01-01'),
  });
  const organisationId = organisation._id;
  const system = { organisationId, name: 'system' };
  await db.organisations.updateOne({ _id: organisationId }, { $addToSet: { activeCurrencies: { $each: ['UGX', 'TZS'] } } });

  // ----- Structure ---------------------------------------------------------------------------
  const [ug] = await db.entities.create([
    { organisationId, code: 'UG01', name: 'Faraja Uganda Ltd', legalName: 'Faraja Uganda Limited', country: 'Uganda', functionalCurrency: 'UGX' },
  ]);
  await periods.createFiscalYear(system, ug._id, d('2026-01-01'));

  await db.branches.updateOne({ organisationId, code: 'HQ' }, { name: 'Nairobi Head Office', city: 'Nairobi' });
  const hq = (await db.branches.findOne({ organisationId, code: 'HQ' }).lean())!;
  const [msa, ksm, kla] = await db.branches.create([
    { organisationId, entityId: ke._id, code: 'MSA', name: 'Mombasa Branch', city: 'Mombasa', country: 'Kenya', currency: 'KES' },
    { organisationId, entityId: ke._id, code: 'KSM', name: 'Kisumu Branch', city: 'Kisumu', country: 'Kenya', currency: 'KES' },
    { organisationId, entityId: ug._id, code: 'KLA', name: 'Kampala Branch', city: 'Kampala', country: 'Uganda', currency: 'UGX' },
  ]);
  await db.dimensions.create([
    { organisationId, type: 'COST_CENTRE', code: 'RETAIL', name: 'Retail' },
    { organisationId, type: 'COST_CENTRE', code: 'WHOLESALE', name: 'Wholesale' },
    { organisationId, type: 'PROJECT', code: 'EXPANSION', name: 'Regional Expansion 2026' },
  ]);

  // ----- Users -------------------------------------------------------------------------------
  const roles = new Map((await db.roles.find({ organisationId }).lean()).map((r) => [r.name, r._id]));
  const hash = await bcrypt.hash(PASSWORD, PASSWORD_ROUNDS);
  await db.users.create([
    { organisationId, email: 'accountant@farajasoft.demo', name: 'Brian Kamau', passwordHash: hash, roleIds: [roles.get('Accountant')] },
    { organisationId, email: 'approver@farajasoft.demo', name: 'Grace Wanjiru', passwordHash: hash, roleIds: [roles.get('Finance Reviewer')] },
    {
      organisationId,
      email: 'manager.msa@farajasoft.demo',
      name: 'Hassan Ali',
      passwordHash: hash,
      roleIds: [roles.get('Branch Manager')],
      allBranches: false,
      branchIds: [msa._id],
      approvalLimit: toD128('500000'),
    },
    { organisationId, email: 'auditor@farajasoft.demo', name: 'Ruth Achieng', passwordHash: hash, roleIds: [roles.get('Auditor')] },
  ]);

  async function actor(email: string): Promise<AuthUser> {
    const u = (await db.users.findOne({ email }).lean())!;
    const rs = await db.roles.find({ _id: { $in: u.roleIds } }).lean();
    return {
      id: u._id,
      organisationId: u.organisationId,
      email: u.email,
      name: u.name,
      permissions: [...new Set(rs.flatMap((r) => r.permissions))],
      allBranches: u.allBranches,
      branchIds: u.branchIds,
      approvalLimit: u.approvalLimit ? u.approvalLimit.toString() : null,
      ip: '127.0.0.1',
      userAgent: 'seed',
    };
  }
  const director = await actor(ADMIN_EMAIL);
  const accountant = await actor('accountant@farajasoft.demo');
  const approver = await actor('approver@farajasoft.demo');

  // ----- Exchange rates ----------------------------------------------------------------------
  const rand = rng(42);
  const rates = [];
  for (let m = 1; m <= 10; m++) {
    const date = d(`2026-${String(m).padStart(2, '0')}-01`);
    rates.push(
      { fromCurrency: 'USD', toCurrency: 'KES', rate: (128.5 + rand() * 2.5).toFixed(4), effectiveDate: date },
      { fromCurrency: 'EUR', toCurrency: 'KES', rate: (139 + rand() * 4).toFixed(4), effectiveDate: date },
      { fromCurrency: 'USD', toCurrency: 'UGX', rate: (3640 + rand() * 60).toFixed(4), effectiveDate: date },
      { fromCurrency: 'KES', toCurrency: 'UGX', rate: (28.2 + rand() * 0.6).toFixed(4), effectiveDate: date },
    );
  }
  await db.exchangeRates.insertMany(
    rates.map((r) => ({
      ...r,
      rate: toD128(r.rate),
      organisationId,
      rateType: 'SPOT',
      source: 'Central Bank (demo)',
      status: 'APPROVED',
      createdBy: accountant.id,
      approvedBy: director.id,
      approvedAt: r.effectiveDate,
    })),
  );

  // ----- Journals ----------------------------------------------------------------------------
  const acc = new Map((await db.accounts.find({ organisationId }).lean()).map((a) => [a.code, a._id]));
  const dims = new Map((await db.dimensions.find({ organisationId }).lean()).map((x) => [x.code, x._id]));
  const A = (code: string) => acc.get(code)!;
  const line = (code: string, side: 'debit' | 'credit', amount: string | number, extra: Partial<LineInput> = {}): LineInput => ({
    accountId: A(code),
    [side]: new Decimal(amount),
    ...extra,
  });

  async function postJournal(input: JournalInput, by = accountant, checker = approver) {
    const j = await journals.create(by, input);
    await journals.submit(by, j._id);
    return journals.approve(checker, j._id, { post: true });
  }

  const money = (min: number, max: number, places = 2) => new Decimal(min + rand() * (max - min)).toDecimalPlaces(places);

  // Opening balances. The USD bank balance is translated at the January rate; equity absorbs the difference.
  const janUsd = (await db.exchangeRates.findOne({ organisationId, fromCurrency: 'USD', toCurrency: 'KES', effectiveDate: d('2026-01-01') }).lean())!;
  const usdOpeningKes = new Decimal(40000).times(janUsd.rate.toString()).toDecimalPlaces(2);
  const openingEquity = new Decimal(8500000 + 250000 + 18000000 - 3600000 + 4200000 - 15000000 - 6000000).plus(usdOpeningKes);
  await postJournal({
    entityId: ke._id,
    branchId: hq._id,
    journalDate: d('2026-01-01'),
    description: 'Opening balances at 1 January 2026',
    reference: 'OB-2026',
    type: 'OPENING',
    lines: [
      line('1120', 'debit', '8500000'),
      line('1110', 'debit', '250000'),
      line('1130', 'debit', '40000', { currency: 'USD' }),
      line('1610', 'debit', '18000000'),
      line('1620', 'credit', '3600000'),
      line('1300', 'debit', '4200000'),
      line('3100', 'credit', '15000000'),
      line('2510', 'credit', '6000000'),
      line('3300', 'credit', openingEquity.toFixed(2)),
    ],
  });

  const keBranches = [hq, msa, ksm];
  for (let m = 1; m <= 9; m++) {
    const mm = String(m).padStart(2, '0');
    for (const b of keBranches) {
      const scale = b.code === 'HQ' ? 1.6 : b.code === 'MSA' ? 1.1 : 0.7;
      const sales = money(1_400_000 * scale, 2_000_000 * scale);
      const cogs = sales.times(0.55 + rand() * 0.1).toDecimalPlaces(2);
      const cc = rand() > 0.5 ? dims.get('RETAIL') : dims.get('WHOLESALE');
      await postJournal({
        entityId: ke._id,
        branchId: b._id,
        journalDate: d(`2026-${mm}-${b.code === 'HQ' ? '25' : '26'}`),
        description: `${b.name} cash sales summary`,
        reference: `SALES-${b.code}-${mm}`,
        lines: [
          line('1120', 'debit', sales.times(1.16).toDecimalPlaces(2).toFixed(2)),
          line('4100', 'credit', sales.toFixed(2), { costCentreId: cc }),
          line('2130', 'credit', sales.times(0.16).toDecimalPlaces(2).toFixed(2)),
        ],
      });
      await postJournal({
        entityId: ke._id,
        branchId: b._id,
        journalDate: d(`2026-${mm}-27`),
        description: `${b.name} cost of goods sold`,
        lines: [line('5100', 'debit', cogs.toFixed(2), { costCentreId: cc }), line('1300', 'credit', cogs.toFixed(2))],
      });
      const salaries = money(350_000 * scale, 420_000 * scale);
      const rent = new Decimal(b.code === 'HQ' ? 280000 : b.code === 'MSA' ? 180000 : 120000);
      const utilities = money(30_000 * scale, 55_000 * scale);
      await postJournal({
        entityId: ke._id,
        branchId: b._id,
        journalDate: d(`2026-${mm}-28`),
        description: `${b.name} monthly operating expenses`,
        reference: `OPEX-${b.code}-${mm}`,
        lines: [
          line('6100', 'debit', salaries.toFixed(2), { departmentId: dims.get(b.code === 'HQ' ? 'ADMIN' : 'SALES') }),
          line('6200', 'debit', rent.toFixed(2)),
          line('6300', 'debit', utilities.toFixed(2)),
          line('1120', 'credit', salaries.plus(rent).plus(utilities).toFixed(2)),
        ],
      });
    }
    // Inventory replenishment centrally
    const purchase = money(2_800_000, 3_400_000).toFixed(2);
    await postJournal({
      entityId: ke._id,
      branchId: hq._id,
      journalDate: d(`2026-${mm}-05`),
      description: 'Inventory purchase - central procurement',
      lines: [line('1300', 'debit', purchase), line('1120', 'credit', purchase)],
    });
    // Foreign-currency receipt from an export customer into the USD account
    if (m % 2 === 0) {
      const usd = money(8000, 15000).toFixed(2);
      await postJournal({
        entityId: ke._id,
        branchId: msa._id,
        journalDate: d(`2026-${mm}-15`),
        description: 'Export sale settled in USD',
        reference: `EXP-${mm}`,
        lines: [
          line('1130', 'debit', usd, { currency: 'USD' }),
          line('4100', 'credit', usd, { currency: 'USD', projectId: dims.get('EXPANSION') }),
        ],
      });
    }
    // Depreciation
    await postJournal(
      {
        entityId: ke._id,
        branchId: hq._id,
        journalDate: d(`2026-${mm}-28`),
        description: 'Monthly depreciation',
        lines: [line('6850', 'debit', '150000'), line('1620', 'credit', '150000')],
      },
      accountant,
      director,
    );
  }

  // Uganda entity
  await postJournal({
    entityId: ug._id,
    branchId: kla._id,
    journalDate: d('2026-03-01'),
    description: 'Capital injection',
    lines: [line('1120', 'debit', '750000000'), line('3100', 'credit', '750000000')],
  });
  for (let m = 3; m <= 9; m++) {
    const mm = String(m).padStart(2, '0');
    const sales = money(120_000_000, 180_000_000, 0);
    const exp = money(60_000_000, 90_000_000, 0);
    await postJournal({
      entityId: ug._id,
      branchId: kla._id,
      journalDate: d(`2026-${mm}-27`),
      description: 'Kampala sales and expenses',
      lines: [
        line('1120', 'debit', sales.toFixed(0)),
        line('4200', 'credit', sales.toFixed(0)),
        line('6200', 'debit', exp.toFixed(0)),
        line('1120', 'credit', exp.toFixed(0)),
      ],
    });
  }

  // An accrual that reverses automatically on the first day of the next month
  await postJournal({
    entityId: ke._id,
    branchId: hq._id,
    journalDate: d('2026-09-30'),
    description: 'Accrued audit fees - September',
    type: 'ACCRUAL',
    autoReverseDate: d('2026-10-01'),
    lines: [line('6700', 'debit', '450000'), line('2120', 'credit', '450000')],
  });

  // Work in progress for the approval queue
  const pending = await journals.create(accountant, {
    entityId: ke._id,
    branchId: msa._id,
    journalDate: d('2026-10-02'),
    description: 'Marketing campaign - coastal region',
    reference: 'MKT-OCT',
    lines: [line('6400', 'debit', '320000'), line('1120', 'credit', '320000')],
  });
  await journals.submit(accountant, pending._id);
  await journals.create(accountant, {
    entityId: ke._id,
    branchId: ksm._id,
    journalDate: d('2026-10-03'),
    description: 'Staff travel - Kisumu (draft)',
    lines: [line('6500', 'debit', '85000'), line('1110', 'credit', '85000')],
  });

  // Commercial finance: customers, suppliers, invoices, bills, payments, procurement and banking
  await seedCommercial({ s: services, organisationId, ke, ug, hq, msa, kla, accountant, approver, director });
  // Phase 3: month-end rates, intercompany trade, FX revaluation and group adjustments
  await seedGroup({ s: services, organisationId, ke, ug, hq, kla, accountant, approver, director });
  // Phase 4: inventory, fixed assets, expense claims, projects and budgets
  await seedOperations({ s: services, organisationId, ke, hq, msa, accountant, approver, director });
  // Phase 5: approval rules and requests, delegation, service account, NCI, exceptions, warehouse
  await seedPlatform({ s: services, organisationId, ke, ug, hq, msa, accountant, approver, director });
  // Phase 6: supporting documents
  await seedGovernance({ s: services, organisationId, accountant, approver });
  // Phase 7: recurring journals and collections history
  await seedAutomation({ s: services, organisationId, ke, hq, msa, accountant });
  // Phase 9: invoice letterhead, M-Pesa paybill payments and a customer portal link
  const { portalUrl } = await seedPayments({ s: services, organisationId, ke, hq, accountant, approver, director });
  // Phase 10: tax withheld by a county government customer, and eTIMS connection for head office
  await seedCompliance({ s: services, organisationId, ke, hq, accountant, approver, director });

  // Demo users have no real mailboxes: nothing the seed queued should be sent.
  await db.emails.deleteMany({});

  // Close the first half of the year
  const kePeriods = await db.periods.find({ organisationId, entityId: ke._id }).sort({ startDate: 1 }).lean();
  for (const p of kePeriods.slice(0, 6)) await periods.changeStatus(director, p._id, 'HARD_CLOSED');
  for (const p of kePeriods.slice(6, 8)) await periods.changeStatus(director, p._id, 'SOFT_CLOSED');

  const posted = await db.journals.countDocuments({ organisationId, status: 'POSTED' });
  const [invoices, payments] = await Promise.all([db.invoices.countDocuments({ organisationId }), db.payments.countDocuments({ organisationId })]);
  console.log(`Seeded "${organisation.name}" with ${posted} posted journals, ${invoices} invoices and bills, and ${payments} receipts and payments.`);
  console.log(`\nSign in with any of these (password: ${PASSWORD}):`);
  for (const [email, role] of [
    [ADMIN_EMAIL, 'Administrator + Finance Director'],
    ['accountant@farajasoft.demo', 'Accountant'],
    ['approver@farajasoft.demo', 'Finance Reviewer'],
    ['manager.msa@farajasoft.demo', 'Branch Manager (Mombasa only, limit KES 500,000)'],
    ['auditor@farajasoft.demo', 'Auditor (read-only)'],
  ]) {
    console.log(`  ${email.padEnd(30)} ${role}`);
  }
  if (portalUrl) console.log(`
Customer portal (no sign-in): ${portalUrl}`);
  await db.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

