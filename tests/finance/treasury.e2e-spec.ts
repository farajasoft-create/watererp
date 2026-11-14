import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { dec } from '../../src/modules/finance/core/common/money';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Treasury: a fixed deposit placed with maker-checker, interest accrued month by month, settled at
 * maturity with withholding tax on the interest and rolled over, plus the treasury report and
 * maturity reminders.
 *
 * 1,000,000 at 12% for 90 days (1 Jan – 1 Apr 2026, actual/365) earns 29,589.04. Accrued 9,863.01 to
 * 31 Jan (30 days) and 9,205.48 more to 28 Feb (58 days: 19,068.49). At maturity 15% withholding
 * (4,438.36) leaves 1,025,150.68, of which 10,520.55 is interest not yet accrued.
 */

const PASSWORD = 'Password1234';

describe('Treasury investments (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let bank: string;
  let deposit: string;
  let rolled: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const balance = async (code: string) => {
    const { db } = await getServices();
    const [row] = await db.ledger.aggregate<{ d: unknown; c: unknown }>([{ $match: { accountId: new Types.ObjectId(acc[code]) } }, { $group: { _id: null, d: { $sum: '$debit' }, c: { $sum: '$credit' } } }]);
    return row ? dec(row.d as never).minus(dec(row.c as never)).toFixed(2) : '0.00';
  };
  const body = (extra: object = {}) => ({
    entityId: ke,
    type: 'FIXED_DEPOSIT',
    institution: 'Kenya Commercial Bank',
    reference: 'FD-2026-001',
    principal: '1000000',
    ratePercent: '12',
    dayCount: 'ACT_365',
    startDate: '2026-01-01',
    maturityDate: '2026-04-01',
    withholdingPercent: '15',
    bankAccountId: bank,
    investmentAccountId: acc['1150'],
    interestIncomeAccountId: acc['4800'],
    interestReceivableAccountId: acc['1250'],
    withholdingAccountId: acc['1460'],
    ...extra,
  });

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Treasury E2E', adminName: 'Owner', email: 'owner@tr.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    const hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    acc['1150'] = (await as(owner).post('/accounts', { code: '1150', name: 'Short-term deposits', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parentId: acc['1100'] }).expect(201)).body.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (n: string) => roles.find((r) => r.name === n)!.id;
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@tr.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Rita Reviewer', email: 'rev@tr.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@tr.test');
    reviewer = await login('rev@tr.test');
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Operating account', glAccountId: acc['1120'] }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('places a deposit only after a second person approves it', async () => {
    await as(preparer).post('/investments', body({ maturityDate: '2025-12-31' })).expect(400);
    await as(preparer).post('/investments', body({ interestIncomeAccountId: acc['1250'] })).expect(400);
    const noWht = await as(preparer).post('/investments', body({ withholdingAccountId: null })).expect(400);
    expect(noWht.body.message).toMatch(/withholding tax/);

    const created = (await as(preparer).post('/investments', body()).expect(201)).body;
    deposit = created.id;
    expect(created).toMatchObject({ status: 'DRAFT', principal: '1000000' });
    expect(created.number).toMatch(/^TRS-KE-/);
    await as(preparer).post(`/investments/${deposit}/submit`).expect(201);
    await as(preparer).post(`/investments/${deposit}/approve`).expect(403);
    expect((await as(reviewer).post(`/investments/${deposit}/approve`).expect(201)).body.status).toBe('ACTIVE');
    expect(await balance('1150')).toBe('1000000.00');
    expect(await balance('1120')).toBe('-1000000.00');
    expect((await as(owner).get(`/investments/${deposit}`).expect(200)).body.termInterest).toBe('29589.04');
  });

  it('accrues interest month by month without drift', async () => {
    const jan = (await as(preparer).post('/investments/accrue', { entityId: ke, asOf: '2026-01-31' }).expect(201)).body;
    expect(jan).toMatchObject({ accrued: 1, total: '9863.01' });
    expect((await as(preparer).post('/investments/accrue', { entityId: ke, asOf: '2026-01-31' }).expect(201)).body.accrued).toBe(0);
    const feb = (await as(preparer).post('/investments/accrue', { entityId: ke, asOf: '2026-02-28' }).expect(201)).body;
    expect(feb.total).toBe('9205.48');
    expect(await balance('1250')).toBe('19068.49');
    expect(await balance('4800')).toBe('-19068.49');
  });

  it('settles at maturity net of withholding tax and rolls the proceeds over', async () => {
    const settled = (await as(preparer).post(`/investments/${deposit}/settle`, { date: '2026-04-01', rollover: { maturityDate: '2026-07-01', reinvestInterest: true } }).expect(201)).body;
    expect(settled.status).toBe('MATURED');
    expect(settled.settlement).toMatchObject({ interest: '29589.04', withholding: '4438.36', net: '1025150.68' });
    rolled = settled.settlement.rolledOverToId;
    const next = (await as(owner).get(`/investments/${rolled}`).expect(200)).body;
    expect(next).toMatchObject({ status: 'ACTIVE', principal: '1025150.68', ratePercent: '12', startDate: '2026-04-01T00:00:00.000Z', rolledOverFromId: deposit });

    expect(await balance('1150')).toBe('1025150.68'); // first deposit out, rollover in
    expect(await balance('1250')).toBe('0.00'); // accrued interest cleared
    expect(await balance('4800')).toBe('-29589.04'); // full term interest is income
    expect(await balance('1460')).toBe('4438.36'); // withholding tax recoverable
    expect(await balance('1120')).toBe('-1000000.00'); // proceeds went straight back into the rollover
    await as(preparer).post(`/investments/${deposit}/settle`, { date: '2026-04-01' }).expect(400);
  });

  it('reports cash and investments for a period and reminds before maturity', async () => {
    const report = (await as(preparer).get(`/treasury/report?entityId=${ke}&from=2026-04-01&to=2026-04-30&horizonDays=90`).expect(200)).body;
    expect(report.totals).toMatchObject({ cash: '-1000000', invested: '1025150.68', liquidity: '25150.68' });
    expect(report.holdings).toHaveLength(1);
    expect(report.holdings[0]).toMatchObject({ id: rolled, principal: '1025150.68' });
    expect(report.maturing).toHaveLength(1);
    expect(report.settled[0]).toMatchObject({ id: deposit, net: '1025150.68' });
    expect(report.placed[0]).toMatchObject({ id: rolled });
    expect(dec(report.interestEarned).gt(0)).toBe(true);

    const { investments } = await getServices();
    expect(await investments.remindMaturities(new Date('2026-06-01T00:00:00Z'))).toEqual({ sent: 0 });
    expect(await investments.remindMaturities(new Date('2026-06-26T00:00:00Z'))).toEqual({ sent: 1 });
    expect(await investments.remindMaturities(new Date('2026-06-27T00:00:00Z'))).toEqual({ sent: 0 });
    const notices = (await as(reviewer).get('/notifications').expect(200)).body.items as { kind: string; title: string }[];
    expect(notices.some((n) => n.kind === 'investment-maturity' && n.title.includes('matures on 2026-07-01'))).toBe(true);
  });
});
