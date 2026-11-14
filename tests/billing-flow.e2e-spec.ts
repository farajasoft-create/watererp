import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WaterServices } from '../src/modules/water/server/container';
import type { Platform } from '../src/platform/container';

/**
 * The whole water revenue cycle through the real platform API: set-up, meter reading (online and offline
 * sync), estimates, a billing run with maker-checker approval, M-Pesa paybill payments, the journals sent
 * through the platform ledger, the NRW water balance and the disconnection list; then the platform rules
 * every module relies on (module switches, per-module roles, events).
 */

let replSet: MongoMemoryReplSet;
let handle: (req: Request) => Promise<Response>;
let platform: Platform;
let s: WaterServices;
const events: string[] = [];
const journals: { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];

const BASE = 'http://water.test/api/v1';
const cookies: Record<string, string> = {};

async function call<T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown, expected?: number): Promise<T> {
  const res = await handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (expected !== undefined) expect(res.status, JSON.stringify(data)).toBe(expected);
  else expect(res.status, `${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(300);
  return data as T;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = replSet.getUri('water_e2e');
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';

  // A stand-in for FarajaSoft Accounting that records the journals it receives.
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://books.test')) return realFetch(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    journals.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith('/journals')) return Response.json({ id: `j${journals.length}`, status: 'DRAFT' }, { status: 201 });
    return Response.json({ ok: true });
  });

  ({ handleApi: handle } = await import('../src/platform/api'));
  platform = await (await import('../src/platform/container')).getPlatform();
  s = platform.modules.water as WaterServices;
  platform.core.events.on('water.*', (e) => void events.push(e.name));
  const [org] = await s.db.organisations.create([{ name: 'Test Water Co', code: 'TWC', modules: ['water'] }]);
  const hash = await bcrypt.hash('password-123456', 4);
  await s.db.users.create([
    { organisationId: org._id, email: 'admin@test.co', name: 'Admin', isAdmin: true, passwordHash: hash },
    { organisationId: org._id, email: 'billing@test.co', name: 'Billing', access: [{ module: 'water', role: 'BILLING' }], passwordHash: hash },
    { organisationId: org._id, email: 'manager@test.co', name: 'Manager', access: [{ module: 'water', role: 'MANAGER' }], passwordHash: hash },
  ]);
  for (const who of ['admin', 'billing', 'manager']) await call(who, 'POST', '/auth/login', { email: `${who}@test.co`, password: 'password-123456' }, 200);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await platform?.core.db.connection.close();
  await replSet?.stop();
});

describe('revenue cycle', () => {
  const ids: Record<string, string> = {};

  it('sets up a zone, tariff, customers and meters', async () => {
    const zone = await call<{ id: string }>('admin', 'POST', '/water/zones', { code: 'kml', name: 'Kamelil' });
    ids.zone = zone.id;
    const tariff = await call<{ id: string }>('admin', 'POST', '/water/tariffs', {
      code: 'DOM',
      name: 'Domestic',
      category: 'DOMESTIC',
      effectiveFrom: '2026-07-01',
      blocks: [{ upTo: '6', rate: '0', fixedAmount: '600' }, { upTo: '20', rate: '120' }, { upTo: null, rate: '140' }],
      meterRent: '50',
      sewerPercent: '0',
      defaultEstimate: '10',
    });
    ids.tariff = tariff.id;

    const a = await call<{ id: string; accountNo: string }>('billing', 'POST', '/water/customers', { name: 'Kiprono Kirui', category: 'DOMESTIC', zoneId: zone.id, tariffId: tariff.id, phone: '0712345678', status: 'ACTIVE', openingBalance: '500' });
    expect(a.accountNo).toBe('KML-00001');
    ids.a = a.id;
    const b = await call<{ id: string }>('billing', 'POST', '/water/customers', { name: 'Chebet Jepkosgei', category: 'DOMESTIC', zoneId: zone.id, tariffId: tariff.id, status: 'ACTIVE' });
    ids.b = b.id;

    for (const [key, serial] of [['ma', 'M-001'], ['mb', 'M-002']] as const) {
      const m = await call<{ id: string }>('billing', 'POST', '/water/meters', { serialNo: serial, dials: 5 });
      ids[key] = m.id;
    }
    await call('billing', 'POST', `/water/meters/${ids.ma}/install`, { customerId: ids.a, reading: '100', date: '2026-09-30' }, 200);
    await call('billing', 'POST', `/water/meters/${ids.mb}/install`, { customerId: ids.b, reading: '50', date: '2026-09-30' }, 200);
    const bulk = await call<{ id: string; status: string }>('admin', 'POST', '/water/meters', { serialNo: 'BULK-KML', type: 'BULK', zoneId: zone.id, initialReading: '10000', dials: 7 });
    expect(bulk.status).toBe('INSTALLED');
    ids.bulk = bulk.id;

    // A tariff whose bands do not cover every consumption is refused.
    await call('admin', 'POST', '/water/tariffs', { code: 'BAD', name: 'Bad', category: 'DOMESTIC', effectiveFrom: '2026-07-01', blocks: [{ upTo: '10', rate: '1' }] }, 400);
  });

  it('captures readings, deduplicates offline syncs and estimates the rest', async () => {
    await call('billing', 'POST', '/water/cycles', { period: '2026-10' });
    const read = await call<{ status: string; units: string; exception: string }>('billing', 'POST', '/water/readings', { clientId: 'device-1-0001', meterId: ids.ma, value: '118', readAt: '2026-10-28T08:00:00+03:00', gps: { lat: 0.06, lng: 35.2 } });
    expect(read).toMatchObject({ status: 'APPROVED', units: '18', exception: 'NONE' });

    // The phone retries the same reading after a dropped connection: stored once.
    const sync = await call<{ results: { ok: boolean; duplicate: boolean }[] }>('billing', 'POST', '/water/readings/sync', {
      readings: [
        { clientId: 'device-1-0001', meterId: ids.ma, value: '118', readAt: '2026-10-28T08:00:00+03:00' },
        { clientId: 'device-1-0002', meterId: ids.bulk, value: '10030', readAt: '2026-10-28T09:00:00+03:00' },
      ],
    });
    expect(sync.results.map((r) => [r.ok, r.duplicate])).toEqual([
      [true, true],
      [true, false],
    ]);

    // Customer B's gate was locked: the reader records why instead of a value.
    const noAccess = await call<{ status: string; exception: string }>('billing', 'POST', '/water/readings', { clientId: 'device-1-0003', meterId: ids.mb, fieldException: 'NO_ACCESS', readAt: '2026-10-28T10:00:00+03:00' });
    expect(noAccess).toMatchObject({ status: 'PENDING', exception: 'NO_ACCESS' });

    const est = await call<{ estimated: number }>('billing', 'POST', '/water/cycles/2026-10/estimate', {}, 200);
    expect(est.estimated).toBe(1);
  });

  it('bills the period with maker-checker approval', async () => {
    const { run, unread } = await call<{ run: { id: string; billCount: number; totalAmount: string }; unread: string[] }>('billing', 'POST', '/water/bill-runs', { period: '2026-10', billDate: '2026-10-31' });
    expect(unread).toEqual([]);
    expect(run.billCount).toBe(2);
    // A: 600 + 12 × 120 + 50 rent = 2090. B (estimated 10 m³): 600 + 4 × 120 + 50 = 1130.
    expect(run.totalAmount).toBe('3220');
    ids.run = run.id;

    // The preparer cannot approve their own run.
    await call('billing', 'POST', `/water/bill-runs/${run.id}/approve`, undefined, 403);

    // One ledger connection for the whole platform; water maps its own accounts.
    await call('admin', 'PATCH', '/settings/ledger', { enabled: true, baseUrl: 'https://books.test', apiKey: 'fsk_test_key', entityId: 'e'.repeat(24), branchId: 'b'.repeat(24), mode: 'SUBMIT' });
    await call('admin', 'PATCH', '/water/settings/accounts', {
      accounts: { receivable: '1'.repeat(24), water: '2'.repeat(24), meterRent: '3'.repeat(24), mpesa: '4'.repeat(24), cash: '5'.repeat(24), adjustments: '6'.repeat(24) },
    });

    const approved = await call<{ status: string }>('manager', 'POST', `/water/bill-runs/${run.id}/approve`, undefined, 200);
    expect(approved.status).toBe('APPROVED');

    const a = await call<{ balance: string; bills: { billNo: string; amountDue: string; balanceBroughtForward: string }[] }>('admin', 'GET', `/water/customers/${ids.a}`);
    expect(a.balance).toBe('2590');
    expect(a.bills[0]).toMatchObject({ billNo: '202610-000001', balanceBroughtForward: '500', amountDue: '2590' });

    // The run reached the ledger as one balanced journal, submitted for approval.
    const create = journals.find((j) => j.url.endsWith('/journals'))!;
    expect(create.headers['Idempotency-Key']).toBe(`farajasoft-water:billRun:${run.id}`);
    expect(create.body).toMatchObject({ reference: 'WATER-BILLS-2026-10', journalDate: '2026-10-31' });
    const lines = create.body!.lines as { debit?: string; credit?: string }[];
    expect(lines[0].debit).toBe('3220.00');
    expect(lines.slice(1).reduce((t, l) => t + Number(l.credit), 0)).toBe(3220);
    expect(journals.some((j) => j.url.endsWith('/submit'))).toBe(true);
    const stored = await s.db.billRuns.findById(run.id).lean();
    expect(stored?.accounting?.status).toBe('SENT');
    expect(events).toContain('water.bill-run.approved');
  });

  it('takes M-Pesa paybill payments once, and parks unknown accounts', async () => {
    await call('admin', 'PATCH', '/water/settings/mpesa', { shortcode: '600100' });
    const settings = await call<{ mpesa: { callbackToken: string } }>('admin', 'GET', '/water/settings');
    const token = settings.mpesa.callbackToken;
    ids.token = token;
    const c2b = (TransID: string, BillRefNumber: string, TransAmount: string) => ({ TransactionType: 'Pay Bill', TransID, TransTime: '20261101103000', TransAmount, BusinessShortCode: '600100', BillRefNumber, MSISDN: '254712345678', FirstName: 'KIPRONO' });

    expect(await call('mpesa', 'POST', `/water/mpesa/c2b/${token}/validation`, c2b('X', 'nobody', '1'), 200)).toMatchObject({ ResultCode: 'C2B00012' });
    expect(await call('mpesa', 'POST', `/water/mpesa/c2b/${token}/validation`, c2b('X', 'kml 1', '1'), 200)).toMatchObject({ ResultCode: '0' });

    await call('mpesa', 'POST', `/water/mpesa/c2b/${token}/confirmation`, c2b('TKA1B2C3D4', 'kml 1', '1000.00'), 200);
    await call('mpesa', 'POST', `/water/mpesa/c2b/${token}/confirmation`, c2b('TKA1B2C3D4', 'kml 1', '1000.00'), 200);
    const a = await call<{ balance: string }>('admin', 'GET', `/water/customers/${ids.a}`);
    expect(a.balance).toBe('1590');
    expect(await s.db.payments.countDocuments({ reference: 'TKA1B2C3D4' })).toBe(1);

    // A wrong token is ignored but still answered, so Safaricom does not retry forever.
    await call('mpesa', 'POST', `/water/mpesa/c2b/${'x'.repeat(32)}/confirmation`, c2b('TKZZZ', 'kml 1', '5'), 200);
    expect(await s.db.payments.countDocuments({ reference: 'TKZZZ' })).toBe(0);

    await call('mpesa', 'POST', `/water/mpesa/c2b/${token}/confirmation`, c2b('TKUNKNOWN1', 'house 7', '400'), 200);
    const unmatched = await call<{ items: { id: string; status: string }[] }>('admin', 'GET', '/water/payments?status=UNMATCHED');
    expect(unmatched.items).toHaveLength(1);
    await call('admin', 'POST', `/water/payments/${unmatched.items[0].id}/allocate`, { customerId: ids.b }, 200);
    const b = await call<{ balance: string }>('admin', 'GET', `/water/customers/${ids.b}`);
    expect(b.balance).toBe('730');

    const mpesaJournal = journals.filter((j) => j.url.endsWith('/journals')).find((j) => (j.body!.description as string).includes('TKA1B2C3D4'));
    expect((mpesaJournal!.body!.lines as { accountId: string; debit?: string }[])[0]).toMatchObject({ accountId: '4'.repeat(24), debit: '1000.00' });
  });

  it('reverses a payment and charges the customer back', async () => {
    const pay = await call<{ id: string }>('admin', 'POST', '/water/payments', { customerId: ids.a, amount: '200', channel: 'CASH', reference: 'RB-0001', paidAt: '2026-11-01' });
    expect((await call<{ balance: string }>('admin', 'GET', `/water/customers/${ids.a}`)).balance).toBe('1390');
    await call('admin', 'POST', `/water/payments/${pay.id}/reverse`, { reason: 'Counterfeit note' }, 200);
    expect((await call<{ balance: string }>('admin', 'GET', `/water/customers/${ids.a}`)).balance).toBe('1590');
    const statement = await call<{ type: string; balance: string }[]>('admin', 'GET', `/water/customers/${ids.a}/statement`);
    expect(statement.map((e) => [e.type, e.balance])).toEqual([
      ['OPENING', '500'],
      ['BILL', '2590'],
      ['PAYMENT', '1590'],
      ['PAYMENT', '1390'],
      ['REVERSAL', '1590'],
    ]);
    expect(journals.some((j) => (j.body?.reference as string | undefined)?.startsWith('WATER-REV-'))).toBe(true);
  });

  it('approves adjustments only by a second person', async () => {
    const adj = await call<{ id: string }>('billing', 'POST', '/water/adjustments', { customerId: ids.b, amount: '-130', reason: 'Leak repaired on customer side', category: 'LEAK_ALLOWANCE' });
    await call('billing', 'POST', `/water/adjustments/${adj.id}/review`, { approve: true }, 403);
    await call('manager', 'POST', `/water/adjustments/${adj.id}/review`, { approve: true }, 200);
    expect((await call<{ balance: string }>('admin', 'GET', `/water/customers/${ids.b}`)).balance).toBe('600');
  });

  it('computes the water balance from the bulk meter', async () => {
    const wb = await call<{ zones: { code: string; systemInput: string; revenueWater: string; nonRevenueWater: string; nrwPercent: string }[] }>('admin', 'GET', '/water/reports/water-balance?period=2026-10');
    // 30 m³ in; 18 metered + 10 estimated billed.
    expect(wb.zones[0]).toMatchObject({ code: 'KML', systemInput: '30', revenueWater: '28', nonRevenueWater: '2', nrwPercent: '6.7' });
    const dash = await call<{ billing: { billed: string }; indicators: { meteringRatio: string } }>('admin', 'GET', '/water/reports/dashboard?period=2026-10');
    expect(dash.billing.billed).toBe('3220');
    expect(dash.indicators.meteringRatio).toBe('100');
  });

  it('lists overdue accounts for disconnection and reconnects them', async () => {
    await call('admin', 'PATCH', '/water/settings/billing', {
      billing: { dueDays: 14, penaltyPercent: '2', reconnectionFee: '1000', disconnectionMinArrears: '1000', disconnectionGraceDays: 0, highFactor: 2, lowFactor: 0.3 },
    });
    const gen = await call<{ listed: number }>('admin', 'POST', '/water/disconnections/generate', {}, 200);
    // Only A owes more than KES 1,000; its October bill is due 2026-11-14, so set the clock past it.
    expect(gen.listed).toBe(0);
    await s.db.customers.updateOne({ _id: ids.a }, { oldestUnpaidDueDate: new Date('2026-10-01T00:00:00Z') });
    expect((await call<{ listed: number }>('admin', 'POST', '/water/disconnections/generate', {}, 200)).listed).toBe(1);
    const [row] = await call<{ id: string }[]>('admin', 'GET', '/water/disconnections');
    await call('admin', 'POST', `/water/disconnections/${row.id}/disconnect`, {}, 200);
    expect((await call<{ status: string }>('admin', 'GET', `/water/customers/${ids.a}`)).status).toBe('DISCONNECTED');
    await call('admin', 'POST', `/water/disconnections/${row.id}/reconnect`, {}, 200);
    const a = await call<{ status: string; balance: string }>('admin', 'GET', `/water/customers/${ids.a}`);
    expect(a).toMatchObject({ status: 'ACTIVE', balance: '2590' });
  });

  it('keeps meter readers to the field routes', async () => {
    const zone = await s.db.zones.findById(ids.zone).lean();
    const hash = await bcrypt.hash('password-123456', 4);
    await s.db.users.create([{ organisationId: zone!.organisationId, email: 'reader@test.co', name: 'Reader', access: [{ module: 'water', role: 'METER_READER', scope: [zone!._id] }], passwordHash: hash }]);
    await call('reader', 'POST', '/auth/login', { email: 'reader@test.co', password: 'password-123456' }, 200);
    // October is billed, so there is nothing to read until the next cycle opens.
    await call('reader', 'GET', '/water/field/route', undefined, 400);
    await call('billing', 'POST', '/water/cycles', { period: '2026-11' });
    const route = await call<{ period: string; stops: { serialNo: string; read: boolean }[] }>('reader', 'GET', '/water/field/route');
    expect(route.period).toBe('2026-11');
    expect(route.stops.map((x) => x.serialNo).sort()).toEqual(['BULK-KML', 'M-001', 'M-002']);
    await call('reader', 'GET', '/water/customers', undefined, 403);
    await call('reader', 'POST', '/water/bill-runs', { period: '2026-10', billDate: '2026-10-31' }, 403);
  });

  it('gives users one role per module, managed in one place', async () => {
    const roles = await call<{ module: string; roles: { key: string }[] }[]>('admin', 'GET', '/roles');
    expect(roles.find((r) => r.module === 'water')!.roles.map((r) => r.key)).toContain('CASHIER');
    await call('admin', 'POST', '/users', { name: 'Cashier', email: 'cashier@test.co', password: 'password-123456', access: [{ module: 'water', role: 'CASHIER' }] });
    await call('admin', 'POST', '/users', { name: 'X', email: 'x@test.co', password: 'password-123456', access: [{ module: 'water', role: 'PILOT' }] }, 400);
    await call('admin', 'POST', '/users', { name: 'Y', email: 'y@test.co', password: 'password-123456', access: [{ module: 'nothing', role: 'X' }] }, 400);
    await call('cashier', 'POST', '/auth/login', { email: 'cashier@test.co', password: 'password-123456' }, 200);
    const me = await call<{ permissions: string[]; access: { module: string; roleLabel: string }[] }>('cashier', 'GET', '/auth/me');
    expect(me.access).toEqual([expect.objectContaining({ module: 'water', roleLabel: 'Cashier' })]);
    expect(me.permissions).toContain('water.payment.record');
    expect(me.permissions).not.toContain('core.users.manage');
    await call('cashier', 'GET', '/users', undefined, 403);
    await call('cashier', 'GET', '/water/customers');
  });

  it('refuses a module the organisation has switched off, M-Pesa included', async () => {
    const modules = await call<{ key: string; enabled: boolean }[]>('admin', 'PUT', '/settings/modules', { modules: [] }, 200);
    expect(modules.find((m) => m.key === 'water')!.enabled).toBe(false);
    await call('admin', 'GET', '/water/customers', undefined, 403);
    const payment = { TransactionType: 'Pay Bill', TransID: 'TKOFF1', TransTime: '20261101103000', TransAmount: '10', BusinessShortCode: '600100', BillRefNumber: 'kml 1', MSISDN: '254712345678' };
    await call('mpesa', 'POST', `/water/mpesa/c2b/${ids.token}/confirmation`, payment, 200);
    expect(await s.db.payments.countDocuments({ reference: 'TKOFF1' })).toBe(0);
    await call('admin', 'PUT', '/settings/modules', { modules: ['nope'] }, 400);
    await call('admin', 'PUT', '/settings/modules', { modules: ['water'] }, 200);
    await call('admin', 'GET', '/water/customers');
  });
});
