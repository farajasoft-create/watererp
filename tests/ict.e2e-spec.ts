import bcrypt from 'bcryptjs';
import mongoose, { Connection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ictModule } from '../src/modules/ict/module';
import type { IctServices } from '../src/modules/ict/server/container';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';

/**
 * ICT & Administration: the IT help desk (ticket numbers, categories routed to officers, priorities
 * with response and resolution deadlines, acknowledgements, tracking, hold, resolution, requester
 * confirmation and rating, reopening, escalation, auto-close, reports) and office assets (equipment
 * issued to staff, consumables stock and issues, the administrative efficiency report).
 */

let replSet: MongoMemoryReplSet;
let conn: Connection;
let platform: Platform;
let handle: (req: Request) => Promise<Response>;
let orgId: Types.ObjectId;
let ict: IctServices;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const PASSWORD = 'password-123456';

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T; text: string }> {
  const res = await handle(new Request(`http://platform.test/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null) as T, text };
}
const ok = async <T = Record<string, unknown>>(p: Promise<{ status: number; data: T }>, status = 200) => {
  const r = await p;
  if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};

type Ticket = { id: string; number: string; status: string; priority: string; assignedTo: string | null; respondBy: string; resolveBy: string; createdAt: string; firstResponseAt: string | null; reopenCount: number; rating: number | null; comments: { body: string; internal: boolean }[]; history: { action: string; note?: string }[] };
const HOUR = 3_600_000;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('ict_e2e')).asPromise();
  const modules = [ictModule];
  platform = await createPlatform(conn, { modules });
  handle = createApi(async () => platform, modules);
  const { db } = platform.core;
  const [org] = await db.organisations.create([{ name: 'Tachasis Water', code: 'TACH', modules: ['ict'] }]);
  orgId = org._id;
  ict = platform.modules.ict as IctServices;
  await ictModule.seed!({ db, core: platform.core, services: ict, organisationId: orgId, demo: false, demoPassword: PASSWORD });
  const hash = await bcrypt.hash(PASSWORD, 4);
  const users = await db.users.create([
    { organisationId: orgId, email: 'manager@test.co', name: 'ICT Manager', access: [{ module: 'ict', role: 'MANAGER' }], passwordHash: hash },
    { organisationId: orgId, email: 'agent@test.co', name: 'Agent One', access: [{ module: 'ict', role: 'AGENT' }], passwordHash: hash },
    { organisationId: orgId, email: 'agent2@test.co', name: 'Agent Two', access: [{ module: 'ict', role: 'AGENT' }], passwordHash: hash },
    { organisationId: orgId, email: 'admin@test.co', name: 'Admin Officer', access: [{ module: 'ict', role: 'ADMIN_OFFICER' }], passwordHash: hash },
    { organisationId: orgId, email: 'staff@test.co', name: 'Staff Member', access: [], passwordHash: hash },
    { organisationId: orgId, email: 'staff2@test.co', name: 'Other Staff', access: [], passwordHash: hash },
  ]);
  for (const u of users) ids[u.email.split('@')[0]] = u._id.toHexString();
  for (const who of ['manager', 'agent', 'agent2', 'admin', 'staff', 'staff2']) expect((await call(who, 'POST', '/auth/login', { email: `${who}@test.co`, password: PASSWORD })).status).toBe(200);
});

afterAll(async () => {
  await conn?.close();
  await replSet?.stop();
});

describe('IT help desk', () => {
  it('logs a request with a number, deadlines by priority and an acknowledgement', async () => {
    const cats = await ok<{ id: string; code: string }[]>(call('staff', 'GET', '/ict/helpdesk/categories'));
    expect(cats.length).toBeGreaterThanOrEqual(9);
    for (const c of cats) ids[c.code] = c.id;
    const t = await ok<Ticket>(call('staff', 'POST', '/ict/helpdesk/tickets', { categoryId: ids.HARDWARE, priority: 'HIGH', subject: 'Laptop will not start', description: 'Black screen since morning', assetTag: 'pc-001', department: 'Finance' }), 201);
    ids.t1 = t.id;
    expect(t.number).toBe('HD-00001');
    expect(t.status).toBe('OPEN');
    expect(new Date(t.respondBy).getTime() - new Date(t.createdAt).getTime()).toBe(2 * HOUR);
    expect(new Date(t.resolveBy).getTime() - new Date(t.createdAt).getTime()).toBe(8 * HOUR);
    const ack = await platform.core.db.notifications.find({ userId: new Types.ObjectId(ids.staff) }).lean();
    expect(ack.some((n) => n.title.startsWith('HD-00001 received'))).toBe(true);
    const desk = await platform.core.db.notifications.find({ userId: new Types.ObjectId(ids.manager) }).lean();
    expect(desk.some((n) => n.title.includes('HD-00001'))).toBe(true);

    expect((await call('staff', 'GET', '/ict/helpdesk/tickets')).status).toBe(403);
    expect((await call('staff2', 'GET', `/ict/helpdesk/tickets/${t.id}`)).status).toBe(404);
    expect((await ok<Ticket[]>(call('staff', 'GET', '/ict/helpdesk/mine'))).map((x) => x.number)).toEqual(['HD-00001']);
  });

  it('routes a category to its officer', async () => {
    expect((await call('agent', 'PUT', `/ict/helpdesk/categories/${ids.NETWORK}`, { code: 'NETWORK', name: 'Network and internet', defaultAssignee: ids.agent })).status).toBe(403);
    await ok(call('manager', 'PUT', `/ict/helpdesk/categories/${ids.NETWORK}`, { code: 'NETWORK', name: 'Network and internet', defaultAssignee: ids.agent }));
    expect((await call('manager', 'PUT', `/ict/helpdesk/categories/${ids.EMAIL}`, { code: 'EMAIL', name: 'Email', defaultAssignee: ids.staff })).status).toBe(400);
    const t = await ok<Ticket>(call('staff', 'POST', '/ict/helpdesk/tickets', { categoryId: ids.NETWORK, subject: 'No internet in the billing office' }), 201);
    ids.t2 = t.id;
    expect(t.status).toBe('ASSIGNED');
    expect(t.assignedTo).toBe(ids.agent);
    expect(t.priority).toBe('MEDIUM');
  });

  it('is worked, held, resolved, reopened and closed with a rating', async () => {
    expect((await call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/assign`, { assigneeId: ids.agent2 })).status).toBe(403);
    expect((await ok<Ticket>(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/assign`, { assigneeId: ids.agent }))).status).toBe('ASSIGNED');
    expect((await call('agent2', 'POST', `/ict/helpdesk/tickets/${ids.t1}/start`)).status).toBe(403);
    const started = await ok<Ticket>(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/start`));
    expect(started.status).toBe('IN_PROGRESS');
    expect(started.firstResponseAt).toBeTruthy();

    await ok(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/comments`, { body: 'Probably the motherboard', internal: true }));
    await ok(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/comments`, { body: 'Please bring the charger' }));
    await ok(call('staff', 'POST', `/ict/helpdesk/tickets/${ids.t1}/comments`, { body: 'Brought it' }));
    const seen = await ok<Ticket>(call('staff', 'GET', `/ict/helpdesk/tickets/${ids.t1}`));
    expect(seen.comments.map((c) => c.body)).toEqual(['Please bring the charger', 'Brought it']);
    expect((await ok<Ticket>(call('agent', 'GET', `/ict/helpdesk/tickets/${ids.t1}`))).comments).toHaveLength(3);

    await ok(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/hold`, { reason: 'Waiting for a spare part' }));
    // Pretend it waited an hour on hold: the resolution deadline moves on by that hour.
    await ict.db.tickets.updateOne({ _id: new Types.ObjectId(ids.t1) }, { onHoldSince: new Date(Date.now() - HOUR) });
    const resumed = await ok<Ticket>(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/resume`));
    expect(new Date(resumed.resolveBy).getTime() - new Date(started.resolveBy).getTime()).toBeGreaterThanOrEqual(HOUR - 1000);

    expect((await ok<Ticket>(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/resolve`, { resolution: 'Replaced the power board' }))).status).toBe('RESOLVED');
    expect((await call('staff2', 'POST', `/ict/helpdesk/tickets/${ids.t1}/confirm`, { rating: 5 })).status).toBe(404);
    const reopened = await ok<Ticket>(call('staff', 'POST', `/ict/helpdesk/tickets/${ids.t1}/reopen`, { reason: 'It went off again' }));
    expect(reopened.status).toBe('REOPENED');
    expect(reopened.reopenCount).toBe(1);
    await ok(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t1}/resolve`, { resolution: 'Replaced the battery as well' }));
    const closed = await ok<Ticket>(call('staff', 'POST', `/ict/helpdesk/tickets/${ids.t1}/confirm`, { rating: 5, feedback: 'Quick, thanks' }));
    expect(closed.status).toBe('CLOSED');
    expect(closed.rating).toBe(5);
    expect(closed.history.map((h) => h.action)).toEqual(['RAISED', 'ASSIGNED', 'STARTED', 'ON_HOLD', 'RESUMED', 'RESOLVED', 'REOPENED', 'RESOLVED', 'CLOSED']);
    expect((await call('staff', 'POST', `/ict/helpdesk/tickets/${ids.t1}/comments`, { body: 'one more' })).status).toBe(400);
  });

  it('lets the requester withdraw a request not yet started', async () => {
    const t = await ok<Ticket>(call('staff', 'POST', '/ict/helpdesk/tickets', { categoryId: ids.PRINTER, priority: 'LOW', subject: 'Printer out of toner' }), 201);
    expect((await call('staff2', 'POST', `/ict/helpdesk/tickets/${t.id}/cancel`, {})).status).toBe(404);
    expect((await call('agent', 'POST', `/ict/helpdesk/tickets/${t.id}/cancel`, {})).status).toBe(403);
    expect((await ok<Ticket>(call('staff', 'POST', `/ict/helpdesk/tickets/${t.id}/cancel`, { reason: 'Found a cartridge' }))).status).toBe('CANCELLED');
    await ok(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t2}/start`));
    expect((await call('staff', 'POST', `/ict/helpdesk/tickets/${ids.t2}/cancel`, {})).status).toBe(400);
  });

  it('escalates late tickets and closes resolved ones nobody confirmed', async () => {
    const t2 = new Types.ObjectId(ids.t2);
    const created = new Date(Date.now() - 30 * HOUR);
    // Straight to the collection: Mongoose will not change createdAt.
    await ict.db.tickets.collection.updateOne({ _id: t2 }, { $set: { createdAt: created, resolveBy: new Date(created.getTime() + 24 * HOUR) } });
    const r1 = await ok<{ escalated: number }>(call('manager', 'POST', '/ict/helpdesk/housekeeping'));
    expect(r1.escalated).toBe(1);
    expect((await ict.db.tickets.findById(t2).lean())!.escalationLevel).toBe(1);
    expect((await ok<{ escalated: number }>(call('manager', 'POST', '/ict/helpdesk/housekeeping'))).escalated).toBe(0);
    const desk = await ok<{ counts: { overdue: number } }>(call('agent', 'GET', '/ict/helpdesk/tickets?overdue=true'));
    expect(desk.counts.overdue).toBe(1);

    await ok(call('agent', 'POST', `/ict/helpdesk/tickets/${ids.t2}/resolve`, { resolution: 'Reset the switch' }));
    await ict.db.tickets.updateOne({ _id: t2 }, { resolvedAt: new Date(Date.now() - 4 * 24 * HOUR) });
    expect((await ok<{ closed: number }>(call('manager', 'POST', '/ict/helpdesk/housekeeping'))).closed).toBe(1);
    expect((await ict.db.tickets.findById(t2).lean())!.status).toBe('CLOSED');
  });

  it('reports help desk performance', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const r = await ok<{ raised: number; resolved: number; satisfaction: { average: number }; byOfficer: { key: string; resolved: number }[]; byCategory: { key: string }[]; reopened: number }>(call('agent', 'GET', `/ict/helpdesk/report?from=${day}&to=${day}`));
    expect(r.raised).toBe(2); // the escalated one was back-dated a day
    expect(r.resolved).toBe(1);
    expect(r.reopened).toBe(1);
    expect(r.satisfaction.average).toBe(5);
    expect(r.byOfficer.find((o) => o.key === 'Agent One')?.resolved).toBe(1);
    const csv = await call('agent', 'GET', `/ict/helpdesk/report?from=${day}&to=${day}&format=csv`);
    expect(csv.text).toContain('HD-00001');
    expect((await call('staff', 'GET', `/ict/helpdesk/report?from=${day}&to=${day}`)).status).toBe(403);
  });
});

describe('office assets', () => {
  it('issues equipment to staff and takes it back', async () => {
    expect((await call('staff', 'POST', '/ict/assets', { tag: 'PC-002', description: 'Laptop' })).status).toBe(403);
    const a = await ok<{ id: string; tag: string; status: string }>(call('admin', 'POST', '/ict/assets', { tag: 'pc-001', description: 'HP ProBook laptop', kind: 'LAPTOP', make: 'HP', serialNo: '5CD123', condition: 'NEW' }), 201);
    ids.pc = a.id;
    expect(a.tag).toBe('PC-001');
    expect((await call('admin', 'POST', '/ict/assets', { tag: 'PC-001', description: 'Duplicate' })).status).toBe(400);
    expect((await ok<{ status: string; holderName: string }>(call('admin', 'POST', `/ict/assets/${a.id}/issue`, { holderId: ids.staff, department: 'Finance' }))).holderName).toBe('Staff Member');
    expect((await call('admin', 'POST', `/ict/assets/${a.id}/issue`, { holderId: ids.staff2 })).status).toBe(400);
    expect((await ok<unknown[]>(call('staff', 'GET', '/ict/assets/mine')))).toHaveLength(1);
    expect((await call('staff', 'GET', '/ict/assets')).status).toBe(403);
    const detail = await ok<{ tickets: { number: string }[] }>(call('agent', 'GET', `/ict/assets/${a.id}`));
    expect(detail.tickets.map((t) => t.number)).toEqual(['HD-00001']);
    const back = await ok<{ status: string; holderId: string | null; allocations: { returnedAt: string; conditionIn: string }[] }>(call('admin', 'POST', `/ict/assets/${a.id}/return`, { condition: 'FAULTY', note: 'Screen cracked' }));
    expect(back.status).toBe('UNDER_REPAIR');
    expect(back.holderId).toBeNull();
    expect(back.allocations[0]).toMatchObject({ conditionIn: 'FAULTY' });
    expect((await ok<{ status: string }>(call('admin', 'POST', `/ict/assets/${a.id}/status`, { status: 'IN_STORE' }))).status).toBe('IN_STORE');
    expect((await call('admin', 'GET', '/ict/assets?format=csv')).text).toContain('PC-001');
  });

  it('keeps consumables stock and warns when it runs low', async () => {
    const toner = await ok<{ id: string }>(call('admin', 'POST', '/ict/consumables', { code: 'TONER85A', name: 'HP 85A toner', unit: 'cartridge', reorderLevel: 2 }), 201);
    await ok(call('admin', 'POST', `/ict/consumables/${toner.id}/moves`, { kind: 'RECEIPT', quantity: 5, reference: 'LPO 0042' }), 201);
    expect((await call('admin', 'POST', `/ict/consumables/${toner.id}/moves`, { kind: 'ISSUE', quantity: 1 })).status).toBe(400);
    const after = await ok<{ onHand: number; low: boolean }>(call('admin', 'POST', `/ict/consumables/${toner.id}/moves`, { kind: 'ISSUE', quantity: 4, toId: ids.staff, department: 'Finance' }), 201);
    expect(after).toMatchObject({ onHand: 1, low: true });
    expect((await call('admin', 'POST', `/ict/consumables/${toner.id}/moves`, { kind: 'ISSUE', quantity: 5, department: 'Finance' })).status).toBe(400);
    const alerts = await platform.core.db.notifications.find({ userId: new Types.ObjectId(ids.admin), title: /Re-order/ }).lean();
    expect(alerts).toHaveLength(1);
    expect(await ok<unknown[]>(call('admin', 'GET', `/ict/consumables/${toner.id}/moves`))).toHaveLength(2);
  });

  it('reports administrative efficiency', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const r = await ok<{ equipment: { total: number; inStore: number }; consumables: { byDepartment: { key: string; quantity: number }[]; toReorder: { code: string }[] } }>(call('manager', 'GET', `/ict/admin-report?from=${day}&to=${day}`));
    expect(r.equipment).toMatchObject({ total: 1, inStore: 1 });
    expect(r.consumables.byDepartment).toEqual([{ key: 'Finance', quantity: 4 }]);
    expect(r.consumables.toReorder.map((x) => x.code)).toEqual(['TONER85A']);
  });
});

describe('memos and notices', () => {
  it('approves, issues, tracks reading, takes acknowledgements, minutes on and recalls', async () => {
    await ok(call('staff', 'POST', '/ict/circulars', { title: 'Staff party', body: 'Friday' }), 403);
    const m = await ok<{ id: string; number: string; status: string }>(call('admin', 'POST', '/ict/circulars', { kind: 'MEMO', title: 'Office hours during the water rationing', body: 'Offices open 7am to 4pm from Monday.', approverId: ids.manager, requiresAck: true }), 201);
    expect(m.number).toBe(`MEMO/${new Date().getUTCFullYear()}/001`);
    expect((await ok<{ status: string }>(call('admin', 'POST', `/ict/circulars/${m.id}/send`))).status).toBe('PENDING_APPROVAL');
    await ok(call('agent', 'POST', `/ict/circulars/${m.id}/approve`, { approve: true }), 404);
    const issued = await ok<{ status: string; recipients: unknown[] }>(call('manager', 'POST', `/ict/circulars/${m.id}/approve`, { approve: true, comment: 'Issue' }));
    expect(issued.status).toBe('ISSUED');
    expect(issued.recipients).toHaveLength(6);

    const inbox = await ok<{ id: string; mine: { readAt: string | null } }[]>(call('staff', 'GET', '/ict/circulars'));
    expect(inbox[0].mine.readAt).toBeNull();
    const opened = await ok<{ recipients: { readAt: string | null }[] }>(call('staff', 'GET', `/ict/circulars/${m.id}`));
    expect(opened.recipients).toHaveLength(1); // a recipient sees only their own receipt
    await ok(call('staff', 'POST', `/ict/circulars/${m.id}/acknowledge`, { comment: 'Noted' }));
    await ok(call('staff', 'POST', `/ict/circulars/${m.id}/forward`, { userId: ids.staff2, minute: 'Please inform the field team' }));
    const sent = await ok<{ total: number; read: number; acknowledged: number }[]>(call('admin', 'GET', '/ict/circulars?box=sent'));
    expect(sent[0]).toMatchObject({ total: 6, read: 2, acknowledged: 1 }); // the approver and the member of staff
    const full = await ok<{ minutes: { toName: string; text: string }[] }>(call('admin', 'GET', `/ict/circulars/${m.id}`));
    expect(full.minutes.map((x) => x.toName)).toContain('Other Staff');

    const n = await ok<{ id: string }>(call('admin', 'POST', '/ict/circulars', { kind: 'NOTICE', title: 'Agents meeting', body: 'Monday 9am', audience: 'USERS', audienceUserIds: [ids.agent, ids.agent2] }), 201);
    expect((await ok<{ recipients: unknown[] }>(call('admin', 'POST', `/ict/circulars/${n.id}/send`))).recipients).toHaveLength(2);
    await ok(call('staff', 'GET', `/ict/circulars/${n.id}`), 404);
    expect((await ok<{ status: string }>(call('admin', 'POST', `/ict/circulars/${n.id}/recall`, { reason: 'Meeting moved' }))).status).toBe('RECALLED');
    await ok(call('agent', 'POST', `/ict/circulars/${n.id}/acknowledge`, {}), 400);
  });
});
