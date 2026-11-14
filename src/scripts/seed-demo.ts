/**
 * Demo data for people testing the system by hand (`npm run db:seed -- --demo`, after each module's own
 * demo data). It signs in as demo users and works through the real API, so every record passes the same
 * checks and approvals as one entered on screen. Each section is skipped when its data is already there,
 * and a failing section is reported without stopping the others.
 *
 * Demo users all share SEED_DEMO_PASSWORD (or the administrator's password when that is not set).
 */
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import type { Platform } from '@/platform/container';

type Json = Record<string, unknown>;
type Call = <T = Json>(who: string, method: string, path: string, body?: unknown) => Promise<T>;

const BASE = 'http://seed.local/api/v1';
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

/** Demo users added here (water and HR add their own in their module seeds). */
export const DEMO_USERS: { email: string; name: string; access: { module: string; role: string }[] }[] = [
  { email: 'care@demo.water', name: 'Grace Customer-Care', access: [{ module: 'water', role: 'CUSTOMER_SERVICE' }] },
  { email: 'credit@demo.water', name: 'Daniel Credit-Control', access: [{ module: 'water', role: 'CREDIT_CONTROL' }] },
  { email: 'director@demo.finance', name: 'Esther Finance-Director', access: [{ module: 'finance', role: 'FINANCE_DIRECTOR' }] },
  { email: 'accountant@demo.finance', name: 'Peter Accountant', access: [{ module: 'finance', role: 'ACCOUNTANT' }] },
  { email: 'reviewer@demo.finance', name: 'Lucy Finance-Reviewer', access: [{ module: 'finance', role: 'FINANCE_REVIEWER' }] },
  { email: 'staff@demo.finance', name: 'Sam Staff-Member', access: [{ module: 'finance', role: 'STAFF' }] },
  { email: 'auditor@demo.finance', name: 'Alice External-Auditor', access: [{ module: 'finance', role: 'AUDITOR' }] },
  { email: 'manager@demo.ict', name: 'Ian ICT-Manager', access: [{ module: 'ict', role: 'MANAGER' }] },
  { email: 'helpdesk@demo.ict', name: 'Henry Help-Desk', access: [{ module: 'ict', role: 'AGENT' }] },
  { email: 'admin@demo.ict', name: 'Agnes Admin-Officer', access: [{ module: 'ict', role: 'ADMIN_OFFICER' }] },
  { email: 'head@demo.audit', name: 'Hannah Head-of-Audit', access: [{ module: 'internalaudit', role: 'HEAD' }] },
  { email: 'auditor@demo.audit', name: 'Abel Internal-Auditor', access: [{ module: 'internalaudit', role: 'AUDITOR' }] },
  { email: 'committee@demo.audit', name: 'Charles Audit-Committee', access: [{ module: 'internalaudit', role: 'COMMITTEE' }] },
  { email: 'analyst@demo.bi', name: 'Nancy Analyst', access: [{ module: 'bi', role: 'ANALYST' }] },
  { email: 'viewer@demo.bi', name: 'Victor Report-Reader', access: [{ module: 'bi', role: 'VIEWER' }] },
  { email: 'manager@demo.projects', name: 'Paul Projects-Manager', access: [{ module: 'projects', role: 'MANAGER' }] },
  { email: 'officer@demo.estates', name: 'Edwin Estates-Officer', access: [{ module: 'estates', role: 'MANAGER' }] },
  { email: 'caretaker@demo.estates', name: 'Cate Caretaker', access: [{ module: 'estates', role: 'CARETAKER' }] },
  { email: 'librarian@demo.portals', name: 'Linda Librarian', access: [{ module: 'portals', role: 'LIBRARIAN' }] },
  { email: 'officer@demo.tenders', name: 'Oscar Procurement-Officer', access: [{ module: 'tenders', role: 'OFFICER' }] },
  { email: 'head@demo.tenders', name: 'Helen Head-of-Procurement', access: [{ module: 'tenders', role: 'HEAD' }] },
  { email: 'ao@demo.tenders', name: 'Andrew Accounting-Officer', access: [{ module: 'tenders', role: 'ACCOUNTING_OFFICER' }] },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ email: `member${n}@demo.tenders`, name: `Committee Member ${n}`, access: [{ module: 'tenders', role: 'MEMBER' }] })),
  { email: 'everyone@demo.staff', name: 'Esther Ordinary-Staff', access: [] },
];

