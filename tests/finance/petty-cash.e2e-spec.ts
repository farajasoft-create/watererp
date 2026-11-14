import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Petty cash: a float and per-category limits on a petty cash box, online requests checked against the
 * per-voucher and monthly limits, approval by someone other than the requester, payment out of the box
 * (expense debited, box credited, never below zero), and the petty cash book with the replenishment due.
 */

const PASSWORD = 'Password1234';

describe('Petty cash (e2e)', () => {
  let owner: string;
  let staff: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let bank: string;
  let box: string;
  const acc: Record<string, string> = {};
  const cat: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    put: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const glBalance = async (code: string) => {
    const tb = await as(owner).get(`/reports/trial-balance?entityId=${ke}&from=2026-01-01&to=2026-12-31`).expect(200);
    const row = tb.body.rows.find((r: { code: string }) => r.code === code);
    return row ? Number(row.closingDebit) - Number(row.closingCredit) : 0;
  };

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Petty E2E', adminName: 'Owner', email: 'owner@pc.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Clerk', email: 'clerk@pc.test', password: PASSWORD, roleIds: [role('Staff Requester')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@pc.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    staff = await login('clerk@pc.test');
    reviewer = await login('rev@pc.test');
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Bank', glAccountId: acc['1120'] }).expect(201)).body.id;
    box = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'HQ petty cash', type: 'PETTY_CASH', glAccountId: acc['1110'] }).expect(201)).body.id;
    for (const c of (await as(owner).get('/expense-categories').expect(200)).body) cat[c.code] = c.id;
    await as(owner).post('/bank-transfers', { entityId: ke, fromBankAccountId: bank, toBankAccountId: box, date: '2026-01-02', amount: '10000', reference: 'Float' }).expect(201);
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('sets a float and category limits', async () => {
    await as(staff).put(`/petty-cash/boxes/${box}/limits`, { float: '10000', categories: [] }).expect(403);
    await as(owner).put(`/petty-cash/boxes/${box}/limits`, { float: '10000', categories: [{ categoryId: cat.TRAVEL, perVoucher: '5000', perMonth: '3000' }] }).expect(400);
    const l = await as(owner).put(`/petty-cash/boxes/${box}/limits`, { float: '10000', categories: [{ categoryId: cat.TRAVEL, perVoucher: '3000', perMonth: '5000' }] }).expect(200);
    expect(l.body.float).toBe('10000');
    await as(owner).put(`/petty-cash/boxes/${bank}/limits`, { float: '1', categories: [] }).expect(400); // not a petty cash account
  });

  it('checks requests against the limits, approves and pays out of the box', async () => {
    const boxes = (await as(staff).get('/petty-cash/boxes').expect(200)).body;
    expect(boxes.map((b: { name: string }) => b.name)).toEqual(['HQ petty cash']);
    await as(staff).post('/petty-cash', { bankAccountId: box, categoryId: cat.TRAVEL, amount: '3500', purpose: 'Boda boda to Kapsoya works' }).expect(400); // per voucher
    const other = Object.keys(cat).find((c) => c !== 'TRAVEL')!;
    await as(staff).post('/petty-cash', { bankAccountId: box, categoryId: cat[other], amount: '100', purpose: 'Not from this box' }).expect(400);
    const a = (await as(staff).post('/petty-cash', { bankAccountId: box, categoryId: cat.TRAVEL, amount: '3000', purpose: 'Fare to Eldoret for the tender opening' }).expect(201)).body;
    expect(a.number).toBe('PCV-KE-000001');
    const b = (await as(staff).post('/petty-cash', { bankAccountId: box, categoryId: cat.TRAVEL, amount: '2000', purpose: 'Fare to Kapsabet' }).expect(201)).body;
    await as(staff).post('/petty-cash', { bankAccountId: box, categoryId: cat.TRAVEL, amount: '1', purpose: 'Over the month' }).expect(400); // 5000 used this month
    await as(staff).post(`/petty-cash/${a.id}/approve`).expect(403);
    await as(reviewer).post(`/petty-cash/${a.id}/approve`).expect(201);
    await as(owner).post(`/petty-cash/${a.id}/pay`, { date: '2026-01-05', receiptReference: 'R-77' }).expect(201);
    expect(await glBalance('1110')).toBe(7000);
    expect(await glBalance('6500')).toBe(3000);
    await as(reviewer).post(`/petty-cash/${b.id}/reject`, { reason: 'Use the pool vehicle' }).expect(201);

    const book = (await as(owner).get(`/petty-cash/boxes/${box}/book`).expect(200)).body;
    expect(book).toMatchObject({ balance: '7000.00', float: '10000.00', replenish: '3000.00' });
    expect(book.categories[0]).toMatchObject({ usedThisMonth: '3000.00', left: '2000.00' });
    const mine = (await as(staff).get('/petty-cash?mine=true').expect(200)).body;
    expect(mine.map((v: { status: string }) => v.status).sort()).toEqual(['PAID', 'REJECTED']);
  });

  it('keeps the sponsorship and donations register', async () => {
    const sp = (await as(staff).post('/sponsorships', { entityId: ke, kind: 'SPONSORSHIP', beneficiary: 'Kapsoya Primary School', category: 'EDUCATION', purpose: 'Water day drama festival', amount: '50000', inKind: 'Two water bowsers for the day', inKindValue: '12000', benefits: 'Branding at the venue' }).expect(201)).body;
    expect(sp.number).toBe('SPN-KE-000001');
    await as(staff).post(`/sponsorships/${sp.id}/decide`, { approve: true }).expect(403);
    await as(reviewer).post(`/sponsorships/${sp.id}/decide`, { approve: false }).expect(400);
    await as(reviewer).post(`/sponsorships/${sp.id}/decide`, { approve: true }).expect(201);
    const school = (await as(owner).post('/suppliers', { code: 'KPS', name: 'Kapsoya Primary School', currency: 'KES' }).expect(201)).body.id;
    const small = (await as(owner).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: school, date: '2026-01-10', bankAccountId: bank, amount: '40000', reference: 'EFT-1' }).expect(201)).body.id;
    await as(owner).post(`/sponsorships/${sp.id}/paid`, { paymentId: small }).expect(400); // not posted
    await as(owner).post(`/payments/${small}/submit`).expect(201);
    await as(reviewer).post(`/payments/${small}/approve`).expect(201);
    await as(owner).post(`/sponsorships/${sp.id}/paid`, { paymentId: small }).expect(400); // less than approved
    const full = (await as(owner).post('/payments', { entityId: ke, kind: 'PAYMENT', partyId: school, date: '2026-01-11', bankAccountId: bank, amount: '50000', reference: 'EFT-2' }).expect(201)).body.id;
    await as(owner).post(`/payments/${full}/submit`).expect(201);
    await as(reviewer).post(`/payments/${full}/approve`).expect(201);
    expect((await as(owner).post(`/sponsorships/${sp.id}/paid`, { paymentId: full }).expect(201)).body.status).toBe('PAID');
    await as(staff).post(`/sponsorships/${sp.id}/acknowledge`, { text: 'Letter of thanks from the head teacher' }).expect(201);
    const report = (await as(reviewer).get(`/sponsorships/report?year=${new Date().getUTCFullYear()}`).expect(200)).body;
    expect(report.totals).toMatchObject({ count: 1, cash: '50000.00', inKind: '12000.00' });
    expect(report.rows[0]).toMatchObject({ kind: 'SPONSORSHIP', category: 'EDUCATION', paid: '50000.00' });
  });

  it('never pays more than the box holds', async () => {
    await as(owner).put(`/petty-cash/boxes/${box}/limits`, { float: '10000', categories: [{ categoryId: cat.TRAVEL, perVoucher: '9000', perMonth: '20000' }] }).expect(200);
    const big = (await as(staff).post('/petty-cash', { bankAccountId: box, categoryId: cat.TRAVEL, amount: '8000', purpose: 'Hire of a lorry' }).expect(201)).body;
    await as(reviewer).post(`/petty-cash/${big.id}/approve`).expect(201);
    const res = await as(owner).post(`/petty-cash/${big.id}/pay`, { date: '2026-01-06' }).expect(400);
    expect(res.body.message).toMatch(/replenish/);
  });
});
