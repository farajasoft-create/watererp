import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../../src/modules/finance/core/database/db.service';
import { api, closeTestApp, createTestApp } from './harness';

/**
 * End-to-end tests for the financial core's controls. They run against a throwaway database
 * (MONGODB_URI_TEST, default farajasoft_e2e on the local replica set; see vitest.config.ts) that is dropped first.
 */

const PASSWORD = 'Password1234';

describe('Financial core (e2e)', () => {
  let db: Db;
  let owner: string; // Administrator + Finance Director
  let preparer: string; // Accountant
  let reviewer: string; // Finance Reviewer
  let entityId: string;
  let hqId: string;
  let branch2Id: string;
  const acc: Record<string, string> = {};

  const as = (token: string) => ({
    get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body?: object) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function login(email: string) {
    const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    return res.body.token as string;
  }

  const journal = (overrides: Record<string, unknown> = {}, lines?: object[]) => ({
    entityId,
    branchId: hqId,
    journalDate: '2026-03-15',
    description: 'Test journal',
    lines: lines ?? [
      { accountId: acc['6200'], debit: '1000.00' },
      { accountId: acc['1120'], credit: '1000.00' },
    ],
    ...overrides,
  });

  /** Creates, submits, approves and posts a journal; returns its id. */
  async function postJournal(body: object) {
    const created = await as(preparer).post('/journals', body).expect(201);
    await as(preparer).post(`/journals/${created.body.id}/submit`).expect(201);
    await as(reviewer).post(`/journals/${created.body.id}/approve`, { post: true }).expect(201);
    return created.body.id as string;
  }

  beforeAll(async () => {
    ({ db } = await createTestApp());

    const reg = await api()
      .post('/api/v1/auth/register')
      .send({
        organisationName: 'E2E Holdings',
        adminName: 'Owner',
        email: 'owner@e2e.test',
        password: PASSWORD,
        entityCode: 'KE',
        entityName: 'E2E Kenya',
        functionalCurrency: 'KES',
        fiscalYearStart: '2026-01-01',
      })
      .expect(201);
    owner = reg.body.token;

    const entities = await as(owner).get('/entities').expect(200);
    entityId = entities.body[0].id;
    hqId = (await as(owner).get('/branches').expect(200)).body[0].id;
    branch2Id = (await as(owner).post('/branches', { entityId, code: 'BR2', name: 'Branch Two' }).expect(201)).body.id;
    for (const a of (await as(owner).get('/accounts').expect(200)).body) acc[a.code] = a.id;

    const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
    const role = (name: string) => roles.find((r) => r.name === name)!.id;
    await as(owner).post('/users', { name: 'Preparer', email: 'prep@e2e.test', password: PASSWORD, roleIds: [role('Accountant')] }).expect(201);
    await as(owner).post('/users', { name: 'Reviewer', email: 'rev@e2e.test', password: PASSWORD, roleIds: [role('Finance Reviewer')] }).expect(201);
    preparer = await login('prep@e2e.test');
    reviewer = await login('rev@e2e.test');
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it('rejects unauthenticated requests', async () => {
    await api().get('/api/v1/journals').expect(401);
  });

  describe('validation', () => {
    it('rejects an unbalanced journal', async () => {
      const res = await as(preparer)
        .post('/journals', journal({}, [{ accountId: acc['6200'], debit: '100' }, { accountId: acc['1120'], credit: '99.99' }]))
        .expect(400);
      expect(res.body.message).toMatch(/does not balance/);
    });

    it('rejects postings to header accounts', async () => {
      const res = await as(preparer)
        .post('/journals', journal({}, [{ accountId: acc['6000'], debit: '100' }, { accountId: acc['1120'], credit: '100' }]))
        .expect(400);
      expect(res.body.message).toMatch(/header account/);
    });

    it('rejects manual postings to control accounts', async () => {
      const res = await as(preparer)
        .post('/journals', journal({}, [{ accountId: acc['1200'], debit: '100' }, { accountId: acc['4100'], credit: '100' }]))
        .expect(400);
      expect(res.body.message).toMatch(/control account/);
    });

    it('enforces required dimensions', async () => {
      const res = await as(preparer)
        .post('/journals', journal({}, [{ accountId: acc['6100'], debit: '100' }, { accountId: acc['1120'], credit: '100' }]))
        .expect(400);
      expect(res.body.message).toMatch(/requires a department/);
    });

    it('rejects a line that has both a debit and a credit', async () => {
      await as(preparer)
        .post('/journals', journal({}, [{ accountId: acc['6200'], debit: '100', credit: '100' }, { accountId: acc['1120'], credit: '0' }]))
        .expect(400);
    });

    it('rejects dates with no accounting period', async () => {
      const res = await as(preparer).post('/journals', journal({ journalDate: '2025-06-01' })).expect(400);
      expect(res.body.message).toMatch(/No accounting period/);
    });
  });

  describe('maker-checker workflow', () => {
    it('prevents the preparer from approving their own journal', async () => {
      const ownerJournal = await as(owner).post('/journals', journal()).expect(201);
      await as(owner).post(`/journals/${ownerJournal.body.id}/submit`).expect(201);
      const res = await as(owner).post(`/journals/${ownerJournal.body.id}/approve`).expect(403);
      expect(res.body.message).toMatch(/Segregation of duties/);
    });

    it('requires approval before posting', async () => {
      const created = await as(preparer).post('/journals', journal()).expect(201);
      await as(reviewer).post(`/journals/${created.body.id}/post`).expect(400);
    });

    it('denies approval to users without the permission', async () => {
      const created = await as(owner).post('/journals', journal()).expect(201);
      await as(owner).post(`/journals/${created.body.id}/submit`).expect(201);
      await as(preparer).post(`/journals/${created.body.id}/approve`).expect(403);
    });

    it('posts an approved journal to the ledger exactly once', async () => {
      const id = await postJournal(journal({ description: 'Rent' }));
      const posted = await as(owner).get(`/journals/${id}`).expect(200);
      expect(posted.body.status).toBe('POSTED');
      expect(posted.body.approvedByName).toBe('Reviewer');
      expect(await db.ledger.countDocuments({ journalId: id })).toBe(2);
      await as(reviewer).post(`/journals/${id}/post`).expect(400);
      expect(await db.ledger.countDocuments({ journalId: id })).toBe(2);
    });

    it('locks posted journals against editing and deletion', async () => {
      const id = await postJournal(journal());
      await as(preparer).patch(`/journals/${id}`, journal()).expect(400);
      await api().delete(`/api/v1/journals/${id}`).set('Authorization', `Bearer ${preparer}`).expect(400);
    });

    it('lets concurrent post requests succeed only once', async () => {
      const created = await as(preparer).post('/journals', journal()).expect(201);
      await as(preparer).post(`/journals/${created.body.id}/submit`).expect(201);
      await as(reviewer).post(`/journals/${created.body.id}/approve`).expect(201);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => as(reviewer).post(`/journals/${created.body.id}/post`)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await db.ledger.countDocuments({ journalId: created.body.id })).toBe(2);
    });

    it('returns the same journal for a repeated Idempotency-Key', async () => {
      const send = () =>
        api().post('/api/v1/journals').set('Authorization', `Bearer ${preparer}`).set('Idempotency-Key', 'abc-123').send(journal());
      const first = await send().expect(201);
      const second = await send().expect(201);
      expect(second.body.id).toBe(first.body.id);
      expect(first.body.source).toBe('API');
    });
  });

  describe('multi-currency', () => {
    it('fails without an approved rate, then translates at the latest approved rate', async () => {
      const usdLines = [
        { accountId: acc['1130'], debit: '100.00', currency: 'USD' },
        { accountId: acc['4100'], credit: '100.00', currency: 'USD' },
      ];
      const missing = await as(preparer).post('/journals', journal({}, usdLines)).expect(400);
      expect(missing.body.message).toMatch(/no approved USD\/KES rate/);

      // Captured by the preparer → pending; approved by the reviewer.
      const rate = await as(preparer)
        .post('/exchange-rates', { fromCurrency: 'USD', toCurrency: 'KES', rate: '129.3456', effectiveDate: '2026-03-01' })
        .expect(201);
      expect(rate.body.status).toBe('PENDING');
      await as(preparer).post('/journals', journal({}, usdLines)).expect(400);
      await as(reviewer).post(`/exchange-rates/${rate.body.id}/approve`).expect(201);

      const created = await as(preparer).post('/journals', journal({}, usdLines)).expect(201);
      expect(created.body.lines[0]).toMatchObject({ currency: 'USD', debitTx: '100', exchangeRate: '129.3456', debit: '12934.56' });
      expect(created.body.totalDebit).toBe('12934.56');
    });

    it('uses the inverse quote when only the opposite direction exists', async () => {
      await as(owner)
        .post('/exchange-rates', { fromCurrency: 'KES', toCurrency: 'EUR', rate: '0.0071', effectiveDate: '2026-03-01' })
        .expect(201);
      const res = await as(owner).get('/exchange-rates/lookup?from=EUR&to=KES&date=2026-03-10').expect(200);
      expect(res.body.inverted).toBe(true);
      expect(Number(res.body.rate)).toBeCloseTo(140.8450704225, 8);
    });

    it('rejects foreign-currency lines on accounts pinned to another currency', async () => {
      const res = await as(preparer)
        .post('/journals', journal({}, [{ accountId: acc['1130'], debit: '100', currency: 'KES' }, { accountId: acc['4100'], credit: '100' }]))
        .expect(400);
      expect(res.body.message).toMatch(/only accepts USD/);
    });
  });

  describe('period controls', () => {
    it('blocks posting into a hard-closed period and requires a reason to reopen', async () => {
      const years = (await as(owner).get(`/fiscal-years?entityId=${entityId}`).expect(200)).body;
      const jan = years[0].periods[0];
      const created = await as(preparer).post('/journals', journal({ journalDate: '2026-01-20' })).expect(201);
      await as(preparer).post(`/journals/${created.body.id}/submit`).expect(201);
      await as(reviewer).post(`/journals/${created.body.id}/approve`).expect(201);

      // Cannot close while journals are awaiting posting.
      await as(owner).post(`/periods/${jan.id}/status`, { status: 'HARD_CLOSED' }).expect(400);
      await as(reviewer).post(`/journals/${created.body.id}/reject`, { reason: 'Wrong period' }).expect(201);
      await as(reviewer).post(`/periods/${jan.id}/status`, { status: 'HARD_CLOSED' }).expect(403);
      await as(owner).post(`/periods/${jan.id}/status`, { status: 'HARD_CLOSED' }).expect(201);

      const blocked = await as(preparer).post('/journals', journal({ journalDate: '2026-01-25' })).expect(400);
      expect(blocked.body.message).toMatch(/closed/);

      await as(owner).post(`/periods/${jan.id}/status`, { status: 'OPEN' }).expect(400);
      await as(owner).post(`/periods/${jan.id}/status`, { status: 'OPEN', reason: 'Audit adjustment' }).expect(201);
      const events = await as(owner).get(`/audit-events?recordType=Period&recordId=${jan.id}`).expect(200);
      expect(events.body.items.map((e: { action: string }) => e.action)).toContain('period.reopen');
    });

    it('allows soft-closed periods only for authorised users', async () => {
      const years = (await as(owner).get(`/fiscal-years?entityId=${entityId}`).expect(200)).body;
      const feb = years[0].periods[1];
      const created = await as(preparer).post('/journals', journal({ journalDate: '2026-02-10' })).expect(201);
      await as(preparer).post(`/journals/${created.body.id}/submit`).expect(201);
      await as(reviewer).post(`/journals/${created.body.id}/approve`).expect(201);
      await as(reviewer).post(`/periods/${feb.id}/status`, { status: 'SOFT_CLOSED' }).expect(201);
      await as(reviewer).post(`/journals/${created.body.id}/post`).expect(403);
      await as(owner).post(`/journals/${created.body.id}/post`).expect(201);
    });
  });

  describe('reversals', () => {
    it('reverses a posted journal once and nets the ledger to zero', async () => {
      const id = await postJournal(journal({ journalDate: '2026-04-10', lines: [
        { accountId: acc['6700'], debit: '5000' },
        { accountId: acc['2120'], credit: '5000' },
      ] }));
      const rev = await as(owner).post(`/journals/${id}/reverse`, { date: '2026-04-30', reason: 'Posted in error' }).expect(201);
      expect(rev.body.status).toBe('POSTED');
      expect(rev.body.reversalOfId).toBe(id);
      await as(owner).post(`/journals/${id}/reverse`, { date: '2026-04-30', reason: 'again' }).expect(400);

      const activity = await as(owner)
        .get(`/reports/account-activity?entityId=${entityId}&accountId=${acc['6700']}&from=2026-04-01&to=2026-04-30`)
        .expect(200);
      expect(activity.body.closingBalance).toBe('0');
    });

    it('auto-reverses accruals on the requested date', async () => {
      const id = await postJournal(
        journal({ journalDate: '2026-05-31', type: 'ACCRUAL', autoReverseDate: '2026-06-01' }, [
          { accountId: acc['6300'], debit: '750' },
          { accountId: acc['2120'], credit: '750' },
        ]),
      );
      const original = await as(owner).get(`/journals/${id}`).expect(200);
      expect(original.body.reversedByNumber).toMatch(/^JV-KE-/);
    });
  });

  describe('branch access and tenancy', () => {
    it('confines a branch-restricted user to their branch', async () => {
      const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
      await as(owner)
        .post('/users', {
          name: 'Branch Clerk',
          email: 'clerk@e2e.test',
          password: PASSWORD,
          roleIds: [roles.find((r) => r.name === 'Accountant')!.id],
          allBranches: false,
          branchIds: [branch2Id],
        })
        .expect(201);
      const clerk = await login('clerk@e2e.test');
      await as(clerk).post('/journals', journal({ branchId: hqId })).expect(403);
      await as(clerk).post('/journals', journal({ branchId: branch2Id })).expect(201);
      const list = await as(clerk).get('/journals').expect(200);
      expect(list.body.items.every((j: { branchId: string }) => j.branchId === branch2Id)).toBe(true);
      const branches = await as(clerk).get('/branches').expect(200);
      expect(branches.body.map((b: { id: string }) => b.id)).toEqual([branch2Id]);
    });

    it('isolates organisations from each other', async () => {
      const other = await api()
        .post('/api/v1/auth/register')
        .send({
          organisationName: 'Other Org',
          adminName: 'Other',
          email: 'other@e2e.test',
          password: PASSWORD,
          entityCode: 'UG',
          entityName: 'Other Uganda',
          functionalCurrency: 'UGX',
          fiscalYearStart: '2026-01-01',
        })
        .expect(201);
      const mine = (await as(owner).get('/journals').expect(200)).body.items[0];
      await as(other.body.token).get(`/journals/${mine.id}`).expect(404);
      expect((await as(other.body.token).get('/journals').expect(200)).body.total).toBe(0);
      const otherAccounts = (await as(other.body.token).get('/accounts').expect(200)).body;
      expect(otherAccounts.find((a: { id: string }) => a.id === acc['1120'])).toBeUndefined();
    });
  });

  describe('reports', () => {
    it('produces a balanced trial balance and balance sheet', async () => {
      const tb = await as(owner).get(`/reports/trial-balance?entityId=${entityId}&from=2026-01-01&to=2026-12-31`).expect(200);
      expect(tb.body.balanced).toBe(true);
      expect(tb.body.totals.closingDebit).toBe(tb.body.totals.closingCredit);
      const bs = await as(owner).get(`/reports/balance-sheet?entityId=${entityId}&asOf=2026-12-31`).expect(200);
      expect(bs.body.balanced).toBe(true);
    });

    it('denies reports to users without permission', async () => {
      const roles = (await as(owner).get('/roles').expect(200)).body as { id: string; name: string }[];
      const role = await as(owner).post('/roles', { name: 'No reports', permissions: ['journal.view'] }).expect(201);
      expect(roles.length).toBeGreaterThan(0);
      await as(owner).post('/users', { name: 'Limited', email: 'limited@e2e.test', password: PASSWORD, roleIds: [role.body.id] }).expect(201);
      const limited = await login('limited@e2e.test');
      await as(limited).get(`/reports/trial-balance?entityId=${entityId}&from=2026-01-01&to=2026-12-31`).expect(403);
    });
  });
});
