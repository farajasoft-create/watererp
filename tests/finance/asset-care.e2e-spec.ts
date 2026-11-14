import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Asset care: tags (unique, QR labels), custody and condition, donated assets, warranty and insurance
 * with lapse reporting, maintenance linked to supplier bills, and physical verification by scanning.
 */

const PASSWORD = 'Password1234';

describe('Asset care (e2e)', () => {
  let owner: string;
  let ke: string;
  let hq: string;
  let equipment: string;
  let pump: string;
  let laptop: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    del: (url: string) => api().delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  });
  const register = (body: object) => as(owner).post('/assets', { entityId: ke, branchId: hq, categoryId: equipment, acquisitionDate: '2026-01-15', capitalisation: { mode: 'POST', contraAccountId: acc['1120'] }, ...body });
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Asset Care E2E', adminName: 'Owner', email: 'owner@ac.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    equipment = ((await as(owner).get('/asset-categories').expect(200)).body as { id: string; code: string }[]).find((c) => c.code === 'EQUIPMENT')!.id;
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('tags assets uniquely, records details and refuses a donated asset without a donor', async () => {
    const created = await register({
      name: 'Booster pump',
      cost: '450000',
      location: 'Kipsongo booster station',
      tagNumber: 'tw-pmp-001',
      details: { custodian: 'Station attendant', condition: 'NEW', supplierName: 'Davis & Shirtliff', warranty: { provider: 'Davis & Shirtliff', expiresOn: inDays(20), terms: '24 months parts and labour' } },
    }).expect(201);
    pump = created.body.id;
    const detail = (await as(owner).get(`/assets/${pump}`).expect(200)).body.asset;
    expect(detail).toMatchObject({ tagNumber: 'TW-PMP-001', custodian: 'Station attendant', condition: 'NEW', acquisitionType: 'PURCHASED' });
    expect(detail.warranty.terms).toBe('24 months parts and labour');

    // Default tag is the asset number; tags (and numbers) cannot be reused.
    const second = await register({ name: 'Laptop', cost: '90000' }).expect(201);
    laptop = second.body.id;
    expect(second.body.tagNumber).toBe(second.body.number);
    const clash = await register({ name: 'Other pump', cost: '1000', tagNumber: 'TW-PMP-001' }).expect(400);
    expect(clash.body.message).toMatch(/already used by FA-/);
    await as(owner).patch(`/assets/${laptop}`, { tagNumber: 'TW-PMP-001' }).expect(400);

    const donated = await register({ name: 'Water quality kit', cost: '80000', details: { acquisitionType: 'DONATED' } }).expect(400);
    expect(donated.body.message).toMatch(/donor/);
    await register({ name: 'Water quality kit', cost: '80000', details: { acquisitionType: 'DONATED', donor: 'WASREB' } }).expect(201);

    // Partial updates keep the other insurance fields.
    await as(owner).patch(`/assets/${pump}`, { details: { insurance: { insurer: 'APA Insurance', policyNumber: 'APA/ENG/2026/77', sumInsured: '450000', expiresOn: inDays(-3) } } }).expect(200);
    const updated = (await as(owner).patch(`/assets/${pump}`, { details: { insurance: { premium: '9000' } } }).expect(200)).body;
    expect(updated.insurance).toMatchObject({ insurer: 'APA Insurance', policyNumber: 'APA/ENG/2026/77' });
    expect(updated.insurance.premium.toString()).toBe('9000');
  });

  it('logs maintenance against a posted supplier bill, once', async () => {
    const supplier = (await as(owner).post('/suppliers', { code: 'DS', name: 'Davis & Shirtliff', currency: 'KES' }).expect(201)).body.id;
    const bill = (await as(owner).post('/invoices', { entityId: ke, branchId: hq, kind: 'PURCHASE_BILL', partyId: supplier, date: '2026-03-10', supplierInvoiceNumber: 'DS-55', lines: [{ description: 'Pump service', accountId: acc['6700'], quantity: '1', unitPrice: '12000' }] }).expect(201)).body;
    await as(owner).post(`/invoices/${bill.id}/submit`).expect(201);
    // Draft bills cannot be linked.
    await as(owner).post(`/assets/${pump}/maintenance`, { date: '2026-03-10', kind: 'SERVICE', description: 'Seals', cost: '1', invoiceId: bill.id }).expect(400);
    const approver = await approve(bill.id);
    expect(approver).toBe('POSTED');
    await as(owner).post(`/assets/${pump}/maintenance`, { date: '2026-03-10', kind: 'SERVICE', description: 'Too much', cost: '20000', invoiceId: bill.id }).expect(400);
    const logged = (await as(owner).post(`/assets/${pump}/maintenance`, { date: '2026-03-10', kind: 'SERVICE', description: 'Replaced mechanical seal', cost: '12000', invoiceId: bill.id, nextDue: inDays(10) }).expect(201)).body;
    expect(logged.maintenance).toHaveLength(1);
    expect(logged.maintenance[0]).toMatchObject({ vendor: 'Davis & Shirtliff', invoiceNumber: bill.number });
    const again = await as(owner).post(`/assets/${laptop}/maintenance`, { date: '2026-03-10', kind: 'REPAIR', description: 'Screen', cost: '100', invoiceId: bill.id }).expect(400);
    expect(again.body.message).toMatch(/already linked/);
    const inHouse = (await as(owner).post(`/assets/${laptop}/maintenance`, { date: '2026-03-12', kind: 'REPAIR', description: 'Keyboard swapped from spares', cost: '0' }).expect(201)).body;
    await as(owner).del(`/assets/${laptop}/maintenance/${inHouse.maintenance[0].id}`).expect(200);
    expect((await as(owner).get(`/assets/${laptop}`).expect(200)).body.asset.maintenance).toHaveLength(0);
  });

  it('reports lapsing cover and services due, and verifies assets by scanning', async () => {
    const care = (await as(owner).get(`/assets/care?entityId=${ke}&days=30`).expect(200)).body;
    expect(care.insurance.map((x: { tagNumber: string; days: number }) => [x.tagNumber, x.days < 0])).toEqual([['TW-PMP-001', true]]);
    expect(care.warranty.map((x: { tagNumber: string }) => x.tagNumber)).toEqual(['TW-PMP-001']);
    expect(care.serviceDue).toHaveLength(1);
    expect(care.uninsured.map((x: { name: string }) => x.name).sort()).toEqual(['Laptop', 'Water quality kit']);
    expect(care.unverified).toHaveLength(3);
    expect(care.maintenanceCostThisYear.toString()).toBe(new Date().getUTCFullYear() === 2026 ? '12000' : '0');

    const scanned = (await as(owner).get('/assets/by-tag/tw-pmp-001').expect(200)).body;
    expect(scanned.id).toBe(pump);
    await as(owner).get('/assets/by-tag/NOPE-1').expect(404);
    const v = (await as(owner).post('/assets/verify', { tag: 'TW-PMP-001', location: 'Store, head office', condition: 'POOR' }).expect(201)).body;
    expect(v).toMatchObject({ moved: true, previousLocation: 'Kipsongo booster station' });
    expect(v.asset).toMatchObject({ location: 'Store, head office', condition: 'POOR' });
    expect(v.asset.lastVerified.byName).toBe('Owner');
    const after = (await as(owner).get(`/assets/care?entityId=${ke}&days=30`).expect(200)).body;
    expect(after.unverified).toHaveLength(2);

    const labels = await as(owner).get(`/assets/labels?entityId=${ke}`).expect(200);
    expect(labels.headers.get('content-type')).toBe('application/pdf');
    expect(String(labels.body).startsWith('%PDF-')).toBe(true);
    await as(owner).get(`/assets/labels?entityId=${ke}&ids=${laptop}&skip=5`).expect(200);
    await as(owner).get(`/assets/labels?entityId=${ke}&location=nowhere`).expect(400);
  });

  async function approve(billId: string) {
    // The owner prepared the bill; a second user approves it (segregation of duties).
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@ac.test', password: PASSWORD, roleIds: [roles.find((r) => r.name === 'Finance Reviewer')!.id] }).expect(201);
    const token = (await api().post('/api/v1/auth/login').send({ email: 'rev@ac.test', password: PASSWORD }).expect(200)).body.token as string;
    return (await as(token).post(`/invoices/${billId}/approve`, {}).expect(201)).body.status as string;
  }
});
