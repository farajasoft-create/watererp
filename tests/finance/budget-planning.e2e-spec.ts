import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Budget preparation and in-year control: department submissions backed by workplans, consolidation
 * into the entity budget, reallocations, supplementary budgets and reductions (which cannot take away
 * money already spent or committed), department balances and the scheduled balance notices.
 */

const PASSWORD = 'Password1234';
const months = (v: string) => Array(12).fill(v);

describe('Budget planning (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let preparerId: string;
  let ke: string;
  let hq: string;
  let fy: string;
  let ops: string;
  let admin: string;
  let budget: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const submission = (departmentId: string, account: string, monthly: string, cost: string) => ({
    entityId: ke,
    fiscalYearId: fy,
    departmentId,
    title: 'FY2026 departmental budget',
    workplan: [{ activity: 'Pipeline maintenance', output: 'Mains repaired', indicator: 'km repaired', target: '40', quarters: [1, 2, 3, 4], cost }],
    lines: [{ accountId: acc[account], amounts: months(monthly) }],
  });
  const change = (kind: string, lines: object[]) => ({ budgetId: budget, date: '2026-04-01', kind, reason: 'Mid-year review', lines });

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Budget E2E', adminName: 'Owner', email: 'owner@bp.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    fy = (await as(owner).get(`/fiscal-years?entityId=${ke}`).expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (n: string) => roles.find((r) => r.name === n)!.id;
    preparerId = (await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@bp.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201)).body.id;
    await as(owner).post('/users', { name: 'Rita Reviewer', email: 'rev@bp.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@bp.test');
    reviewer = await login('rev@bp.test');
    ops = (await as(owner).post('/dimensions', { type: 'DEPARTMENT', code: 'WSV', name: 'Water services', headUserId: preparerId }).expect(201)).body.id;
    admin = (await as(owner).post('/dimensions', { type: 'DEPARTMENT', code: 'CORP', name: 'Corporate services' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('takes department submissions backed by workplans and consolidates the approved ones', async () => {
    const opsSub = (await as(preparer).post('/budget-submissions', submission(ops, '6600', '1000', '10000')).expect(201)).body;
    expect(opsSub).toMatchObject({ status: 'DRAFT', total: '12000' });
    expect(opsSub.number).toMatch(/^BSUB-KE-/);
    const mismatch = await as(preparer).post(`/budget-submissions/${opsSub.id}/submit`).expect(400);
    expect(mismatch.body.message).toMatch(/workplan costs 10000 but the budget lines total 12000/);
    await as(preparer).patch(`/budget-submissions/${opsSub.id}`, submission(ops, '6600', '1000', '12000')).expect(200);
    await as(preparer).post(`/budget-submissions/${opsSub.id}/submit`).expect(201);
    await as(preparer).post(`/budget-submissions/${opsSub.id}/approve`).expect(403);
    await as(reviewer).post(`/budget-submissions/${opsSub.id}/reject`).expect(400);
    await as(reviewer).post(`/budget-submissions/${opsSub.id}/reject`, { reason: 'Split by quarter' }).expect(201);
    await as(preparer).post(`/budget-submissions/${opsSub.id}/submit`).expect(201);
    expect((await as(reviewer).post(`/budget-submissions/${opsSub.id}/approve`).expect(201)).body.status).toBe('APPROVED');

    const admSub = (await as(preparer).post('/budget-submissions', submission(admin, '6200', '500', '6000')).expect(201)).body;
    await as(preparer).post(`/budget-submissions/${admSub.id}/submit`).expect(201);
    await as(reviewer).post(`/budget-submissions/${admSub.id}/approve`).expect(201);

    const status = (await as(preparer).get(`/budget-submissions/consolidation?entityId=${ke}&fiscalYearId=${fy}`).expect(200)).body;
    expect(status).toMatchObject({ readyToConsolidate: 2, approvedTotal: '18000' });
    expect(status.rows.find((r: { code: string }) => r.code === 'WSV').latest.status).toBe('APPROVED');

    const consolidated = (await as(preparer).post('/budget-submissions/consolidate', { entityId: ke, fiscalYearId: fy, name: 'FY2026 approved estimates' }).expect(201)).body;
    budget = consolidated.id;
    expect(consolidated).toMatchObject({ status: 'DRAFT', total: '18000' });
    expect(consolidated.lines.map((l: { departmentId: string }) => l.departmentId).sort()).toEqual([admin, ops].sort());
    expect((await as(preparer).get(`/budget-submissions/${opsSub.id}`).expect(200)).body).toMatchObject({ status: 'CONSOLIDATED', budgetId: budget });
    await as(preparer).post('/budget-submissions/consolidate', { entityId: ke, fiscalYearId: fy, name: 'Again' }).expect(400);

    await as(preparer).post(`/budgets/${budget}/submit`).expect(201);
    await as(reviewer).post(`/budgets/${budget}/approve`).expect(201);
    const template = (await as(preparer).get(`/budget-submissions/template?entityId=${ke}&fiscalYearId=${fy}&departmentId=${ops}`).expect(200)).body;
    expect(template.lines).toHaveLength(1);
    expect(template.lines[0]).toMatchObject({ accountId: acc['6600'], amounts: months('1000') });
  });

  it('reallocates, adds and reduces budget through approved changes, never below what is spent', async () => {
    const unbalanced = await as(preparer)
      .post('/budget-changes', change('REALLOCATION', [{ accountId: acc['6600'], departmentId: ops, period: 0, change: '-300' }, { accountId: acc['6200'], departmentId: admin, period: 0, change: '200' }]))
      .expect(400);
    expect(unbalanced.body.message).toMatch(/net to zero/);
    await as(preparer).post('/budget-changes', change('SUPPLEMENTARY', [{ accountId: acc['6600'], departmentId: ops, period: 0, change: '-1' }])).expect(400);

    const move = (await as(preparer)
      .post('/budget-changes', change('REALLOCATION', [{ accountId: acc['6600'], departmentId: ops, period: 0, change: '-300' }, { accountId: acc['6200'], departmentId: admin, period: 0, change: '300' }]))
      .expect(201)).body;
    expect(move).toMatchObject({ increase: '300', decrease: '300', status: 'DRAFT' });
    await as(preparer).post(`/budget-changes/${move.id}/submit`).expect(201);
    await as(preparer).post(`/budget-changes/${move.id}/approve`).expect(403);
    await as(reviewer).post(`/budget-changes/${move.id}/approve`).expect(201);

    let b = (await as(owner).get(`/budgets/${budget}`).expect(200)).body;
    expect(b).toMatchObject({ total: '18000', revisions: 1 });
    expect(b.original.total).toBe('18000');
    expect(b.lines.find((l: { departmentId: string }) => l.departmentId === ops).amounts[0]).toBe('700');
    expect(b.original.lines.find((l: { departmentId: string }) => l.departmentId === ops).amounts[0]).toBe('1000');

    // Operations spends 11,500 by March.
    const j = (await as(preparer)
      .post('/journals', { entityId: ke, branchId: hq, journalDate: '2026-03-15', description: 'Pipeline repairs', lines: [{ accountId: acc['6600'], departmentId: ops, debit: '11500' }, { accountId: acc['1120'], credit: '11500' }] })
      .expect(201)).body;
    await as(preparer).post(`/journals/${j.id}/submit`).expect(201);
    await as(reviewer).post(`/journals/${j.id}/approve`, { post: true }).expect(201);

    // 12,000 - 300 = 11,700 left; taking 500 more would leave 11,200 against 11,500 spent.
    const cut = (await as(preparer).post('/budget-changes', change('REDUCTION', [{ accountId: acc['6600'], departmentId: ops, period: 11, change: '-500' }])).expect(201)).body;
    await as(preparer).post(`/budget-changes/${cut.id}/submit`).expect(201);
    const refused = await as(reviewer).post(`/budget-changes/${cut.id}/approve`).expect(400);
    expect(refused.body.message).toMatch(/11500\.00 is already spent or committed/);
    await as(preparer).post(`/budget-changes/${cut.id}/cancel`).expect(201);

    const extra = (await as(preparer).post('/budget-changes', change('SUPPLEMENTARY', [{ accountId: acc['6600'], departmentId: ops, period: 11, change: '2000' }])).expect(201)).body;
    await as(preparer).post(`/budget-changes/${extra.id}/submit`).expect(201);
    await as(reviewer).post(`/budget-changes/${extra.id}/approve`).expect(201);
    b = (await as(owner).get(`/budgets/${budget}`).expect(200)).body;
    expect(b).toMatchObject({ total: '20000', revisions: 2 });
    expect(b.original.total).toBe('18000');

    const report = (await as(owner).get(`/reports/budget-vs-actual?entityId=${ke}&from=2026-01-01&to=2026-12-31`).expect(200)).body;
    expect(report.rows.find((r: { code: string }) => r.code === '6600')).toMatchObject({ originalBudget: '12000', budget: '13700', actual: '11500' });

    const notices = (await as(preparer).get('/notifications').expect(200)).body.items as { kind: string; title: string }[];
    expect(notices.filter((n) => n.kind === 'budget-change')).toHaveLength(2);
  });

  it('shows department balances and tells the head once when a line passes the alert level', async () => {
    const report = (await as(preparer).get(`/budget-balances?entityId=${ke}&asOf=2026-03-31`).expect(200)).body;
    const row = report.rows.find((r: { code: string }) => r.code === '6600');
    expect(row).toMatchObject({ department: 'WSV · Water services', annual: '13700', toDate: '2700', spent: '11500', committed: '0', available: '2200', usedPercent: '83.9' });
    expect(report.departments.find((d: { department: string }) => d.department === 'CORP · Corporate services')).toMatchObject({ annual: '6300', spent: '0' });

    const { budgetPlanning } = await getServices();
    expect(await budgetPlanning.notifyBalances(new Date('2026-03-31T12:00:00Z'))).toEqual({ sent: 0 }); // alerts are off by default
    await as(owner).patch('/organisation', { settings: { budgetAlertPercent: 80 } }).expect(200);
    expect(await budgetPlanning.notifyBalances(new Date('2026-03-31T12:00:00Z'))).toEqual({ sent: 1 });
    expect(await budgetPlanning.notifyBalances(new Date('2026-03-31T12:00:00Z'))).toEqual({ sent: 0 });
    const notices = (await as(preparer).get('/notifications').expect(200)).body.items as { kind: string; title: string }[];
    expect(notices.find((n) => n.kind === 'budget-balance')?.title).toBe('Budget 80% used: WSV · Water services, 6600 ' + row.name);
  });
});
