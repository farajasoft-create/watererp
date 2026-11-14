import bcrypt from 'bcryptjs';
import mongoose, { Connection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hrModule } from '../src/modules/hr/module';
import type { HrServices } from '../src/modules/hr/server/container';
import { waterModule } from '../src/modules/water/module';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';
import { isBalanced, Journal } from '../src/platform/ledger/types';

/**
 * HR & payroll through the API: employees and pay items, department-limited managers, unpaid leave,
 * a payroll prepared by one user and approved by another, loans, journals, statutory returns and
 * staff self-service on the same login as another module.
 */

let replSet: MongoMemoryReplSet;
let conn: Connection;
let platform: Platform;
let handle: (req: Request) => Promise<Response>;
let orgId: Types.ObjectId;
const cookies: Record<string, string> = {};
const posted: { journal: Journal; key: string }[] = [];
const heard: string[] = [];
const ids: Record<string, string> = {};
const PASSWORD = 'password-123456';

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T; text: string }> {
  const res = await handle(new Request(`http://platform.test/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await res.text();
  const json = res.headers.get('content-type')?.includes('json');
  return { status: res.status, data: (json && text ? JSON.parse(text) : null) as T, text };
}

const login = async (who: string, email: string) => expect((await call(who, 'POST', '/auth/login', { email, password: PASSWORD })).status).toBe(200);
const hex = (n: number) => n.toString(16).padStart(24, '0');

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('hr_e2e')).asPromise();
  const modules = [waterModule, hrModule];
  platform = await createPlatform(conn, { modules });
  handle = createApi(async () => platform, modules);
  platform.core.ledger.use({
    name: 'Test ledger',
    isConnected: async () => true,
    post: async (_org, journal, key) => {
      posted.push({ journal, key });
      return `j${posted.length}`;
    },
    accounts: async () => [],
  });
  platform.core.events.on('hr.*', (e) => void heard.push(e.name));

  const { db } = platform.core;
  const [org] = await db.organisations.create([{ name: 'Tachasis Water', code: 'TACH', modules: ['water', 'hr'] }]);
  orgId = org._id;
  await hrModule.seed!({ db, core: platform.core, services: platform.modules.hr as HrServices, organisationId: orgId, demo: false, demoPassword: PASSWORD });
  const tec = await (platform.modules.hr as HrServices).db.departments.findOne({ organisationId: orgId, code: 'TEC' }).lean();
  ids.TEC = tec!._id.toHexString();
  ids.ADM = (await (platform.modules.hr as HrServices).db.departments.findOne({ organisationId: orgId, code: 'ADM' }).lean())!._id.toHexString();

  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.users.create([
    { organisationId: orgId, email: 'hr@test.co', name: 'HR', access: [{ module: 'hr', role: 'HR_MANAGER' }], passwordHash: hash },
    { organisationId: orgId, email: 'payroll@test.co', name: 'Payroll', access: [{ module: 'hr', role: 'PAYROLL_OFFICER' }], passwordHash: hash },
    { organisationId: orgId, email: 'finance@test.co', name: 'Finance', access: [{ module: 'hr', role: 'FINANCE' }], passwordHash: hash },
    { organisationId: orgId, email: 'tech@test.co', name: 'Tech head', access: [{ module: 'hr', role: 'LINE_MANAGER', scope: [tec!._id] }], passwordHash: hash },
    { organisationId: orgId, email: 'reader@test.co', name: 'Reader', access: [{ module: 'water', role: 'METER_READER' }], passwordHash: hash },
  ]);
  for (const who of ['hr', 'payroll', 'finance', 'tech', 'reader']) await login(who, `${who}@test.co`);
});

afterAll(async () => {
  await conn?.close();
  await replSet?.stop();
});

const employee = (firstName: string, dept: string, hireDate: string, salary: string, extra: Record<string, unknown> = {}) => ({
  firstName,
  lastName: 'Test',
  gender: 'MALE',
  departmentId: ids[dept],
  hireDate,
  kraPin: `A${String(Math.abs(firstName.charCodeAt(0) * 1234567)).padStart(9, '0').slice(-9)}Z`,
  nationalId: String(30000000 + firstName.charCodeAt(0)),
  nssfNo: `N${firstName}`,
  shaNo: `S${firstName}`,
  ...extra,
  pay: { basicSalary: salary, payMethod: 'BANK', bank: { name: 'KCB', accountNo: `11${firstName.length}` }, exempt: { paye: false, nssf: false, shif: false, ahl: false } },
});

describe('HR & payroll', () => {
  it('keeps employees, with pay only for those allowed to see it', async () => {
    for (const [key, body] of [
      ['amos', employee('Amos', 'TEC', '2024-01-15', '50000', { email: 'reader@test.co' })],
      ['beth', employee('Beth', 'ADM', '2026-11-16', '60000', { gender: 'FEMALE' })],
      ['carl', employee('Carl', 'TEC', '2023-05-01', '40000')],
    ] as const) {
      const res = await call<{ id: string; employeeNo: string }>('hr', 'POST', '/hr/employees', body);
      expect(res.status).toBe(201);
      ids[key] = res.data.id;
    }
    const list = await call<{ items: { employeeNo: string; basicSalary?: string }[] }>('hr', 'GET', '/hr/employees');
    expect(list.data.items.map((e) => e.employeeNo)).toEqual(['EMP-0001', 'EMP-0002', 'EMP-0003']);
    expect(list.data.items[0].basicSalary).toBe('50000');

    // The technical head sees only Technical, and no pay.
    const scoped = await call<{ items: { firstName: string; basicSalary?: string }[] }>('tech', 'GET', '/hr/employees');
    expect(scoped.data.items.map((e) => e.firstName)).toEqual(['Amos', 'Carl']);
    expect(scoped.data.items[0].basicSalary).toBeUndefined();
    expect((await call('tech', 'GET', `/hr/employees/${ids.beth}`)).status).toBe(403);
    expect((await call('tech', 'POST', '/hr/employees', employee('Dan', 'TEC', '2025-01-01', '1'))).status).toBe(403);
  });

  it('pays recurring items and loans up to their balance', async () => {
    expect((await call('payroll', 'POST', `/hr/employees/${ids.carl}/pay-items`, { kind: 'DEDUCTION', code: 'LOAN', name: 'Salary advance', amount: '5000', balance: '7000', fromPeriod: '2026-11' })).status).toBe(201);
    expect((await call('payroll', 'POST', `/hr/employees/${ids.amos}/pay-items`, { kind: 'EARNING', code: 'HOUSE', name: 'House allowance', amount: '7500', fromPeriod: '2026-01' })).status).toBe(201);
    const preview = await call<{ result: { grossPay: string; netPay: string } }>('payroll', 'GET', `/hr/employees/${ids.carl}/pay-preview?period=2026-11`);
    expect(preview.data.result.grossPay).toBe('40000');
  });

  it('takes unpaid leave off pay; a manager approves leave only in their departments', async () => {
    const types = await call<{ id: string; code: string }[]>('hr', 'GET', '/hr/leave-types');
    ids.UL = types.data.find((t) => t.code === 'UL')!.id;
    ids.AL = types.data.find((t) => t.code === 'AL')!.id;
    const req = await call<{ id: string; days: number }>('hr', 'POST', '/hr/leave', { employeeId: ids.amos, leaveTypeId: ids.UL, startDate: '2026-11-09', endDate: '2026-11-11', reason: 'Personal' });
    expect(req.data.days).toBe(3);
    expect((await call('tech', 'POST', `/hr/leave/${req.data.id}/review`, { decision: 'APPROVED' })).status).toBe(200);
    expect(heard).toContain('hr.leave.approved');

    const beth = await call<{ id: string }>('hr', 'POST', '/hr/leave', { employeeId: ids.beth, leaveTypeId: ids.UL, startDate: '2026-12-01', endDate: '2026-12-01' });
    expect((await call('tech', 'POST', `/hr/leave/${beth.data.id}/review`, { decision: 'APPROVED' })).status).toBe(403);
    // Maternity leave does not apply to men; annual leave cannot exceed what is earned.
    const ml = (await call<{ id: string; code: string }[]>('hr', 'GET', '/hr/leave-types')).data.find((t) => t.code === 'ML')!.id;
    expect((await call('hr', 'POST', '/hr/leave', { employeeId: ids.amos, leaveTypeId: ml, startDate: '2026-12-01', endDate: '2026-12-02' })).status).toBe(400);
    const tooLong = await call<{ message: string }>('hr', 'POST', '/hr/leave', { employeeId: ids.carl, leaveTypeId: ids.AL, startDate: '2026-11-16', endDate: '2026-12-31' });
    expect(tooLong.data.message).toMatch(/available/);
  });

  it('prepares a payroll that someone else approves, then posts it to the ledger', async () => {
    const run = await call<{ id: string; employeeCount: number; status: string }>('payroll', 'POST', '/hr/payroll', { period: '2026-11' });
    expect(run.status).toBe(201);
    ids.run = run.data.id;
    expect(run.data.employeeCount).toBe(3);
    expect((await call('payroll', 'POST', '/hr/payroll', { period: '2026-11' })).status).toBe(409);

    const detail = await call<{ payslips: { items: { id: string; employeeId: string; gross: string; daysPaid: number; warnings: string[]; netPay: string }[] } }>('payroll', 'GET', `/hr/payroll/${ids.run}`);
    const slip = (k: string) => detail.data.payslips.items.find((p) => p.employeeId === ids[k])!;
    // Amos: 50,000 less 3 of 21 working days unpaid, plus house allowance.
    expect(slip('amos').gross).toBe('50357.14');
    // Beth joined on the 16th: 15 of 30 days.
    expect(slip('beth').gross).toBe('30000');
    expect(slip('beth').warnings[0]).toMatch(/Part month/);

    expect((await call('payroll', 'POST', `/hr/payroll/${ids.run}/approve`)).status).toBe(403);
    const approved = await call<{ status: string }>('finance', 'POST', `/hr/payroll/${ids.run}/approve`);
    expect(approved.data.status).toBe('APPROVED');
    expect(heard).toContain('hr.payroll.approved');

    const after = await call<{ payslips: { items: { payslipNo: string }[] } }>('finance', 'GET', `/hr/payroll/${ids.run}`);
    expect(after.data.payslips.items.map((p) => p.payslipNo)).toEqual(['PS-202611-0001', 'PS-202611-0002', 'PS-202611-0003']);

    // Accounts not mapped yet: the journal waits with a clear reason, then goes once they are.
    const stored = await call<{ accounting: { status: string; error: string } }>('finance', 'GET', `/hr/payroll/${ids.run}`);
    expect(stored.data.accounting.status).toBe('FAILED');
    expect(stored.data.accounting.error).toMatch(/PAYE payable/);
    const accounts = Object.fromEntries(['salaries', 'employerCosts', 'paye', 'nssf', 'shif', 'ahl', 'nita', 'otherDeductions', 'netPay', 'bank'].map((k, i) => [k, hex(i + 1)]));
    expect((await call('hr', 'PATCH', '/hr/settings/accounts', { accounts })).status).toBe(200);
    expect((await call<{ sent: number }>('hr', 'POST', '/hr/accounting/retry')).data.sent).toBe(1);
    const journal = posted.find((p) => p.key.startsWith('farajasoft-hr:payroll:'))!;
    expect(isBalanced(journal.journal.lines)).toBe(true);
    expect(journal.journal.reference).toBe('PAYROLL-2026-11');

    expect((await call('finance', 'POST', `/hr/payroll/${ids.run}/paid`, { paidAt: '2026-11-28', reference: 'EFT 4471' })).status).toBe(200);
    expect(posted.some((p) => p.key.startsWith('farajasoft-hr:salaries-paid:') && isBalanced(p.journal.lines))).toBe(true);
  });

  it('produces the statutory returns and repays loans month by month', async () => {
    const summary = await call<{ due: string; employees: number; nssf: { employee: string; tier1: string; tier2: string } }>('finance', 'GET', '/hr/returns?period=2026-11');
    expect(summary.data.due).toBe('2026-12-09');
    expect(summary.data.employees).toBe(3);
    const paye = await call('finance', 'GET', '/hr/returns/csv?period=2026-11&type=PAYE');
    expect(paye.text.split('\n')).toHaveLength(4);
    expect(paye.text).toContain('Taxable pay');

    const loan = () => (platform.modules.hr as HrServices).db.payItems.findOne({ code: 'LOAN' }).lean();
    expect((await loan())!.balance!.toString()).toBe('2000');
    const dec = await call<{ id: string }>('payroll', 'POST', '/hr/payroll', { period: '2026-12' });
    await call('finance', 'POST', `/hr/payroll/${dec.data.id}/approve`);
    const after = await loan();
    expect(after!.balance!.toString()).toBe('0');
    expect(after!.active).toBe(false);
  });

  it('gives an employee their own payslips and leave on the login they already have', async () => {
    const portal = await call<{ newLogin: boolean }>('hr', 'POST', `/hr/employees/${ids.amos}/portal`, {});
    expect(portal.data.newLogin).toBe(false);
    await login('reader', 'reader@test.co'); // permissions are read fresh, but sign in again as a user would
    const me = await call<{ employee: { name: string }; payslips: { id: string; period: string }[]; balances: { code: string; available: number }[] }>('reader', 'GET', '/hr/me');
    expect(me.status).toBe(200);
    expect(me.data.payslips.map((p) => p.period)).toEqual(['2026-12', '2026-11']);
    expect((await call('reader', 'GET', `/hr/me/payslips/${me.data.payslips[0].id}`)).status).toBe(200);
    // Still a meter reader in water, and nothing more in HR.
    expect((await call('reader', 'GET', '/water/field/route')).status).not.toBe(403);
    expect((await call('reader', 'GET', '/hr/employees')).status).toBe(403);
    const others = await (platform.modules.hr as HrServices).db.payslips.findOne({ employeeId: new Types.ObjectId(ids.carl) }).lean();
    expect((await call('reader', 'GET', `/hr/me/payslips/${others!._id}`)).status).toBe(404);

    const p9 = await call<{ totals: { paye: string } }>('reader', 'GET', '/hr/me/p9?year=2026');
    expect(Number(p9.data.totals.paye)).toBeGreaterThan(0);
    const applied = await call<{ id: string; status: string }>('reader', 'POST', '/hr/me/leave', { leaveTypeId: ids.AL, startDate: '2026-12-14', endDate: '2026-12-15' });
    expect(applied.status).toBe(201);
    expect((await call('tech', 'POST', `/hr/leave/${applied.data.id}/review`, { decision: 'APPROVED' })).status).toBe(200);
  });

  it('pays daily staff for the days entered on the draft payroll', async () => {
    const casual = await call<{ id: string }>('hr', 'POST', '/hr/employees', { ...employee('Esther', 'TEC', '2026-12-01', '0', { gender: 'FEMALE' }), pay: { payType: 'DAILY', rate: '900', payMethod: 'MPESA', mpesaPhone: '0711000222' } });
    expect(casual.status).toBe(201);
    const run = await call<{ id: string }>('payroll', 'POST', '/hr/payroll', { period: '2027-01' });
    type Detail = { rated: { employeeId: string; units: number }[]; payslips: { items: { employeeId: string; gross: string; warnings: string[]; id: string }[] } };
    const before = await call<Detail>('payroll', 'GET', `/hr/payroll/${run.data.id}`);
    expect(before.data.rated).toEqual([expect.objectContaining({ employeeId: casual.data.id, units: 0 })]);
    expect(before.data.payslips.items.find((p) => p.employeeId === casual.data.id)!.warnings).toContain('No days entered for the month');

    expect((await call('payroll', 'PUT', `/hr/payroll/${run.data.id}/units`, { rows: [{ employeeId: ids.amos, units: 3 }] })).status).toBe(400);
    expect((await call('payroll', 'PUT', `/hr/payroll/${run.data.id}/units`, { rows: [{ employeeId: casual.data.id, units: 12 }] })).status).toBe(200);
    const after = await call<Detail>('payroll', 'GET', `/hr/payroll/${run.data.id}`);
    const slip = after.data.payslips.items.find((p) => p.employeeId === casual.data.id)!;
    expect(slip.gross).toBe('10800');
    const printable = await call<{ lines: { code: string; name: string }[] }>('payroll', 'GET', `/hr/payslips/${slip.id}`);
    expect(printable.data.lines[0]).toMatchObject({ code: 'BASIC', name: '12 days at 900.00' });
  });

  it('pays a bonus off-cycle, taxed together with the month\'s salary', async () => {
    expect((await call('payroll', 'POST', '/hr/payroll', { period: '2026-11', kind: 'OFF_CYCLE' })).status).toBe(400);
    const run = await call<{ id: string; employeeCount: number }>('payroll', 'POST', '/hr/payroll', { period: '2026-11', kind: 'OFF_CYCLE', title: 'November bonus' });
    expect(run.status).toBe(201);
    expect(run.data.employeeCount).toBe(0);
    // 10% of basic to Technical: Amos 5,000 and Carl 4,000; the daily casual has no basic and is left out.
    const many = await call<{ employeeCount: number }>('payroll', 'POST', `/hr/payroll/${run.data.id}/entries/many`, { departmentId: ids.TEC, name: 'November bonus', percentOfBasic: 10 });
    expect(many.data.employeeCount).toBe(2);
    // The monthly payroll takes pay items, not entries.
    expect((await call('payroll', 'POST', `/hr/payroll/${ids.run}/entries`, { rows: [{ employeeId: ids.amos, kind: 'EARNING', name: 'Bonus', amount: '1' }] })).status).toBe(400);

    type Slip = { id: string; employeeId: string; gross: string; paye: string; nssfEmployee: string; shif: string; ahlEmployee: string; nita: string; personalRelief: string; priorGrossPay: string };
    const detail = await call<{ entries: { employeeName: string }[]; payslips: { items: Slip[] } }>('payroll', 'GET', `/hr/payroll/${run.data.id}`);
    expect(detail.data.entries).toHaveLength(2);
    const amos = detail.data.payslips.items.find((p) => p.employeeId === ids.amos)!;
    // Already in the 30% band on salary, with relief and NITA used: 5,000 less NSSF 300, SHIF 137.50 and levy 75, at 30%.
    expect(amos).toMatchObject({ gross: '5000', nssfEmployee: '300', shif: '137.5', ahlEmployee: '75', paye: '1346.25', nita: '0', personalRelief: '0', priorGrossPay: '50357.14' });

    const approved = await call<{ status: string }>('finance', 'POST', `/hr/payroll/${run.data.id}/approve`);
    expect(approved.data.status).toBe('APPROVED');
    const after = await call<{ payslips: { items: { payslipNo: string }[] } }>('finance', 'GET', `/hr/payroll/${run.data.id}`);
    expect(after.data.payslips.items.map((p) => p.payslipNo)).toEqual(['PS-202611-0004', 'PS-202611-0005']);
    const printable = await call<{ title: string }>('finance', 'GET', `/hr/payslips/${amos.id}`);
    expect(printable.data.title).toBe('November bonus');

    // The returns still list each employee once for the month, with both payrolls added up.
    const summary = await call<{ employees: number }>('finance', 'GET', '/hr/returns?period=2026-11');
    expect(summary.data.employees).toBe(3);
    const paye = await call('finance', 'GET', '/hr/returns/csv?period=2026-11&type=PAYE');
    expect(paye.text.trim().split('\n')).toHaveLength(4);
    const netPay = await call('finance', 'GET', '/hr/returns/csv?period=2026-11&type=NET_PAY');
    expect(netPay.text.trim().split('\n')).toHaveLength(6);
    expect(netPay.text).toContain('November bonus');
  });

  it('pays a leaver\'s final dues, then makes the month\'s payroll catch up with them', async () => {
    const hr = platform.modules.hr as HrServices;
    expect((await call('payroll', 'POST', `/hr/employees/${ids.carl}/pay-items`, { kind: 'DEDUCTION', code: 'LOAN2', name: 'Emergency loan', amount: '1000', balance: '3000', fromPeriod: '2027-01' })).status).toBe(201);
    expect((await call('hr', 'POST', `/hr/employees/${ids.carl}/terminate`, { date: '2027-01-15', reason: 'REDUNDANCY' })).status).toBe(200);

    type Dues = { yearsOfService: number; dayRate: string; lines: { code: string; kind: string; amount: string; suggested: boolean; leaveDays?: number; payItemId?: string }[] };
    const dues = await call<Dues>('payroll', 'GET', `/hr/final-dues/${ids.carl}`);
    expect(dues.data.yearsOfService).toBe(3);
    expect(dues.data.dayRate).toBe('1333.33');
    const code = (c: string) => dues.data.lines.find((l) => l.code === c)!;
    expect(code('LEAVE_PAY').suggested).toBe(true);
    expect(code('SEVERANCE')).toMatchObject({ amount: '59999.85', suggested: true }); // redundancy: 15 days x 3 years
    expect(code('NOTICE_PAY').suggested).toBe(false);
    expect(code('LOAN2')).toMatchObject({ kind: 'DEDUCTION', amount: '3000', suggested: true });

    const run = await call<{ id: string }>('payroll', 'POST', '/hr/payroll', { period: '2027-01', kind: 'OFF_CYCLE', title: 'Final dues: Carl' });
    const rows = dues.data.lines.filter((l) => l.suggested).map(({ suggested: _, ...l }) => ({ ...l, employeeId: ids.carl }));
    // A loan can be recovered only up to its balance.
    const greedy = rows.map((r) => (r.code === 'LOAN2' ? { ...r, amount: '3500' } : r));
    expect((await call('payroll', 'POST', `/hr/payroll/${run.data.id}/entries`, { rows: greedy })).status).toBe(400);
    expect((await call('payroll', 'POST', `/hr/payroll/${run.data.id}/entries`, { rows })).status).toBe(200);
    expect((await call('finance', 'POST', `/hr/payroll/${run.data.id}/approve`)).status).toBe(200);

    const loan = await hr.db.payItems.findOne({ code: 'LOAN2' }).lean();
    expect(loan!.balance!.toString()).toBe('0');
    const paidOut = await hr.db.leaveAdjustments.findOne({ employeeId: new Types.ObjectId(ids.carl), kind: 'ENCASHMENT' }).lean();
    expect(paidOut!.days).toBe(-code('LEAVE_PAY').leaveDays!);
    expect(paidOut!.year).toBe(2027);

    // January's payroll was worked out before the final dues were approved: it must be recalculated first.
    const jan = (await call<{ id: string; period: string; kind: string }[]>('payroll', 'GET', '/hr/payroll')).data.find((r) => r.period === '2027-01' && r.kind === 'REGULAR')!;
    const stale = await call<{ message: string }>('finance', 'POST', `/hr/payroll/${jan.id}/approve`);
    expect(stale.status).toBe(409);
    expect(stale.data.message).toMatch(/Recalculate/);
    await call('payroll', 'POST', `/hr/payroll/${jan.id}/recalculate`);
    expect((await call('finance', 'POST', `/hr/payroll/${jan.id}/approve`)).status).toBe(200);
    const carl = (await call<{ payslips: { items: { nita: string; personalRelief: string; daysPaid: number }[] } }>('finance', 'GET', `/hr/payroll/${jan.id}?search=Carl`)).data.payslips.items[0];
    // The leaver's half month: NITA and personal relief were already given on the final dues.
    expect(carl).toMatchObject({ daysPaid: 15, nita: '0', personalRelief: '0' });
  });

  it('refuses every HR call once the organisation switches HR off', async () => {
    await platform.core.db.organisations.updateOne({ _id: orgId }, { modules: ['water'] });
    expect((await call('hr', 'GET', '/hr/employees')).status).toBe(403);
    await platform.core.db.organisations.updateOne({ _id: orgId }, { modules: ['water', 'hr'] });
  });
});