export async function seedTestingDemo(platform: Platform, organisationId: Types.ObjectId, password: string, modules: string[]) {
  const db = platform.core.db;
  const hash = await bcrypt.hash(password, 10);
  for (const u of DEMO_USERS) {
    const access = u.access.filter((a) => modules.includes(a.module));
    if (u.access.length && !access.length) continue;
    if (!(await db.users.exists({ email: u.email }))) await db.users.create([{ organisationId, email: u.email, name: u.name, access, passwordHash: hash }]);
  }

  const { createApi } = await import('@/platform/api');
  const handle = createApi(async () => platform);
  const cookies: Record<string, string> = {};
  // Each demo user calls from its own loopback address, as separate people would, so the per-address
  // sign-in limit does not stop the seed part-way.
  const ips: Record<string, string> = {};
  const ipOf = (who: string) => (ips[who] ??= `127.0.${Math.floor(Object.keys(ips).length / 250)}.${(Object.keys(ips).length % 250) + 2}`);
  const call: Call = async <T,>(who: string, method: string, path: string, body?: unknown) => {
    if (!cookies[who] && who !== 'public') {
      const res = await handle(new Request(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ipOf(who) }, body: JSON.stringify({ email: who, password }) }));
      if (res.status !== 200) throw new Error(`Could not sign in as ${who}: ${await res.text()}`);
      cookies[who] = (res.headers.get('set-cookie') ?? '').split(';')[0];
    }
    const res = await handle(
      new Request(`${BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ipOf(who), ...(cookies[who] && { cookie: cookies[who] }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    if (res.status >= 300) throw new Error(`${method} ${path} as ${who} → ${res.status}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : null) as T;
  };

  const sections: [string, string, () => Promise<string>][] = [
    ['water', 'Water billing, payments and complaints', () => water(call, platform, organisationId)],
    ['finance', 'Finance suppliers, customers, requisition and journal', () => finance(call)],
    ['ict', 'ICT help desk and office assets', () => ict(call, platform, organisationId)],
    ['internalaudit', 'Internal audit universe, risks and plan', () => internalAudit(call, platform, organisationId)],
    ['tenders', 'Tenders', () => tenders(call, platform, organisationId)],
    ['estates', 'Estates', () => estates(call)],
    ['projects', 'Projects and donors', () => projects(call)],
    ['portals', 'Library and MSME portal', () => portals(call, platform, organisationId)],
  ];
  for (const [module, label, run] of sections) {
    if (!modules.includes(module)) continue;
    try {
      console.log(`${label}: ${await run()}`);
    } catch (err) {
      console.error(`${label}: FAILED – ${(err as Error).message}`, (err as Error).stack?.split('\n')[1]?.trim() ?? '');
    }
  }
}

