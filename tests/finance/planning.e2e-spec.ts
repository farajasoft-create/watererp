import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Planning and public-sector reporting: the annual procurement plan checked against the approved
 * budget and drawn on by requisitions, programme-based budgeting with KPIs, the statement of changes
 * in net assets, and the National Treasury asset register fields.
 */

const PASSWORD = 'Password1234';
const months = (v: string) => Array(12).fill(v);

describe('Planning (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let fy: string;
  let wsv: string;
  let corp: string;
  let pipe: string;
  let plan: string;
  let fittings: string;
  let stationery: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const items = (stationeryCost: string, fittingsId?: string, stationeryId?: string, fittingsCost = '9000') => [
    { id: fittingsId, description: 'Pipe fittings', category: 'GOODS', method: 'OPEN_TENDER', departmentId: wsv, accountId: acc['6600'], quantity: '100', unit: 'pcs', estimatedCost: fittingsCost, quarter: 1, sourceOfFunds: 'Internal revenue', agpo: true },
    { id: stationeryId, description: 'Office stationery', category: 'GOODS', method: 'REQUEST_FOR_QUOTATION', departmentId: corp, accountId: acc['6200'], quantity: '1', unit: 'lot', estimatedCost: stationeryCost, quarter: 2 },
  ];
  const requisition = (lines: object[]) => ({ entityId: ke, branchId: hq, date: '2026-02-01', description: 'Field materials', lines });
  const post = async (lines: object[]) => {
    const j = (await as(preparer).post('/journals', { entityId: ke, branchId: hq, journalDate: '2026-03-15', description: 'Spending', lines }).expect(201)).body;
    await as(preparer).post(`/journals/${j.id}/submit`).expect(201);
    await as(reviewer).post(`/journals/${j.id}/approve`, { post: true }).expect(201);
  };

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Planning E2E', adminName: 'Owner', email: 'owner@pl.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    fy = (await as(owner).get(`/fiscal-years?entityId=${ke}`).expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (n: string) => roles.find((r) => r.name === n)!.id;
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@pl.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Rita Reviewer', email: 'rev@pl.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@pl.test');
    reviewer = await login('rev@pl.test');
    wsv = (await as(owner).post('/dimensions', { type: 'DEPARTMENT', code: 'WSV', name: 'Water services' }).expect(201)).body.id;
    corp = (await as(owner).post('/dimensions', { type: 'DEPARTMENT', code: 'CORP', name: 'Corporate services' }).expect(201)).body.id;
    pipe = (await as(owner).post('/dimensions', { type: 'PROJECT', code: 'PIPE', name: 'Pipeline extension' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('checks the procurement plan against the approved budget before approval', async () => {
    const created = (await as(preparer).post('/procurement-plans', { entityId: ke, fiscalYearId: fy, title: 'FY2026 procurement plan', items: items('7000') }).expect(201)).body;
    plan = created.id;
    expect(created).toMatchObject({ status: 'DRAFT', total: '16000', version: 1 });
    const noBudget = await as(preparer).post(`/procurement-plans/${plan}/submit`).expect(400);
    expect(noBudget.body.message).toMatch(/Approve the budget/);

    const budget = (await as(preparer)
      .post('/budgets', {
        entityId: ke,
        fiscalYearId: fy,
        name: 'FY2026',
        kind: 'BUDGET',
        lines: [
          { accountId: acc['6600'], departmentId: wsv, amounts: months('1000') },
          { accountId: acc['6600'], departmentId: wsv, projectId: pipe, amounts: months('200') },
          { accountId: acc['6200'], departmentId: corp, amounts: months('500') },
        ],
      })
      .expect(201)).body;
    await as(preparer).post(`/budgets/${budget.id}/submit`).expect(201);
    await as(reviewer).post(`/budgets/${budget.id}/approve`).expect(201);

    const over = await as(preparer).post(`/procurement-plans/${plan}/submit`).expect(400);
    expect(over.body.message).toMatch(/6200 planned 7000\.00 against 6000\.00/);
    const draft = (await as(preparer).get(`/procurement-plans/${plan}`).expect(200)).body;
    expect(draft.budgetCheck.ok).toBe(false);
    fittings = draft.items[0].id;
    stationery = draft.items[1].id;

    await as(preparer).patch(`/procurement-plans/${plan}`, { entityId: ke, fiscalYearId: fy, title: 'FY2026 procurement plan', items: items('5000') }).expect(200);
    const fresh = (await as(preparer).get(`/procurement-plans/${plan}`).expect(200)).body;
    fittings = fresh.items[0].id;
    stationery = fresh.items[1].id;
    expect(fresh.budgetCheck.ok).toBe(true);
    await as(preparer).post(`/procurement-plans/${plan}/submit`).expect(201);
    await as(preparer).post(`/procurement-plans/${plan}/approve`).expect(403);
    expect((await as(reviewer).post(`/procurement-plans/${plan}/approve`).expect(201)).body.status).toBe('APPROVED');
  });

  it('lets requisitions draw on plan items only up to what is left', async () => {
    const offered = (await as(preparer).get(`/procurement-plans/items?entityId=${ke}&date=2026-02-01`).expect(200)).body;
    expect(offered.items.map((i: { id: string }) => i.id)).toEqual([fittings, stationery]);

    const r = (await as(preparer).post('/requisitions', requisition([{ description: 'Fittings batch 1', planItemId: fittings, quantity: '10', estimatedUnitPrice: '500' }])).expect(201)).body;
    expect(r.lines[0]).toMatchObject({ accountId: acc['6600'], departmentId: wsv, planItemId: fittings });
    const tooMuch = await as(preparer).post('/requisitions', requisition([{ description: 'Fittings batch 2', planItemId: fittings, quantity: '9', estimatedUnitPrice: '500' }])).expect(201);
    // Drafts do not hold plan room; submitting checks again against what live requisitions use.
    await as(preparer).post(`/requisitions/${r.id}/submit`).expect(201);
    const refused = await as(preparer).post(`/requisitions/${tooMuch.body.id}/submit`).expect(400);
    expect(refused.body.message).toMatch(/has 4000\.00 left of 9000\.00; this request needs 4500\.00/);
    await as(preparer).post('/requisitions', requisition([{ description: 'Wrong account', planItemId: fittings, accountId: acc['6200'], quantity: '1', estimatedUnitPrice: '10' }])).expect(400);

    await as(preparer).post('/requisitions', requisition([{ description: 'Unplanned', accountId: acc['6600'], quantity: '1', estimatedUnitPrice: '10' }])).expect(201);
    await as(owner).patch('/organisation', { settings: { requireProcurementPlan: true } }).expect(200);
    const unplanned = await as(preparer).post('/requisitions', requisition([{ description: 'Unplanned', accountId: acc['6600'], quantity: '1', estimatedUnitPrice: '10' }])).expect(400);
    expect(unplanned.body.message).toMatch(/choose the procurement plan item/);
    await as(owner).patch('/organisation', { settings: { requireProcurementPlan: false } }).expect(200);

    const exec = (await as(preparer).get(`/procurement-plans/${plan}/execution`).expect(200)).body;
    expect(exec.rows[0]).toMatchObject({ planned: '9000', requisitioned: '5000', left: '4000', status: 'IN_PROGRESS' });
    expect(exec.rows[1]).toMatchObject({ planned: '5000', requisitioned: '0' });
    expect(exec.totals).toMatchObject({ planned: '14000', agpo: '9000', agpoPercent: '64.3' });
  });

  it('revises the approved plan keeping requisitions linked to its items', async () => {
    const rev = (await as(preparer).post(`/procurement-plans/${plan}/revise`).expect(201)).body;
    expect(rev).toMatchObject({ version: 2, status: 'DRAFT', revisionOf: plan });
    await as(preparer).post(`/procurement-plans/${plan}/revise`).expect(400);
    await as(preparer).patch(`/procurement-plans/${rev.id}`, { entityId: ke, fiscalYearId: fy, title: 'FY2026 procurement plan (revised)', items: items('5000', fittings, stationery, '11000') }).expect(200);
    await as(preparer).post(`/procurement-plans/${rev.id}/submit`).expect(201);
    await as(reviewer).post(`/procurement-plans/${rev.id}/approve`).expect(201);
    expect((await as(preparer).get(`/procurement-plans/${plan}`).expect(200)).body.status).toBe('SUPERSEDED');
    const exec = (await as(preparer).get(`/procurement-plans/${rev.id}/execution`).expect(200)).body;
    expect(exec.rows[0]).toMatchObject({ id: fittings, planned: '11000', requisitioned: '5000', left: '6000' });
  });

  it('reports budget and spending by programme with KPI achievement', async () => {
    const water = (await as(preparer).post('/programmes', { code: 'p1', name: 'Water services', objective: 'Universal access to safe water' }).expect(201)).body;
    const supply = (await as(preparer)
      .post('/programmes', { code: 'P1-1', name: 'Water supply', parentId: water.id, departmentIds: [wsv], kpis: [{ indicator: 'Households connected', unit: 'households', baseline: '0', target: '500' }] })
      .expect(201)).body;
    await as(preparer).post('/programmes', { code: 'P1-2', name: 'Pipeline extension', parentId: water.id, projectIds: [pipe] }).expect(201);
    await as(preparer).post('/programmes', { code: 'P2', name: 'Administration', departmentIds: [corp] }).expect(201);
    const clash = await as(preparer).post('/programmes', { code: 'P3', name: 'Again', departmentIds: [wsv] }).expect(400);
    expect(clash.body.message).toMatch(/Water services already belongs to P1-1/);
    await as(preparer).post('/programmes', { code: 'P1-1-1', name: 'Too deep', parentId: supply.id }).expect(400);
    await as(preparer).post(`/programmes/${supply.id}/kpis/${supply.kpis[0]._id ?? supply.kpis[0].id}`, { fiscalYearId: fy, quarter: 1, value: '120' }).expect(201);

    await post([
      { accountId: acc['6600'], departmentId: wsv, debit: '3000' },
      { accountId: acc['6600'], departmentId: wsv, projectId: pipe, debit: '1000' },
      { accountId: acc['6200'], departmentId: corp, debit: '800' },
      { accountId: acc['1120'], credit: '4800' },
    ]);
    const report = (await as(preparer).get(`/reports/programmes?entityId=${ke}&fiscalYearId=${fy}`).expect(200)).body;
    const p1 = report.rows.find((r: { code: string }) => r.code === 'P1');
    expect(p1).toMatchObject({ budget: '14400', actual: '4000', balance: '10400', absorptionPercent: '27.8' });
    expect(p1.subProgrammes.map((s: { code: string; budget: string; actual: string }) => [s.code, s.budget, s.actual])).toEqual([
      ['P1-1', '12000', '3000'],
      ['P1-2', '2400', '1000'],
    ]);
    expect(p1.subProgrammes[0].kpis[0]).toMatchObject({ indicator: 'Households connected', target: '500', latest: '120' });
    expect(report.rows.find((r: { code: string }) => r.code === 'P2')).toMatchObject({ budget: '6000', actual: '800' });
    expect(report.totals).toMatchObject({ budget: '20400', actual: '4800' });
  });

  it('shows the statement of changes in net assets agreeing with the balance sheet', async () => {
    await post([
      { accountId: acc['1120'], debit: '50000' },
      { accountId: acc['3100'], credit: '50000' },
    ]);
    const s = (await as(owner).get(`/reports/changes-in-net-assets?entityId=${ke}&from=2026-01-01&to=2026-12-31`).expect(200)).body;
    expect(s.rows.find((r: { code: string }) => r.code === '3100')).toMatchObject({ opening: '0', surplus: '0', otherMovements: '50000', closing: '50000' });
    expect(s.totals).toMatchObject({ opening: '0', surplus: '-4800', otherMovements: '50000', closing: '45200' });
    const bs = (await as(owner).get(`/reports/balance-sheet?entityId=${ke}&asOf=2026-12-31`).expect(200)).body;
    expect(bs.totals.equity).toBe(s.totals.closing);
  });

  it('keeps the National Treasury register fields on assets', async () => {
    const cat = ((await as(owner).get('/asset-categories').expect(200)).body as { id: string; code: string }[]).find((c) => c.code === 'VEHICLES')!;
    const asset = (await as(owner)
      .post('/assets', {
        entityId: ke,
        branchId: hq,
        categoryId: cat.id,
        name: 'Pickup truck',
        acquisitionDate: '2026-01-10',
        cost: '3000000',
        location: 'Head office yard',
        details: { makeModel: 'Toyota Hilux 2.4', pvNumber: 'PV-0042', deliveryDate: '2026-01-08' },
        capitalisation: { mode: 'POST', contraAccountId: acc['1120'] },
      })
      .expect(201)).body;
    const depot = (await as(owner).post('/branches', { entityId: ke, code: 'KAP', name: 'Kapsabet' }).expect(201)).body.id;
    await as(owner).post(`/assets/${asset.id}/transfer`, { date: '2026-02-01', branchId: depot, location: 'Kapsabet depot' }).expect(201);
    const row = (await as(owner).get(`/assets?entityId=${ke}&asOf=2026-12-31`).expect(200)).body.rows.find((r: { id: string }) => r.id === asset.id);
    expect(row).toMatchObject({ makeModel: 'Toyota Hilux 2.4', pvNumber: 'PV-0042', originalLocation: 'Head office yard', location: 'Kapsabet depot' });
    expect(row.deliveryDate.slice(0, 10)).toBe('2026-01-08');
  });
});
