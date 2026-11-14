import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServices } from '../../src/modules/finance/core/container';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * Reports read whole months from the monthly totals and only the partial months from the ledger. These
 * tests prove the totals stay exactly equal to the ledger through postings and reversals, and that the
 * reports equal what summing the ledger directly gives, for awkward date ranges and branch filters.
 */

const PASSWORD = 'Password1234';

describe('Monthly totals and reports (e2e)', () => {
  let owner: string;
  let preparer: string;
  let reviewer: string;
  let ke: string;
  let hq: string;
  let br2: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  });
  const login = async (email: string) => (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200)).body.token as string;

  async function post(date: string, branchId: string, debit: string, credit: string, amount: string) {
    const j = await as(preparer).post('/journals', { entityId: ke, branchId, journalDate: date, description: `Test ${date}`, lines: [{ accountId: acc[debit], debit: amount }, { accountId: acc[credit], credit: amount }] }).expect(201);
    await as(preparer).post(`/journals/${j.body.id}/submit`).expect(201);
    const posted = await as(reviewer).post(`/journals/${j.body.id}/approve`, { post: true }).expect(201);
    expect(posted.body.status).toBe('POSTED');
    return j.body.id as string;
  }

  /** What the ledger itself says: net debit per account code over [from, to], optionally for one branch. */
  async function ledger(from: string | null, to: string, branchId?: string) {
    const { db } = await getServices();
    const rows = await db.ledger
      .find({ entityId: ke, date: { ...(from && { $gte: new Date(`${from}T00:00:00Z`) }), $lte: new Date(`${to}T00:00:00Z`) }, ...(branchId && { branchId }) })
      .lean();
    const codes = Object.fromEntries(Object.entries(acc).map(([code, id]) => [id, code]));
    const out: Record<string, { debit: number; credit: number }> = {};
    for (const r of rows) {
      const code = codes[r.accountId.toString()];
      out[code] ??= { debit: 0, credit: 0 };
      out[code].debit += Number(r.debit.toString());
      out[code].credit += Number(r.credit.toString());
    }
    return out;
  }
  const round = (n: number) => Math.round(n * 100) / 100;

  beforeAll(async () => {
    await createTestApp();
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ organisationName: 'Totals E2E', adminName: 'Owner', email: 'owner@totals.test', password: PASSWORD, entityCode: 'KE', entityName: 'Totals Kenya', country: 'Kenya', functionalCurrency: 'KES', fiscalYearStart: '2026-01-01' })
      .expect(201);
    owner = reg.body.token;
    ke = (await as(owner).get('/entities').expect(200)).body[0].id;
    hq = (await as(owner).get('/branches').expect(200)).body[0].id;
    br2 = (await as(owner).post('/branches', { entityId: ke, code: 'BR2', name: 'Branch Two' }).expect(201)).body.id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;
    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@totals.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@totals.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@totals.test');
    reviewer = await login('rev@totals.test');

    // Postings scattered across month starts and ends, both branches, revenue, expenses and balance sheet.
    const plan: [string, string, string, string, string][] = [
      ['2026-01-01', hq, '1120', '3100', '500000'],
      ['2026-01-15', hq, '6200', '1120', '1234.56'],
      ['2026-01-31', br2, '1120', '4100', '9999.99'],
      ['2026-02-01', br2, '6300', '1120', '777.77'],
      ['2026-02-14', hq, '1120', '4100', '25000'],
      ['2026-02-28', hq, '6400', '1120', '3333.33'],
      ['2026-03-01', br2, '1120', '4200', '12000.10'],
      ['2026-03-17', hq, '6500', '1110', '450.45'],
      ['2026-03-31', br2, '6600', '1120', '8100'],
      ['2026-04-10', hq, '1120', '4100', '60000.01'],
      ['2026-05-20', br2, '6200', '1120', '15000'],
      ['2026-06-30', hq, '1110', '1120', '20000'],
    ];
    for (const p of plan) await post(...p);
    // A reversal through a second journal in the same month.
    await post('2026-04-10', hq, '4100', '1120', '1000');
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('keeps the monthly totals exactly equal to the ledger, and a rebuild changes nothing', async () => {
    const { db, warehouse } = await getServices();
    const fromLedger = await db.ledger.aggregate<{ _id: string; debit: unknown; credit: unknown; n: number }>([
      { $match: { entityId: new (await import('mongoose')).Types.ObjectId(ke) } },
      { $group: { _id: { $concat: [{ $dateToString: { date: '$date', format: '%Y-%m' } }, '|', { $toString: '$branchId' }, '|', { $toString: '$accountId' }] }, debit: { $sum: '$debit' }, credit: { $sum: '$credit' }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const facts = async () =>
      (await db.ledgerFacts.find({ entityId: ke }).lean())
        .map((f) => ({ _id: `${f.month.toISOString().slice(0, 7)}|${f.branchId}|${f.accountId}`, debit: f.debit.toString(), credit: f.credit.toString(), n: f.entries }))
        .sort((a, b) => a._id.localeCompare(b._id));
    const expected = fromLedger.map((r) => ({ _id: r._id, debit: String(r.debit), credit: String(r.credit), n: r.n }));
    // Thirteen two-line journals were posted: the comparison is over real data.
    expect(expected.reduce((n, r) => n + r.n, 0)).toBe(26);
    expect(new Set(expected.map((r) => r._id.slice(0, 7))).size).toBe(6);
    expect(await facts()).toEqual(expected);
    await warehouse.rebuild((await db.entities.findById(ke).lean())!.organisationId);
    expect(await facts()).toEqual(expected);
  });

  it('gives the same consolidation from the monthly totals as from the ledger', async () => {
    const { db } = await getServices();
    const organisationId = (await db.entities.findById(ke).lean())!.organisationId;
    const run = async () => (await as(owner).get('/consolidation?from=2026-02-01&asOf=2026-05-17').expect(200)).body;
    const fast = await run();
    expect(await db.warehouseState.exists({ organisationId, live: true })).toBeTruthy();
    await db.warehouseState.updateOne({ organisationId }, { live: false });
    const slow = await run();
    await db.warehouseState.updateOne({ organisationId }, { live: true });
    expect(fast.rows.length).toBeGreaterThan(3);
    expect(fast.rows).toEqual(slow.rows);
    expect(fast.totals).toEqual(slow.totals);
  });

  const ranges: [string, string][] = [
    ['2026-01-01', '2026-06-30'], // whole months only
    ['2026-01-15', '2026-03-17'], // partial at both ends
    ['2026-02-01', '2026-02-28'], // exactly one month
    ['2026-01-31', '2026-02-01'], // two partial days across a boundary
    ['2026-03-17', '2026-03-17'], // a single day
    ['2026-02-02', '2026-06-29'], // inner months with partial edges
  ];

  it.each(ranges)('trial balance %s to %s equals the ledger', async (from, to) => {
    for (const branch of [undefined, br2]) {
      const res = (await as(owner).get(`/reports/trial-balance?entityId=${ke}&from=${from}&to=${to}${branch ? `&branchIds=${branch}` : ''}`).expect(200)).body;
      expect(res.balanced).toBe(true);
      const period = await ledger(from, to, branch);
      if (!branch) expect(Object.keys(period).length).toBeGreaterThan(0);
      const before = await ledger(null, new Date(new Date(`${from}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10), branch);
      for (const row of res.rows as { code: string; openingDebit: string; openingCredit: string; debit: string; credit: string }[]) {
        expect([row.code, round(Number(row.debit))]).toEqual([row.code, round(period[row.code]?.debit ?? 0)]);
        expect([row.code, round(Number(row.credit))]).toEqual([row.code, round(period[row.code]?.credit ?? 0)]);
        const opening = round((before[row.code]?.debit ?? 0) - (before[row.code]?.credit ?? 0));
        expect([row.code, round(Number(row.openingDebit) - Number(row.openingCredit))]).toEqual([row.code, opening]);
      }
      // Every account with movement in the range appears.
      for (const code of Object.keys(period)) expect(res.rows.some((r: { code: string }) => r.code === code)).toBe(true);
    }
  });

  it.each(ranges)('profit and loss %s to %s by branch equals the ledger', async (from, to) => {
    const res = (await as(owner).get(`/reports/profit-and-loss?entityId=${ke}&from=${from}&to=${to}&byBranch=true`).expect(200)).body;
    const income = (rows: Record<string, { debit: number; credit: number }>) => {
      let revenue = 0;
      let costs = 0;
      for (const [code, v] of Object.entries(rows)) {
        if (code.startsWith('4')) revenue += v.credit - v.debit;
        if (code.startsWith('5') || code.startsWith('6')) costs += v.debit - v.credit;
      }
      return round(revenue - costs);
    };
    expect(round(Number(res.totals.netProfit))).toBe(income(await ledger(from, to)));
    for (const branch of [hq, br2]) {
      const column = res.netProfit[branch];
      expect(round(Number(column ?? 0))).toBe(income(await ledger(from, to, branch)));
    }
  });

  it('flags an unusually large manual posting against the account’s history from the monthly totals', async () => {
    // A history of ordinary professional fees, then one outsized and one ordinary posting in July.
    for (const [date, amount] of [
      ['2026-02-03', '950'],
      ['2026-02-20', '1100'],
      ['2026-03-09', '1000'],
      ['2026-04-14', '1050'],
      ['2026-05-05', '980'],
      ['2026-06-11', '1020'],
    ]) {
      await post(date, hq, '6700', '1120', amount);
    }
    const big = await post('2026-07-08', hq, '6700', '1120', '48000');
    const normal = await post('2026-07-09', hq, '6700', '1120', '1030');
    const res = (await as(owner).get(`/analytics/exceptions?entityId=${ke}&from=2026-07-01&to=2026-07-31`).expect(200)).body as { kind: string; link: string; detail: string }[];
    const unusual = res.filter((e) => e.kind === 'unusual_amount');
    expect(unusual.map((e) => e.link)).toEqual([`/finance/journals/${big}`]);
    expect(unusual[0].detail).toMatch(/standard deviations above/);
    // The ordinary one is not unusual (it is only back-dated, being dated in July and posted today).
    expect(unusual.some((e) => e.link === `/journals/${normal}`)).toBe(false);
  });

  it.each(['2026-01-31', '2026-03-17', '2026-06-30', '2026-12-31'])('balance sheet at %s balances and matches the ledger', async (asOf) => {
    const res = (await as(owner).get(`/reports/balance-sheet?entityId=${ke}&asOf=${asOf}`).expect(200)).body;
    expect(res.balanced).toBe(true);
    const all = await ledger(null, asOf);
    const bank = all['1120'] ? round(all['1120'].debit - all['1120'].credit) : 0;
    const line = res.sections[0].lines.find((l: { code: string }) => l.code === '1120');
    expect(round(Number(line?.amount ?? 0))).toBe(bank);
  });
});
