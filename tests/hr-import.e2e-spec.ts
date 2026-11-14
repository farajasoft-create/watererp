import bcrypt from 'bcryptjs';
import { createCipheriv, randomBytes } from 'node:crypto';
import mongoose, { Connection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hrModule } from '../src/modules/hr/module';
import type { HrServices } from '../src/modules/hr/server/container';
import { FarajasofterpImporter, ImportReport } from '../src/modules/hr/server/import/farajasofterp';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';
import { Journal } from '../src/platform/ledger/types';

/**
 * Copying a farajasofterp company into the HR module: a made-up farajasofterp database with two
 * companies, encrypted fields, approved and draft pay runs and leave, imported twice.
 */

const KEY = 'b'.repeat(64);
const NOW = new Date('2026-11-02T08:00:00Z');
function enc(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `enc:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}

let replSet: MongoMemoryReplSet;
let conn: Connection;
let source: Connection;
let platform: Platform;
let hr: HrServices;
let orgId: Types.ObjectId;
let importer: FarajasofterpImporter;
const posted: Journal[] = [];
const ids = { company: new Types.ObjectId(), other: new Types.ObjectId(), amos: new Types.ObjectId(), beth: new Types.ObjectId(), carl: new Types.ObjectId(), dan: new Types.ObjectId(), al: new Types.ObjectId(), study: new Types.ObjectId() };

/** A farajasofterp pay run entry, as its payroll processor writes them. */
function comp(e: Types.ObjectId, code: string, basic: number, house: number, paye: number, extra: Record<string, number> = {}) {
  const gross = basic + house;
  const nssf = Math.min(gross, 72000) * 0.06;
  const shif = Math.max(gross * 0.0275, 300);
  const ahl = gross * 0.015;
  const other = Object.values(extra).reduce((s, v) => s - v, 0);
  const total = nssf + shif + ahl + paye + other;
  return {
    id: e.toHexString(),
    employeeId: code,
    firstName: code,
    lastName: 'X',
    department: 'Technical',
    position: 'Staff',
    'Basic Salary': basic,
    'House Allowance': house,
    ...extra,
    PAYETax: -paye,
    NSSFTax: -nssf,
    SHIFTax: -shif,
    AHLTax: -ahl,
    'employer_NSSF Employer': nssf,
    'employer_AHL Employer': ahl,
    fixedSalary: gross,
    totalEarnings: 0,
    totalDeductions: Math.round(total * 100) / 100,
    netSalary: Math.round((gross - total) * 100) / 100,
  };
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('platform_import')).asPromise();
  source = await mongoose.createConnection(replSet.getUri('farajasofterp_src')).asPromise();
  platform = await createPlatform(conn, { modules: [hrModule] });
  platform.core.ledger.use({
    name: 'Test',
    isConnected: async () => true,
    post: async (_org, journal) => {
      posted.push(journal);
      return 'j';
    },
    accounts: async () => [],
  });
  hr = platform.modules.hr as HrServices;
  importer = new FarajasofterpImporter(hr.db, hr.payroll, hr.leave);
  const [org] = await platform.core.db.organisations.create([{ name: 'Tachasis Water', code: 'TACH', modules: ['hr'] }]);
  orgId = org._id;
  await hrModule.seed!({ db: platform.core.db, core: platform.core, services: hr, organisationId: orgId, demo: false, demoPassword: '' });

  const s = source.db!;
  await s.collection('companies').insertMany([{ _id: ids.company, name: 'Tachasis WSC' }, { _id: ids.other, name: 'Another client' }]);
  const password = await bcrypt.hash('old-password-1', 4);
  const base = { company: ids.company, address: 'Nandi Hills', dateOfBirth: '1990-05-01', contractType: 'Permanent', jobRole: 'Staff', status: 'active', preferredPaymentMethod: 'BANK' };
  await s.collection('employees').insertMany([
    { ...base, _id: ids.amos, employeeId: 'TW-001', firstName: 'Amos', lastName: 'Kiprop', gender: 'male', email: 'amos@tachasis.test', password, phone: '0722000111', nationalId: enc('28000111'), position: 'Plumber', department: 'Technical', dateOfJoining: '2021-02-01', salary: { basicSalary: 50000, houseAllowance: 7500 }, customFields: { kraPin: 'A001234567B', nssfNumber: '2001', nhifNumber: 'CR1' }, bankInfo: { bankCode: 'KCBL', accountNumber: enc('1100999'), branchCode: '01001' } },
    { ...base, _id: ids.beth, employeeId: 'TW-002', firstName: 'Beth', lastName: 'Chebet', gender: 'female', email: 'beth@tachasis.test', password, nationalId: '28000222', position: 'Accountant', department: 'Finance & Administration', dateOfJoining: '2019-07-15', status: 'terminated', dateOfLeaving: '2026-09-30', terminationDetails: { reason: 'Resigned' }, salary: { basicSalary: 90000 } },
    { ...base, _id: ids.carl, employeeId: 'TW-003', firstName: 'Carl', lastName: 'Rono', gender: 'male', email: 'amos@tachasis.test', password, manager: ids.amos.toHexString(), position: 'Pump operator', department: 'Technical', dateOfJoining: '2024-01-10', salary: { basicSalary: 30000 }, customFields: { kraPin: 'nonsense' } },
    { ...base, _id: ids.dan, employeeId: 'TW-004', firstName: 'Dan', lastName: 'Casual', department: 'Technical', dateOfJoining: '2025-06-01', paySettings: { payType: 'daily_rate', rate: 900 }, salary: {} },
    { ...base, _id: new Types.ObjectId(), company: ids.other, employeeId: 'OT-1', firstName: 'Other', lastName: 'Client', dateOfJoining: '2020-01-01', salary: { basicSalary: 1 } },
  ]);
  await s.collection('payruns').insertMany([
    { company_id: ids.company, period: 'September 2026', status: 'Complete', compData: [comp(ids.amos, 'TW-001', 50000, 7500, 7713.4), comp(ids.beth, 'TW-002', 90000, 0, 17000, { 'Sacco Deduction': -2000 }), comp(ids.carl, 'TW-003', 30000, 0, 1100)] },
    { company_id: ids.company, period: 'October 2026', status: 'Ready', compData: [comp(ids.amos, 'TW-001', 50000, 7500, 7713.4), comp(ids.carl, 'TW-003', 30000, 0, 1100)] },
    { company_id: ids.company, period: 'November 2026', status: 'Draft', compData: [comp(ids.amos, 'TW-001', 50000, 7500, 1)] },
  ]);
  await s.collection('leavetypes').insertMany([
    { _id: ids.al, company: ids.company, name: 'Annual Leave', code: 'AL', category: 'paid' },
    { _id: ids.study, company: ids.company, name: 'Study Leave', code: 'STL', category: 'unpaid' },
  ]);
  await s.collection('leaverequests').insertMany([
    { company: ids.company, employee: ids.amos, leaveType: ids.al, startDate: new Date('2026-03-02'), endDate: new Date('2026-03-04'), totalDays: 3, status: 'approved', reason: 'Family' },
    { company: ids.company, employee: ids.carl, leaveType: ids.study, startDate: new Date('2026-12-07'), endDate: new Date('2026-12-08'), totalDays: 2, status: 'pending' },
  ]);
  await s.collection('leavebalances').insertMany([{ employee: ids.amos, leaveType: ids.al, fiscalYear: '2026', available: 12.5 }]);
});

afterAll(async () => {
  await source?.close();
  await conn?.close();
  await replSet?.stop();
});

const options = { commit: true, withLogins: true, encryptionKey: KEY, now: NOW, companyId: ids.company };

describe('importing farajasofterp', () => {
  it('asks which company when there are several, and a dry run writes nothing', async () => {
    await expect(importer.run(source.db!, orgId, { ...options, companyId: undefined, commit: false })).rejects.toThrow(/Tachasis WSC/);
    await expect(importer.run(source.db!, orgId, { ...options, encryptionKey: undefined, commit: false })).rejects.toThrow(/SOURCE_FIELD_ENCRYPTION_KEY/);
    const dry = await importer.run(source.db!, orgId, { ...options, commit: false });
    expect(dry.employees).toEqual({ found: 4, created: 4, updated: 0, skipped: 0 });
    expect(dry.payrolls.periods).toEqual(['2026-09', '2026-10']);
    expect(await hr.db.employees.countDocuments()).toBe(0);
  });

  let report: ImportReport;
  it('brings employees, pay, departments and statutory numbers across', async () => {
    report = await importer.run(source.db!, orgId, options);
    expect(report.employees.created).toBe(4);
    const amos = await hr.db.employees.findOne({ legacyId: ids.amos.toHexString() }).lean();
    expect(amos).toMatchObject({ employeeNo: 'TW-001', nationalId: '28000111', kraPin: 'A001234567B', nssfNo: '2001', shaNo: 'CR1', phone: '254722000111', status: 'ACTIVE' });
    expect(amos!.bank?.accountNo).toBe('1100999');
    expect(amos!.basicSalary?.toString()).toBe('50000');
    const beth = await hr.db.employees.findOne({ employeeNo: 'TW-002' }).lean();
    expect(beth!.status).toBe('TERMINATED');
    expect(beth!.terminationDate!.toISOString().slice(0, 10)).toBe('2026-09-30');
    const carl = await hr.db.employees.findOne({ employeeNo: 'TW-003' }).lean();
    expect(carl!.managerId!.equals(amos!._id)).toBe(true);
    expect(carl!.kraPin).toBeUndefined();
    const depts = await hr.db.departments.find({ organisationId: orgId }).lean();
    expect(depts.map((d) => d.name)).toEqual(expect.arrayContaining(['Technical', 'Finance & Administration']));
    // The allowance carries on from the month after the last imported payroll.
    const house = await hr.db.payItems.findOne({ employeeId: amos!._id }).lean();
    expect(house).toMatchObject({ code: 'HOUSE_ALW', fromPeriod: '2026-11', toPeriod: null });
    const dan = await hr.db.employees.findOne({ employeeNo: 'TW-004' }).lean();
    expect([dan!.payType, dan!.rate!.toString()]).toEqual(['DAILY', '900']);
    expect(report.warnings.join('\n')).toMatch(/KRA PIN "nonsense"/);
  });

  it('keeps approved payroll history as payslips, never sent to the ledger', async () => {
    const runs = await hr.db.payRuns.find({ organisationId: orgId }).sort({ period: 1 }).lean();
    expect(runs.map((r) => [r.period, r.status, r.imported, r.employeeCount])).toEqual([
      ['2026-09', 'PAID', true, 3],
      ['2026-10', 'APPROVED', true, 2],
    ]);
    const slip = await hr.db.payslips.findOne({ period: '2026-09', 'employee.employeeNo': 'TW-002' }).lean();
    expect(slip!.payslipNo).toBe('IMP-202609-0002');
    expect(slip!.otherDeductions!.toString()).toBe('2000');
    expect(slip!.paye!.toString()).toBe('17000');
    const retried = await hr.payroll.retryLedger({ organisationId: orgId } as never);
    expect(retried).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(posted).toHaveLength(0);
    // The P9 now covers the imported months.
    const p9 = await hr.reports.p9(orgId, slip!.employeeId, 2026);
    expect(Number(p9.totals.paye)).toBe(17000);
  });

  it('carries leave and makes this year’s balance match farajasofterp', async () => {
    const amos = await hr.db.employees.findOne({ employeeNo: 'TW-001' }).lean();
    const balances = await hr.leave.balances(orgId, amos!, 2026, NOW);
    expect(balances.find((b) => b.code === 'AL')!.available).toBe(12.5);
    expect(balances.find((b) => b.code === 'AL')!.taken).toBe(3);
    expect(report.leaveTypes).toEqual({ matched: 1, created: 1 });
    expect(await hr.db.leaveRequests.countDocuments({ organisationId: orgId, status: 'PENDING' })).toBe(1);
  });

  it('lets staff sign in with their old password, and compares the last month with this engine', async () => {
    expect(report.logins.created).toBe(1);
    expect(report.warnings.join('\n')).toMatch(/already linked to another employee/);
    const handle = createApi(async () => platform, [hrModule]);
    const login = await handle(new Request('http://t/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'amos@tachasis.test', password: 'old-password-1' }) }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const me = await handle(new Request('http://t/api/v1/hr/me', { headers: { cookie } }));
    expect(((await me.json()) as { payslips: unknown[] }).payslips).toHaveLength(2);

    expect(report.comparison && 'differences' in report.comparison).toBe(true);
    if (report.comparison && 'differences' in report.comparison) {
      expect(report.comparison.period).toBe('2026-10');
      expect(Number(report.comparison.oldNet)).toBeGreaterThan(0);
    }
  });

  it('can run again without duplicating anything', async () => {
    const again = await importer.run(source.db!, orgId, options);
    expect(again.employees).toEqual({ found: 4, created: 0, updated: 4, skipped: 0 });
    expect(again.payrolls.periods).toEqual([]);
    expect(await hr.db.employees.countDocuments()).toBe(4);
    expect(await hr.db.payslips.countDocuments()).toBe(5);
    expect(await hr.db.payItems.countDocuments()).toBe(1);
    expect(await hr.db.leaveRequests.countDocuments()).toBe(2);
    const amos = await hr.db.employees.findOne({ employeeNo: 'TW-001' }).lean();
    expect((await hr.leave.balances(orgId, amos!, 2026, NOW)).find((b) => b.code === 'AL')!.available).toBe(12.5);
    // November is not imported (a draft there), so it is paid here as usual.
    const run = await hr.payroll.createRun({ id: new Types.ObjectId(), organisationId: orgId, isAdmin: true, access: {}, permissions: [], modules: ['hr'], email: '', name: '', ip: null }, { period: '2026-11' });
    expect(run!.employeeCount).toBe(3);
  });
});
