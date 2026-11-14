import bcrypt from 'bcryptjs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { expect, vi } from 'vitest';
import type { Platform } from '../src/platform/container';

/**
 * A platform on an in-memory replica set with a stand-in ledger (https://books.test) and SMS gateway,
 * for end-to-end tests. Each test file gets its own database.
 */
export interface TestApp {
  platform: Platform;
  /** Calls the API as a signed-in user (cookies are kept per name). */
  call<T = Record<string, unknown>>(who: string, method: string, path: string, body?: unknown, expected?: number): Promise<T>;
  /** Raw request, for text and CSV responses. */
  raw(who: string, method: string, path: string, body?: unknown, contentType?: string): Promise<Response>;
  journals: { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }[];
  sms: { to: string; message: string }[];
  orgId: string;
  stop(): Promise<void>;
}

const BASE = 'http://app.test/api/v1';

export async function startApp(dbName: string, opts: { modules: string[]; users: { who: string; isAdmin?: boolean; access?: { module: string; role: string }[] }[] }): Promise<TestApp> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = replSet.getUri(dbName);
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  const journals: TestApp['journals'] = [];
  const sms: TestApp['sms'] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('africastalking.com')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      sms.push({ to: body.get('to') ?? '', message: body.get('message') ?? '' });
      return Response.json({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: `m${sms.length}` }] } });
    }
    if (!url.startsWith('https://books.test')) return realFetch(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    journals.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith('/journals')) return Response.json({ id: `j${journals.length}`, status: 'DRAFT' }, { status: 201 });
    return Response.json({ ok: true });
  });
  const { handleApi } = await import('../src/platform/api');
  const platform = await (await import('../src/platform/container')).getPlatform();
  const db = platform.core.db;
  const [org] = await db.organisations.create([{ name: 'Tachasis Water Co', code: 'TWC', modules: opts.modules, phone: '0700000000' }]);
  const hash = await bcrypt.hash('password-123456', 4);
  await db.users.create(opts.users.map((u) => ({ organisationId: org._id, email: `${u.who}@test.co`, name: u.who[0].toUpperCase() + u.who.slice(1), isAdmin: Boolean(u.isAdmin), access: u.access ?? [], passwordHash: hash })));

  const cookies: Record<string, string> = {};
  const raw = async (who: string, method: string, path: string, body?: unknown, contentType = 'application/json') => {
    const res = await handleApi(
      new Request(`${BASE}${path}`, {
        method,
        headers: { 'content-type': contentType, ...(cookies[who] && { cookie: cookies[who] }) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
    const set = res.headers.get('set-cookie');
    if (set) cookies[who] = set.split(';')[0];
    return res;
  };
  const call = async <T,>(who: string, method: string, path: string, body?: unknown, expected?: number): Promise<T> => {
    const res = await raw(who, method, path, body);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (expected !== undefined) expect(res.status, `${method} ${path}: ${text}`).toBe(expected);
    else expect(res.status, `${method} ${path}: ${text}`).toBeLessThan(300);
    return data as T;
  };
  for (const u of opts.users) await call(u.who, 'POST', '/auth/login', { email: `${u.who}@test.co`, password: 'password-123456' }, 200);

  return {
    platform,
    call,
    raw,
    journals,
    sms,
    orgId: org._id.toHexString(),
    async stop() {
      vi.unstubAllGlobals();
      await platform.core.db.connection.close();
      await replSet.stop();
    },
  };
}

/** A zone, a domestic tariff and active, metered customers (readings start at 100). */
export async function seedWater(app: TestApp, names: string[]) {
  const zone = await app.call<{ id: string }>('admin', 'POST', '/water/zones', { code: 'kml', name: 'Kamelil' });
  const tariff = await app.call<{ id: string }>('admin', 'POST', '/water/tariffs', {
    code: 'DOM',
    name: 'Domestic',
    category: 'DOMESTIC',
    effectiveFrom: '2026-07-01',
    blocks: [{ upTo: '6', rate: '0', fixedAmount: '600' }, { upTo: '20', rate: '120' }, { upTo: null, rate: '140' }],
    meterRent: '50',
    sewerPercent: '0',
    defaultEstimate: '10',
  });
  const customers: { id: string; accountNo: string; meterId: string; serialNo: string }[] = [];
  for (const [i, name] of names.entries()) {
    const c = await app.call<{ id: string; accountNo: string }>('admin', 'POST', '/water/customers', { name, category: 'DOMESTIC', zoneId: zone.id, tariffId: tariff.id, phone: `07123456${String(i).padStart(2, '0')}`, status: 'ACTIVE' });
    const serialNo = `M-${String(i + 1).padStart(3, '0')}`;
    const m = await app.call<{ id: string }>('admin', 'POST', '/water/meters', { serialNo, dials: 5 });
    await app.call('admin', 'POST', `/water/meters/${m.id}/install`, { customerId: c.id, reading: '100', date: '2026-09-30' }, 200);
    customers.push({ id: c.id, accountNo: c.accountNo, meterId: m.id, serialNo });
  }
  return { zoneId: zone.id, tariffId: tariff.id, customers };
}

export async function connectLedger(app: TestApp, waterAccounts: Record<string, string>) {
  await app.call('admin', 'PATCH', '/settings/ledger', { enabled: true, baseUrl: 'https://books.test', apiKey: 'fsk_test_key', entityId: 'e'.repeat(24), branchId: 'b'.repeat(24), mode: 'SUBMIT' });
  await app.call('admin', 'PATCH', '/water/settings/accounts', { accounts: waterAccounts });
}

export const ACCOUNTS = {
  receivable: '1'.repeat(24),
  water: '2'.repeat(24),
  meterRent: '3'.repeat(24),
  mpesa: '4'.repeat(24),
  cash: '5'.repeat(24),
  adjustments: '6'.repeat(24),
  bank: '7'.repeat(24),
  other: '8'.repeat(24),
  reconnection: '9'.repeat(24),
  sewer: 'a'.repeat(24),
  penalty: 'b'.repeat(24),
};
