import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 19 (group): eliminating the parent's investment against the subsidiary's
 * equity at acquisition (goodwill, non-controlling interest, pre-acquisition results), and eliminating
 * intercompany loans tagged on manual journals.
 */

const PASSWORD = 'Password1234';

describe('Group acquisitions and intercompany loans (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let sub: string;
  let hq: string;
  let subHq: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  async function postJournal(entityId: string, branchId: string, date: string, description: string, lines: object[]) {
    const created = await as(preparer).post('/journals', { entityId, branchId, journalDate: date, description, lines }).expect(201);
    await as(preparer).post(`/journals/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/journals/${created.body.id}/approve`, { post: true }).expect(201)).body;
  }
  const report = async () => (await as(owner).get('/consolidation?from=2026-01-01&asOf=2026-03-31').expect(200)).body;
  const row = (r: { rows: { code: string; name: string; consolidated: string; acquisitions: string; eliminations: string }[] }, code: string) => r.rows.find((x) => x.code === code || x.name === code);

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Acq E2E', adminName: 'Owner', email: 'owner@acq.test', password: PASSWORD, entityCode: 'KE', entityName: 'Parent Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    sub = (await as(owner).post('/entities', { code: 'SUB', name: 'Subsidiary Kenya', country: 'Kenya', functionalCurrency: 'KES' }).expect(201)).body.id;
    subHq = (await as(owner).post('/branches', { entityId: sub, code: 'SHQ', name: 'Subsidiary HQ' }).expect(201)).body.id;
    await as(owner).post('/fiscal-years', { entityId: sub, startDate: '2026-01-01' }).expect(201);
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    acc['1260'] = (await as(owner).post('/accounts', { code: '1260', name: 'Loan to subsidiary', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parentId: acc['1100'] }).expect(201)).body.id;
    acc['2260'] = (await as(owner).post('/accounts', { code: '2260', name: 'Loan from parent', accountClass: 'LIABILITY', accountType: 'CURRENT_LIABILITY', parentId: acc['2100'] }).expect(201)).body.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@acq.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@acq.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@acq.test');
    reviewer = await login('rev@acq.test');

    // The subsidiary: capital in January, trading before and after the acquisition at the end of February.
    await postJournal(sub, subHq, '2026-01-10', 'Share capital', [{ accountId: acc['1120'], debit: '1000000' }, { accountId: acc['3100'], credit: '1000000' }]);
    await postJournal(sub, subHq, '2026-02-15', 'Sales before acquisition', [{ accountId: acc['1120'], debit: '200000' }, { accountId: acc['4100'], credit: '200000' }]);
    await postJournal(sub, subHq, '2026-03-15', 'Sales after acquisition', [{ accountId: acc['1120'], debit: '100000' }, { accountId: acc['4100'], credit: '100000' }]);
    // The parent buys 75% for 960,000.
    await postJournal(ke, hq, '2026-02-28', 'Acquisition of 75% of SUB', [{ accountId: acc['1640'], debit: '960000' }, { accountId: acc['1120'], credit: '960000' }]);
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('provisions goodwill and investment accounts', () => {
    expect(acc['1630']).toBeDefined();
    expect(acc['1640']).toBeDefined();
  });

  it('records the acquisition (approvers only) and keeps ownership in step', async () => {
    const body = { parentEntityId: ke, subsidiaryEntityId: sub, acquisitionDate: '2026-02-28', investmentAccountId: acc['1640'], cost: '960000', ownershipPercent: '75', goodwillAccountId: acc['1630'] };
    await as(preparer).post('/consolidation/investments', body).expect(403);
    await as(reviewer).post('/consolidation/investments', { ...body, subsidiaryEntityId: ke }).expect(400);
    await as(reviewer).post('/consolidation/investments', { ...body, ownershipPercent: '120' }).expect(400);
    await as(reviewer).post('/consolidation/investments', body).expect(201);
    await as(reviewer).post('/consolidation/investments', body).expect(400);
    const entity = (await as(owner).get('/entities').expect(200)).body.find((e: { id: string }) => e.id === sub);
    expect(entity.ownershipPercent).toBe('75');
  });

  it('eliminates the investment against equity at acquisition, recognising goodwill and non-controlling interest', async () => {
    const r = await report();
    expect(r.acquisitions).toHaveLength(1);
    expect(r.acquisitions[0]).toMatchObject({ parentCode: 'KE', subsidiaryCode: 'SUB', netAssets: '1200000', cost: '960000', goodwill: '60000', nonControllingInterest: '300000' });
    expect(row(r, '1630')!.consolidated).toBe('60000');
    expect(row(r, '1640')!.consolidated).toBe('0');
    expect(row(r, '3100')!.consolidated).toBe('0');
    expect(row(r, 'Non-controlling interest at acquisition')!.consolidated).toBe('300000');
    // Only results after the acquisition belong to the group.
    expect(r.totals.revenue).toBe('100000');
    expect(r.totals.netProfit).toBe('100000');
    expect(r.totals.profitToNonControlling).toBe('25000');
    expect(r.totals.profitToOwners).toBe('75000');
    expect(r.totals.nonControllingInterest).toBe('325000');
    expect(r.totals.equityToOwners).toBe('75000');
    expect(r.totals.balanced).toBe(true);
  });

  it('eliminates intercompany loans tagged on manual journals', async () => {
    await as(preparer)
      .post('/journals', { entityId: ke, branchId: hq, journalDate: '2026-03-20', description: 'Loan', lines: [{ accountId: acc['1260'], debit: '50000', intercompanyEntityId: ke }, { accountId: acc['1120'], credit: '50000' }] })
      .expect(400);
    await postJournal(ke, hq, '2026-03-20', 'Loan to SUB', [{ accountId: acc['1260'], debit: '50000', intercompanyEntityId: sub }, { accountId: acc['1120'], credit: '50000' }]);
    await postJournal(sub, subHq, '2026-03-20', 'Loan from KE', [{ accountId: acc['1120'], debit: '50000' }, { accountId: acc['2260'], credit: '50000', intercompanyEntityId: ke }]);
    const r = await report();
    expect(row(r, '1260')).toMatchObject({ eliminations: '-50000', consolidated: '0' });
    expect(row(r, '2260')).toMatchObject({ eliminations: '-50000', consolidated: '0' });
    expect(r.totals.intercompanyDifference).toBe('0');
    expect(r.intercompany.map((d: { entityCode: string; partyName: string }) => [d.entityCode, d.partyName]).sort()).toEqual([
      ['KE', 'Subsidiary Kenya'],
      ['SUB', 'Parent Kenya'],
    ]);
    expect(r.totals.balanced).toBe(true);
  });
});
