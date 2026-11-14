import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 4: inventory at weighted average cost wired into sales and purchases,
 * stock transfers and adjustments, fixed assets and depreciation, expense claims, budgets with
 * spending control, and project profitability.
 */

const PASSWORD = 'Password1234';

describe('Operational finance (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let br2: string;
  let mainWh: string;
  let wh2: string;
  let bank: string;
  let customer: string;
  let supplier: string;
  let widget: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  async function postDocument(body: object) {
    const created = await as(preparer).post('/invoices', body).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/invoices/${created.body.id}/approve`).expect(201)).body;
  }
  const stock = async () => (await as(owner).get(`/stock?entityId=${ke}`).expect(200)).body;
  const glBalance = async (code: string, to = '2026-12-31') => {
    const tb = await as(owner).get(`/reports/trial-balance?entityId=${ke}&from=2026-01-01&to=${to}`).expect(200);
    const row = tb.body.rows.find((r: { code: string }) => r.code === code);
    return row ? Number(row.closingDebit) - Number(row.closingCredit) : 0;
  };

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Ops E2E', adminName: 'Owner', email: 'owner@ops.test', password: PASSWORD, entityCode: 'KE', entityName: 'Ops Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    br2 = (await as(owner).post('/branches', { entityId: ke, code: 'BR2', name: 'Branch Two' }).expect(201)).body.id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@ops.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@ops.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@ops.test');
    reviewer = await login('rev@ops.test');
    mainWh = (await as(owner).get('/warehouses').expect(200)).body[0].id;
    wh2 = (await as(owner).post('/warehouses', { entityId: ke, branchId: br2, code: 'BR2-STORE', name: 'Branch Two store' }).expect(201)).body.id;
    bank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'Bank', glAccountId: acc['1120'] }).expect(201)).body.id;
    customer = (await as(preparer).post('/customers', { code: 'CUST', name: 'Customer', currency: 'KES' }).expect(201)).body.id;
    supplier = (await as(preparer).post('/suppliers', { code: 'SUPP', name: 'Supplier', currency: 'KES' }).expect(201)).body.id;
    widget = (
      await as(preparer)
        .post('/items', { code: 'WIDGET', name: 'Widget', type: 'STOCK', unit: 'each', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'], salesAccountId: acc['4100'], reorderLevel: '20' })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('inventory', () => {
    let saleId: string;

    it('receives stock on bills at cost and averages it', async () => {
      const bill = (unitPrice: string, ref: string, date: string) => ({
        entityId: ke,
        branchId: hq,
        kind: 'PURCHASE_BILL',
        partyId: supplier,
        date,
        supplierInvoiceNumber: ref,
        lines: [{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '10', unitPrice }],
      });
      await postDocument(bill('100', 'S-1', '2026-02-01'));
      await postDocument(bill('130', 'S-2', '2026-02-10'));
      const s = await stock();
      const row = s.rows.find((r: { code: string }) => r.code === 'WIDGET');
      expect(row).toMatchObject({ quantity: '20', value: '2300', averageCost: '115' });
      expect(s.difference).toBe('0');
    });

    it('issues stock at average cost on sale and books cost of sales', async () => {
      const inv = await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-02-15', lines: [{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '5', unitPrice: '200' }] });
      saleId = inv.id;
      const detail = await as(owner).get(`/invoices/${saleId}`).expect(200);
      expect(detail.body.lines[0].costOfSales).toBe('575');
      expect(await glBalance('5100')).toBe(575);
      expect(await glBalance('1300')).toBe(1725);
    });

    it('refuses to sell more than is on hand', async () => {
      const created = await as(preparer).post('/invoices', { entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-02-16', lines: [{ description: 'Too many', itemId: widget, warehouseId: mainWh, quantity: '100', unitPrice: '200' }] }).expect(201);
      await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
      const res = await as(reviewer).post(`/invoices/${created.body.id}/approve`).expect(400);
      expect(res.body.message).toMatch(/Insufficient stock of WIDGET/);
    });

    it('transfers stock between branches and keeps each branch balanced', async () => {
      const t = await as(preparer).post('/stock/documents', { entityId: ke, kind: 'TRANSFER', date: '2026-02-20', reason: 'Restock Branch Two', warehouseId: mainWh, toWarehouseId: wh2, lines: [{ itemId: widget, quantity: '5' }] }).expect(201);
      await as(preparer).post(`/stock/documents/${t.body.id}/submit`).expect(201);
      await as(preparer).post(`/stock/documents/${t.body.id}/approve`).expect(403);
      const posted = await as(reviewer).post(`/stock/documents/${t.body.id}/approve`).expect(201);
      expect(posted.body.status).toBe('POSTED');
      const s = await stock();
      const row = s.rows.find((r: { code: string }) => r.code === 'WIDGET');
      expect(row.warehouses.find((w: { code: string }) => w.code === 'BR2-STORE')).toMatchObject({ quantity: '5', value: '575' });
      const ib = await as(owner).get(`/reports/inter-branch?entityId=${ke}&asOf=2026-12-31`).expect(200);
      expect(ib.body.rows.every((r: { balanced: boolean }) => r.balanced)).toBe(true);
    });

    it('writes off stock through an approved adjustment', async () => {
      const a = await as(preparer).post('/stock/documents', { entityId: ke, kind: 'ADJUSTMENT', date: '2026-02-21', reason: 'Damaged in store', warehouseId: mainWh, adjustmentAccountId: acc['5100'], lines: [{ itemId: widget, quantity: '-2' }] }).expect(201);
      await as(preparer).post(`/stock/documents/${a.body.id}/submit`).expect(201);
      await as(reviewer).post(`/stock/documents/${a.body.id}/approve`).expect(201);
      const s = await stock();
      expect(s.rows.find((r: { code: string }) => r.code === 'WIDGET')).toMatchObject({ quantity: '13', value: '1495' });
      expect(s.difference).toBe('0');
    });

    it('returns stock when a sale is voided', async () => {
      await as(reviewer).post(`/invoices/${saleId}/void`, { date: '2026-02-25', reason: 'Order cancelled' }).expect(201);
      const s = await stock();
      expect(s.rows.find((r: { code: string }) => r.code === 'WIDGET')).toMatchObject({ quantity: '18', value: '2070' });
      expect(s.difference).toBe('0');
      expect(await glBalance('5100')).toBe(230);
    });
  });

  describe('fixed assets', () => {
    let laptop: string;

    it('capitalises an asset and depreciates it monthly', async () => {
      const categories = (await as(owner).get('/asset-categories').expect(200)).body as { id: string; code: string }[];
      const equipment = categories.find((c) => c.code === 'EQUIPMENT')!.id;
      const asset = await as(preparer)
        .post('/assets', { entityId: ke, branchId: hq, categoryId: equipment, name: 'Laptops', acquisitionDate: '2026-01-15', cost: '36000', capitalisation: { mode: 'POST', contraAccountId: acc['1120'] } })
        .expect(201);
      laptop = asset.body.id;
      expect(asset.body.number).toMatch(/^FA-/);
      expect(await glBalance('1610')).toBe(36000);
      const preview = await as(owner).get(`/depreciation/preview?entityId=${ke}&periodEnd=2026-03-31`).expect(200);
      expect(preview.body.total).toBe('3000');
      await as(preparer).post('/depreciation/runs', { entityId: ke, periodEnd: '2026-03-31' }).expect(403);
      await as(reviewer).post('/depreciation/runs', { entityId: ke, periodEnd: '2026-03-31' }).expect(201);
      await as(reviewer).post('/depreciation/runs', { entityId: ke, periodEnd: '2026-03-31' }).expect(400);
      expect(await glBalance('1620')).toBe(-3000);
      expect(await glBalance('6850')).toBe(3000);
    });

    it('depreciates reducing-balance assets on net book value', async () => {
      const categories = (await as(owner).get('/asset-categories').expect(200)).body as { id: string; code: string }[];
      await as(preparer)
        .post('/assets', { entityId: ke, branchId: hq, categoryId: categories.find((c) => c.code === 'VEHICLES')!.id, name: 'Delivery van', acquisitionDate: '2026-04-02', cost: '100000', capitalisation: { mode: 'POST', contraAccountId: acc['1120'] } })
        .expect(201);
      const preview = await as(owner).get(`/depreciation/preview?entityId=${ke}&periodEnd=2026-04-30`).expect(200);
      const van = preview.body.lines.find((l: { name: string }) => l.name === 'Delivery van');
      expect(van.amount).toBe('2083.33');
    });

    it('requires depreciation to be current, then disposes with a loss', async () => {
      await as(reviewer).post(`/assets/${laptop}/dispose`, { date: '2026-05-10', proceeds: '30000', proceedsAccountId: acc['1120'], reason: 'Sold' }).expect(400);
      await as(reviewer).post(`/assets/${laptop}/dispose`, { date: '2026-04-10', proceeds: '30000', proceedsAccountId: acc['1120'], reason: 'Sold' }).expect(201);
      // NBV 33,000 (36,000 - 3,000) sold for 30,000: a 3,000 loss.
      expect(await glBalance('4800')).toBe(3000);
      const register = await as(owner).get(`/assets?entityId=${ke}&asOf=2026-04-30`).expect(200);
      expect(register.body.rows.find((r: { id: string }) => r.id === laptop)).toMatchObject({ status: 'DISPOSED', netBookValue: '0' });
      expect(register.body.ledger.cost).toBe(register.body.totals.cost);
    });
  });

  describe('expense claims', () => {
    it('flags policy breaches, posts on approval and reimburses', async () => {
      const categories = (await as(preparer).get('/expense-categories').expect(200)).body as { id: string; code: string }[];
      const cat = (c: string) => categories.find((x) => x.code === c)!.id;
      const claim = await as(preparer)
        .post('/expense-claims', {
          entityId: ke,
          branchId: hq,
          title: 'Client visit Mombasa',
          lines: [
            { date: '2026-03-02', categoryId: cat('MEALS'), description: 'Client dinner', amount: '6000' },
            { date: '2026-03-02', categoryId: cat('TRAVEL'), description: 'Train ticket', amount: '2000', receiptReference: 'SGR-1123' },
          ],
        })
        .expect(201);
      expect(claim.body.policyBreaches).toBe(2); // over the meals limit and no receipt
      await as(preparer).post(`/expense-claims/${claim.body.id}/submit`).expect(201);
      await as(preparer).post(`/expense-claims/${claim.body.id}/approve`, {}).expect(403);
      const noReason = await as(reviewer).post(`/expense-claims/${claim.body.id}/approve`, {}).expect(400);
      expect(noReason.body.message).toMatch(/policy exception/);
      await as(reviewer).post(`/expense-claims/${claim.body.id}/approve`, { comment: 'Client hospitality agreed in advance' }).expect(201);
      expect(await glBalance('2170')).toBe(-8000);
      const paid = await as(reviewer).post(`/expense-claims/${claim.body.id}/pay`, { date: '2026-03-05', bankAccountId: bank }).expect(201);
      expect(paid.body.status).toBe('PAID');
      expect(await glBalance('2170')).toBe(0);
    });
  });

  describe('budgets', () => {
    let fiscalYearId: string;

    it('reports budget against actual', async () => {
      fiscalYearId = (await as(owner).get(`/fiscal-years?entityId=${ke}`).expect(200)).body[0].id;
      const months = (v: string) => Array.from({ length: 12 }, () => v);
      const budget = await as(preparer)
        .post('/budgets', { entityId: ke, fiscalYearId, name: 'FY2026 budget', kind: 'BUDGET', lines: [{ accountId: acc['6600'], amounts: months('1000') }, { accountId: acc['5100'], amounts: months('500') }] })
        .expect(201);
      await as(preparer).post(`/budgets/${budget.body.id}/submit`).expect(201);
      await as(preparer).post(`/budgets/${budget.body.id}/approve`).expect(403);
      await as(reviewer).post(`/budgets/${budget.body.id}/approve`).expect(201);
      const report = await as(owner).get(`/reports/budget-vs-actual?entityId=${ke}&from=2026-01-01&to=2026-03-31`).expect(200);
      const cogs = report.body.rows.find((r: { code: string }) => r.code === '5100');
      expect(cogs).toMatchObject({ budget: '1500', actual: '230', variance: '-1270', favourable: true });
    });

    it('blocks purchase orders over budget unless the approver may override', async () => {
      await as(owner).patch('/organisation', { settings: { budgetControl: 'BLOCK' } }).expect(200);
      const po = await as(preparer)
        .post('/purchase-orders', { entityId: ke, branchId: hq, supplierId: supplier, date: '2026-05-01', lines: [{ description: 'Office fit-out', accountId: acc['6600'], quantity: '1', unitPrice: '20000' }] })
        .expect(201);
      await as(preparer).post(`/purchase-orders/${po.body.id}/submit`).expect(201);
      const blocked = await as(reviewer).post(`/purchase-orders/${po.body.id}/approve`).expect(403);
      expect(blocked.body.message).toMatch(/Over budget: 6600/);
      await as(owner).post(`/purchase-orders/${po.body.id}/approve`).expect(201);
    });
  });

  describe('projects', () => {
    it('reports project profitability against contract and budget', async () => {
      const project = await as(owner)
        .post('/dimensions', { type: 'PROJECT', code: 'ROLLOUT', name: 'Store rollout', project: { customerId: customer, contractValue: '500000', budgetCost: '300000' } })
        .expect(201);
      await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-06-01', lines: [{ description: 'Milestone 1', accountId: acc['4200'], quantity: '1', unitPrice: '200000', projectId: project.body.id }] });
      await postDocument({ entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-06-02', supplierInvoiceNumber: 'P-1', lines: [{ description: 'Contractor', accountId: acc['6700'], quantity: '1', unitPrice: '90000', projectId: project.body.id }] });
      const res = await as(owner).get(`/reports/projects?entityId=${ke}&asOf=2026-12-31`).expect(200);
      const row = res.body.rows.find((r: { code: string }) => r.code === 'ROLLOUT');
      expect(row).toMatchObject({ revenue: '200000', cost: '90000', margin: '110000', marginPercent: '55', budgetUsedPercent: '30', billedPercent: '40', customer: 'Customer' });
    });
  });
});
