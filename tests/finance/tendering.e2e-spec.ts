import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Tender evaluation by a committee (weighted technical criteria, pass mark, price weighting, ranking,
 * chair's completion, award following the recommendation) and local purchase order amendments
 * (new versions approved by a second person, the LPO printed and emailed to the supplier).
 *
 * Bids for 100 meters: Aqua 1,000 each, Blue 900, Crest 800. Technical (Experience 40 / Capacity 60):
 * Aqua 90, Blue 80, Crest 50 (below the 70 pass mark). With price weighted 30%: Aqua 90×0.7 + 90×0.3
 * = 90; Blue 80×0.7 + 100×0.3 = 86. Aqua ranks first.
 */

const PASSWORD = 'Password1234';

describe('Tendering and LPOs (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  const member: string[] = [];
  const memberId: string[] = [];
  let ke: string;
  let hq: string;
  let rfq: string;
  let po: string;
  const sup: Record<string, string> = {};
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;
  const score = (who: number, supplier: string, experience: number, capacity: number) =>
    as(member[who]).post(`/rfqs/${rfq}/evaluation/scores`, { supplierId: sup[supplier], scores: [{ criterion: 'Experience', score: experience }, { criterion: 'Capacity', score: capacity, comment: 'Site visit done' }] });

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Tender E2E', adminName: 'Owner', email: 'owner@td.test', password: PASSWORD, entityCode: 'KE', entityName: 'Water Co', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (n: string) => roles.find((r) => r.name === n)!.id;
    await as(owner).post('/users', { name: 'Paula Preparer', email: 'prep@td.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Rita Reviewer', email: 'rev@td.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@td.test');
    reviewer = await login('rev@td.test');
    for (const [i, name] of ['Chris Chair', 'Mary Member', 'Sam Secretary'].entries()) {
      memberId.push((await as(owner).post('/users', { name, email: `m${i}@td.test`, password: PASSWORD, roleIds: [role('Auditor')] }).expect(201)).body.id);
      member.push(await login(`m${i}@td.test`));
    }
    for (const [code, name] of [['AQUA', 'Aqua Meters'], ['BLUE', 'Blue Flow'], ['CREST', 'Crest Supplies']]) {
      sup[code] = (await as(preparer).post('/suppliers', { code, name, currency: 'KES', email: `${code.toLowerCase()}@sup.test` }).expect(201)).body.id;
    }
    rfq = (await as(preparer)
      .post('/rfqs', { entityId: ke, branchId: hq, title: 'Supply of water meters', date: '2026-03-01', dueDate: '2026-03-15', supplierIds: Object.values(sup), lines: [{ description: 'Water meters 15mm', quantity: '100', accountId: acc['6600'] }] })
      .expect(201)).body.id;
    await as(preparer).post(`/rfqs/${rfq}/send`).expect(201);
    for (const [code, price] of [['AQUA', '1000'], ['BLUE', '900'], ['CREST', '800']]) await as(preparer).post(`/rfqs/${rfq}/quotes`, { supplierId: sup[code], lines: [{ lineNo: 1, unitPrice: price }] }).expect(201);
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('evaluates bids by committee and awards to the recommended bidder', async () => {
    const committee = (n: number) => ({
      members: memberId.slice(0, n).map((userId, i) => ({ userId, role: i === 0 ? 'CHAIR' : i === 2 ? 'SECRETARY' : 'MEMBER' })),
      criteria: [{ name: 'Experience', weight: 40 }, { name: 'Capacity', weight: 60 }],
      passMark: 70,
      financialWeight: 30,
    });
    await as(owner).post(`/rfqs/${rfq}/committee`, committee(2)).expect(400);
    await as(preparer).post(`/rfqs/${rfq}/committee`, committee(3)).expect(403);
    await as(owner).post(`/rfqs/${rfq}/committee`, { ...committee(3), criteria: [{ name: 'Experience', weight: 50 }] }).expect(400);
    await as(owner).post(`/rfqs/${rfq}/committee`, committee(3)).expect(201);

    await score(0, 'AQUA', 90, 90).expect(400); // still open for quotes
    await as(preparer).post(`/rfqs/${rfq}/close`).expect(201);
    await as(preparer).post(`/rfqs/${rfq}/evaluation/scores`, { supplierId: sup.AQUA, scores: [{ criterion: 'Experience', score: 90 }, { criterion: 'Capacity', score: 90 }] }).expect(403);
    await as(member[0]).post(`/rfqs/${rfq}/evaluation/scores`, { supplierId: sup.AQUA, scores: [{ criterion: 'Experience', score: 90 }] }).expect(400);
    await as(owner).post(`/rfqs/${rfq}/award`, { date: '2026-03-20', lines: [{ lineNo: 1, supplierId: sup.AQUA }] }).expect(400);

    for (const m of [0, 1, 2]) {
      await score(m, 'AQUA', 90, 90).expect(201);
      await score(m, 'BLUE', 80, 80).expect(201);
    }
    await score(0, 'CREST', 50, 50).expect(201);
    await score(1, 'CREST', 50, 50).expect(201);
    const early = await as(member[0]).post(`/rfqs/${rfq}/evaluation/complete`).expect(400);
    expect(early.body.message).toMatch(/Sam Secretary → Crest Supplies/);
    await score(2, 'CREST', 50, 50).expect(201);
    await as(member[1]).post(`/rfqs/${rfq}/evaluation/complete`).expect(403);

    const done = (await as(member[0]).post(`/rfqs/${rfq}/evaluation/complete`, { recommendation: 'Delivery within 30 days.' }).expect(201)).body.evaluation;
    expect(done.status).toBe('COMPLETED');
    const row = (code: string) => done.rows.find((r: { supplierId: string }) => r.supplierId === sup[code]);
    expect(row('AQUA')).toMatchObject({ technical: 90, responsive: true, price: '100000', financial: 90, combined: 90, rank: 1 });
    expect(row('BLUE')).toMatchObject({ technical: 80, price: '90000', financial: 100, combined: 86, rank: 2 });
    expect(row('CREST')).toMatchObject({ technical: 50, responsive: false, rank: null });
    expect(done.recommendedSupplierId).toBe(sup.AQUA);
    expect(done.committee.every((m: { signedAt: string | null }) => m.signedAt)).toBe(true);
    await score(0, 'AQUA', 10, 10).expect(400);

    await as(owner).post(`/rfqs/${rfq}/award`, { date: '2026-03-20', lines: [{ lineNo: 1, supplierId: sup.CREST, reason: 'Cheapest' }] }).expect(400);
    const notRecommended = await as(owner).post(`/rfqs/${rfq}/award`, { date: '2026-03-20', lines: [{ lineNo: 1, supplierId: sup.BLUE }] }).expect(400);
    expect(notRecommended.body.message).toMatch(/not the committee's recommendation/);
    const awarded = (await as(owner).post(`/rfqs/${rfq}/award`, { date: '2026-03-20', lines: [{ lineNo: 1, supplierId: sup.AQUA }] }).expect(201)).body;
    po = awarded.awards[0].purchaseOrderId;
    await as(reviewer).get(`/rfqs/${rfq}/evaluation/report`).expect(200);
  });

  it('amends an approved order as a new version approved by someone else, and sends the LPO', async () => {
    await as(preparer).post(`/purchase-orders/${po}/submit`).expect(201);
    await as(reviewer).post(`/purchase-orders/${po}/approve`).expect(201);
    await as(preparer).post(`/purchase-orders/${po}/receipts`, { date: '2026-03-25', lines: [{ poLineNo: 1, quantity: '40' }] }).expect(201);

    const meters = (qty: string) => ({ description: 'Water meters 15mm', accountId: acc['6600'], quantity: qty, unitPrice: '1000' });
    const below = await as(preparer).post(`/purchase-orders/${po}/amendment`, { reason: 'Fewer meters', lines: [meters('30')] }).expect(400);
    expect(below.body.message).toMatch(/40 has already been received/);
    await as(preparer).post(`/purchase-orders/${po}/amendment`, { reason: 'Drop', lines: [] }).expect(400);
    await as(preparer).post(`/purchase-orders/${po}/amendment`, { reason: 'Extra meters for the new estate', lines: [meters('120'), { description: 'Meter fittings', accountId: acc['6600'], quantity: '10', unitPrice: '200' }] }).expect(201);
    await as(preparer).post(`/purchase-orders/${po}/amendment`, { reason: 'Again', lines: [meters('130')] }).expect(400);
    await as(preparer).post(`/purchase-orders/${po}/amendment/approve`).expect(403);
    const amended = (await as(reviewer).post(`/purchase-orders/${po}/amendment/approve`).expect(201)).body;
    expect(amended).toMatchObject({ version: 2, status: 'PARTIALLY_RECEIVED', total: '122000', amendment: null });
    expect(amended.lines[0]).toMatchObject({ quantity: '120', quantityReceived: '40' });
    expect(amended.revisions[0]).toMatchObject({ version: 1, total: '100000', newTotal: '122000', reason: 'Extra meters for the new estate' });

    await as(preparer).get(`/purchase-orders/${po}/pdf`).expect(200);
    expect((await as(preparer).post(`/purchase-orders/${po}/email`).expect(201)).body).toMatchObject({ sent: true, to: 'aqua@sup.test' });
    const { db } = await getServices();
    const email = await db.emails.findOne({ to: 'aqua@sup.test', subject: /^Purchase order/ }).lean();
    expect(email?.attachments?.[0]?.filename).toMatch(/^LPO PO-KE-\d+ v2\.pdf$/);
  });
});
