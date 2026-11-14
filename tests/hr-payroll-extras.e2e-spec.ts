import bcrypt from 'bcryptjs';
import mongoose, { Connection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hrModule } from '../src/modules/hr/module';
import type { HrServices } from '../src/modules/hr/server/container';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';

/**
 * Payroll extras: employer pension contributions and the scheme remittance file, insurance relief,
 * contract gratuity accrued and paid with final dues, board payroll kept apart from staff, pay change
 * advice between payrolls, and the payroll audit trail.
 */

let replSet: MongoMemoryReplSet;
let conn: Connection;
let platform: Platform;
let handle: (req: Request) => Promise<Response>;
let orgId: Types.ObjectId;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const PASSWORD = 'password-123456';

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T; text: string }> {
  const res = await handle(new Request(`http://platform.test/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null) as T, text };
}
const ok = async <T = Record<string, unknown>>(p: Promise<{ status: number; data: T }>, status = 200) => {
  const r = await p;
  if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};

const employee = (firstName: string, pay: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  firstName,
  lastName: 'Test',
  departmentId: ids.TEC,
  hireDate: '2025-01-01',
  nationalId: String(32000000 + firstName.charCodeAt(0) * 7 + firstName.length),
  ...extra,
  pay: { payMethod: 'BANK', bank: { name: 'KCB', accountNo: `22${firstName}` }, exempt: { paye: false, nssf: false, shif: false, ahl: false }, ...pay },
});

type Slip = { id: string; employeeId: string; employerPension: string; gratuity: string; insuranceRelief: string; lines: { type: string; code: string; amount: string }[] };
const approve = async (runId: string) => expect((await ok<{ status: string }>(call('finance', 'POST', `/hr/payroll/${runId}/approve`))).status).toBe('APPROVED');

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('hr_payroll_extras_e2e')).asPromise();
  const modules = [hrModule];
  platform = await createPlatform(conn, { modules });
  handle = createApi(async () => platform, modules);
  const { db } = platform.core;
  const [org] = await db.organisations.create([{ name: 'Tachasis Water', code: 'TACH', modules: ['hr'] }]);
  orgId = org._id;
  const hr = platform.modules.hr as HrServices;
  await hrModule.seed!({ db, core: platform.core, services: hr, organisationId: orgId, demo: false, demoPassword: PASSWORD });
  ids.TEC = (await hr.db.departments.findOne({ organisationId: orgId, code: 'TEC' }).lean())!._id.toHexString();
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.users.create([
    { organisationId: orgId, email: 'hr@test.co', name: 'HR', access: [{ module: 'hr', role: 'HR_MANAGER' }], passwordHash: hash },
    { organisationId: orgId, email: 'payroll@test.co', name: 'Payroll', access: [{ module: 'hr', role: 'PAYROLL_OFFICER' }], passwordHash: hash },
    { organisationId: orgId, email: 'finance@test.co', name: 'Finance', access: [{ module: 'hr', role: 'FINANCE' }], passwordHash: hash },
  ]);
  for (const who of ['hr', 'payroll', 'finance']) expect((await call(who, 'POST', '/auth/login', { email: `${who}@test.co`, password: PASSWORD })).status).toBe(200);
});

afterAll(async () => {
  await conn?.close();
  await replSet?.stop();
});

describe('payroll extras', () => {
  it('accrues employer pension, insurance relief and gratuity, and keeps the board apart', async () => {
    ids.amos = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Amos', { basicSalary: '100000', gratuityRate: 20 }, { employmentType: 'CONTRACT', contractEndDate: '2027-01-31' })), 201)).id;
    ids.beth = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Beth', { basicSalary: '60000' })), 201)).id;
    ids.carol = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Carol', { basicSalary: '30000' }, { payGroup: 'BOARD' })), 201)).id;
    await ok(call('hr', 'POST', `/hr/employees/${ids.amos}/pay-items`, { kind: 'DEDUCTION', code: 'KIE', name: 'KIE pension', amount: '5000', pension: true, employerRate: 10, memberNo: 'KIE-0001', fromPeriod: '2026-10' }), 201);
    await ok(call('hr', 'POST', `/hr/employees/${ids.amos}/pay-items`, { kind: 'DEDUCTION', code: 'LIFE', name: 'Life cover', amount: '2000', insurance: true, fromPeriod: '2026-10' }), 201);

    const oct = await ok<{ id: string; employeeCount: number; totals: Record<string, string> }>(call('payroll', 'POST', '/hr/payroll', { period: '2026-10' }), 201);
    ids.oct = oct.id;
    expect(oct.employeeCount).toBe(2); // Carol is on the board payroll
    expect(Number(oct.totals.employerPension)).toBe(10000);
    expect(Number(oct.totals.gratuity)).toBe(20000);
    const slips = (await ok<{ payslips: { items: Slip[] } }>(call('payroll', 'GET', `/hr/payroll/${oct.id}?pageSize=50`))).payslips.items;
    const amos = slips.find((s) => s.employeeId === ids.amos)!;
    expect(Number(amos.employerPension)).toBe(10000);
    expect(Number(amos.gratuity)).toBe(20000);
    expect(Number(amos.insuranceRelief)).toBe(300); // 15% of 2,000
    const full = await ok<Slip>(call('payroll', 'GET', `/hr/payslips/${amos.id}`));
    expect(full.lines.find((l) => l.code === 'KIE_ER')?.type).toBe('EMPLOYER');
    expect(Number(full.lines.find((l) => l.code === 'GRATUITY')?.amount)).toBe(20000);
    await approve(oct.id);

    const board = await ok<{ id: string; employeeCount: number; title: string }>(call('payroll', 'POST', '/hr/payroll', { period: '2026-10', kind: 'GROUP', payGroup: 'BOARD' }), 201);
    expect(board.employeeCount).toBe(1);
    expect(board.title).toBe('Board 2026-10');
    expect((await call('payroll', 'POST', '/hr/payroll', { period: '2026-10', kind: 'GROUP', payGroup: 'BOARD' })).status).toBe(409);
  });

  it('gives the pension scheme its remittance file', async () => {
    const p = await ok<{ rows: { memberNo: string; employee: string; employer: string }[]; schemes: { scheme: string; members: number }[]; totals: { total: string } }>(call('payroll', 'GET', `/hr/payroll/${ids.oct}/pension`));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].memberNo).toBe('KIE-0001');
    expect(Number(p.rows[0].employee)).toBe(5000);
    expect(Number(p.rows[0].employer)).toBe(10000);
    expect(Number(p.totals.total)).toBe(15000);
    expect(p.schemes).toEqual([expect.objectContaining({ scheme: 'KIE pension', members: 1 })]);
    const csv = await call('payroll', 'GET', `/hr/payroll/${ids.oct}/pension?format=csv&scheme=KIE%20pension`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('KIE-0001');
    expect(csv.text).toContain('15000.00');
  });

  it('advises what changed since the last payroll', async () => {
    await ok(call('hr', 'PATCH', `/hr/employees/${ids.beth}/pay`, { basicSalary: '65000', payMethod: 'BANK', bank: { name: 'KCB', accountNo: '22Beth' } }));
    ids.dan = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Dan', { basicSalary: '40000' }, { hireDate: '2026-11-01' })), 201)).id;
    const nov = await ok<{ id: string }>(call('payroll', 'POST', '/hr/payroll', { period: '2026-11' }), 201);
    ids.nov = nov.id;
    const advice = await ok<{ previous: { period: string }; rows: { employeeId: string; status: string; changes: { code: string; was: string; now: string }[] }[]; totals: { joined: number; changed: number } }>(call('payroll', 'GET', `/hr/payroll/${nov.id}/changes`));
    expect(advice.previous.period).toBe('2026-10');
    expect(advice.rows.find((r) => r.employeeId === ids.dan)?.status).toBe('JOINED');
    const beth = advice.rows.find((r) => r.employeeId === ids.beth)!;
    expect(beth.status).toBe('CHANGED');
    expect(beth.changes.find((c) => c.code === 'BASIC')).toMatchObject({ was: expect.anything(), now: expect.anything() });
    expect(Number(beth.changes.find((c) => c.code === 'BASIC')!.now) - Number(beth.changes.find((c) => c.code === 'BASIC')!.was)).toBe(5000);
    expect(advice.rows.find((r) => r.employeeId === ids.amos)).toBeUndefined(); // paid the same
    expect((await call('payroll', 'GET', `/hr/payroll/${nov.id}/changes?format=csv`)).text).toContain('Basic salary');
    // The same tables as Excel, Word and PDF; the staff list too.
    expect((await call('payroll', 'GET', `/hr/payroll/${nov.id}/changes?format=xls`)).text).toContain('<Workbook');
    expect((await call('payroll', 'GET', `/hr/payroll/${nov.id}/changes?format=doc`)).text).toContain('Pay change advice');
    expect((await call('payroll', 'GET', `/hr/payroll/${nov.id}/changes?format=pdf`)).text.startsWith('%PDF')).toBe(true);
    const staff = await call('hr', 'GET', '/hr/employees/export/xls');
    expect(staff.status).toBe(200);
    expect(staff.text).toContain('Dan');
    expect((await call('hr', 'GET', '/hr/employees/export/doc')).text).toContain('Staff list');
    expect((await call('hr', 'GET', '/hr/employees/export/pdf')).status).toBe(200);
    expect((await call('hr', 'GET', '/hr/employees/export/txt')).status).toBe(400);
    await approve(nov.id);
  });

  it('pays accrued gratuity with final dues and clears the balance', async () => {
    const g = await ok<{ rows: { employeeId: string; accrued: string; balance: string }[] }>(call('payroll', 'GET', '/hr/gratuity'));
    expect(Number(g.rows.find((r) => r.employeeId === ids.amos)!.balance)).toBe(40000);

    const dues = await ok<{ lines: { code: string; amount: string; suggested: boolean }[] }>(call('payroll', 'GET', `/hr/final-dues/${ids.amos}`));
    const line = dues.lines.find((l) => l.code === 'GRATUITY_PAY')!;
    expect(Number(line.amount)).toBe(40000);
    expect(line.suggested).toBe(true);

    const run = await ok<{ id: string }>(call('payroll', 'POST', '/hr/payroll', { period: '2026-11', kind: 'OFF_CYCLE', title: 'Gratuity' }), 201);
    await ok(call('payroll', 'POST', `/hr/payroll/${run.id}/entries`, { rows: [{ employeeId: ids.amos, kind: 'EARNING', code: 'GRATUITY_PAY', name: 'Contract gratuity', amount: line.amount }] }));
    const detail = await ok<{ totals: Record<string, string> }>(call('payroll', 'GET', `/hr/payroll/${run.id}`));
    expect(Number(detail.totals.gratuityPaid)).toBe(40000);
    await approve(run.id);

    const after = await ok<{ rows: { employeeId: string; paid: string; balance: string }[] }>(call('payroll', 'GET', '/hr/gratuity'));
    const row = after.rows.find((r) => r.employeeId === ids.amos)!;
    expect(Number(row.paid)).toBe(40000);
    expect(Number(row.balance)).toBe(0);
    expect((await ok<{ lines: { code: string }[] }>(call('payroll', 'GET', `/hr/final-dues/${ids.amos}`))).lines.some((l) => l.code === 'GRATUITY_PAY')).toBe(false);
  });

  it('keeps an audit trail of pay changes', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const all = await ok<{ action: string; by: string; employee: string; payroll: string }[]>(call('payroll', 'GET', `/hr/payroll-audit?from=${day}&to=${day}`));
    expect(all.some((r) => r.action === 'hr.payroll.approve' && r.by === 'Finance' && r.payroll === '2026-10')).toBe(true);
    expect(all.some((r) => r.action === 'hr.payItem.create' && r.employee.includes('Amos'))).toBe(true);
    const beth = await ok<{ action: string; by: string }[]>(call('payroll', 'GET', `/hr/payroll-audit?from=${day}&to=${day}&employeeId=${ids.beth}`));
    expect(beth.some((r) => r.action === 'hr.employee.pay' && r.by === 'HR')).toBe(true);
    expect(beth.every((r) => !r.action.startsWith('hr.payroll.'))).toBe(true);
    expect((await call('payroll', 'GET', `/hr/payroll-audit?from=${day}&to=${day}&format=csv`)).text).toContain('Payroll approved');
    expect((await call('hr', 'GET', `/hr/payroll-audit?from=${day}&to=${day}`)).status).toBe(200);
  });
  it('keeps directorates, departments, divisions and service units in one tree', async () => {
    const dir = await ok<{ id: string }>(call('hr', 'POST', '/hr/departments', { code: 'DTS', name: 'Technical services', level: 'DIRECTORATE' }), 201);
    await ok(call('hr', 'PUT', `/hr/departments/${ids.TEC}`, { code: 'TEC', name: 'Technical', level: 'DEPARTMENT', parentId: dir.id, headId: ids.beth }));
    const div = await ok<{ id: string }>(call('hr', 'POST', '/hr/departments', { code: 'NRW', name: 'Non-revenue water', level: 'DIVISION', parentId: ids.TEC }), 201);
    await ok(call('hr', 'POST', '/hr/departments', { code: 'KAPSU', name: 'Kapsoya service unit', level: 'SERVICE_UNIT', parentId: div.id }), 201);
    expect((await call('hr', 'PUT', `/hr/departments/${dir.id}`, { code: 'DTS', name: 'Technical services', level: 'DIRECTORATE', parentId: div.id })).status).toBe(400); // a loop
    const tree = await ok<{ code: string; path: string; depth: number; head: string; staffBelow: number }[]>(call('hr', 'GET', '/hr/departments'));
    expect(tree.find((d) => d.code === 'KAPSU')).toMatchObject({ path: 'Technical services / Technical / Non-revenue water / Kapsoya service unit', depth: 3 });
    const tec = tree.find((d) => d.code === 'TEC')!;
    expect(tec.head).toContain('Beth');
    expect(tree.find((d) => d.code === 'DTS')!.staffBelow).toBe(tec.staffBelow);
  });

  it('keeps the attendance register from biometric terminals', async () => {
    const opts = await ok<{ id: string; employeeNo: string; name: string }[]>(call('hr', 'GET', '/hr/employees/options'));
    const no = (id: string) => opts.find((o) => o.id === id)!.employeeNo;
    const sent = await ok<{ stored: number; unknownEmployees: string[] }>(call('hr', 'POST', '/hr/attendance/punches', { device: 'HQ-GATE-1', punches: [
      { employeeNo: no(ids.beth), at: '2026-11-16T07:55:00+03:00' },
      { employeeNo: no(ids.beth), at: '2026-11-16T17:05:00+03:00' },
      { employeeNo: no(ids.dan), at: '2026-11-16T08:40:00+03:00', method: 'FACE' },
      { employeeNo: 'NOBODY', at: '2026-11-16T08:00:00+03:00' },
    ] }));
    expect(sent).toMatchObject({ stored: 3, unknownEmployees: ['NOBODY'] });
    expect((await ok<{ stored: number }>(call('hr', 'POST', '/hr/attendance/punches', { device: 'HQ-GATE-1', punches: [{ employeeNo: no(ids.beth), at: '2026-11-16T07:55:00+03:00' }] }))).stored).toBe(0);
    const day = await ok<{ rows: { employeeId: string; status: string; hours: number | null; lateMinutes: number }[] }>(call('hr', 'GET', '/hr/attendance/day?date=2026-11-16'));
    const row = (id: string) => day.rows.find((r) => r.employeeId === id)!;
    expect(row(ids.beth)).toMatchObject({ status: 'PRESENT', hours: 9.17 });
    expect(row(ids.dan)).toMatchObject({ status: 'LATE', lateMinutes: 40 });
    expect(row(ids.amos).status).toBe('ABSENT');
    const sunday = await ok<{ rows: { status: string }[] }>(call('hr', 'GET', '/hr/attendance/day?date=2026-11-15'));
    expect(sunday.rows.every((r) => r.status === 'OFF' || r.status === 'NOT_EMPLOYED')).toBe(true);
    const sum = await ok<{ rows: { employeeId: string; present: number; late: number; absent: number }[] }>(call('hr', 'GET', '/hr/attendance/summary?from=2026-11-15&to=2026-11-16'));
    expect(sum.rows.find((r) => r.employeeId === ids.dan)).toMatchObject({ present: 1, late: 1, absent: 0 });
    expect((await call('finance', 'GET', '/hr/attendance/day?date=2026-11-16')).status).toBe(403);
  });

  it('takes pension, union and SACCO deductions from scheme tables the organisation keeps', async () => {
    expect((await call('hr', 'POST', '/hr/deduction-schemes', { code: 'KUWASU', name: 'Union dues', kind: 'UNION' })).status).toBe(400); // no rate or amount
    const union = await ok<{ id: string }>(call('hr', 'POST', '/hr/deduction-schemes', { code: 'KUWASU', name: 'Union dues', kind: 'UNION', employeeRate: 2, minimum: '200', maximum: '1000' }), 201);
    const sacco = await ok<{ id: string }>(call('hr', 'POST', '/hr/deduction-schemes', { code: 'SACCO', name: 'Maji SACCO', kind: 'SACCO', employeeAmount: '3000' }), 201);
    const lapf = await ok<{ id: string }>(call('hr', 'POST', '/hr/deduction-schemes', { code: 'LAPF', name: 'LAPF pension', kind: 'PENSION', employeeRate: 7.5, employerRate: 15 }), 201);
    for (const s of [union, sacco, lapf]) await ok(call('payroll', 'POST', `/hr/deduction-schemes/${s.id}/members`, { employeeId: ids.dan, fromPeriod: '2026-12', memberNo: 'M-1' }), 201);
    expect((await call('payroll', 'POST', `/hr/deduction-schemes/${union.id}/members`, { employeeId: ids.dan, fromPeriod: '2026-12' })).status).toBe(409);
    const run = await ok<{ id: string }>(call('payroll', 'POST', '/hr/payroll', { period: '2026-12' }), 201);
    const slipOf = async () => {
      const items = (await ok<{ payslips: { items: Slip[] } }>(call('payroll', 'GET', `/hr/payroll/${run.id}?pageSize=50`))).payslips.items;
      return ok<Slip>(call('payroll', 'GET', `/hr/payslips/${items.find((x) => x.employeeId === ids.dan)!.id}`));
    };
    const dan = await slipOf();
    const line = (s: Slip, code: string) => Number(s.lines.find((l) => l.code === code)?.amount ?? NaN);
    expect(line(dan, 'KUWASU')).toBe(800); // 2% of 40,000, within 200..1,000
    expect(line(dan, 'SACCO')).toBe(3000);
    expect(line(dan, 'LAPF')).toBe(3000); // 7.5% of 40,000
    expect(Number(dan.employerPension)).toBe(6000); // 15%

    // A rate change applies to every member at the next calculation.
    await ok(call('hr', 'PUT', `/hr/deduction-schemes/${union.id}`, { code: 'KUWASU', name: 'Union dues', kind: 'UNION', employeeRate: 3, maximum: '1000' }));
    await ok(call('payroll', 'POST', `/hr/payroll/${run.id}/recalculate`));
    expect(line(await slipOf(), 'KUWASU')).toBe(1000); // 3% = 1,200, capped
    const list = await ok<{ code: string; members: number }[]>(call('payroll', 'GET', '/hr/deduction-schemes'));
    expect(list.find((x) => x.code === 'LAPF')?.members).toBe(1);

    // User-defined payroll reports: every pay line is reportable in the BI builder (here: union dues by month).
    await approve(run.id);
    const { runQuery } = await import('../src/modules/bi/server/engine');
    const reader = { id: new Types.ObjectId(), organisationId: orgId, email: '', name: 'x', isAdmin: true, access: {}, modules: ['hr'], permissions: [], ip: null };
    const r = await runQuery((platform.modules.hr as HrServices).db as never, reader, { dataset: 'hr.payLines', filters: [{ field: 'code', op: 'eq', value: 'KUWASU' }], groupBy: [{ field: 'period' }], measures: [{ agg: 'sum', field: 'amount' }] });
    expect(r.rows).toEqual([expect.objectContaining({ period: '2026-12', sum_amount: 1000 })]);
  });
});
