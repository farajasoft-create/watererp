import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, TestApp } from './helpers';

/**
 * Projects & Donors: a donor grant spent through a finance fund, a capital project spent through a
 * finance project dimension, positions read live from the ledger (bank lines ignored), budget lines,
 * receipts, milestones, KPIs, work in progress and capitalisation, drill-through to postings, donor
 * reports, and the donor's read-only portal link.
 */

let app: TestApp;
const ids: Record<string, string> = {};
type Position = Record<string, unknown> & { budget: { code: string; spent: string }[] };

beforeAll(async () => {
  app = await startApp('projects_e2e', {
    modules: ['projects'],
    users: [
      { who: 'pm', access: [{ module: 'projects', role: 'MANAGER' }] },
      { who: 'board', access: [{ module: 'projects', role: 'VIEWER' }] },
    ],
  });
  const db = app.platform.core.db.connection;
  const org = new Types.ObjectId(app.orgId);
  const project = new Types.ObjectId();
  const fund = new Types.ObjectId();
  await db.collection('finance_dimensionvalues').insertMany([
    { _id: project, organisationId: org, type: 'PROJECT', code: 'P-001', name: 'Kapsabet water works' },
    { _id: fund, organisationId: org, type: 'FUND', code: 'WB-01', name: 'World Bank WaSSIP' },
  ]);
  const acc = (code: string, name: string, accountClass: string, accountType: string) => ({ _id: new Types.ObjectId(), organisationId: org, code, name, accountClass, accountType });
  const wip = acc('1500', 'Capital work in progress', 'ASSET', 'FIXED_ASSET');
  const consult = acc('6100', 'Consultancy', 'EXPENSE', 'OPERATING_EXPENSE');
  const bank = acc('1100', 'KCB project account', 'ASSET', 'BANK');
  await db.collection('finance_accounts').insertMany([wip, consult, bank]);
  const d128 = (v: number) => Types.Decimal128.fromString(v.toFixed(2));
  const line = (accountId: Types.ObjectId, accountClass: string, debit: number, credit: number, date: string) => ({ organisationId: org, entityId: new Types.ObjectId(), journalId: new Types.ObjectId(), journalNumber: `JV-${date}`, lineNo: 1, date: new Date(date), periodId: new Types.ObjectId(), accountId, accountClass, branchId: new Types.ObjectId(), projectId: project, fundId: fund, description: 'Works certificate', currency: 'KES', exchangeRate: d128(1), debitTx: d128(debit), creditTx: d128(credit), debit: d128(debit), credit: d128(credit), source: 'MANUAL', postedAt: new Date(date) });
  await db.collection('finance_ledgerentries').insertMany([
    line(wip._id, 'ASSET', 600_000, 0, '2026-08-15'),
    line(consult._id, 'EXPENSE', 100_000, 0, '2026-09-10'),
    line(bank._id, 'ASSET', 0, 700_000, '2026-09-10'),
  ]);
});

afterAll(async () => {
  await app?.stop();
});

