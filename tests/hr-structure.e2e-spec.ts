import bcrypt from 'bcryptjs';
import mongoose, { Connection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hrModule } from '../src/modules/hr/module';
import type { HrServices } from '../src/modules/hr/server/container';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';

/**
 * HR structure: job groups with salary scales and grade allowances, the staff establishment against
 * staff in post, career events (promotion, transfer, acting) approved by a second person, annual
 * increments, and pay stopping when a contract ends.
 */

let replSet: MongoMemoryReplSet;
let conn: Connection;
let platform: Platform;
let handle: (req: Request) => Promise<Response>;
let orgId: Types.ObjectId;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const PASSWORD = 'password-123456';

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await handle(new Request(`http://platform.test/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null) as T };
}
const ok = async <T = Record<string, unknown>>(p: Promise<{ status: number; data: T }>, status = 200) => {
  const r = await p;
  if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};

const employee = (firstName: string, dept: string, hireDate: string, pay: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  firstName,
  lastName: 'Test',
  departmentId: ids[dept],
  hireDate,
  nationalId: String(31000000 + firstName.charCodeAt(0) * 7 + firstName.length),
  ...extra,
  pay: { basicSalary: '0', payMethod: 'BANK', bank: { name: 'KCB', accountNo: `22${firstName}` }, exempt: { paye: false, nssf: false, shif: false, ahl: false }, ...pay },
});

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('hr_structure_e2e')).asPromise();
  const modules = [hrModule];
  platform = await createPlatform(conn, { modules });
  handle = createApi(async () => platform, modules);
  const { db } = platform.core;
  const [org] = await db.organisations.create([{ name: 'Tachasis Water', code: 'TACH', modules: ['hr'] }]);
  orgId = org._id;
  const hr = platform.modules.hr as HrServices;
  await hrModule.seed!({ db, core: platform.core, services: hr, organisationId: orgId, demo: false, demoPassword: PASSWORD });
  for (const code of ['TEC', 'ADM']) ids[code] = (await hr.db.departments.findOne({ organisationId: orgId, code }).lean())!._id.toHexString();
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.users.create([
    { organisationId: orgId, email: 'hr@test.co', name: 'HR', access: [{ module: 'hr', role: 'HR_MANAGER' }], passwordHash: hash },
    { organisationId: orgId, email: 'hr2@test.co', name: 'HR two', access: [{ module: 'hr', role: 'HR_MANAGER' }], passwordHash: hash },
    { organisationId: orgId, email: 'payroll@test.co', name: 'Payroll', access: [{ module: 'hr', role: 'PAYROLL_OFFICER' }], passwordHash: hash },
  ]);
  for (const who of ['hr', 'hr2', 'payroll']) expect((await call(who, 'POST', '/auth/login', { email: `${who}@test.co`, password: PASSWORD })).status).toBe(200);
});

afterAll(async () => {
  await conn?.close();
  await replSet?.stop();
});

describe('HR structure', () => {
  it('pays from the job group scale with its allowances', async () => {
    ids.TWS5 = (await ok<{ id: string }>(call('hr', 'POST', '/hr/job-groups', { code: 'tws5', name: 'Technician', rank: 5, notches: ['40000', '42000', '44000'], allowances: [{ code: 'HOUSE', name: 'House allowance', amount: '8000' }] }), 201)).id;
    ids.TWS6 = (await ok<{ id: string }>(call('hr', 'POST', '/hr/job-groups', { code: 'TWS6', name: 'Supervisor', rank: 6, notches: ['50000', '53000', '56000'], allowances: [{ code: 'HOUSE', name: 'House allowance', amount: '10000' }] }), 201)).id;
    expect((await call('hr', 'POST', '/hr/job-groups', { code: 'BAD', name: 'Falling', notches: ['5', '4'] })).status).toBe(400);
    expect((await call('hr', 'POST', '/hr/employees', employee('Zed', 'TEC', '2024-03-10', { jobGroupId: ids.TWS5, notch: 4 }))).status).toBe(400);

    const amos = await ok<{ id: string; basicSalary: string }>(call('hr', 'POST', '/hr/employees', employee('Amos', 'TEC', '2024-03-10', { jobGroupId: ids.TWS5, notch: 2 }, { jobTitle: 'Plumber', qualifications: [{ level: 'Diploma', title: 'Water engineering', institution: 'KMTC', year: 2019 }], dependants: [{ name: 'Baby Amos', relationship: 'Child' }] })), 201);
    ids.amos = amos.id;
    expect(amos.basicSalary).toBe('42000');
    const preview = await ok<{ result: { grossPay: string } }>(call('payroll', 'GET', `/hr/employees/${ids.amos}/pay-preview?period=2026-11`));
    expect(preview.result.grossPay).toBe('50000');
    ids.dan = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Dan', 'TEC', '2024-06-01', { jobGroupId: ids.TWS5, notch: 1 }, { jobTitle: 'Plumber' })), 201)).id;
    ids.beth = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Beth', 'ADM', '2023-01-01', { basicSalary: '60000' }, { jobTitle: 'Accountant' })), 201)).id;
  });

  it('shows the establishment against staff in post', async () => {
    await ok(
      call('hr', 'PUT', '/hr/establishment', {
        rows: [
          { departmentId: ids.TEC, jobGroupId: ids.TWS5, designation: 'Plumber', authorised: 3 },
          { departmentId: ids.TEC, jobGroupId: ids.TWS6, designation: 'Supervisor', authorised: 1 },
        ],
      }),
    );
    const est = await ok<{ rows: { department: string; jobGroup: string; authorised: number; inPost: number; vacant: number }[]; totals: { authorised: number; vacant: number } }>(call('hr', 'GET', '/hr/establishment'));
    const tec = est.rows.filter((r) => r.department === 'Technical' || r.department.startsWith('Tec'));
    expect(tec.find((r) => r.jobGroup === 'TWS5')).toMatchObject({ authorised: 3, inPost: 2, vacant: 1 });
    expect(tec.find((r) => r.jobGroup === 'TWS6')).toMatchObject({ authorised: 1, inPost: 0, vacant: 1 });
  });

  it('promotes, transfers and appoints to act only with a second approval, keeping the history', async () => {
    const promo = await ok<{ id: string; to: { basicSalary: string; notch: number } }>(call('hr', 'POST', '/hr/career-events', { employeeId: ids.amos, kind: 'PROMOTION', effectiveDate: '2026-11-01', jobGroupId: ids.TWS6, jobTitle: 'Supervisor', reason: 'Promoted after interview' }), 201);
    expect(promo.to).toMatchObject({ basicSalary: '50000', notch: 1 });
    expect((await call('hr', 'POST', '/hr/career-events', { employeeId: ids.amos, kind: 'TRANSFER', effectiveDate: '2026-11-01', departmentId: ids.ADM, reason: 'Again' })).status).toBe(400);
    expect((await call('hr', 'POST', `/hr/career-events/${promo.id}/decide`, { approve: true })).status).toBe(403);
    await ok(call('hr2', 'POST', `/hr/career-events/${promo.id}/decide`, { approve: true }));
    let amos = await ok<{ basicSalary: string; notch: number; jobGroupId: string; nextIncrementDate: string }>(call('hr', 'GET', `/hr/employees/${ids.amos}`));
    expect(amos).toMatchObject({ basicSalary: '50000', notch: 1, jobGroupId: ids.TWS6 });
    expect(amos.nextIncrementDate.slice(0, 10)).toBe('2027-11-01');
    expect((await call('hr', 'POST', '/hr/career-events', { employeeId: ids.amos, kind: 'PROMOTION', effectiveDate: '2026-12-01', jobGroupId: ids.TWS5, reason: 'Wrong way' })).status).toBe(400);

    const transfer = await ok<{ id: string }>(call('hr', 'POST', '/hr/career-events', { employeeId: ids.amos, kind: 'TRANSFER', effectiveDate: '2026-12-01', departmentId: ids.ADM, station: 'Kapsabet', reason: 'Staff rotation' }), 201);
    await ok(call('hr2', 'POST', `/hr/career-events/${transfer.id}/decide`, { approve: true }));
    amos = await ok(call('hr', 'GET', `/hr/employees/${ids.amos}`));
    expect(amos).toMatchObject({ departmentId: ids.ADM, station: 'Kapsabet', basicSalary: '50000' });
    const history = await ok<{ kind: string; status: string }[]>(call('hr', 'GET', `/hr/employees/${ids.amos}/career`));
    expect(history.map((h) => h.kind)).toEqual(['TRANSFER', 'PROMOTION']);

    expect((await call('hr', 'POST', '/hr/career-events', { employeeId: ids.beth, kind: 'ACTING', effectiveDate: '2026-11-01', jobTitle: 'Finance manager', actingAllowance: '5000', reason: 'Manager on leave' })).status).toBe(400);
    const acting = await ok<{ id: string }>(call('hr', 'POST', '/hr/career-events', { employeeId: ids.beth, kind: 'ACTING', effectiveDate: '2026-11-01', endDate: '2027-01-31', jobTitle: 'Finance manager', actingAllowance: '5000', reason: 'Manager on leave' }), 201);
    await ok(call('hr2', 'POST', `/hr/career-events/${acting.id}/decide`, { approve: true }));
    const beth = await ok<{ jobTitle: string; basicSalary: string }>(call('hr', 'GET', `/hr/employees/${ids.beth}`));
    expect(beth).toMatchObject({ jobTitle: 'Accountant', basicSalary: '60000' });
    expect((await ok<{ result: { grossPay: string } }>(call('payroll', 'GET', `/hr/employees/${ids.beth}/pay-preview?period=2026-12`))).result.grossPay).toBe('65000');
    expect((await ok<{ result: { grossPay: string } }>(call('payroll', 'GET', `/hr/employees/${ids.beth}/pay-preview?period=2027-02`))).result.grossPay).toBe('60000');
  });

  it('raises annual increments up the scale', async () => {
    const due = await ok<{ employeeId: string; notch: number; nextNotch: number; newPay: string }[]>(call('payroll', 'GET', '/hr/increments/due?asOf=2026-11-30'));
    expect(due.map((d) => d.employeeId)).toEqual([ids.dan]);
    expect(due[0]).toMatchObject({ notch: 1, nextNotch: 2, newPay: '42000' });
    expect(await ok(call('payroll', 'POST', '/hr/increments', { employeeIds: [ids.dan], effectiveDate: '2026-11-30' }), 201)).toEqual({ requested: 1 });
    const pending = await ok<{ id: string; kind: string }[]>(call('hr', 'GET', '/hr/career-events'));
    await ok(call('hr', 'POST', `/hr/career-events/${pending.find((p) => p.kind === 'INCREMENT')!.id}/decide`, { approve: true }));
    expect(await ok(call('hr', 'GET', `/hr/employees/${ids.dan}`))).toMatchObject({ notch: 2, basicSalary: '42000' });
  });

  it('stops pay when a contract ends', async () => {
    ids.carl = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Carl', 'TEC', '2025-01-01', { basicSalary: '30000' }, { employmentType: 'CONTRACT', contractEndDate: '2026-10-31' })), 201)).id;
    ids.eve = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Eve', 'TEC', '2025-01-01', { basicSalary: '30000' }, { employmentType: 'CONTRACT', contractEndDate: '2026-11-15' })), 201)).id;
    const ending = await ok<{ employeeId: string; ended: boolean }[]>(call('hr', 'GET', '/hr/contracts/ending?days=30'));
    expect(ending.map((e) => e.employeeId).sort()).toEqual([ids.carl, ids.eve].sort());
    const run = await ok<{ id: string }>(call('payroll', 'POST', '/hr/payroll', { period: '2026-11' }), 201);
    const detail = await ok<{ payslips: { items: { employeeId: string; gross: string; warnings: string[] }[] } }>(call('payroll', 'GET', `/hr/payroll/${run.id}?pageSize=100`));
    const slips = detail.payslips.items;
    expect(slips.some((s) => s.employeeId === ids.carl)).toBe(false);
    const eve = slips.find((s) => s.employeeId === ids.eve)!;
    expect(eve.gross).toBe('15000');
    expect(eve.warnings.join(' ')).toMatch(/Contract ends 2026-11-15/);
  });

  it('recruits through an approved, published vacancy to an appointment with onboarding', async () => {
    const vacancy = (positions: number, extra: Record<string, unknown> = {}) => ({ title: 'Plumber', departmentId: ids.TEC, jobGroupId: ids.TWS5, positions, minimumLevel: 'DIPLOMA', minimumExperience: 2, closingDate: '2030-12-31', description: 'Maintain water mains', panel: [], ...extra });
    const hr2 = (await platform.core.db.users.findOne({ email: 'hr2@test.co' }).lean())!._id.toHexString();
    const v = await ok<{ id: string; number: string }>(call('hr', 'POST', '/hr/vacancies', vacancy(3, { panel: [hr2] })), 201);
    await ok(call('hr', 'POST', `/hr/vacancies/${v.id}/submit`, {}));
    expect((await call('hr', 'POST', `/hr/vacancies/${v.id}/approve`, {})).status).toBe(403);
    const over = await call<{ message: string }>('hr2', 'POST', `/hr/vacancies/${v.id}/approve`, {});
    expect(over.status).toBe(400);
    expect(over.data.message).toMatch(/Only 2 authorised posts are vacant/);
    expect((await call('hr', 'POST', `/hr/vacancies/${v.id}/reject`, { reason: 'Mine' })).status).toBe(403);
    // HR cuts it to one post and resubmits.
    await ok(call('hr2', 'POST', `/hr/vacancies/${v.id}/reject`, { reason: 'Too many posts' }));
    await ok(call('hr', 'PATCH', `/hr/vacancies/${v.id}`, vacancy(1, { panel: [hr2] })));
    await ok(call('hr', 'POST', `/hr/vacancies/${v.id}/submit`, {}));
    await ok(call('hr2', 'POST', `/hr/vacancies/${v.id}/approve`, {}));
    await ok(call('hr', 'POST', `/hr/vacancies/${v.id}/publish`, {}));

    const jobs = await ok<{ organisation: string; vacancies: { id: string; title: string }[] }>(call('anon', 'GET', '/hr/jobs/tach'));
    expect(jobs.vacancies.map((j) => j.id)).toEqual([v.id]);
    const applicant = (name: string, nationalId: string, highestLevel: string, experienceYears: number, gender: string) => ({ name, email: `${nationalId}@mail.test`, phone: '0712345678', nationalId, gender, county: 'Nandi', highestLevel, experienceYears });
    const ann = await ok<{ reference: string }>(call('anon', 'POST', `/hr/jobs/TACH/${v.id}/apply`, applicant('Ann Wanjiru Kibet', '20000001', 'DEGREE', 5, 'FEMALE')), 201);
    expect(ann.reference).toMatch(new RegExp(`^${v.number}-0001$`));
    await ok(call('anon', 'POST', `/hr/jobs/TACH/${v.id}/apply`, applicant('Ben Kiprop', '20000002', 'DIPLOMA', 3, 'MALE')), 201);
    const cate = await ok<{ reference: string }>(call('anon', 'POST', `/hr/jobs/TACH/${v.id}/apply`, applicant('Cate Jepkosgei', '20000003', 'KCSE', 6, 'FEMALE')), 201);
    expect((await call('anon', 'POST', `/hr/jobs/TACH/${v.id}/apply`, applicant('Ann Again', '20000001', 'DEGREE', 5, 'FEMALE'))).status).toBe(409);

    expect((await call('hr', 'POST', `/hr/vacancies/${v.id}/shortlist`, {})).status).toBe(400);
    await ok(call('hr', 'POST', `/hr/vacancies/${v.id}/close`, {}));
    expect(await ok(call('hr', 'POST', `/hr/vacancies/${v.id}/shortlist`, { interviewAt: '2031-01-10' }))).toEqual({ shortlisted: 2, notShortlisted: 1 });
    expect((await ok<{ status: string }>(call('anon', 'GET', `/hr/jobs/TACH/status?reference=${cate.reference}&nationalId=20000003`))).status).toBe('REGRET');

    const detail = await ok<{ applications: { id: string; name: string; status: string }[] }>(call('hr', 'GET', `/hr/vacancies/${v.id}`));
    const app = (n: string) => detail.applications.find((a) => a.name.startsWith(n))!.id;
    expect((await call('hr', 'POST', `/hr/applications/${app('Ann')}/score`, { score: 90 })).status).toBe(403);
    await ok(call('hr2', 'POST', `/hr/applications/${app('Ann')}/score`, { score: 70 }));
    await ok(call('hr2', 'POST', `/hr/applications/${app('Ben')}/score`, { score: 85, comment: 'Strong practical answers' }));

    const appointed = await ok<{ employeeId: string }>(call('hr', 'POST', `/hr/applications/${app('Ben')}/appoint`, { hireDate: '2031-02-01' }), 201);
    const ben = await ok<{ firstName: string; lastName: string; jobGroupId: string; notch: number; basicSalary: string; onboarding: { _id?: string; id?: string; task: string; done: boolean }[] }>(call('hr', 'GET', `/hr/employees/${appointed.employeeId}`));
    expect(ben).toMatchObject({ firstName: 'Ben', lastName: 'Kiprop', jobGroupId: ids.TWS5, notch: 1, basicSalary: '40000' });
    expect(ben.onboarding).toHaveLength(7);
    const task = ben.onboarding[0];
    const tasks = await ok<{ done: boolean }[]>(call('hr', 'PATCH', `/hr/employees/${appointed.employeeId}/onboarding/${task.id ?? task._id}`, { done: true }));
    expect(tasks[0].done).toBe(true);
    expect((await call('hr', 'POST', `/hr/applications/${app('Ann')}/appoint`, { hireDate: '2031-02-01' })).status).toBe(400);
    expect((await ok<{ status: string }>(call('anon', 'GET', `/hr/jobs/TACH/status?reference=${ann.reference}&nationalId=20000001`))).status).toBe('REGRET');

    const report = await ok<{ number: string; applications: number; shortlisted: number; appointed: number; female: number; counties: Record<string, number> }[]>(call('hr', 'GET', '/hr/reports/recruitment?from=2020-01-01&to=2099-12-31'));
    expect(report.find((r) => r.number === v.number)).toMatchObject({ applications: 3, shortlisted: 2, appointed: 1, female: 2, counties: { Nandi: 3 } });
  });

  it('lets staff ask to change their records, which HR approves', async () => {
    ids.gina = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', employee('Gina', 'ADM', '2024-01-01', { basicSalary: '45000' }, { email: 'gina@test.co', gender: 'FEMALE' })), 201)).id;
    await ok(call('hr', 'POST', `/hr/employees/${ids.gina}/portal`, { password: PASSWORD }));
    expect((await call('gina', 'POST', '/auth/login', { email: 'gina@test.co', password: PASSWORD })).status).toBe(200);
    await ok(call('gina', 'POST', '/hr/me/changes/personal', { phone: '0799000111', dependants: [{ name: 'Tom', relationship: 'Son' }] }), 201);
    expect((await call('gina', 'POST', '/hr/me/changes/personal', { phone: '0799000222' })).status).toBe(400);
    expect((await call('gina', 'POST', '/hr/me/changes/personal', { basicSalary: '90000' })).status).toBe(400);
    await ok(call('gina', 'POST', '/hr/me/changes/bank', { bank: { name: 'Equity', accountNo: '0999' } }), 201);
    const pending = await ok<{ id: string; kind: string }[]>(call('hr', 'GET', '/hr/change-requests'));
    expect(pending.map((p) => p.kind).sort()).toEqual(['BANK', 'PERSONAL']);
    for (const p of pending) await ok(call('hr', 'POST', `/hr/change-requests/${p.id}/decide`, { approve: true }));
    expect(await ok(call('hr', 'GET', `/hr/employees/${ids.gina}`))).toMatchObject({ phone: '0799000111', bank: { name: 'Equity', accountNo: '0999' }, dependants: [{ name: 'Tom', relationship: 'Son' }] });
    const mine = await ok<{ status: string }[]>(call('gina', 'GET', '/hr/me/changes'));
    expect(mine.every((m) => m.status === 'APPROVED')).toBe(true);
  });

  it('hands over before leave, tells people about decisions and recalls leave under way', async () => {
    const types = await ok<{ id: string; code: string }[]>(call('hr', 'GET', '/hr/leave-types'));
    const al = types.find((t) => t.code === 'AL')!.id;
    const leave = await ok<{ id: string; days: number }>(call('gina', 'POST', '/hr/me/leave', { leaveTypeId: al, startDate: '2026-12-07', endDate: '2026-12-11', handoverTo: ids.dan, handoverNotes: 'Petty cash keys with Dan' }), 201);
    expect(leave.days).toBe(5);
    await ok(call('hr', 'POST', `/hr/leave/${leave.id}/review`, { decision: 'APPROVED' }));
    const notes = await ok<unknown>(call('gina', 'GET', '/notifications'));
    const list = (Array.isArray(notes) ? notes : (notes as { items: { title: string }[] }).items) as { title: string }[];
    expect(list.some((n) => /leave from 2026-12-07 to 2026-12-11 was approved/.test(n.title))).toBe(true);
    expect((await call('hr', 'POST', `/hr/leave/${leave.id}/recall`, { returnDate: '2026-12-07', reason: 'Audit' })).status).toBe(400);
    const recalled = await ok<{ days: number; daysRestored: number; endDate: string }>(call('hr', 'POST', `/hr/leave/${leave.id}/recall`, { returnDate: '2026-12-10', reason: 'Year-end audit' }));
    expect(recalled).toMatchObject({ days: 3, daysRestored: 2 });
    expect(recalled.endDate.slice(0, 10)).toBe('2026-12-09');
    expect((await call('hr', 'POST', `/hr/leave/${leave.id}/recall`, { returnDate: '2026-12-09', reason: 'Again' })).status).toBe(400);
  });

  it('takes a disciplinary case through show cause, decision and appeal, and receives grievances', async () => {
    const c = await ok<{ id: string; number: string }>(call('hr', 'POST', '/hr/cases', { kind: 'DISCIPLINARY', employeeId: ids.dan, category: 'Absenteeism', description: 'Absent without leave for 3 days', incidentDate: '2026-11-02' }), 201);
    expect(c.number).toBe('DC-0001');
    expect((await call('hr', 'POST', `/hr/cases/${c.id}/steps`, { action: 'SHOW_CAUSE', note: 'Explain the absence' })).status).toBe(400);
    await ok(call('hr', 'POST', `/hr/cases/${c.id}/steps`, { action: 'SHOW_CAUSE', note: 'Explain the absence', dueDate: '2026-11-10' }));
    await ok(call('hr', 'POST', `/hr/cases/${c.id}/steps`, { action: 'RESPONSE', note: 'Was unwell, no note' }));
    expect((await call('hr', 'POST', `/hr/cases/${c.id}/steps`, { action: 'DECISION', outcome: 'RESOLVED' })).status).toBe(400);
    await ok(call('hr', 'POST', `/hr/cases/${c.id}/steps`, { action: 'DECISION', outcome: 'WRITTEN_WARNING', note: 'Warning letter issued' }));
    await ok(call('hr', 'POST', `/hr/cases/${c.id}/steps`, { action: 'APPEAL', note: 'Hospital records now available' }));
    const closed = await ok<{ status: string; outcome: string; steps: unknown[]; appeal: { decision: string } }>(call('hr', 'POST', `/hr/cases/${c.id}/steps`, { action: 'APPEAL_DECISION', appealDecision: 'VARIED', outcome: 'VERBAL_WARNING' }));
    expect(closed).toMatchObject({ status: 'CLOSED', outcome: 'VERBAL_WARNING', appeal: { decision: 'VARIED' } });
    expect(closed.steps).toHaveLength(6);
    expect((await call('payroll', 'GET', '/hr/cases')).status).toBe(403);

    expect(await ok(call('gina', 'POST', '/hr/me/grievances', { category: 'Workload', against: 'Overtime allocation', description: 'Overtime is not shared fairly in the section' }), 201)).toMatchObject({ number: 'GR-0001' });
    const grievances = await ok<{ number: string; employee: { id: string } }[]>(call('hr', 'GET', '/hr/cases?kind=GRIEVANCE'));
    expect(grievances[0]).toMatchObject({ number: 'GR-0001', employee: { id: ids.gina } });
  });

  it('clears a leaver section by section with an exit interview', async () => {
    const clr = await ok<{ id: string; items: { section: string }[] }>(call('hr', 'POST', `/hr/employees/${ids.eve}/clearance`, { lastDay: '2026-11-15', reason: 'End of contract' }), 201);
    expect(clr.items.map((i) => i.section)).toEqual(['Supervisor', 'ICT', 'Finance', 'Stores', 'Transport', 'HR']);
    expect((await call('hr', 'POST', `/hr/employees/${ids.eve}/clearance`, { lastDay: '2026-11-15', reason: 'Again' })).status).toBe(409);
    expect((await call('hr', 'POST', `/hr/clearances/${clr.id}/complete`)).status).toBe(400);
    expect((await call('hr', 'POST', `/hr/clearances/${clr.id}/sections`, { section: 'Finance', cleared: true, owed: '500' })).status).toBe(400);
    await ok(call('payroll', 'POST', `/hr/clearances/${clr.id}/sections`, { section: 'Finance', cleared: false, owed: '500', note: 'Imprest not surrendered' }));
    for (const section of ['Supervisor', 'ICT', 'Finance', 'Stores', 'Transport', 'HR']) await ok(call('hr', 'POST', `/hr/clearances/${clr.id}/sections`, { section, cleared: true }));
    const early = await call<{ message: string }>('hr', 'POST', `/hr/clearances/${clr.id}/complete`);
    expect(early.data.message).toMatch(/exit interview/);
    await ok(call('hr', 'POST', `/hr/clearances/${clr.id}/exit-interview`, { reasonForLeaving: 'Contract ended', wouldRecommend: true }));
    expect(await ok(call('hr', 'POST', `/hr/clearances/${clr.id}/complete`))).toMatchObject({ status: 'CLEARED' });
  });

  it('appraises on a balanced scorecard with self-rating, supervisor rating and appeal', async () => {
    const cycle = await ok<{ id: string }>(call('hr', 'POST', '/hr/appraisal-cycles', { name: '2026 appraisal', from: '2026-01-01', to: '2026-12-31' }), 201);
    const targets = [
      { perspective: 'FINANCIAL', objective: 'Cut unbilled water', measure: 'NRW %', target: '25%', weight: 25 },
      { perspective: 'CUSTOMER', objective: 'Answer complaints in 48h', weight: 25 },
      { perspective: 'INTERNAL_PROCESS', objective: 'Monthly reconciliations on time', weight: 25 },
      { perspective: 'LEARNING_GROWTH', objective: 'Complete an Excel course', weight: 25 },
    ];
    expect((await call('hr', 'POST', '/hr/appraisals/targets', { cycleId: cycle.id, employeeId: ids.gina, targets: targets.slice(0, 3).map((t) => ({ ...t, weight: 33 })) })).status).toBe(400);
    expect((await call('hr', 'POST', '/hr/appraisals/targets', { cycleId: cycle.id, employeeId: ids.gina, targets: targets.map((t) => ({ ...t, weight: 20 })) })).status).toBe(400);
    expect((await call('payroll', 'POST', '/hr/appraisals/targets', { cycleId: cycle.id, employeeId: ids.gina, targets })).status).toBe(403);
    const a = await ok<{ id: string; targets: { _id?: string; id?: string }[] }>(call('hr', 'POST', '/hr/appraisals/targets', { cycleId: cycle.id, employeeId: ids.gina, targets }));
    const tid = a.targets.map((t) => t.id ?? t._id);
    const rate = (r: number[]) => tid.map((targetId, i) => ({ targetId, rating: r[i] }));

    expect((await call('gina', 'POST', `/hr/me/appraisals/${a.id}/self-review`, { ratings: rate([5, 5, 5, 5]) })).status).toBe(400);
    await ok(call('gina', 'POST', `/hr/me/appraisals/${a.id}/agree`));
    expect((await call('hr', 'POST', `/hr/appraisals/${a.id}/review`, { ratings: rate([5, 4, 4, 3]) })).status).toBe(400);
    await ok(call('gina', 'POST', `/hr/me/appraisals/${a.id}/self-review`, { ratings: rate([5, 5, 4, 4]) }));
    const reviewed = await ok<{ score: number; grade: string; status: string }>(call('hr', 'POST', `/hr/appraisals/${a.id}/review`, { ratings: rate([5, 4, 4, 3]), recommendation: 'TRAINING', trainingNeeds: ['Excel for finance'] }));
    expect(reviewed).toMatchObject({ score: 80, grade: 'Very good', status: 'REVIEWED' });

    await ok(call('gina', 'POST', `/hr/me/appraisals/${a.id}/appeal`, { grounds: 'Complaints target was met in Q3 and Q4' }));
    expect((await call('hr', 'POST', `/hr/appraisals/${a.id}/appeal-decision`, { decision: 'Upheld in part' })).status).toBe(403);
    const decided = await ok<{ score: number; status: string; appeal: { originalScore: number } }>(call('hr2', 'POST', `/hr/appraisals/${a.id}/appeal-decision`, { decision: 'Customer rating raised', ratings: rate([5, 5, 4, 3]) }));
    expect(decided).toMatchObject({ score: 85, status: 'CLOSED', appeal: { originalScore: 80 } });

    const report = await ok<{ completed: number; averageScore: number; trainingNeeds: { need: string }[] }>(call('hr', 'GET', `/hr/appraisal-cycles/${cycle.id}/report`));
    expect(report).toMatchObject({ completed: 1, averageScore: 85 });
    expect(report.trainingNeeds.map((n) => n.need)).toEqual(['Excel for finance']);
  });

  it('plans training from appraisal needs within the training budget and records evaluation', async () => {
    await ok(call('hr', 'PUT', '/hr/training-budget', { year: 2026, amount: '50000' }));
    expect((await ok<{ need: string }[]>(call('hr', 'GET', '/hr/training-needs'))).map((n) => n.need)).toEqual(['Excel for finance']);
    const t = await ok<{ id: string }>(call('hr', 'POST', '/hr/trainings', { title: 'Excel for finance', provider: 'KSG', startDate: '2026-12-14', endDate: '2026-12-16', cost: '60000', participantIds: [ids.gina], needs: ['Excel for finance'] }), 201);
    expect((await call('hr', 'POST', `/hr/trainings/${t.id}/approve`, {})).status).toBe(403);
    const over = await call<{ message: string }>('hr2', 'POST', `/hr/trainings/${t.id}/approve`, {});
    expect(over.data.message).toMatch(/Only 50000\.00 of the 2026 training budget is left/);
    await ok(call('hr', 'PATCH', `/hr/trainings/${t.id}`, { title: 'Excel for finance', provider: 'KSG', startDate: '2026-12-14', endDate: '2026-12-16', cost: '30000', participantIds: [ids.gina], needs: ['Excel for finance'] }));
    await ok(call('hr2', 'POST', `/hr/trainings/${t.id}/approve`, {}));
    expect(await ok(call('hr', 'GET', '/hr/training-needs'))).toEqual([]);
    await ok(call('hr', 'POST', `/hr/trainings/${t.id}/complete`, {}));
    await ok(call('gina', 'POST', `/hr/me/trainings/${t.id}/evaluate`, { rating: 4, feedback: 'Useful pivot tables' }));
    const budget = await ok<{ budget: string; committed: string; remaining: string; averageEvaluation: number; byDepartment: { department: string; cost: string }[] }>(call('hr', 'GET', '/hr/training-budget?year=2026'));
    expect(budget).toMatchObject({ budget: '50000', committed: '30000', remaining: '20000', averageEvaluation: 4 });
    const mine = await ok<{ title: string; me: { attended: boolean; rating: number } }[]>(call('gina', 'GET', '/hr/me/trainings'));
    expect(mine[0]).toMatchObject({ title: 'Excel for finance', me: { attended: true, rating: 4 } });
  });
});
