import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BiServices } from '../src/modules/bi/server/container';
import { trendOf } from '../src/modules/bi/server/engine';
import { nextRun } from '../src/modules/bi/server/reports.service';
import { seedWater, startApp, TestApp } from './helpers';

/**
 * Reports & Analytics: the dataset catalogue limited by each user's permissions, grouped and pivoted
 * reports with trends and forecasts, drill-through, saved reports with versions and rollback, sharing,
 * exports (Excel, PDF, Word, CSV), the access log, scheduled email delivery, dashboards, end-to-end
 * turnaround across modules and customer risk scoring.
 */

let app: TestApp;
let bi: BiServices;
let org: Types.ObjectId;
const ids: Record<string, string> = {};

type Result = { columns: { key: string; label: string }[]; rows: Record<string, unknown>[]; pivot?: { total: number; colValues: unknown[] }; trend?: { direction: string; forecast: { period: string; value: number }[] } };

beforeAll(async () => {
  app = await startApp('bi_e2e', {
    modules: ['water', 'bi', 'ict'],
    users: [
      { who: 'admin', isAdmin: true },
      { who: 'analyst', access: [{ module: 'bi', role: 'ANALYST' }, { module: 'water', role: 'MANAGER' }] },
      { who: 'boss', access: [{ module: 'bi', role: 'MANAGER' }, { module: 'water', role: 'MANAGER' }] },
      { who: 'reader', access: [{ module: 'bi', role: 'VIEWER' }] },
    ],
  });
  bi = app.platform.modules.bi as BiServices;
  const w = await seedWater(app, ['Kiprono Kirui', 'Chebet Jepkosgei', 'Mutai Rono']);
  const db = app.platform.core.db;
  org = (await db.organisations.findOne({}).lean())!._id;
  const zoneId = new Types.ObjectId(w.zoneId);
  const D = (s: string) => new Date(`${s}T00:00:00Z`);
  const d128 = (n: number) => Types.Decimal128.fromString(n.toFixed(2));
  // Three months of bills rising month on month, and payments.
  const bills = [];
  for (const [m, base] of [['08', 1000], ['09', 1200], ['10', 1400]] as const) {
    for (const [i, c] of w.customers.entries()) {
      bills.push({ organisationId: org, billRunId: new Types.ObjectId(), billNo: `B-${m}-${i}`, customerId: new Types.ObjectId(c.id), accountNo: c.accountNo, customerName: `C${i}`, zoneId, category: i === 2 ? 'COMMERCIAL' : 'DOMESTIC', period: `2026-${m}`, status: 'ISSUED', units: d128(10 + i), currentCharges: d128(base + i * 100), balanceBroughtForward: d128(0), amountDue: d128(base + i * 100), billDate: D(`2026-${m}-28`), dueDate: D(`2026-${m}-28`), estimated: false, supplementary: false, lines: [] });
    }
  }
  await db.connection.collection('water_bills').insertMany(bills);
  await db.connection.collection('water_payments').insertMany([
    { organisationId: org, receiptNo: 'R1', channel: 'MPESA', reference: 'QX1', amount: d128(1000), paidAt: D('2026-09-05'), customerId: new Types.ObjectId(w.customers[0].id), accountNo: w.customers[0].accountNo, status: 'POSTED' },
    { organisationId: org, receiptNo: 'R2', channel: 'MPESA', reference: 'QX2', amount: d128(1200), paidAt: D('2026-10-05'), customerId: new Types.ObjectId(w.customers[0].id), accountNo: w.customers[0].accountNo, status: 'POSTED' },
  ]);
  // Customer 3 owes a lot for a long time and never pays: high risk.
  await db.connection.collection('water_customers').updateOne({ _id: new Types.ObjectId(w.customers[2].id) }, { $set: { balance: d128(9000), oldestUnpaidDueDate: new Date(Date.now() - 200 * 86_400_000) } });
  await db.connection.collection('water_customers').updateOne({ _id: new Types.ObjectId(w.customers[0].id) }, { $set: { balance: d128(200), oldestUnpaidDueDate: new Date(Date.now() - 5 * 86_400_000) } });
  const now = Date.now();
  await db.connection.collection('water_tickets').insertMany([
    { organisationId: org, number: 'T1', category: 'LEAK', channel: 'SMS', priority: 'NORMAL', status: 'RESOLVED', subject: 'x', createdAt: new Date(now - 10 * 3_600_000), resolvedAt: new Date(now - 5 * 3_600_000), slaDueAt: new Date(now - 2 * 3_600_000) },
    { organisationId: org, number: 'T2', category: 'LEAK', channel: 'SMS', priority: 'NORMAL', status: 'RESOLVED', subject: 'x', createdAt: new Date(now - 50 * 3_600_000), resolvedAt: new Date(now - 1 * 3_600_000), slaDueAt: new Date(now - 26 * 3_600_000) },
    { organisationId: org, number: 'T3', category: 'BILLING', channel: 'PORTAL', priority: 'NORMAL', status: 'OPEN', subject: 'x', createdAt: new Date(now - 80 * 3_600_000), slaDueAt: new Date(now - 30 * 3_600_000) },
  ]);
});