async function water(call: Call, platform: Platform, organisationId: Types.ObjectId) {
  const conn = platform.core.db.connection;
  if (await conn.collection('water_bill_runs').countDocuments({ organisationId })) return 'already there';
  // The water seed puts its demo customers in the first three zones by code (Ainapngetuny, Chepkemel,
  // Kabolebo). The first is read and billed here; the other two are left for testers to read and bill.
  const withCustomers = await conn.collection('water_customers').distinct('zoneId', { organisationId });
  const zones = await conn.collection('water_zones').find({ organisationId, _id: { $in: withCustomers } }).sort({ code: 1 }).limit(1).toArray();
  if (!zones.length) return 'no customers; run the water seed first';
  const meters = await conn.collection('water_meters').find({ organisationId, zoneId: zones[0]._id, type: 'CUSTOMER' }).toArray();
  const period = today().slice(0, 7);
  let read = 0;
  for (const [i, m] of meters.entries()) {
    const last = Number(String(m.lastReading ?? '0'));
    const value = i === 3 ? last + 95 : last + 8 + ((i * 5) % 17); // one very high reading, for the exceptions screen
    await call('billing@demo.water', 'POST', '/water/readings', { clientId: `seed-${m.serialNo}-${period}`, meterId: String(m._id), value: String(value), readAt: new Date().toISOString() });
    read++;
  }
  const pending = await call<{ items?: { id: string }[] } | { id: string }[]>('manager@demo.water', 'GET', `/water/readings?period=${period}&status=PENDING`);
  const pendingItems = Array.isArray(pending) ? pending : (pending.items ?? []);
  for (const r of pendingItems) await call('manager@demo.water', 'POST', `/water/readings/${r.id}/review`, { action: 'APPROVE', note: 'Checked on site' });
  const { run } = await call<{ run: { id: string; billCount: number; totalAmount: string } }>('billing@demo.water', 'POST', '/water/bill-runs', { period, zoneId: String(zones[0]._id), billDate: today() });
  await call('manager@demo.water', 'POST', `/water/bill-runs/${run.id}/approve`);
  const customers = await conn.collection('water_customers').find({ organisationId, zoneId: zones[0]._id }).sort({ accountNo: 1 }).toArray();
  const paid = customers.slice(0, 5);
  for (const [i, c] of paid.entries()) {
    await call('cashier@demo.water', 'POST', '/water/payments', { customerId: String(c._id), amount: String(500 + i * 250), channel: i % 2 ? 'MPESA' : 'CASH', reference: `SEED-RCPT-${i + 1}`, paidAt: today(), payerName: c.name });
  }
  await call('care@demo.water', 'POST', '/water/tickets', { category: 'BURST', channel: 'PHONE', customerId: String(customers[1]._id), subject: 'Burst pipe outside the gate' });
  await call('care@demo.water', 'POST', '/water/tickets', { category: 'BILLING', channel: 'WALK_IN', customerId: String(customers[3]._id), subject: 'Bill is much higher than usual' });
  return `${read} readings, bill run of ${run.billCount} bills (KES ${run.totalAmount}) approved, ${paid.length} payments, 2 complaints`;
}

async function finance(call: Call) {
  const suppliers = await call<unknown[] | { items: unknown[] }>('accountant@demo.finance', 'GET', '/finance/suppliers');
  if ((Array.isArray(suppliers) ? suppliers : suppliers.items).length) return 'already there';
  for (const s of [
    { code: 'DAVIS', name: 'Davis & Shirtliff Ltd', taxId: 'P051100001A', currency: 'KES', paymentTermsDays: 30, email: 'sales@davis.example' },
    { code: 'CHEMKEN', name: 'Chemken Water Chemicals', taxId: 'P051100002B', currency: 'KES', paymentTermsDays: 30 },
    { code: 'NANDISTAT', name: 'Nandi Stationers', taxId: 'P051100003C', currency: 'KES', paymentTermsDays: 14 },
    { code: 'KPLC', name: 'Kenya Power', currency: 'KES', paymentTermsDays: 14 },
  ])
    await call('accountant@demo.finance', 'POST', '/finance/suppliers', s);
  for (const c of [
    { code: 'NANDICG', name: 'County Government of Nandi', currency: 'KES', paymentTermsDays: 30 },
    { code: 'TINDHOSP', name: 'Tindiret Sub-County Hospital', currency: 'KES', paymentTermsDays: 30 },
  ])
    await call('accountant@demo.finance', 'POST', '/finance/customers', c);

  const [entity] = await call<{ id: string }[]>('accountant@demo.finance', 'GET', '/finance/entities');
  const [branch] = await call<{ id: string }[]>('accountant@demo.finance', 'GET', `/finance/branches?entityId=${entity.id}`);
  // A requisition from an ordinary member of staff, waiting for approval.
  const req = await call<{ id: string }>('staff@demo.finance', 'POST', '/finance/requisitions', {
    entityId: entity.id,
    branchId: branch.id,
    date: today(),
    requiredBy: inDays(21).slice(0, 10),
    description: 'Pipe fittings for Kamelil repairs',
    lines: [
      { description: '2" PVC pipes (6 m)', quantity: '40', estimatedUnitPrice: '1450' },
      { description: '2" gate valves', quantity: '6', estimatedUnitPrice: '3800' },
    ],
  });
  await call('staff@demo.finance', 'POST', `/finance/requisitions/${req.id}/submit`, {});
  // A journal prepared by the accountant, waiting for the reviewer.
  const accounts = await call<{ id: string; code: string; isPostable: boolean }[]>('accountant@demo.finance', 'GET', `/finance/accounts?entityId=${entity.id}`);
  const byCode = (code: string) => accounts.find((a) => a.code === code && a.isPostable)?.id;
  let journal = 'no journal (accounts 1400/2120 not found)';
  if (byCode('1400') && byCode('2120')) {
    const j = await call<{ id: string; number?: string }>('accountant@demo.finance', 'POST', '/finance/journals', {
      entityId: entity.id,
      branchId: branch.id,
      journalDate: today(),
      description: 'Accrue external audit fee',
      lines: [
        { accountId: byCode('1400'), debit: '150000' },
        { accountId: byCode('2120'), credit: '150000' },
      ],
    });
    await call('accountant@demo.finance', 'POST', `/finance/journals/${j.id}/submit`, {});
    journal = 'a journal awaiting approval';
  }
  return `4 suppliers, 2 customers, a submitted requisition and ${journal}`;
}