describe('projects and donors', () => {
  it('sets up a donor, a grant with budget lines and its receipts', async () => {
    ids.donor = (await app.call<{ id: string }>('pm', 'POST', '/projects/donors', { name: 'World Bank', type: 'MULTILATERAL', email: 'tm@worldbank.test' }, 201)).id;
    await app.call('board', 'POST', '/projects/donors', { name: 'x' }, 403);
    const body = { donorId: ids.donor, code: 'wb-01', title: 'Water and Sanitation Improvement', amount: '1000000', startDate: '2026-07-01', endDate: '2027-06-30', fundCode: 'WB-01', budgetLines: [{ code: 'works', name: 'Civil works', amount: '800000', accountPrefixes: ['15'] }, { code: 'consult', name: 'Supervision consultancy', amount: '300000', accountPrefixes: ['61'] }] };
    await app.call('pm', 'POST', '/projects/grants', body, 400);
    ids.grant = (await app.call<{ id: string }>('pm', 'POST', '/projects/grants', { ...body, budgetLines: [body.budgetLines[0], { ...body.budgetLines[1], amount: '150000' }] }, 201)).id;
    await app.call('pm', 'POST', `/projects/grants/${ids.grant}/disbursements`, { date: '2026-07-20', amount: '500000', reference: 'IDA tranche 1' }, 201);
    await app.call('pm', 'POST', `/projects/grants/${ids.grant}/disbursements`, { date: '2026-08-20', amount: '600000' }, 400);
  });

  it('reads the grant position live from the ledger', async () => {
    const g = await app.call<{ position: Position }>('board', 'GET', `/projects/grants/${ids.grant}`);
    expect(g.position).toMatchObject({ fundLinked: true, amount: '1000000', received: '500000', spent: '700000', cashBalance: '-200000', undrawn: '500000' });
    expect(g.position.budget.map((b) => [b.code, b.spent])).toEqual([['WORKS', '600000'], ['CONSULT', '100000']]);
    const tx = await app.call<{ account: string; amount: string }[]>('board', 'GET', `/projects/grants/${ids.grant}/transactions?line=CONSULT`);
    expect(tx).toEqual([expect.objectContaining({ account: '6100 Consultancy', amount: '100000' })]);
  });

  it('tracks a capital project: spending, progress, KPIs, WIP and capitalisation', async () => {
    const p = await app.call<{ id: string }>('pm', 'POST', '/projects/projects', { code: 'kap-01', name: 'Kapsabet water works rehabilitation', kind: 'CAPEX', financeCode: 'p-001', grantIds: [ids.grant], budget: '900000', startDate: '2026-07-01', endDate: '2027-06-30' }, 201);
    ids.project = p.id;
    await app.call('pm', 'PUT', `/projects/projects/${p.id}/milestones`, { milestones: [{ name: 'Intake and treatment works', weight: 3, percentComplete: 50 }, { name: 'Designs approved', weight: 1, percentComplete: 100 }] });
    const withKpi = await app.call<{ kpis: { id: string }[] }>('pm', 'POST', `/projects/projects/${p.id}/kpis`, { name: 'New connections', unit: 'connections', baseline: 0, target: 400 }, 200);
    await app.call('pm', 'POST', `/projects/projects/${p.id}/kpis/${withKpi.kpis[0].id}/record`, { value: 100, note: 'Q1' }, 200);
    const view = await app.call<{ position: Record<string, unknown> }>('board', 'GET', `/projects/projects/${p.id}`);
    expect(view.position).toMatchObject({ financeLinked: true, spent: '700000', capex: '600000', opex: '100000', wip: '600000', physicalPct: 62.5, kpiAttainmentPct: 25 });
    await app.call('pm', 'POST', `/projects/projects/${p.id}/capitalise`, { date: '2026-10-01', amount: '700000' }, 400);
    const after = await app.call<{ position: Record<string, unknown> }>('pm', 'POST', `/projects/projects/${p.id}/capitalise`, { date: '2026-10-01', amount: '400000', assetRef: 'FA-0101' }, 200);
    expect(after.position).toMatchObject({ capitalised: '400000', wip: '200000' });
  });

  it('reports to the donor and shows the portfolio', async () => {
    const xls = await (await app.raw('board', 'GET', `/projects/grants/${ids.grant}/report/xls`)).text();
    expect(xls.match(/<Worksheet /g)).toHaveLength(5);
    expect(xls).toContain('Civil works');
    expect((await app.raw('board', 'GET', `/projects/grants/${ids.grant}/report/pdf`)).headers.get('content-type')).toContain('pdf');
    const d = await app.call<{ grants: { committed: string; spent: string }; projects: { wip: string }; byDonor: { donor: string; received: string }[] }>('board', 'GET', '/projects/dashboard');
    expect(d.grants).toMatchObject({ committed: '1000000', spent: '700000' });
    expect(d.projects.wip).toBe('200000');
    expect(d.byDonor).toEqual([expect.objectContaining({ donor: 'World Bank', received: '500000' })]);
  });

  it('gives the donor a read-only portal link that can be withdrawn', async () => {
    const link = await app.call<{ path: string }>('pm', 'POST', `/projects/donors/${ids.donor}/portal`, { enable: true }, 200);
    const token = link.path.split('/').pop()!;
    const view = await app.call<{ donor: string; grants: { code: string; tables: { label: string }[] }[] }>('anyone', 'GET', `/projects/donor-portal/${token}`);
    expect(view.donor).toBe('World Bank');
    expect(view.grants.map((g) => g.code)).toEqual(['WB-01']);
    expect(view.grants[0].tables.map((t) => t.label)).toContain('Budget against actual');
    await app.call('pm', 'POST', `/projects/donors/${ids.donor}/portal`, { enable: false }, 200);
    await app.call('anyone', 'GET', `/projects/donor-portal/${token}`, undefined, 404);
  });
});