afterAll(async () => {
  await app?.stop();
});

describe('trend maths', () => {
  it('fits a line, forecasts and flags outliers', () => {
    const rows = [100, 110, 120, 130, 400, 150].map((v, i) => ({ m: new Date(Date.UTC(2026, i, 1)), v }));
    const t = trendOf(rows, 'm', 'v', 'month');
    expect(t.direction).toBe('up');
    expect(t.forecast.map((f) => f.period)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(t.anomalies.map((a) => a.period)).toEqual(['2026-05']);
    expect(nextRun('WEEKLY', 7, new Date('2026-11-09T10:00:00Z')).toISOString()).toBe('2026-11-16T04:00:00.000Z');
  });
});

describe('reports and analytics', () => {
  it('offers only the data each user may already see', async () => {
    const mine = await app.call<{ key: string }[]>('analyst', 'GET', '/bi/datasets');
    expect(mine.map((d) => d.key)).toEqual(expect.arrayContaining(['water.bills', 'water.payments', 'water.customers']));
    expect(mine.map((d) => d.key)).not.toContain('core.tasks');
    expect(mine.map((d) => d.key)).not.toContain('hr.employees'); // HR is not switched on
    expect(await app.call<unknown[]>('reader', 'GET', '/bi/datasets')).toEqual([]);
    await app.call('reader', 'POST', '/bi/query', { dataset: 'water.bills', filters: [] }, 403);
  });

  it('groups, pivots, trends and drills through', async () => {
    const byZone = await app.call<Result>('analyst', 'POST', '/bi/query', { dataset: 'water.bills', filters: [], groupBy: [{ field: 'zone' }], measures: [{ agg: 'sum', field: 'amountDue' }, { agg: 'count' }] }, 200);
    expect(byZone.rows).toEqual([{ zone: 'Kamelil', sum_amountDue: 11700, count_rows: 9 }]);

    const monthly = await app.call<Result>('analyst', 'POST', '/bi/query', { dataset: 'water.bills', filters: [], groupBy: [{ field: 'billDate', bucket: 'month' }], measures: [{ agg: 'sum', field: 'charges' }] }, 200);
    expect(monthly.rows.map((r) => r.sum_charges)).toEqual([3300, 3900, 4500]);
    expect(monthly.trend?.direction).toBe('up');
    expect(monthly.trend?.forecast[0].value).toBe(5100);

    const pivot = await app.call<Result>('analyst', 'POST', '/bi/query', { dataset: 'water.bills', filters: [], groupBy: [{ field: 'category' }, { field: 'period' }], measures: [{ agg: 'sum', field: 'amountDue' }], pivot: true }, 200);
    expect(pivot.pivot?.total).toBe(11700);
    expect(pivot.pivot?.colValues).toEqual(['2026-08', '2026-09', '2026-10']);

    const filtered = await app.call<Result>('analyst', 'POST', '/bi/query', { dataset: 'water.bills', filters: [{ field: 'billDate', op: 'between', value: '2026-09-01', to: '2026-10-31' }, { field: 'category', op: 'eq', value: 'COMMERCIAL' }], columns: ['billNo', 'amountDue'] }, 200);
    expect(filtered.rows.map((r) => r.billNo).sort()).toEqual(['B-09-2', 'B-10-2']);

    const drill = await app.call<Result>('analyst', 'POST', '/bi/query/drill', { spec: { dataset: 'water.bills', filters: [], groupBy: [{ field: 'billDate', bucket: 'month' }], measures: [{ agg: 'sum', field: 'charges' }] }, values: { billDate: monthly.rows[1].billDate } }, 200);
    expect(drill.rows).toHaveLength(3);
    await app.call('analyst', 'POST', '/bi/query', { dataset: 'water.bills', filters: [], groupBy: [{ field: 'zone', bucket: 'month' }] }, 400);
  });

  it('saves reports with versions, rollback, sharing and an access log', async () => {
    const r = await app.call<{ id: string }>('analyst', 'POST', '/bi/reports', { name: 'Billing by zone', folder: 'Commercial', chart: 'bar', spec: { dataset: 'water.bills', filters: [], groupBy: [{ field: 'zone' }], measures: [{ agg: 'sum', field: 'amountDue' }] } }, 201);
    ids.report = r.id;
    await app.call('analyst', 'PUT', `/bi/reports/${r.id}`, { name: 'Billing by category', chart: 'pie', note: 'by category', spec: { dataset: 'water.bills', filters: [], groupBy: [{ field: 'category' }], measures: [{ agg: 'sum', field: 'amountDue' }] } }, 200);
    const back = await app.call<{ version: number; name: string; chart: string; versions: { version: number }[] }>('analyst', 'POST', `/bi/reports/${r.id}/rollback`, { version: 1 }, 200);
    expect(back).toMatchObject({ version: 3, name: 'Billing by zone', chart: 'bar' });
    expect(back.versions.map((v) => v.version)).toEqual([1, 2]);

    await app.call('reader', 'GET', `/bi/reports/${r.id}`, undefined, 404);
    await app.call('analyst', 'PUT', `/bi/reports/${r.id}/share`, { everyone: true }, 403);
    const readerId = (await app.platform.core.db.users.findOne({ email: 'reader@test.co' }).lean())!._id.toHexString();
    await app.call('analyst', 'PUT', `/bi/reports/${r.id}/share`, { everyone: false, sharedWith: [readerId] }, 200);
    await app.call('reader', 'GET', `/bi/reports/${r.id}`, undefined, 200);
    // Sharing a report does not hand over data the reader may not see.
    await app.call('reader', 'POST', `/bi/reports/${r.id}/run`, {}, 403);
    await app.call('reader', 'PUT', `/bi/reports/${r.id}`, { name: 'x', spec: { dataset: 'water.bills', filters: [] } }, 403);

    const run = await app.call<{ result: Result }>('boss', 'POST', `/bi/reports/${r.id}/run`, {}, 200);
    expect(run.result.rows[0].zone).toBe('Kamelil');
    const log = await app.call<{ who: string; action: string }[]>('analyst', 'GET', `/bi/reports/${r.id}/access-log`);
    expect(log.map((l) => `${l.who}:${l.action}`)).toEqual(expect.arrayContaining(['Reader:view', 'Boss:run', 'Analyst:update']));
  });

  it('exports to Excel, PDF, Word and CSV', async () => {
    const xls = await app.raw('analyst', 'GET', `/bi/reports/${ids.report}/export/xls`);
    expect(xls.headers.get('content-type')).toContain('ms-excel');
    expect(await xls.text()).toContain('<Worksheet ss:Name="Billing by zone">');
    const pdf = await app.raw('analyst', 'GET', `/bi/reports/${ids.report}/export/pdf`);
    expect(pdf.headers.get('content-type')).toContain('pdf');
    expect((await app.raw('analyst', 'GET', `/bi/reports/${ids.report}/export/doc`)).headers.get('content-type')).toContain('msword');
    const csv = await app.raw('analyst', 'POST', '/bi/query/export', { spec: { dataset: 'water.payments', filters: [], columns: ['receiptNo', 'amount'] }, format: 'csv', title: 'Receipts' });
    expect(await csv.text()).toContain('R2,1200.00');
  });

  it('emails scheduled reports', async () => {
    const s = await app.call<{ schedule: { nextRunAt: string } }>('analyst', 'PUT', `/bi/reports/${ids.report}/schedule`, { frequency: 'WEEKLY', hour: 7, emails: ['md@tachwasco.test'] }, 200);
    expect(new Date(s.schedule.nextRunAt).getUTCDay()).toBe(1);
    await bi.db.reports.updateOne({ _id: new Types.ObjectId(ids.report) }, { 'schedule.nextRunAt': new Date(Date.now() - 1000) });
    expect(await app.call('boss', 'POST', '/bi/schedules/run', undefined, 200)).toEqual({ sent: 1, failed: 0 });
    const mail = await app.platform.core.db.emails.findOne({ to: 'md@tachwasco.test' }).lean();
    expect(mail?.subject).toContain('Billing by zone');
    expect(await app.call('boss', 'POST', '/bi/schedules/run', undefined, 200)).toEqual({ sent: 0, failed: 0 });
  });

  it('builds dashboards from saved reports', async () => {
    const kpi = await app.call<{ id: string }>('analyst', 'POST', '/bi/reports', { name: 'Collections', chart: 'kpi', spec: { dataset: 'water.payments', filters: [], groupBy: [{ field: 'channel' }], measures: [{ agg: 'sum', field: 'amount' }] } }, 201);
    const d = await app.call<{ id: string }>('analyst', 'POST', '/bi/dashboards', { name: 'Commercial', refreshSeconds: 120, tiles: [{ reportId: kpi.id, width: 1 }, { reportId: ids.report, width: 2, chart: 'pie' }] }, 201);
    const run = await app.call<{ tiles: { title: string; chart: string; result?: Result; error?: string }[] }>('analyst', 'GET', `/bi/dashboards/${d.id}/run`);
    expect(run.tiles.map((t) => [t.title, t.chart])).toEqual([['Collections', 'kpi'], ['Billing by zone', 'pie']]);
    expect(run.tiles[0].result?.rows[0]).toEqual({ channel: 'MPESA', sum_amount: 2200 });
    const book = await (await app.raw('analyst', 'GET', `/bi/dashboards/${d.id}/export/xls`)).text();
    expect(book.match(/<Worksheet /g)).toHaveLength(2);
    await app.call('analyst', 'POST', '/bi/dashboards', { name: 'Featured', featured: true, tiles: [] }, 403);
  });

  it('measures turnaround across modules and names bottlenecks', async () => {
    await app.call('analyst', 'GET', '/bi/analytics/turnaround?from=2026-01-01&to=2030-01-01', undefined, 403);
    const t = await app.call<{ processes: { key: string; completed: number; onTimePct: number; open: number; overdue: number }[]; bottlenecks: { key: string }[] }>('boss', 'GET', '/bi/analytics/turnaround?from=2026-01-01&to=2030-01-01');
    const complaints = t.processes.find((p) => p.key === 'complaints')!;
    expect(complaints).toMatchObject({ completed: 2, onTimePct: 50, open: 1, overdue: 1 });
    expect(t.processes.map((p) => p.key)).toContain('helpdesk');
    expect(t.processes.map((p) => p.key)).not.toContain('leave'); // HR off
  });

  it('scores customers for default and churn risk', async () => {
    const r = await app.call<{ scored: number; riskiest: { name: string; band: string; defaultRisk: number; expectedLoss: number }[]; portfolio: { balance: number; bands: { band: string; balance: number }[] } }>('analyst', 'GET', '/bi/analytics/customer-risk');
    expect(r.scored).toBe(3);
    expect(r.riskiest[0]).toMatchObject({ name: 'Mutai Rono', band: 'HIGH' });
    expect(r.riskiest[0].defaultRisk).toBeGreaterThan(70);
    expect(r.portfolio.balance).toBe(9200);
    expect(r.portfolio.bands.find((b) => b.band === 'HIGH')?.balance).toBe(9000);
    await app.call('reader', 'GET', '/bi/analytics/customer-risk', undefined, 403);
    expect((r as unknown as { model: { method: string; reason: string } }).model).toMatchObject({ method: 'RULES', reason: expect.stringContaining('Not enough history') });
  });

  it('trains the default model on the organisation’s own history once there is enough of it', async () => {
    const db = app.platform.core.db.connection.db!;
    const org = new Types.ObjectId(app.orgId);
    const DAY = 86_400_000;
    const now = Date.now();
    const zoneId = (await db.collection('water_customers').findOne({ organisationId: org }))!.zoneId;
    // 120 accounts opened a year ago. Good payers paid every month; poor payers paid little and rarely,
    // and most of them were later listed for disconnection.
    const customers = [];
    const bills = [];
    const payments = [];
    const listed = [];
    for (let i = 0; i < 120; i++) {
      const poor = i % 3 === 0;
      const _id = new Types.ObjectId();
      customers.push({ _id, organisationId: org, accountNo: `H${i}`, name: `History ${i}`, category: 'DOMESTIC', status: 'ACTIVE', zoneId, balance: Types.Decimal128.fromString(poor ? '6000' : '0'), oldestUnpaidDueDate: poor ? new Date(now - 200 * DAY) : null, createdAt: new Date(now - 400 * DAY), updatedAt: new Date() });
      for (let m = 1; m <= 12; m++) {
        const at = new Date(now - (m * 30 - 5) * DAY);
        bills.push({ organisationId: org, customerId: _id, billDate: at, currentCharges: Types.Decimal128.fromString('1000'), units: Types.Decimal128.fromString('8'), status: 'ISSUED' });
        if (!poor || ((m === 6 || m === 12) && i % 2 === 0)) payments.push({ organisationId: org, customerId: _id, channel: 'CASH', reference: `H${i}-${m}`, receiptNo: `RH${i}-${m}`, paidAt: new Date(at.getTime() + 10 * DAY), amount: Types.Decimal128.fromString(poor ? '300' : '1000'), status: 'POSTED' });
      }
      if (poor && i % 9 !== 0) listed.push({ organisationId: org, customerId: _id, status: 'LISTED', listedAt: new Date(now - 30 * DAY), arrears: Types.Decimal128.fromString('6000') });
    }
    await db.collection('water_customers').insertMany(customers);
    await db.collection('water_bills').insertMany(bills);
    await db.collection('water_payments').insertMany(payments);
    await db.collection('water_disconnections').insertMany(listed);
    const r = await app.call<{ model: { method: string; trainedOn: number; defaulters: number; testAuc: number; coefficients: Record<string, number> }; riskiest: { name: string; defaultRisk: number; balance: number }[] }>('analyst', 'GET', '/bi/analytics/customer-risk');
    expect(r.model.method).toBe('TRAINED');
    expect(r.model.trainedOn).toBe(120);
    expect(r.model.testAuc).toBeGreaterThanOrEqual(0.6);
    expect(r.model.coefficients.paidShareOfBills).toBeLessThan(0); // paying more lowers the risk
    const poorOnes = r.riskiest.filter((x) => x.name.startsWith('History') && x.balance > 0);
    expect(poorOnes.length).toBeGreaterThan(10);
    expect(poorOnes.every((x) => x.defaultRisk >= 60)).toBe(true);

    // Data mining: the same accounts fall into behaviour groups.
    const seg = await app.call<{ customers: number; segments: { name: string; customers: number; centre: { paidShare: number } }[] }>('analyst', 'GET', '/bi/analytics/customer-segments?k=3');
    expect(seg.segments).toHaveLength(3);
    expect(seg.segments.reduce((s, x) => s + x.customers, 0)).toBe(seg.customers);
    expect(seg.segments.some((x) => x.name.includes('seldom pay'))).toBe(true);
    expect(seg.segments.some((x) => x.name.includes('pay on time'))).toBe(true);
    await app.call('reader', 'GET', '/bi/analytics/customer-segments', undefined, 403);
  });

  it('keeps a daily data warehouse that later changes do not rewrite', async () => {
    await app.call('analyst', 'POST', '/warehouse/snapshot', {}, 403);
    const first = await app.call<{ facts: number; written: { metric: string; value: number }[] }>('admin', 'POST', '/warehouse/snapshot', { date: '2026-11-01' }, 200);
    const connections = first.written.find((w) => w.metric === 'water.activeCustomers')!.value;
    expect(connections).toBeGreaterThan(100);
    expect(first.written.map((w) => w.metric)).toEqual(expect.arrayContaining(['water.arrears', 'ict.openTickets', 'core.pendingApprovals']));
    expect(first.written.map((w) => w.metric)).not.toContain('hr.headcount'); // HR is off here
    // A connection closes later; the 1 November figure stays as it was.
    const db = app.platform.core.db.connection.db!;
    await db.collection('water_customers').updateOne({ organisationId: new Types.ObjectId(app.orgId), status: 'ACTIVE' }, { $set: { status: 'CLOSED' } });
    await app.call('admin', 'POST', '/warehouse/snapshot', { date: '2026-11-02' }, 200);
    const facts = await app.call<{ rows: { date: string; value: number }[] }>('admin', 'GET', '/warehouse/facts?metric=water.activeCustomers');
    expect(facts.rows.map((r) => [r.date, r.value])).toEqual([['2026-11-01', connections], ['2026-11-02', connections - 1]]);
    // Reportable like any other dataset.
    const q = await app.call<{ rows: Record<string, unknown>[] }>('boss', 'POST', '/bi/query', { dataset: 'core.warehouse', filters: [{ field: 'metric', op: 'eq', value: 'Active water connections' }], columns: ['day', 'value'] }, 200);
    expect(q.rows).toHaveLength(2);
  });
});