async function ict(call: Call, platform: Platform, organisationId: Types.ObjectId) {
  const conn = platform.core.db.connection;
  if (await conn.collection('ict_office_assets').countDocuments({ organisationId })) return 'already there';
  const cats = await call<{ id: string; code: string }[]>('everyone@demo.staff', 'GET', '/ict/helpdesk/categories');
  const cat = (code: string) => (cats.find((c) => c.code === code) ?? cats[0]).id;
  const staff = await platform.core.db.users.findOne({ email: 'everyone@demo.staff' }).lean();
  for (const a of [
    { tag: 'PC-001', description: 'HP ProBook 450 laptop', kind: 'LAPTOP', make: 'HP', serialNo: '5CD1234XYZ', condition: 'NEW' },
    { tag: 'PC-002', description: 'Dell OptiPlex desktop', kind: 'COMPUTER', make: 'Dell', serialNo: 'DL998877', condition: 'GOOD' },
    { tag: 'PRN-001', description: 'HP LaserJet printer, billing office', kind: 'PRINTER', make: 'HP', serialNo: 'PRN5566', condition: 'GOOD' },
  ]) {
    const asset = await call<{ id: string }>('admin@demo.ict', 'POST', '/ict/assets', a);
    if (a.tag === 'PC-001' && staff) await call('admin@demo.ict', 'POST', `/ict/assets/${asset.id}/issue`, { holderId: String(staff._id), department: 'Finance' });
  }
  const toner = await call<{ id: string }>('admin@demo.ict', 'POST', '/ict/consumables', { code: 'TONER85A', name: 'HP 85A toner', unit: 'cartridge', reorderLevel: 2 });
  await call('admin@demo.ict', 'POST', `/ict/consumables/${toner.id}/moves`, { kind: 'RECEIPT', quantity: 5, reference: 'LPO 0042' });
  await call('everyone@demo.staff', 'POST', '/ict/helpdesk/tickets', { categoryId: cat('HARDWARE'), priority: 'HIGH', subject: 'Laptop will not start', description: 'Black screen since this morning', assetTag: 'PC-001', department: 'Finance' });
  await call('everyone@demo.staff', 'POST', '/ict/helpdesk/tickets', { categoryId: cat('PRINTER'), priority: 'LOW', subject: 'Printer in billing office jams', department: 'Commercial' });
  return '3 assets (one issued), toner stock and 2 open tickets';
}

