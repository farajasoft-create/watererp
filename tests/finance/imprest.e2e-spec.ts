import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/modules/finance/core/database/db.service';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Staff imprest end to end: request → approval → issue → surrender (spent, cash back, overspend) →
 * approval, the one-open-imprest rule, overdue reminders, and recovery of unaccounted imprest through payroll.
 */

const PASSWORD = 'Password1234';

describe('Staff imprest (e2e)', () => {
  let db: Db;
  let owner: string;
  let holder: string;
  let reviewer: string;
  let holderId: string;
  let ke: string;
  let hq: string;
  let bank: string;
  let safari: string;
  const acc: Record<string, string> = {};
  const cat: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const glBalance = async (code: string) => {
    const tb = await as(owner).get(`/reports/trial-balance?entityId=${ke}&from=2026-01-01&to=2026-12-31`).expect(200);
    const row = tb.body.rows.find((r: { code: string }) => r.code === code);
    return row ? Number(row.closingDebit) - Number(row.closingCredit) : 0;
  };
  /** Requests, approves and issues an imprest of `amount` for a trip ending on `end`. */
  const issued = async (amount: string, end: string, issueDate = '2026-04-01') => {
    const created = await as(holder)
      .post('/imprests', { entityId: ke, branchId: hq, typeId: safari, purpose: 'Meter audit, Kapsabet', destination: 'Kapsabet', startDate: '2026-04-01', endDate: end, lines: [{ description: 'Per diem', amount }] })
      .expect(201);
    await as(holder).post(`/imprests/${created.body.id}/submit`).expect(201);
    await as(reviewer).post(`/imprests/${created.body.id}/approve`, {}).expect(201);
    const out = await as(reviewer).post(`/imprests/${created.body.id}/issue`, { date: issueDate, bankAccountId: bank }).expect(201);
    expect(out.body.status).toBe('ISSUED');
    return created.body.id as string;
  };

  beforeAll(async () => {
    ({ db } = await createTestApp());
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Imprest E2E', adminName: 'Owner', email: 'owner@imp.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    holderId = (await as(owner).post('/users', { name: 'Field Officer', email: 'field@imp.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201)).body.id;
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@imp.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    holder = await login('field@imp.test');
    reviewer = await login('rev@imp.test');
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Bank', glAccountId: acc['1120'] }).expect(201)).body.id;
    for (const c of (await as(owner).get('/expense-categories').expect(200)).body) cat[c.code] = c.id;
    const types = (await as(holder).get('/imprest-types').expect(200)).body as { id: string; code: string }[];
    expect(types.map((t) => t.code).sort()).toEqual(['SAFARI', 'SPECIAL', 'STANDING']);
    safari = types.find((t) => t.code === 'SAFARI')!.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('issues, surrenders with cash back, and blocks a second imprest while one is open', async () => {
    const id = await issued('20000', '2026-04-05');
    expect(await glBalance('1260')).toBe(20000);
    expect(await glBalance('1120')).toBe(-20000);
    const detail = (await as(holder).get(`/imprests/${id}`).expect(200)).body;
    expect(detail.surrenderDue.slice(0, 10)).toBe('2026-04-12'); // trip end + 7 days

    // Still holding it: a new request cannot be submitted.
    const second = await as(holder)
      .post('/imprests', { entityId: ke, branchId: hq, typeId: safari, purpose: 'Another trip', startDate: '2026-04-10', endDate: '2026-04-11', lines: [{ description: 'Fuel', amount: '1000' }] })
      .expect(201);
    const blocked = await as(holder).post(`/imprests/${second.body.id}/submit`).expect(400);
    expect(blocked.body.message).toMatch(/Surrender IMP-KE-000001/);

    // Only the holder surrenders; the approver cannot be the holder.
    await as(reviewer).post(`/imprests/${id}/surrender`, { date: '2026-04-06', lines: [] }).expect(403);
    await as(holder)
      .post(`/imprests/${id}/surrender`, {
        date: '2026-04-06',
        lines: [
          { date: '2026-04-02', categoryId: cat.TRAVEL, description: 'Bus fare', amount: '3000', receiptReference: 'TKT-1' },
          { date: '2026-04-03', categoryId: cat.MEALS, description: 'Meals', amount: '12000', receiptReference: 'R-9' },
        ],
        cashReturned: '5000',
        refundBankAccountId: bank,
        refundReference: 'DEP-55',
      })
      .expect(201);
    await as(holder).post(`/imprests/${id}/surrender/approve`, {}).expect(403);
    const done = await as(reviewer).post(`/imprests/${id}/surrender/approve`, {}).expect(201);
    expect(done.body.status).toBe('SURRENDERED');
    expect(Number(done.body.outstanding)).toBe(0);
    expect(await glBalance('1260')).toBe(0);
    expect(await glBalance('1120')).toBe(-15000);

    // Accounted for: the next request goes through.
    await as(holder).post(`/imprests/${second.body.id}/submit`).expect(201);
    await as(holder).post(`/imprests/${second.body.id}/cancel`, { reason: 'Trip postponed' }).expect(201);
  });

  it('owes the holder what was spent beyond the advance and pays it', async () => {
    const id = await issued('5000', '2026-04-20');
    await as(holder)
      .post(`/imprests/${id}/surrender`, { date: '2026-04-21', lines: [{ date: '2026-04-20', categoryId: cat.TRAVEL, description: 'Taxi and fares', amount: '6500', receiptReference: 'T-2' }] })
      .expect(201);
    const done = await as(reviewer).post(`/imprests/${id}/surrender/approve`, {}).expect(201);
    expect(Number(done.body.owedToApplicant)).toBe(1500);
    expect(await glBalance('2170')).toBe(-1500);
    await as(reviewer).post(`/imprests/${id}/pay-balance`, { date: '2026-04-22', bankAccountId: bank }).expect(201);
    expect(await glBalance('2170')).toBe(0);
    await as(reviewer).post(`/imprests/${id}/pay-balance`, { date: '2026-04-22', bankAccountId: bank }).expect(400);
  });

  it('reminds holders of overdue imprest and recovers it through payroll', async () => {
    const id = await issued('8000', '2026-05-02', '2026-05-01');
    const outstanding = (await as(reviewer).get(`/imprests/outstanding?entityId=${ke}`).expect(200)).body;
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0].daysOverdue).toBeGreaterThan(100);

    const first = (await as(reviewer).post('/imprests/remind-overdue').expect(201)).body;
    expect(first.reminded).toBe(1);
    const again = (await as(reviewer).post('/imprests/remind-overdue').expect(201)).body;
    expect(again.reminded).toBe(0); // not more than every few days
    const mails = await db.emails.find({ category: 'reminder', to: 'field@imp.test' }).lean();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Imprest IMP-KE-000004 is overdue');

    // Payroll recovery needs an employee record and the HR deductions account.
    const noEmployee = await as(reviewer).post(`/imprests/${id}/recover`, { date: '2026-06-15' }).expect(400);
    expect(noEmployee.body.message).toMatch(/no active employee record/);
    const organisationId = (await db.users.findById(holderId).lean())!.organisationId;
    const employeeId = new Types.ObjectId();
    await db.connection.collection('hr_employees').insertOne({ _id: employeeId, organisationId, employeeNo: 'EMP-1', firstName: 'Field', lastName: 'Officer', status: 'ACTIVE', userId: new Types.ObjectId(holderId) });
    await db.connection.collection('hr_settings').insertOne({ organisationId, accounts: { otherDeductions: await deductionsAccount() } });

    const recovering = await as(reviewer).post(`/imprests/${id}/recover`, { date: '2026-06-15', installment: '3000' }).expect(201);
    expect(recovering.body.status).toBe('RECOVERING');
    expect(recovering.body.recovery.fromPeriod).toBe('2026-07');
    const item = await db.connection.collection('hr_pay_items').findOne({ employeeId });
    expect(item).toMatchObject({ kind: 'DEDUCTION', code: 'IMPREST', fromPeriod: '2026-07', active: true });
    expect(item!.amount.toString()).toBe('3000');
    expect(item!.balance.toString()).toBe('8000');
    expect(await glBalance('1260')).toBe(0);
  });

  /** A postable liability account for payroll deductions. */
  async function deductionsAccount() {
    const created = await as(owner).post('/accounts', { code: '2185', name: 'Staff Deductions Payable', accountClass: 'LIABILITY', accountType: 'CURRENT_LIABILITY', parentId: acc['2100'] }).expect(201);
    return created.body.id as string;
  }
});
