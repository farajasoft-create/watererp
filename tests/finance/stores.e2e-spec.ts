import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { dec } from '../../src/modules/finance/core/common/money';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Stores and receiving: department requisitions issued from a store (S11) and counter issues charging
 * the department, branch requisitions dispatched through stock in transit and acknowledged on arrival
 * (shortfall written off), and inspection and acceptance of deliveries before they can be billed.
 *
 * 100 pipes at 50 each are in the main store.
 */

const PASSWORD = 'Password1234';

describe('Stores and inspection (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  const inspector: string[] = [];
  const inspectorId: string[] = [];
  let ke: string;
  let hq: string;
  let main: string;
  let branchStore: string;
  let pipe: string;
  let wsv: string;
  let supplier: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const balance = async (code: string, extra: Record<string, unknown> = {}) => {
    const { db } = await getServices();
    const [row] = await db.ledger.aggregate<{ d: unknown; c: unknown }>([{ $match: { accountId: new Types.ObjectId(acc[code]), ...extra } }, { $group: { _id: null, d: { $sum: '$debit' }, c: { $sum: '$credit' } } }]);
    return row ? dec(row.d as never).minus(dec(row.c as never)).toFixed(2) : '0.00';
  };
  const onHand = async (warehouseId: string) => {
    const { db } = await getServices();
    const b = await db.stockBalances.findOne({ itemId: new Types.ObjectId(pipe), warehouseId: new Types.ObjectId(warehouseId) }).lean();
    return b ? dec(b.quantity).toFixed() : '0';
  };
  const requisition = (extra: object) => ({ entityId: ke, date: '2026-03-10', purpose: 'Repairs on the Kapsabet line', warehouseId: main, ...extra });

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Stores E2E', adminName: 'Owner', email: 'owner@st.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    const br2 = (await as(owner).post('/branches', { entityId: ke, code: 'KAP', name: 'Kapsabet' }).expect(201)).body.id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (n: string) => roles.find((r) => r.name === n)!.id;
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@st.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Rita Reviewer', email: 'rev@st.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@st.test');
    reviewer = await login('rev@st.test');
    for (const [i, name] of ['Ian Inspector', 'Joy Inspector', 'Ken Inspector'].entries()) {
      inspectorId.push((await as(owner).post('/users', { name, email: `i${i}@st.test`, password: PASSWORD, roleIds: [role('Auditor')] }).expect(201)).body.id);
      inspector.push(await login(`i${i}@st.test`));
    }
    main = (await as(owner).get('/warehouses').expect(200)).body[0].id;
    branchStore = (await as(owner).post('/warehouses', { entityId: ke, branchId: br2, code: 'KAP-STORE', name: 'Kapsabet store' }).expect(201)).body.id;
    wsv = (await as(owner).post('/dimensions', { type: 'DEPARTMENT', code: 'WSV', name: 'Water services' }).expect(201)).body.id;
    pipe = (await as(preparer).post('/items', { code: 'PIPE', name: 'HDPE pipe 50mm', type: 'STOCK', unit: 'length', inventoryAccountId: acc['1300'], cogsAccountId: acc['5100'] }).expect(201)).body.id;
    const opening = (await as(preparer).post('/stock/documents', { entityId: ke, kind: 'ADJUSTMENT', date: '2026-03-01', reason: 'Opening stock', warehouseId: main, adjustmentAccountId: acc['3300'], lines: [{ itemId: pipe, quantity: '100', unitCost: '50' }] }).expect(201)).body;
    await as(preparer).post(`/stock/documents/${opening.id}/submit`).expect(201);
    await as(reviewer).post(`/stock/documents/${opening.id}/approve`).expect(201);
    supplier = (await as(preparer).post('/suppliers', { code: 'SUPP', name: 'Supplier', currency: 'KES' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('issues to a department only what its head approved, charging the department', async () => {
    const r = (await as(preparer).post('/store-requisitions', requisition({ kind: 'ISSUE', departmentId: wsv, lines: [{ itemId: pipe, quantity: '30', accountId: acc['6600'] }] })).expect(201)).body;
    expect(r.number).toMatch(/^S11-KE-/);
    await as(preparer).post(`/store-requisitions/${r.id}/submit`).expect(201);
    await as(preparer).post(`/store-requisitions/${r.id}/approve`).expect(403);
    await as(reviewer).post(`/store-requisitions/${r.id}/approve`, { approved: [{ lineNo: 1, quantity: '40' }] }).expect(400);
    await as(reviewer).post(`/store-requisitions/${r.id}/approve`, { approved: [{ lineNo: 1, quantity: '20' }] }).expect(201);
    await as(preparer).post(`/store-requisitions/${r.id}/issue`, { date: '2026-03-11', collectedBy: 'John Kiprop', lines: [{ lineNo: 1, quantity: '25' }] }).expect(400);
    await as(preparer).post(`/store-requisitions/${r.id}/issue`, { date: '2026-03-11', lines: [{ lineNo: 1, quantity: '20' }] }).expect(400);
    const issued = (await as(preparer).post(`/store-requisitions/${r.id}/issue`, { date: '2026-03-11', collectedBy: 'John Kiprop', lines: [{ lineNo: 1, quantity: '20' }] }).expect(201)).body;
    expect(issued).toMatchObject({ status: 'ISSUED', collectedBy: 'John Kiprop' });
    expect(issued.lines[0]).toMatchObject({ requested: '30', approved: '20', issued: '20', value: '1000' });
    expect(await onHand(main)).toBe('80');
    expect(await balance('6600', { departmentId: new Types.ObjectId(wsv) })).toBe('1000.00');
    await as(preparer).get(`/store-requisitions/${r.id}/voucher`).expect(200);

    const counter = (await as(preparer).post('/store-requisitions/counter-issue', requisition({ kind: 'ISSUE', departmentId: wsv, collectedBy: 'Ann Chebet', lines: [{ itemId: pipe, quantity: '5', accountId: acc['6600'] }] })).expect(201)).body;
    expect(counter).toMatchObject({ status: 'ISSUED', counter: true, collectedBy: 'Ann Chebet' });
    expect(await onHand(main)).toBe('75');
    await as(reviewer).post('/store-requisitions/counter-issue', requisition({ kind: 'ISSUE', collectedBy: 'X', lines: [{ itemId: pipe, quantity: '1', accountId: acc['6600'] }] })).expect(403);
  });

  it('dispatches to a branch store through stock in transit and writes off what did not arrive', async () => {
    acc['1310'] = (await as(owner).post('/accounts', { code: '1310', name: 'Stock in transit', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parentId: acc['1100'] }).expect(201)).body.id;
    await as(owner).patch('/organisation', { settings: { stockInTransitAccountId: acc['1310'] } }).expect(200);
    const r = (await as(preparer).post('/store-requisitions', requisition({ kind: 'BRANCH', toWarehouseId: branchStore, lines: [{ itemId: pipe, quantity: '40' }] })).expect(201)).body;
    expect(r.number).toMatch(/^BSV-KE-/);
    await as(preparer).post(`/store-requisitions/${r.id}/submit`).expect(201);
    await as(reviewer).post(`/store-requisitions/${r.id}/approve`).expect(201);
    const sent = (await as(preparer).post(`/store-requisitions/${r.id}/issue`, { date: '2026-03-12', reference: 'Truck KCA 123A', lines: [{ lineNo: 1, quantity: '40' }] }).expect(201)).body;
    expect(sent.status).toBe('DISPATCHED');
    expect(await onHand(main)).toBe('35');
    expect(await onHand(branchStore)).toBe('0');
    expect(await balance('1310')).toBe('2000.00');

    const short = await as(preparer).post(`/store-requisitions/${r.id}/receive`, { date: '2026-03-13', lines: [{ lineNo: 1, quantity: '38' }] }).expect(400);
    expect(short.body.message).toMatch(/shortfall/);
    const got = (await as(preparer).post(`/store-requisitions/${r.id}/receive`, { date: '2026-03-13', notes: 'Two lengths missing', lossAccountId: acc['5100'], lines: [{ lineNo: 1, quantity: '38' }] }).expect(201)).body;
    expect(got.status).toBe('RECEIVED');
    expect(got.lines[0]).toMatchObject({ issued: '40', received: '38' });
    expect(await onHand(branchStore)).toBe('38');
    expect(await balance('1310')).toBe('0.00');
    expect(await balance('5100')).toBe('100.00');
    expect(await balance('1300')).toBe('3650.00'); // 75 − 40 = 35 in main and 38 in Kapsabet, at 50
  });

  it('holds a bill until the inspection committee accepts the delivery, and reverses rejected goods', async () => {
    await as(owner).patch('/organisation', { settings: { requireGoodsInspection: true } }).expect(200);
    const order = async () => {
      const po = (await as(preparer).post('/purchase-orders', { entityId: ke, branchId: hq, supplierId: supplier, date: '2026-03-15', lines: [{ description: 'Valves', accountId: acc['6600'], quantity: '10', unitPrice: '100' }] }).expect(201)).body;
      await as(preparer).post(`/purchase-orders/${po.id}/submit`).expect(201);
      await as(reviewer).post(`/purchase-orders/${po.id}/approve`).expect(201);
      const grn = (await as(preparer).post(`/purchase-orders/${po.id}/receipts`, { date: '2026-03-16', reference: 'DN-55', lines: [{ poLineNo: 1, quantity: '10' }] }).expect(201)).body;
      return { po, grn: grn.id ?? grn.receipt?.id ?? grn.receipts?.at(-1)?.id };
    };
    const { po, grn } = await order();
    const grnId = grn ?? (await as(preparer).get(`/purchase-orders/${po.id}`).expect(200)).body.receipts[0].id;
    const bill = { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-03-17', supplierInvoiceNumber: 'INV-9', purchaseOrderId: po.id, lines: (await as(preparer).get(`/purchase-orders/${po.id}/bill-draft`).expect(200)).body.lines };
    const held = await as(preparer).post('/invoices', bill).expect(400);
    expect(held.body.message).toMatch(/must be inspected and accepted/);

    await as(reviewer).post(`/goods-receipts/${grnId}/inspection-committee`, { memberIds: inspectorId.slice(0, 2) }).expect(400);
    const me = (await as(preparer).get('/auth/me').expect(200)).body;
    await as(reviewer).post(`/goods-receipts/${grnId}/inspection-committee`, { memberIds: [...inspectorId.slice(0, 2), me.user?.id ?? me.id] }).expect(400);
    await as(reviewer).post(`/goods-receipts/${grnId}/inspection-committee`, { memberIds: inspectorId }).expect(201);
    await as(preparer).post(`/goods-receipts/${grnId}/inspection`, { decision: 'ACCEPT' }).expect(403);
    await as(inspector[0]).post(`/goods-receipts/${grnId}/inspection`, { decision: 'REJECT' }).expect(400);
    await as(inspector[0]).post(`/goods-receipts/${grnId}/inspection`, { decision: 'ACCEPT', remarks: 'Matches specification' }).expect(201);
    await as(inspector[0]).post(`/goods-receipts/${grnId}/inspection`, { decision: 'ACCEPT' }).expect(400);
    await as(inspector[1]).post(`/goods-receipts/${grnId}/inspection`, { decision: 'REJECT', remarks: 'Two valves scratched' }).expect(201);
    const done = (await as(inspector[2]).post(`/goods-receipts/${grnId}/inspection`, { decision: 'ACCEPT' }).expect(201)).body;
    expect(done.inspection).toMatchObject({ status: 'ACCEPTED' });
    await as(preparer).get(`/goods-receipts/${grnId}/inspection-certificate`).expect(200);
    await as(preparer).post('/invoices', bill).expect(201);

    // A second delivery the committee rejects is taken back out and the order reopened.
    const second = await order();
    const grn2 = second.grn ?? (await as(preparer).get(`/purchase-orders/${second.po.id}`).expect(200)).body.receipts[0].id;
    await as(reviewer).post(`/goods-receipts/${grn2}/inspection-committee`, { memberIds: inspectorId }).expect(201);
    await as(inspector[0]).post(`/goods-receipts/${grn2}/inspection`, { decision: 'REJECT', remarks: 'Wrong size' }).expect(201);
    await as(inspector[1]).post(`/goods-receipts/${grn2}/inspection`, { decision: 'REJECT', remarks: 'Wrong size' }).expect(201);
    const rejected = (await as(inspector[2]).post(`/goods-receipts/${grn2}/inspection`, { decision: 'ACCEPT' }).expect(201)).body;
    expect(rejected).toMatchObject({ status: 'REVERSED', inspection: { status: 'REJECTED' } });
    expect((await as(preparer).get(`/purchase-orders/${second.po.id}`).expect(200)).body).toMatchObject({ status: 'APPROVED' });
    const pending = (await as(preparer).get(`/inspections?entityId=${ke}&status=REJECTED`).expect(200)).body;
    expect(pending).toHaveLength(1);
  });
});
