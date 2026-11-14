import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Stock control: multi-level item categories (filtering includes subcategories), barcodes, the traffic-light
 * stock dashboard, automatic purchase requisitions for items below their re-order level (once while open),
 * and issuing a store requisition by scanning barcodes.
 */

const PASSWORD = 'Password1234';

describe('Stock control (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let main: string;
  let wsv: string;
  const acc: Record<string, string> = {};
  const item: Record<string, string> = {};
  const cat: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Stock E2E', adminName: 'Owner', email: 'owner@sc.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (n: string) => roles.find((r) => r.name === n)!.id;
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@sc.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Rita Reviewer', email: 'rev@sc.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@sc.test');
    reviewer = await login('rev@sc.test');
    main = (await as(owner).get('/warehouses').expect(200)).body[0].id;
    wsv = (await as(owner).post('/dimensions', { type: 'DEPARTMENT', code: 'WSV', name: 'Water services' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('builds a multi-level category tree', async () => {
    cat.chem = (await as(preparer).post('/item-categories', { code: 'CHEM', name: 'Chemicals' }).expect(201)).body.id;
    cat.coag = (await as(preparer).post('/item-categories', { code: 'COAG', name: 'Coagulants', parentId: cat.chem }).expect(201)).body.id;
    cat.disinf = (await as(preparer).post('/item-categories', { code: 'DISINF', name: 'Disinfectants', parentId: cat.chem }).expect(201)).body.id;
    cat.pipes = (await as(preparer).post('/item-categories', { code: 'PIPES', name: 'Pipes and fittings' }).expect(201)).body.id;
    await as(preparer).patch(`/item-categories/${cat.chem}`, { code: 'CHEM', name: 'Chemicals', parentId: cat.coag }).expect(400); // a loop
    const stock = { type: 'STOCK', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'] };
    item.alum = (await as(preparer).post('/items', { ...stock, code: 'ALUM', name: 'Aluminium sulphate', unit: 'bag', categoryId: cat.coag, barcode: '6161100000017', reorderLevel: '100', reorderQty: '300' }).expect(201)).body.id;
    item.hth = (await as(preparer).post('/items', { ...stock, code: 'HTH', name: 'Calcium hypochlorite', unit: 'drum', categoryId: cat.disinf, barcode: '6161100000024', reorderLevel: '10' }).expect(201)).body.id;
    item.pipe = (await as(preparer).post('/items', { ...stock, code: 'PIPE', name: 'HDPE pipe 50mm', unit: 'length', categoryId: cat.pipes, reorderLevel: '20' }).expect(201)).body.id;
    await as(preparer).post('/items', { ...stock, code: 'DUP', name: 'Duplicate', barcode: '6161100000017' }).expect(400);

    const tree = (await as(preparer).get('/item-categories').expect(200)).body as { code: string; path: string; depth: number; itemsBelow: number }[];
    expect(tree.find((c) => c.code === 'COAG')).toMatchObject({ path: 'Chemicals / Coagulants', depth: 1 });
    expect(tree.find((c) => c.code === 'CHEM')?.itemsBelow).toBe(2);
    const chemicals = (await as(preparer).get(`/items?categoryId=${cat.chem}`).expect(200)).body as { code: string; category: string }[];
    expect(chemicals.map((i) => i.code)).toEqual(['ALUM', 'HTH']);
    expect(chemicals[0].category).toBe('Chemicals / Coagulants');
    await as(preparer).patch(`/item-categories/${cat.chem}`, { code: 'CHEM', name: 'Treatment chemicals' }).expect(200);
    expect((await as(preparer).get(`/items/by-code/6161100000017`).expect(200)).body.category).toBe('Treatment chemicals / Coagulants');
  });

  it('shows stock as traffic lights and raises one re-order requisition', async () => {
    const opening = (await as(preparer).post('/stock/documents', { entityId: ke, kind: 'ADJUSTMENT', date: '2026-03-01', reason: 'Opening stock', warehouseId: main, adjustmentAccountId: acc['3300'], lines: [{ itemId: item.alum, quantity: '80', unitCost: '2500' }, { itemId: item.hth, quantity: '4', unitCost: '18000' }, { itemId: item.pipe, quantity: '50', unitCost: '900' }] }).expect(201)).body;
    await as(preparer).post(`/stock/documents/${opening.id}/submit`).expect(201);
    await as(reviewer).post(`/stock/documents/${opening.id}/approve`).expect(201);
    const board = (await as(preparer).get(`/inventory/dashboard?entityId=${ke}`).expect(200)).body;
    expect(board.summary).toMatchObject({ items: 3, red: 1, amber: 1, green: 1 });
    expect(board.rows.map((r: { code: string; light: string }) => `${r.code}:${r.light}`)).toEqual(['HTH:RED', 'ALUM:AMBER', 'PIPE:GREEN']);

    const auto = (await as(preparer).post('/inventory/auto-requisition', { entityId: ke, branchId: hq, date: '2026-03-02' }).expect(201)).body;
    expect(auto.items).toBe(2);
    const req = (await as(preparer).get(`/requisitions/${auto.created.id}`).expect(200)).body;
    expect(req.status).toBe('DRAFT');
    expect(req.lines.map((l: { quantity: string }) => l.quantity)).toEqual(expect.arrayContaining(['300', '16'])); // alum's re-order quantity; HTH back to twice the level
    expect((await as(preparer).post('/inventory/auto-requisition', { entityId: ke, branchId: hq, date: '2026-03-03' }).expect(201)).body.items).toBe(0); // still open
  });

  it('ships procurement roles at view, edit, approve and admin level', async () => {
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const make = async (who: string, name: string) => {
      await as(owner).post('/users', { name: who, email: `${who}@sc.test`, password: PASSWORD, roleIds: [roles.find((r) => r.name === name)!.id] }).expect(201);
      return login(`${who}@sc.test`);
    };
    const viewer = await make('viewer', 'Procurement Viewer');
    const officer = await make('officer', 'Procurement Officer');
    const approver = await make('approver', 'Procurement Approver');
    const body = { entityId: ke, branchId: hq, date: '2026-03-04', description: 'Gate valves', lines: [{ description: 'Gate valve 4"', quantity: '2', estimatedUnitPrice: '15000' }] };
    await as(viewer).get('/requisitions').expect(200);
    await as(viewer).post('/requisitions', body).expect(403);
    await as(approver).post('/requisitions', body).expect(403);
    const r = (await as(officer).post('/requisitions', body).expect(201)).body;
    await as(officer).post(`/requisitions/${r.id}/submit`).expect(201);
    await as(officer).post(`/requisitions/${r.id}/approve`).expect(403);
    expect((await as(approver).post(`/requisitions/${r.id}/approve`).expect(201)).body.status).toBe('APPROVED');
    expect(roles.some((x) => x.name === 'Head of Procurement')).toBe(true);

    // Branch segregation: an officer limited to Kapsabet neither sees nor raises head-office requisitions.
    const kap = (await as(owner).post('/branches', { entityId: ke, code: 'KAP', name: 'Kapsabet' }).expect(201)).body.id;
    await as(owner).post('/users', { name: 'Kap Officer', email: 'kap@sc.test', password: PASSWORD, roleIds: [roles.find((x) => x.name === 'Procurement Officer')!.id], allBranches: false, branchIds: [kap] }).expect(201);
    const kapOfficer = await login('kap@sc.test');
    await as(kapOfficer).post('/requisitions', body).expect(403);
    const mine = (await as(kapOfficer).post('/requisitions', { ...body, branchId: kap }).expect(201)).body;
    const listed = (await as(kapOfficer).get('/requisitions').expect(200)).body;
    const seen = (Array.isArray(listed) ? listed : listed.rows ?? listed.items ?? listed.data) as { id: string }[];
    expect(seen.map((x) => x.id)).toEqual([mine.id]);
    await as(kapOfficer).get(`/requisitions/${r.id}`).expect(404);
  });

  it('values issues by FIFO, LIFO or weighted average as set on the item', async () => {
    const stock = { type: 'STOCK', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'] };
    const made: Record<string, string> = {};
    for (const v of ['FIFO', 'LIFO', 'AVERAGE']) made[v] = (await as(preparer).post('/items', { ...stock, code: `VALVE-${v}`, name: `Gate valve (${v})`, valuation: v }).expect(201)).body.id;
    // Two receipts at different prices: 10 at 100, then 10 at 130.
    for (const [date, cost] of [['2026-03-01', '100'], ['2026-03-05', '130']]) {
      const d = (await as(preparer).post('/stock/documents', { entityId: ke, kind: 'ADJUSTMENT', date, reason: 'Receipt', warehouseId: main, adjustmentAccountId: acc['3300'], lines: Object.values(made).map((itemId) => ({ itemId, quantity: '10', unitCost: cost })) }).expect(201)).body;
      await as(preparer).post(`/stock/documents/${d.id}/submit`).expect(201);
      await as(reviewer).post(`/stock/documents/${d.id}/approve`).expect(201);
    }
    await as(preparer).patch(`/items/${made.FIFO}`, { valuation: 'LIFO' }).expect(400); // stock on hand
    const issued = (await as(owner).post('/store-requisitions/counter-issue', { entityId: ke, date: '2026-03-10', purpose: 'Valve replacement', warehouseId: main, kind: 'ISSUE', departmentId: wsv, collectedBy: 'Plumber', lines: Object.values(made).map((itemId) => ({ itemId, quantity: '15', accountId: acc['6600'] })) }).expect(201)).body;
    const value = (id: string) => issued.lines.find((l: { itemId: string }) => l.itemId === id).value;
    expect(value(made.FIFO)).toBe('1650'); // 10 × 100 + 5 × 130
    expect(value(made.LIFO)).toBe('1800'); // 10 × 130 + 5 × 100
    expect(value(made.AVERAGE)).toBe('1725'); // 15 × 115
  });

  it('issues a store requisition by scanning barcodes', async () => {
    const r = (await as(preparer).post('/store-requisitions', { entityId: ke, date: '2026-03-10', purpose: 'Dosing at Kapsoya works', warehouseId: main, kind: 'ISSUE', departmentId: wsv, lines: [{ itemId: item.alum, quantity: '3', accountId: acc['6600'] }] }).expect(201)).body;
    await as(preparer).post(`/store-requisitions/${r.id}/submit`).expect(201);
    await as(reviewer).post(`/store-requisitions/${r.id}/approve`).expect(201);
    await as(preparer).post(`/store-requisitions/${r.id}/issue-scan`, { date: '2026-03-11', collectedBy: 'Operator', scans: [{ code: '6161100000024' }] }).expect(400); // not on the requisition
    const issued = (await as(preparer).post(`/store-requisitions/${r.id}/issue-scan`, { date: '2026-03-11', collectedBy: 'Operator', scans: [{ code: '6161100000017' }, { code: '6161100000017' }, { code: 'alum' }] }).expect(201)).body;
    expect(issued.lines[0]).toMatchObject({ issued: '3' });
  });
});
