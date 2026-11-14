import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../../src/modules/finance/core/database/db.service';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for Phase 3: inter-branch balancing, period-end FX revaluation, FX reporting,
 * rate tools and group consolidation with intercompany elimination.
 */

const PASSWORD = 'Password1234';

describe('Multi-branch, FX and consolidation (e2e)', () => {
  let db: Db;
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let ug: string;
  let hq: string;
  let br2: string;
  let kla: string;
  const acc: Record<string, string> = {};
  let kesBank: string;

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  async function postJournal(body: object) {
    const created = await as(preparer).post('/journals', body).expect(201);
    await as(preparer).post(`/journals/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/journals/${created.body.id}/approve`, { post: true }).expect(201)).body;
  }
  async function postDocument(body: object) {
    const created = await as(preparer).post('/invoices', body).expect(201);
    await as(preparer).post(`/invoices/${created.body.id}/submit`).expect(201);
    return (await as(reviewer).post(`/invoices/${created.body.id}/approve`).expect(201)).body;
  }
  const branchNet = async (entityId: string) =>
    db.ledger.aggregate<{ _id: unknown; net: unknown }>([
      { $match: { entityId: new (await import('mongoose')).Types.ObjectId(entityId) } },
      { $group: { _id: '$branchId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
    ]);

  beforeAll(async () => {
    ({ db } = await createTestApp());
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Group E2E', adminName: 'Owner', email: 'owner@group.test', password: PASSWORD, entityCode: 'KE', entityName: 'Group Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    br2 = (await as(owner).post('/branches', { entityId: ke, code: 'BR2', name: 'Branch Two' }).expect(201)).body.id;
    ug = (await as(owner).post('/entities', { code: 'UG', name: 'Group Uganda', country: 'Uganda', functionalCurrency: 'UGX' }).expect(201)).body.id;
    kla = (await as(owner).post('/branches', { entityId: ug, code: 'KLA', name: 'Kampala' }).expect(201)).body.id;
    await as(owner).post('/fiscal-years', { entityId: ug, startDate: '2026-01-01' }).expect(201);
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@group.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@group.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@group.test');
    reviewer = await login('rev@group.test');
    for (const r of [
      { fromCurrency: 'USD', toCurrency: 'KES', rate: '130', effectiveDate: '2026-03-01' },
      { fromCurrency: 'USD', toCurrency: 'KES', rateType: 'CLOSING', rate: '135', effectiveDate: '2026-03-31' },
      { fromCurrency: 'KES', toCurrency: 'UGX', rate: '28', effectiveDate: '2026-01-01' },
    ]) {
      await as(owner).post('/exchange-rates', r).expect(201);
    }
    kesBank = (await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'KES Bank', glAccountId: acc['1120'] }).expect(201)).body.id;
    await as(owner).post('/bank-accounts', { entityId: ke, branchId: hq, name: 'USD Bank', glAccountId: acc['1130'] }).expect(201);
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe('inter-branch accounting', () => {
    it('balances each branch automatically through the clearing account', async () => {
      const j = await postJournal({
        entityId: ke,
        branchId: hq,
        journalDate: '2026-03-05',
        description: 'Head office pays Branch Two rent',
        lines: [
          { accountId: acc['6200'], branchId: br2, debit: '50000' },
          { accountId: acc['1120'], credit: '50000' },
        ],
      });
      const auto = j.lines.filter((l: { autoInterBranch: boolean }) => l.autoInterBranch);
      expect(auto).toHaveLength(2);
      expect(auto.every((l: { accountId: string }) => l.accountId === acc['1500'])).toBe(true);
      expect(j.totalDebit).toBe('50000');
      for (const b of await branchNet(ke)) expect(String(b.net)).toBe('0');
    });

    it('keeps the clearing account system-only', async () => {
      const res = await as(preparer)
        .post('/journals', { entityId: ke, branchId: hq, journalDate: '2026-03-05', description: 'x', lines: [{ accountId: acc['1500'], debit: '1' }, { accountId: acc['1120'], credit: '1' }] })
        .expect(400);
      expect(res.body.message).toMatch(/control account/);
    });

    it('moves a settled receivable to the branch that collected it', async () => {
      const customer = (await as(preparer).post('/customers', { code: 'LOCAL', name: 'Local Customer', currency: 'KES', defaultAccountId: acc['4100'] }).expect(201)).body.id;
      const inv = await postDocument({ entityId: ke, branchId: br2, kind: 'SALES_INVOICE', partyId: customer, date: '2026-03-06', lines: [{ description: 'Goods', quantity: '1', unitPrice: '20000' }] });
      await as(preparer).post('/payments', { entityId: ke, kind: 'RECEIPT', partyId: customer, date: '2026-03-07', bankAccountId: kesBank, amount: '20000', allocations: [{ documentId: inv.id, amount: '20000' }], post: true }).expect(201);
      const ar = await db.ledger.aggregate<{ _id: unknown; net: unknown }>([
        { $match: { accountId: new (await import('mongoose')).Types.ObjectId(acc['1200']) } },
        { $group: { _id: '$branchId', net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
      ]);
      for (const b of ar) expect(String(b.net)).toBe('0');
      for (const b of await branchNet(ke)) expect(String(b.net)).toBe('0');
      const report = await as(owner).get(`/reports/inter-branch?entityId=${ke}&asOf=2026-03-31`).expect(200);
      expect(report.body.net).toBe('0');
      expect(report.body.rows.every((r: { balanced: boolean }) => r.balanced)).toBe(true);
      const br2Row = report.body.rows.find((r: { code: string }) => r.code === 'BR2');
      // Branch Two incurred 50,000 rent paid by HQ (owes HQ) and HQ collected its 20,000 (HQ owes it).
      expect(br2Row.position).toBe('-30000');
    });
  });

  describe('FX revaluation', () => {
    let usdInvoice: string;

    it('previews revaluation of open items and foreign bank balances at closing rates', async () => {
      const usdCustomer = (await as(preparer).post('/customers', { code: 'USDCO', name: 'USD Co', currency: 'USD', defaultAccountId: acc['4100'] }).expect(201)).body.id;
      usdInvoice = (await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: usdCustomer, date: '2026-03-10', lines: [{ description: 'Export', quantity: '1', unitPrice: '1000' }] })).id;
      await postJournal({ entityId: ke, branchId: hq, journalDate: '2026-03-12', description: 'USD deposit', lines: [{ accountId: acc['1130'], debit: '500', currency: 'USD' }, { accountId: acc['3100'], credit: '65000' }] });
      const preview = await as(owner).get(`/fx/revaluations/preview?entityId=${ke}&date=2026-03-31`).expect(200);
      expect(preview.body.rates[0]).toMatchObject({ currency: 'USD', rateType: 'CLOSING' });
      const item = preview.body.lines.find((l: { documentId: string }) => l.documentId === usdInvoice);
      expect(item).toMatchObject({ kind: 'OPEN_ITEM', carrying: '130000', revalued: '135000', difference: '5000' });
      const bank = preview.body.lines.find((l: { kind: string }) => l.kind === 'ACCOUNT');
      expect(bank).toMatchObject({ currency: 'USD', balanceTx: '500', difference: '2500' });
      expect(preview.body.totalGain).toBe('7500');
    });

    it('posts an auto-reversing journal and keeps the subledger reconciled', async () => {
      const run = await as(reviewer).post('/fx/revaluations', { entityId: ke, date: '2026-03-31' }).expect(201);
      expect(run.body.number).toMatch(/^FXR-/);
      const unrealised = async (to: string) => {
        const tb = await as(owner).get(`/reports/trial-balance?entityId=${ke}&from=2026-01-01&to=${to}`).expect(200);
        return tb.body.rows.find((r: { code: string }) => r.code === '4910')?.closingCredit ?? '0';
      };
      expect(await unrealised('2026-03-31')).toBe('7500');
      expect(await unrealised('2026-04-01')).toBe('0');
      const control = await as(owner).get(`/reports/subledger-control?entityId=${ke}`).expect(200);
      for (const c of control.body.checks) expect(c.reconciled).toBe(true);
      await as(reviewer).post('/fx/revaluations', { entityId: ke, date: '2026-03-31' }).expect(400);
      const again = await as(owner).get(`/fx/revaluations/preview?entityId=${ke}&date=2026-03-31`).expect(200);
      expect(again.body.lines).toHaveLength(0);
      await as(preparer).post('/fx/revaluations', { entityId: ke, date: '2026-03-31' }).expect(403);
    });

    it('reports exposure and gains by currency', async () => {
      const exposure = await as(owner).get(`/reports/fx-exposure?entityId=${ke}&asOf=2026-03-31`).expect(200);
      const usd = exposure.body.rows.find((r: { currency: string }) => r.currency === 'USD');
      expect(usd).toMatchObject({ cash: '500', receivables: '1000', net: '1500' });
      const gains = await as(owner).get(`/reports/fx-gains?entityId=${ke}&from=2026-03-01&to=2026-03-31`).expect(200);
      expect(gains.body.totals.unrealised).toBe('7500');
    });
  });

  describe('exchange-rate tools', () => {
    it('imports rates in bulk, skipping duplicates', async () => {
      const body = { source: 'Central bank feed', rates: [{ fromCurrency: 'USD', toCurrency: 'KES', rate: '133', effectiveDate: '2026-04-01' }, { fromCurrency: 'USD', toCurrency: 'KES', rate: '137', effectiveDate: '2026-04-20' }] };
      expect((await as(owner).post('/exchange-rates/import', body).expect(201)).body).toMatchObject({ imported: 2, status: 'APPROVED' });
      expect((await as(owner).post('/exchange-rates/import', body).expect(201)).body.skipped).toBe(2);
    });

    it('derives monthly average and closing rates', async () => {
      const res = await as(owner).post('/exchange-rates/derive', { month: '2026-04', fromCurrency: 'USD', toCurrency: 'KES' }).expect(201);
      expect(res.body).toMatchObject({ average: '135', closing: '137', basedOn: 2 });
    });
  });

  describe('consolidation', () => {
    it('translates entities, eliminates intercompany balances and balances', async () => {
      // Uganda: capital and some revenue.
      await postJournal({ entityId: ug, branchId: kla, journalDate: '2026-03-02', description: 'Capital', lines: [{ accountId: acc['1120'], debit: '28000000' }, { accountId: acc['3100'], credit: '28000000' }] });
      await postJournal({ entityId: ug, branchId: kla, journalDate: '2026-03-20', description: 'Sales', lines: [{ accountId: acc['1120'], debit: '2800000' }, { accountId: acc['4200'], credit: '2800000' }] });
      // Kenya sells KES 100,000 of services to Uganda; Uganda records the bill in KES.
      const icCustomer = (await as(preparer).post('/customers', { code: 'IC-UG', name: 'Group Uganda (IC)', currency: 'KES', intercompanyEntityId: ug, defaultAccountId: acc['4200'] }).expect(201)).body.id;
      const icSupplier = (await as(preparer).post('/suppliers', { code: 'IC-KE', name: 'Group Kenya (IC)', currency: 'KES', intercompanyEntityId: ke, defaultAccountId: acc['6700'] }).expect(201)).body.id;
      await postDocument({ entityId: ke, branchId: hq, kind: 'SALES_INVOICE', partyId: icCustomer, date: '2026-03-25', lines: [{ description: 'Management fee', quantity: '1', unitPrice: '100000' }] });
      await postDocument({ entityId: ug, branchId: kla, kind: 'PURCHASE_BILL', partyId: icSupplier, date: '2026-03-25', supplierInvoiceNumber: 'IC-001', lines: [{ description: 'Management fee', quantity: '1', unitPrice: '100000' }] });

      const res = await as(owner).get('/consolidation?from=2026-01-01&asOf=2026-03-31').expect(200);
      const c = res.body;
      expect(c.reportingCurrency).toBe('KES');
      expect(c.entities.map((e: { code: string }) => e.code)).toEqual(['KE', 'UG']);
      expect(c.missingRates).toEqual([]);
      expect(c.totals.balanced).toBe(true);
      expect(c.totals.intercompanyDifference).toBe('0');
      const mgmt = c.rows.find((r: { code: string }) => r.code === '4200');
      // KE service revenue 100,000 (IC) + UG revenue 2,800,000 UGX ≈ 100,000 KES; the IC part is eliminated.
      expect(mgmt.eliminations).toBe('-100000');
      expect(mgmt.consolidated).toBe('100000');
      expect(c.intercompany.length).toBeGreaterThan(0);
    });

    it('applies group adjustments only after a second person approves them', async () => {
      const adj = await as(preparer)
        .post('/consolidation/adjustments', { date: '2026-03-31', description: 'Group audit fee accrual', lines: [{ accountId: acc['6700'], debit: '25000' }, { accountId: acc['2120'], credit: '25000' }] })
        .expect(201);
      await as(preparer).post(`/consolidation/adjustments/${adj.body.id}/submit`).expect(201);
      await as(preparer).post(`/consolidation/adjustments/${adj.body.id}/approve`).expect(403);
      const before = (await as(owner).get('/consolidation?from=2026-01-01&asOf=2026-03-31').expect(200)).body.totals.netProfit;
      await as(reviewer).post(`/consolidation/adjustments/${adj.body.id}/approve`).expect(201);
      const after = (await as(owner).get('/consolidation?from=2026-01-01&asOf=2026-03-31').expect(200)).body;
      expect(Number(before) - Number(after.totals.netProfit)).toBe(25000);
      expect(after.totals.balanced).toBe(true);
    });
  });
});