async function internalAudit(call: Call, platform: Platform, organisationId: Types.ObjectId) {
  if (await platform.core.db.connection.collection('internalaudit_universe').countDocuments({ organisationId })) return 'already there';
  const billing = await call<{ id: string }>('head@demo.audit', 'POST', '/internalaudit/universe', { code: 'BILLING', name: 'Billing and revenue', kind: 'PROCESS', impact: 4, likelihood: 4 });
  await call('head@demo.audit', 'POST', '/internalaudit/universe', { code: 'PROCURE', name: 'Procurement', kind: 'PROCESS', impact: 4, likelihood: 3 });
  await call('head@demo.audit', 'POST', '/internalaudit/universe', { code: 'FLEET', name: 'Fleet management', impact: 2, likelihood: 2, lastAuditedAt: today() });
  await call('head@demo.audit', 'POST', '/internalaudit/risks', { code: 'R1', title: 'Revenue leakage through unbilled consumption', category: 'FINANCIAL', universeId: billing.id, impact: 5, likelihood: 4, controls: 'Monthly exception report', residualImpact: 4, residualLikelihood: 3 });
  const year = String(new Date().getUTCFullYear() + 1);
  const plan = await call<{ id: string }>('head@demo.audit', 'POST', '/internalaudit/plans', { year, title: `Annual audit plan ${year}`, availableHours: 1000, fromUniverse: true });
  await call('head@demo.audit', 'POST', `/internalaudit/plans/${plan.id}/submit`);
  return '3 auditable areas, 1 risk, and a plan waiting for the audit committee';
}

async function tenders(call: Call, platform: Platform, organisationId: Types.ObjectId) {
  if (await platform.core.db.connection.collection('tenders_tenders').countDocuments({ organisationId })) return 'already there';
  const users = await platform.core.db.users.find({ email: /^member\d@demo\.tenders$/ }).sort({ email: 1 }).lean();
  if (users.length < 6) return 'committee members missing';
  const id = (i: number) => String(users[i]._id);
  const body = {
    title: 'Supply and delivery of water treatment chemicals',
    method: 'OPEN_NATIONAL',
    category: 'GOODS',
    estimate: '12000000',
    planReference: 'APP-2026-014',
    bidSecurity: '200000',
    bidValidityDays: 120,
    closingAt: inDays(21),
    openingAt: inDays(21),
    mandatory: ['Certificate of incorporation', 'Valid tax compliance certificate'],
    criteria: [
      { name: 'Experience', weight: 40 },
      { name: 'Technical specification', weight: 60 },
    ],
    passMark: 70,
  };
  const t = await call<{ id: string }>('officer@demo.tenders', 'POST', '/tenders/tenders', body);
  await call('ao@demo.tenders', 'PUT', `/tenders/tenders/${t.id}/committees`, {
    opening: [
      { userId: id(0), role: 'CHAIR' },
      { userId: id(1), role: 'SECRETARY' },
      { userId: id(2), role: 'MEMBER' },
    ],
    evaluation: [
      { userId: id(3), role: 'CHAIR' },
      { userId: id(4), role: 'SECRETARY' },
      { userId: id(5), role: 'MEMBER' },
    ],
  });
  await call('officer@demo.tenders', 'POST', `/tenders/tenders/${t.id}/publish`);
  await call('officer@demo.tenders', 'POST', '/tenders/tenders', { ...body, title: 'Construction of Kapsoen elevated steel tank', category: 'WORKS', estimate: '25000000', planReference: 'APP-2026-021', bidSecurity: '500000', closingAt: inDays(30), openingAt: inDays(30) });
  return 'one published tender (closes in 21 days) with committees, and one draft';
}

async function estates(call: Call) {
  const existing = await call<unknown[]>('officer@demo.estates', 'GET', '/estates/properties');
  if (existing.length) return 'already there';
  const p = await call<{ id: string; units: { id: string }[] }>('officer@demo.estates', 'POST', '/estates/properties', {
    code: 'HQ-PLAZA',
    name: 'Head office plaza',
    kind: 'COMMERCIAL',
    units: [
      { code: 'G1', description: 'Ground floor shop 1', marketRent: '25000' },
      { code: 'G2', description: 'Ground floor shop 2', marketRent: '25000' },
      { code: 'F1', description: 'First floor office', marketRent: '40000' },
      { code: 'F2', description: 'First floor office', marketRent: '40000' },
    ],
  });
  const tenant = await call<{ id: string }>('officer@demo.estates', 'POST', '/estates/tenants', { name: 'Mama Mboga Stores', kind: 'COMPANY', phone: '0722000111' });
  await call('officer@demo.estates', 'POST', '/estates/tenants', { name: 'Kiprop Chemists', kind: 'COMPANY', phone: '0722000222' });
  const start = `${today().slice(0, 7)}-01`;
  const l = await call<{ id: string }>('officer@demo.estates', 'POST', '/estates/leases', { tenantId: tenant.id, propertyId: p.id, unitId: p.units[0].id, startDate: start, endDate: `${Number(start.slice(0, 4)) + 2}${start.slice(4)}`, rent: '20000', serviceCharge: '2000', deposit: '40000', dueDay: 5 });
  await call('officer@demo.estates', 'POST', `/estates/leases/${l.id}/receive`, { date: today(), amount: '40000', kind: 'DEPOSIT', reference: 'DEP-001' });
  return 'a plaza with 4 units, 2 tenants and 1 lease with its deposit paid';
}

