import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FinanceServices } from '../src/modules/finance/module';
import { seedWater, startApp, TestApp } from './helpers';

/**
 * Finance inside the platform: one sign-in, finance access from the platform role, finance set up for
 * the organisation on first use, the module switch, and other modules' journals landing in finance's
 * general ledger in the same database.
 */

let app: TestApp;
let f: FinanceServices;

beforeAll(async () => {
  app = await startApp('finance_platform_e2e', {
    modules: ['water', 'hr', 'finance'],
    users: [
      { who: 'admin', isAdmin: true },
      { who: 'accountant', access: [{ module: 'finance', role: 'ACCOUNTANT' }, { module: 'water', role: 'BILLING' }] },
      { who: 'reviewer', access: [{ module: 'finance', role: 'FINANCE_REVIEWER' }] },
      { who: 'manager', access: [{ module: 'water', role: 'MANAGER' }] },
      { who: 'staff', access: [{ module: 'finance', role: 'STAFF' }] },
    ],
  });
  f = app.platform.modules.finance as FinanceServices;
});

afterAll(async () => app?.stop());

describe('finance in the platform', () => {
  it('sets finance up for the organisation the first time it is opened', async () => {
    const me = await app.call<{ email: string; permissions: string[]; organisation: { name: string } }>('admin', 'GET', '/finance/auth/me');
    expect(me.email).toBe('admin@test.co');
    expect(me.permissions).toContain('journal.approve');
    const entities = await app.call<{ id: string; code: string; functionalCurrency: string }[]>('admin', 'GET', '/finance/entities');
    expect(entities).toMatchObject([{ code: 'TWC', functionalCurrency: 'KES' }]);
    // The finance organisation is the platform's (same id), in finance_ collections.
    expect(await f.db.organisations.exists({ _id: app.orgId })).toBeTruthy();
    expect(f.db.journals.collection.collectionName).toBe('finance_journals');
  });

  it('gives each person the finance roles of their platform role, and nothing without one', async () => {
    const acc = await app.call<{ permissions: string[] }>('accountant', 'GET', '/finance/auth/me');
    expect(acc.permissions).toContain('journal.create');
    expect(acc.permissions).not.toContain('journal.approve');
    await app.call('manager', 'GET', '/finance/auth/me', undefined, 403);
    // Any member of staff can raise requisitions, claims and imprest, and approve nothing.
    const staff = await app.call<{ permissions: string[] }>('staff', 'GET', '/finance/auth/me');
    expect(staff.permissions).toEqual(expect.arrayContaining(['procurement.request', 'expenses.submit']));
    expect(staff.permissions).not.toContain('procurement.approve');
    expect(staff.permissions).not.toContain('journal.create');
    // Finance's own sign-in is gone: the platform signs people in.
    await app.call('anon', 'POST', '/finance/auth/login', { email: 'admin@test.co', password: 'password-123456' }, 404);
  });

  it('runs a journal through maker-checker with platform users', async () => {
    const [entity] = await app.call<{ id: string }[]>('accountant', 'GET', '/finance/entities');
    const [branch] = await app.call<{ id: string }[]>('accountant', 'GET', `/finance/branches?entityId=${entity.id}`);
    const accounts = await app.call<{ id: string; code: string; isPostable: boolean }[]>('accountant', 'GET', `/finance/accounts?entityId=${entity.id}`);
    const postable = accounts.filter((a) => a.isPostable);
    const j = await app.call<{ id: string; status: string }>('accountant', 'POST', '/finance/journals', {
      entityId: entity.id,
      branchId: branch.id,
      journalDate: new Date().toISOString().slice(0, 10),
      description: 'Accrue October audit fee',
      lines: [
        { accountId: postable.find((a) => a.code === '1400')!.id, debit: '50000' },
        { accountId: postable.find((a) => a.code === '2120')!.id, credit: '50000' },
      ],
    });
    await app.call('accountant', 'POST', `/finance/journals/${j.id}/submit`, {});
    await app.call('accountant', 'POST', `/finance/journals/${j.id}/approve`, {}, 403);
    const approved = await app.call<{ status: string }>('reviewer', 'POST', `/finance/journals/${j.id}/approve`, { post: true });
    expect(['APPROVED', 'POSTED']).toContain(approved.status);
  });

  it('is the ledger water and HR post to, without any connection set up', async () => {
    const ledgerAccounts = await app.call<{ id: string; code: string; type: string }[]>('admin', 'GET', '/ledger/accounts');
    expect(ledgerAccounts.length).toBeGreaterThan(20);
    const byCode = (code: string) => ledgerAccounts.find((a) => a.code === code)!.id;
    await app.call('admin', 'PATCH', '/water/settings/accounts', { accounts: { receivable: byCode('1250'), water: byCode('4200'), meterRent: byCode('4800'), cash: byCode('1110'), mpesa: byCode('1120') } });
    const w = await seedWater(app, ['Kiprono Kirui']);
    await app.call('accountant', 'POST', '/water/cycles', { period: '2026-10' });
    await app.call('accountant', 'POST', '/water/readings', { clientId: 'device-1-0001', meterId: w.customers[0].meterId, value: '110', readAt: '2026-10-28T08:00:00+03:00' });
    const { run } = await app.call<{ run: { id: string } }>('accountant', 'POST', '/water/bill-runs', { period: '2026-10', billDate: '2026-10-31' });
    await app.call('manager', 'POST', `/water/bill-runs/${run.id}/approve`, undefined, 200);
    const stored = await (app.platform.modules.water as { db: { billRuns: { findById: (id: string) => { lean: () => Promise<{ accounting?: { status: string; journalId?: string } }> } } } }).db.billRuns.findById(run.id).lean();
    expect(stored.accounting?.status).toBe('SENT');
    const journal = await f.db.journals.findById(stored.accounting!.journalId).lean();
    expect(journal).toMatchObject({ reference: 'WATER-BILLS-2026-10', status: 'SUBMITTED', source: 'API' });
    // The same key again does not post twice.
    expect(await f.db.journals.countDocuments({ organisationId: app.orgId, idempotencyKey: `farajasoft-water:billRun:${run.id}` })).toBe(1);
  });

  it('lists everyone with a finance role, and leaves adding people to the platform', async () => {
    await app.platform.core.db.users.create([{ organisationId: app.orgId, email: 'clerk@test.co', name: 'Clerk', passwordHash: 'x', access: [{ module: 'finance', role: 'ACCOUNTANT' }] }]);
    const users = await app.call<{ email: string }[]>('admin', 'GET', '/finance/users');
    expect(users.map((u) => u.email)).toEqual(expect.arrayContaining(['admin@test.co', 'accountant@test.co', 'reviewer@test.co', 'clerk@test.co']));
    expect(users.map((u) => u.email)).not.toContain('manager@test.co');
    await app.call('admin', 'POST', '/finance/users', { email: 'x@test.co', name: 'X', roleIds: [] }, 400);
  });

  it('closes finance to everyone when the module is switched off', async () => {
    await app.call('admin', 'PUT', '/settings/modules', { modules: ['water', 'hr'] }, 200);
    await app.call('accountant', 'GET', '/finance/auth/me', undefined, 403);
    await app.call('admin', 'PUT', '/settings/modules', { modules: ['water', 'hr', 'finance'] }, 200);
  });
});
