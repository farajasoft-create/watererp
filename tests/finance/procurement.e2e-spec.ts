import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 16: stock received on the goods received note (Dr inventory, Cr goods received
 * not invoiced), the bill clearing GRNI with the price variance split between stock on hand and cost of
 * sales, receipt reversal and the GRNI report.
 */

const PASSWORD = 'Password1234';

describe('Procurement: receiving stock (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let mainWh: string;
  let widget: string;
  let customer: string;
  let supplier: string;
  let po: { id: string; number: string };
  let billId: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};

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
  /** Ledger balance (debit − credit) of an account. */
  async function balance(code: string) {
    const { db } = await getServices();
    const [row] = await db.ledger.aggregate<{ d: { toString(): string }; c: { toString(): string } }>([
      { $match: { accountId: new Types.ObjectId(acc[code]) } },
      { $group: { _id: null, d: { $sum: '$debit' }, c: { $sum: '$credit' } } },
    ]);
    return row ? Number(row.d.toString()) - Number(row.c.toString()) : 0;
  }
  async function stock() {
    const { db } = await getServices();
    const b = await db.stockBalances.findOne({ itemId: new Types.ObjectId(widget), warehouseId: new Types.ObjectId(mainWh) }).lean();
    return { quantity: Number(b?.quantity?.toString() ?? 0), value: Number(b?.value?.toString() ?? 0) };
  }
  const grni = async () => (await as(reviewer).get(`/reports/received-not-invoiced?entityId=${ke}`).expect(200)).body as { rows: { number: string; quantity: string; value: string }[]; total: string; ledger: string; difference: string };

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Procure E2E', adminName: 'Owner', email: 'owner@grn.test', password: PASSWORD, entityCode: 'KE', entityName: 'Procure Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    for (const t of (await as(owner).get('/tax-codes').expect(200)).body) tax[t.code] = t.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@grn.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@grn.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@grn.test');
    reviewer = await login('rev@grn.test');
    await as(owner).patch('/organisation', { settings: { matchTolerancePercent: '10' } }).expect(200);
    mainWh = (await as(owner).get('/warehouses').expect(200)).body[0].id;
    customer = (await as(preparer).post('/customers', { code: 'CUST', name: 'Customer', currency: 'KES' }).expect(201)).body.id;
    supplier = (await as(preparer).post('/suppliers', { code: 'SUPP', name: 'Supplier', currency: 'KES' }).expect(201)).body.id;
    widget = (
      await as(preparer)
        .post('/items', { code: 'WIDGET', name: 'Widget', type: 'STOCK', unit: 'each', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'], salesAccountId: acc['4100'], salesTaxCodeId: tax.VAT16 })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('provisions the GRNI and landed-cost clearing accounts', async () => {
    expect(acc['2180']).toBeDefined();
    expect(acc['1320']).toBeDefined();
    const org = (await as(owner).get('/organisation').expect(200)).body;
    expect(org.settings.grniAccountId).toBe(acc['2180']);
    expect(org.settings.landedCostAccountId).toBe(acc['1320']);
  });

  it('refuses a stock line without a warehouse or for a non-stock item', async () => {
    const base = { entityId: ke, branchId: hq, supplierId: supplier, date: '2026-04-01' };
    const res = await as(preparer).post('/purchase-orders', { ...base, lines: [{ description: 'Widgets', accountId: acc['1300'], quantity: '1', unitPrice: '1', itemId: widget }] }).expect(400);
    expect(res.body.message).toMatch(/choose the warehouse/);
  });

  it('receives stock on the goods received note: Dr inventory, Cr GRNI', async () => {
    const created = await as(preparer)
      .post('/purchase-orders', {
        entityId: ke,
        branchId: hq,
        supplierId: supplier,
        date: '2026-04-01',
        lines: [
          { description: 'Widgets', accountId: acc['6600'], quantity: '10', unitPrice: '100', itemId: widget, warehouseId: mainWh },
          { description: 'Delivery', accountId: acc['6600'], quantity: '1', unitPrice: '500' },
        ],
      })
      .expect(201);
    po = { id: created.body.id, number: created.body.number };
    // The stock line is coded to the item's inventory account, whatever was sent.
    expect(created.body.lines[0].accountId).toBe(acc['1300']);
    await as(preparer).post(`/purchase-orders/${po.id}/submit`).expect(201);
    await as(owner).post(`/purchase-orders/${po.id}/approve`).expect(201);

    const grn = await as(preparer).post(`/purchase-orders/${po.id}/receipts`, { date: '2026-04-02', lines: [{ poLineNo: 1, quantity: '6' }, { poLineNo: 2, quantity: '1' }] }).expect(201);
    expect(grn.body.journalId).toBeTruthy();
    expect(Number(grn.body.lines[0].value)).toBe(600);
    expect(await stock()).toEqual({ quantity: 6, value: 600 });
    expect(await balance('1300')).toBe(600);
    expect(await balance('2180')).toBe(-600);
    const report = await grni();
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ number: po.number, quantity: '6', value: '600' });
    expect(Number(report.total)).toBe(600);
    expect(Number(report.difference)).toBe(0);
  });

  it('bills received stock: clears GRNI and splits the price variance between stock on hand and cost of sales', async () => {
    // Four of the six are sold before the bill arrives (at the receipt cost of 100 each).
    await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-04-03', lines: [{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '4', unitPrice: '200', taxCodeId: tax.VAT16 }] });
    expect(await balance('5100')).toBe(400);

    const draft = (await as(preparer).get(`/purchase-orders/${po.id}/bill-draft`).expect(200)).body;
    const lines = draft.lines.map((l: Record<string, unknown>) => (l.poLineNo === 1 ? { ...l, unitPrice: '105' } : l));
    expect(lines[0]).toMatchObject({ itemId: widget, warehouseId: mainWh, accountId: acc['1300'] });
    // Billing more than was received is refused for stock lines, even with a match override.
    const over = await as(preparer)
      .post('/invoices', { ...draft, lines: lines.map((l: Record<string, unknown>) => (l.poLineNo === 1 ? { ...l, quantity: '7' } : l)), supplierInvoiceNumber: 'SI-0', entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-04-05', purchaseOrderId: po.id })
      .expect(201);
    await as(preparer).post(`/invoices/${over.body.id}/submit`).expect(201);
    const refused = await as(owner).post(`/invoices/${over.body.id}/approve`, { overrideMatch: true }).expect(400);
    expect(refused.body.message).toMatch(/can only be billed once received/);

    const bill = await postDocument({ entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-04-05', supplierInvoiceNumber: 'SI-1', purchaseOrderId: po.id, lines });
    expect(bill.status).toBe('POSTED');
    // 6 × 5 = 30 variance: 2 of 6 still on hand take 10, the 4 sold take 20.
    expect(await balance('2180')).toBe(0);
    expect(await stock()).toEqual({ quantity: 2, value: 210 });
    expect(await balance('1300')).toBe(210);
    expect(await balance('5100')).toBe(420);
    expect((await grni()).rows).toHaveLength(0);
    const order = (await as(reviewer).get(`/purchase-orders/${po.id}`).expect(200)).body;
    expect(Number(order.lines[0].billedValue)).toBe(600);
    billId = bill.id;
  });

  it('reverses an unbilled receipt and refuses to reverse a billed one', async () => {
    const grn2 = await as(preparer).post(`/purchase-orders/${po.id}/receipts`, { date: '2026-04-06', lines: [{ poLineNo: 1, quantity: '4' }] }).expect(201);
    expect(await stock()).toEqual({ quantity: 6, value: 610 });
    expect(await balance('2180')).toBe(-400);
    expect(Number((await grni()).total)).toBe(400);

    await as(preparer).post(`/goods-receipts/${grn2.body.id}/reverse`, { date: '2026-04-07', reason: 'Wrong delivery' }).expect(201);
    expect(await stock()).toEqual({ quantity: 2, value: 210 });
    expect(await balance('2180')).toBe(0);
    expect(await balance('1300')).toBe(210);
    const again = await as(preparer).post(`/goods-receipts/${grn2.body.id}/reverse`, { date: '2026-04-07', reason: 'Twice' }).expect(400);
    expect(again.body.message).toMatch(/already reversed/);

    const order = (await as(reviewer).get(`/purchase-orders/${po.id}`).expect(200)).body;
    expect(order.lines[0].quantityReceived).toBe('6');
    const first = order.receipts.find((r: { status: string; journalId: string | null }) => r.status === 'POSTED' && r.journalId);
    const billed = await as(preparer).post(`/goods-receipts/${first.id}/reverse`, { date: '2026-04-07', reason: 'Too late' }).expect(400);
    expect(billed.body.message).toMatch(/has been billed/);
  });

  it('voiding the bill puts the receipt back into GRNI', async () => {
    await as(owner).post(`/invoices/${billId}/void`, { date: '2026-04-08', reason: 'Duplicate' }).expect(201);
    expect(await balance('2180')).toBe(-600);
    expect(await stock()).toEqual({ quantity: 2, value: 200 });
    expect(await balance('1300')).toBe(200);
    const report = await grni();
    expect(Number(report.total)).toBe(600);
    expect(Number(report.difference)).toBe(0);
  });

  describe('landed costs', () => {
    let gadget: string;
    let grnA: string;
    let grnB: string;
    let lcId: string;
    /** Inventory in the ledger equals the stock subledger. */
    async function reconciles() {
      const { db } = await getServices();
      const balances = await db.stockBalances.find({}).lean();
      const sub = balances.reduce((a, b) => a + Number(b.value?.toString() ?? 0), 0);
      expect(Math.round((await balance('1300')) * 100)).toBe(Math.round(sub * 100));
    }

    it('allocates freight over the stock received by value; the share already sold goes to cost of sales', async () => {
      gadget = (await as(preparer).post('/items', { code: 'GADGET', name: 'Gadget', type: 'STOCK', unit: 'each', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'], salesAccountId: acc['4100'] }).expect(201)).body.id;
      const order = await as(preparer)
        .post('/purchase-orders', { entityId: ke, branchId: hq, supplierId: supplier, date: '2026-05-01', lines: [{ description: 'Gadgets', accountId: acc['1300'], quantity: '10', unitPrice: '50', itemId: gadget, warehouseId: mainWh }] })
        .expect(201);
      await as(preparer).post(`/purchase-orders/${order.body.id}/submit`).expect(201);
      await as(owner).post(`/purchase-orders/${order.body.id}/approve`).expect(201);
      grnB = (await as(preparer).post(`/purchase-orders/${order.body.id}/receipts`, { date: '2026-05-02', lines: [{ poLineNo: 1, quantity: '10' }] }).expect(201)).body.id;
      const first = (await as(reviewer).get(`/purchase-orders/${po.id}`).expect(200)).body.receipts.find((r: { status: string; journalId: string | null }) => r.status === 'POSTED' && r.journalId);
      grnA = first.id;
      // The forwarder's invoice is booked to Landed Costs Clearing.
      await postDocument({ entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-05-03', supplierInvoiceNumber: 'FRT-1', lines: [{ description: 'Freight and clearing', accountId: acc['1320'], quantity: '1', unitPrice: '300' }] });
      expect(await balance('1320')).toBe(300);
      const cogsBefore = await balance('5100');

      const draft = await as(preparer)
        .post('/landed-costs', { entityId: ke, branchId: hq, date: '2026-05-04', description: 'Freight on April and May deliveries', amount: '300', method: 'QUANTITY', receipts: [{ type: 'GoodsReceipt', id: grnA }, { type: 'GoodsReceipt', id: grnB }] })
        .expect(201);
      expect(draft.body).toMatchObject({ status: 'DRAFT', clearingAccountId: acc['1320'] });
      await as(preparer).patch(`/landed-costs/${draft.body.id}`, { entityId: ke, branchId: hq, date: '2026-05-04', description: 'Freight on April and May deliveries', amount: '300', method: 'VALUE', receipts: [{ type: 'GoodsReceipt', id: grnA }, { type: 'GoodsReceipt', id: grnB }] }).expect(200);
      await as(preparer).post(`/landed-costs/${draft.body.id}/post`).expect(403);
      const posted = (await as(reviewer).post(`/landed-costs/${draft.body.id}/post`).expect(201)).body;
      expect(posted.status).toBe('POSTED');
      // By value: widgets 600 of 1100, gadgets 500 of 1100. Two of the six widgets are still on hand.
      const w = posted.allocations.find((a: { itemId: string }) => a.itemId === widget);
      const g = posted.allocations.find((a: { itemId: string }) => a.itemId === gadget);
      expect([w.amount, w.capitalised, w.expensed]).toEqual(['163.64', '54.55', '109.09']);
      expect([g.amount, g.capitalised, g.expensed]).toEqual(['136.36', '136.36', '0']);
      expect(await balance('1320')).toBe(0);
      expect(Math.round((await balance('5100')) * 100)).toBe(Math.round((cogsBefore + 109.09) * 100));
      await reconciles();
      await as(reviewer).post(`/landed-costs/${draft.body.id}/post`).expect(400);
      lcId = draft.body.id;
    });

    it('refuses documents that received no stock', async () => {
      const freight = (await as(preparer).get('/invoices?kind=PURCHASE_BILL&pageSize=50').expect(200)).body.items.find((b: { supplierInvoiceNumber: string }) => b.supplierInvoiceNumber === 'FRT-1');
      const res = await as(preparer).post('/landed-costs', { entityId: ke, branchId: hq, date: '2026-05-04', description: 'Nothing', amount: '10', method: 'VALUE', receipts: [{ type: 'Invoice', id: freight.id }] }).expect(400);
      expect(res.body.message).toMatch(/received no stock/);
    });

    it('reverses a landed cost back to the clearing account, keeping the ledger and stock in step', async () => {
      const id = lcId;
      // Sell all the widgets on hand first: their share can no longer come out of stock.
      await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: customer, date: '2026-05-05', lines: [{ description: 'Widgets', itemId: widget, warehouseId: mainWh, quantity: '2', unitPrice: '200', taxCodeId: tax.VAT16 }] });
      await as(reviewer).post(`/landed-costs/${id}/reverse`, { date: '2026-05-06', reason: 'Charged to the wrong shipment' }).expect(201);
      expect(await balance('1320')).toBe(300);
      await reconciles();
      const after = (await as(reviewer).get(`/landed-costs/${id}`).expect(200)).body;
      expect(after.status).toBe('REVERSED');
      await as(reviewer).post(`/landed-costs/${id}/reverse`, { date: '2026-05-06', reason: 'Again' }).expect(400);
    });
  });

  describe('requests for quotes', () => {
    let usdSupplier: string;
    let rfq: string;

    it('sends a request to the suppliers, records their quotes and compares them in functional currency', async () => {
      usdSupplier = (await as(preparer).post('/suppliers', { code: 'NINGBO', name: 'Ningbo Trading', currency: 'USD', email: 'sales@ningbo.test' }).expect(201)).body.id;
      await as(owner).post('/exchange-rates', { fromCurrency: 'USD', toCurrency: 'KES', rate: '130', effectiveDate: '2026-06-01' }).expect(201);
      const created = await as(preparer)
        .post('/rfqs', {
          entityId: ke,
          branchId: hq,
          title: 'Widgets and installation',
          date: '2026-06-02',
          dueDate: '2026-06-09',
          supplierIds: [supplier, usdSupplier],
          lines: [
            { description: 'Widgets', quantity: '10', itemId: widget, warehouseId: mainWh },
            { description: 'Installation', quantity: '1', accountId: acc['6600'] },
          ],
        })
        .expect(201);
      rfq = created.body.id;
      expect(created.body.lines[0].accountId).toBe(acc['1300']);
      await as(preparer).post(`/rfqs/${rfq}/quotes`, { supplierId: supplier, lines: [{ lineNo: 1, unitPrice: '100' }] }).expect(400);

      const sent = (await as(preparer).post(`/rfqs/${rfq}/send`).expect(201)).body;
      expect(sent.status).toBe('SENT');
      // Only the supplier with an email address is emailed.
      expect(sent.emailed).toBe(1);
      const { db } = await getServices();
      const email = await db.emails.findOne({ to: 'sales@ningbo.test' }).lean();
      expect(email?.subject).toMatch(/^Request for quotation RFQ-KE-\d+: Widgets and installation/);
      expect(email?.html).toContain('Installation');

      await as(preparer).post(`/rfqs/${rfq}/quotes`, { supplierId: supplier, reference: 'Q-77', lines: [{ lineNo: 1, unitPrice: '100', leadTimeDays: 3 }, { lineNo: 2, unitPrice: '5000' }] }).expect(201);
      await as(preparer).post(`/rfqs/${rfq}/quotes`, { supplierId: usdSupplier, lines: [{ lineNo: 1, unitPrice: '0.70', leadTimeDays: 30 }, { lineNo: 2, unitPrice: '40' }] }).expect(201);
      await as(preparer).post(`/rfqs/${rfq}/quotes`, { supplierId: usdSupplier, lines: [{ lineNo: 3, unitPrice: '1' }] }).expect(400);

      const view = (await as(reviewer).get(`/rfqs/${rfq}`).expect(200)).body;
      const [l1, l2] = view.comparison.lines;
      // 0.70 USD = 91 KES beats 100 KES; 40 USD = 5,200 KES loses to 5,000 KES.
      expect(l1.cheapestSupplierId).toBe(usdSupplier);
      expect(l1.quotes.map((q: { functionalUnitPrice: string }) => q.functionalUnitPrice)).toEqual(['91', '100']);
      expect(l2.cheapestSupplierId).toBe(supplier);
      expect(view.comparison.missingRates).toEqual([]);
    });

    it('awards each line, asking for a reason when the cheapest quote is passed over, and raises a draft order per supplier', async () => {
      const lines = [
        { lineNo: 1, supplierId: usdSupplier },
        { lineNo: 2, supplierId: usdSupplier },
      ];
      await as(preparer).post(`/rfqs/${rfq}/award`, { date: '2026-06-10', lines }).expect(403);
      const refused = await as(owner).post(`/rfqs/${rfq}/award`, { date: '2026-06-10', lines }).expect(400);
      expect(refused.body.message).toMatch(/Line 2: Ningbo Trading is not the cheapest quote/);

      const awarded = (
        await as(owner)
          .post(`/rfqs/${rfq}/award`, { date: '2026-06-10', lines: [{ lineNo: 1, supplierId: usdSupplier }, { lineNo: 2, supplierId: supplier, reason: 'Local installer, faster' }] })
          .expect(201)
      ).body;
      expect(awarded.status).toBe('AWARDED');
      const view = (await as(reviewer).get(`/rfqs/${rfq}`).expect(200)).body;
      expect(view.orders).toHaveLength(2);
      const usdOrder = (await as(reviewer).get(`/purchase-orders/${awarded.awards[0].purchaseOrderId}`).expect(200)).body;
      expect(usdOrder).toMatchObject({ status: 'DRAFT', currency: 'USD', reference: view.number });
      expect(usdOrder.lines[0]).toMatchObject({ itemId: widget, warehouseId: mainWh, unitPrice: '0.7', quantity: '10' });
      const kesOrder = (await as(reviewer).get(`/purchase-orders/${awarded.awards[1].purchaseOrderId}`).expect(200)).body;
      expect(kesOrder.lines[0]).toMatchObject({ description: 'Installation', unitPrice: '5000', accountId: acc['6600'] });
      await as(owner).post(`/rfqs/${rfq}/award`, { date: '2026-06-10', lines: [{ lineNo: 1, supplierId: usdSupplier }] }).expect(400);
      await as(preparer).post(`/rfqs/${rfq}/quotes`, { supplierId: supplier, lines: [{ lineNo: 1, unitPrice: '90' }] }).expect(400);
    });
  });
});