async function projects(call: Call) {
  const existing = await call<unknown[]>('manager@demo.projects', 'GET', '/projects/donors');
  if (existing.length) return 'already there';
  const donor = await call<{ id: string }>('manager@demo.projects', 'POST', '/projects/donors', { name: 'World Bank', type: 'MULTILATERAL', email: 'tm@worldbank.example' });
  const year = new Date().getUTCFullYear();
  const grant = await call<{ id: string }>('manager@demo.projects', 'POST', '/projects/grants', {
    donorId: donor.id,
    code: 'WB-01',
    title: 'Water and Sanitation Improvement',
    amount: '10000000',
    startDate: `${year}-07-01`,
    endDate: `${year + 1}-06-30`,
    fundCode: 'WB-01',
    budgetLines: [
      { code: 'WORKS', name: 'Civil works', amount: '8000000', accountPrefixes: ['15'] },
      { code: 'CONSULT', name: 'Supervision consultancy', amount: '2000000', accountPrefixes: ['61'] },
    ],
  });
  await call('manager@demo.projects', 'POST', `/projects/grants/${grant.id}/disbursements`, { date: today(), amount: '4000000', reference: 'IDA tranche 1' });
  const p = await call<{ id: string }>('manager@demo.projects', 'POST', '/projects/projects', { code: 'KAP-01', name: 'Kapsoen water works rehabilitation', kind: 'CAPEX', financeCode: 'P-001', grantIds: [grant.id], budget: '9000000', startDate: `${year}-07-01`, endDate: `${year + 1}-06-30` });
  await call('manager@demo.projects', 'PUT', `/projects/projects/${p.id}/milestones`, {
    milestones: [
      { name: 'Designs approved', weight: 1, percentComplete: 100 },
      { name: 'Intake and treatment works', weight: 3, percentComplete: 40 },
      { name: 'Commissioning', weight: 1, percentComplete: 0 },
    ],
  });
  return 'a donor, a KES 10m grant with its first tranche, and a project with milestones';
}

async function portals(call: Call, platform: Platform, organisationId: Types.ObjectId) {
  const existing = await call<unknown[]>('librarian@demo.portals', 'GET', '/portals/library');
  if (existing.length) return 'already there';
  const year = new Date().getUTCFullYear();
  await call('librarian@demo.portals', 'POST', '/portals/library', { title: `Strategic plan ${year}-${year + 4}`, category: 'STRATEGIC_PLAN', year, url: 'https://example.org/strategic-plan.pdf', audience: 'PUBLIC', tags: ['Strategy'] });
  await call('librarian@demo.portals', 'POST', '/portals/library', { title: 'Customer service charter', category: 'POLICY', year, url: 'https://example.org/charter.pdf', audience: 'PUBLIC' });
  await call('librarian@demo.portals', 'POST', '/portals/library', { title: 'Procurement manual (staff only)', category: 'MANUAL', url: 'https://example.org/manual.pdf' });
  const org = await platform.core.db.organisations.findById(organisationId).lean();
  await call('public', 'POST', `/portals/public/${org!.code.toLowerCase()}/msmes`, { businessName: 'Kapsoya Youth Welders', ownerName: 'Brian Kip', phone: '0711222333', sector: 'MANUFACTURING', agpo: 'YOUTH', agpoCertificate: 'AGPO/1234', products: [{ name: 'Steel gates', price: '45000', unit: 'gate' }] });
  return '3 library documents (2 public) and 1 MSME registration waiting for approval';
}
