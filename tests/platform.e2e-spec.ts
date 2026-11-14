import bcrypt from 'bcryptjs';
import mongoose, { Connection, Schema, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';
import { defineModel } from '../src/platform/db';
import { routeFor } from '../src/platform/http/route';
import { defineManifest } from '../src/platform/manifest';
import { defineModule } from '../src/platform/module';
import { Journal } from '../src/platform/ledger/types';
import { waterModule } from '../src/modules/water/module';

/**
 * The module contract, with a module written inside the test: its own collection and routes, events
 * between modules, and a module taking over the ledger (what a finance module will do).
 */

const noteSchema = new Schema({ organisationId: Types.ObjectId, text: String, amount: String }, { timestamps: true });
const notesModels = (conn: Connection) => ({ notes: defineModel(conn, 'NotesNote', noteSchema, 'notes_notes') });
type NotesDb = Parameters<Parameters<typeof defineModule>[0]['services']>[0]['db'] & ReturnType<typeof notesModels>;

const posted: { journal: Journal; key: string }[] = [];
const heard: string[] = [];

const notesManifest = defineManifest({
  key: 'notes',
  name: 'Notes',
  description: 'A test module',
  home: '/notes',
  permissions: { VIEW: 'notes.view', WRITE: 'notes.write' },
  roles: { WRITER: { label: 'Writer', permissions: ['notes.view', 'notes.write'] }, READER: { label: 'Reader', permissions: ['notes.view'] } },
  nav: [{ href: '/notes', label: 'Notes', permission: 'notes.view' }],
});

function notesServices(db: NotesDb, core: Platform['core']) {
  return {
    list: (orgId: Types.ObjectId) => db.notes.find({ organisationId: orgId }).lean(),
    async add(orgId: Types.ObjectId, text: string, amount: string) {
      const [note] = await db.notes.create([{ organisationId: orgId, text, amount }]);
      await core.ledger.post(orgId, { date: '2026-11-02', description: text, reference: `NOTE-${note._id}`, lines: [{ accountId: 'cash', description: text, debit: amount }, { accountId: 'income', description: text, credit: amount }] }, `notes:${note._id}`);
      await core.events.emit(orgId, 'notes.note.added', { id: note._id });
      return note;
    },
  };
}
type NotesServices = ReturnType<typeof notesServices>;
const route = routeFor<NotesServices>();

const notesModule = defineModule<NotesServices, ReturnType<typeof notesModels>>({
  manifest: notesManifest,
  models: notesModels,
  services: ({ db, core }) => notesServices(db as NotesDb, core),
  routes: [
    route({ method: 'GET', path: '/notes', permissions: ['notes.view'], handler: ({ s, user }) => s.list(user.organisationId) }),
    route({ method: 'POST', path: '/notes', permissions: ['notes.write'], body: z.object({ text: z.string(), amount: z.string() }), handler: ({ s, user, body }) => s.add(user.organisationId, body.text, body.amount) }),
  ],
  start: ({ core }) => {
    // This module keeps the books itself, so every module's journals now land here instead of Accounting.
    core.ledger.use({
      name: 'Notes ledger',
      isConnected: async () => true,
      post: async (_org, journal, key) => {
        posted.push({ journal, key });
        return `local-${posted.length}`;
      },
      accounts: async () => [{ id: 'cash', code: '1000', name: 'Cash', type: 'ASSET' }],
    });
    core.events.on('notes.*', (e) => void heard.push(e.name));
  },
});

let replSet: MongoMemoryReplSet;
let conn: Connection;
let platform: Platform;
let handle: (req: Request) => Promise<Response>;
const cookies: Record<string, string> = {};

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await handle(new Request(`http://platform.test/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('platform_e2e')).asPromise();
  const modules = [waterModule, notesModule];
  platform = await createPlatform(conn, { modules });
  handle = createApi(async () => platform, modules);
  const { db } = platform.core;
  const [org] = await db.organisations.create([{ name: 'Multi Co', code: 'MULTI', modules: ['water', 'notes'] }]);
  const hash = await bcrypt.hash('password-123456', 4);
  await db.users.create([
    { organisationId: org._id, email: 'writer@test.co', name: 'Writer', access: [{ module: 'notes', role: 'WRITER' }], passwordHash: hash },
    { organisationId: org._id, email: 'cashier@test.co', name: 'Cashier', access: [{ module: 'water', role: 'CASHIER' }, { module: 'notes', role: 'READER' }], passwordHash: hash },
  ]);
  for (const who of ['writer', 'cashier']) expect((await call(who, 'POST', '/auth/login', { email: `${who}@test.co`, password: 'password-123456' })).status).toBe(200);
});

afterAll(async () => {
  await conn?.close();
  await replSet?.stop();
});

describe('platform modules', () => {
  it('mounts a module under its key, in its own collection', async () => {
    const created = await call<{ id: string; text: string }>('writer', 'POST', '/notes/notes', { text: 'Petty cash', amount: '150.00' });
    expect(created.status).toBe(201);
    expect((await call<unknown[]>('writer', 'GET', '/notes/notes')).data).toHaveLength(1);
    expect(await conn.db!.collection('notes_notes').countDocuments()).toBe(1);
  });

  it('applies each user’s role per module', async () => {
    expect((await call('cashier', 'GET', '/notes/notes')).status).toBe(200);
    expect((await call('cashier', 'POST', '/notes/notes', { text: 'x', amount: '1' })).status).toBe(403);
    expect((await call('writer', 'GET', '/water/customers')).status).toBe(403);
    expect((await call('cashier', 'GET', '/water/customers')).status).toBe(200);
  });

  it('lets a module provide the ledger for everyone and hear events', async () => {
    expect(posted).toHaveLength(1);
    expect(posted[0].key).toMatch(/^notes:/);
    expect(heard).toEqual(['notes.note.added']);
    expect((await call<{ id: string }[]>('cashier', 'GET', '/ledger/accounts')).data[0].id).toBe('cash');
  });

  it('lists every installed module to the browser', async () => {
    const me = await call<{ modules: string[]; permissions: string[] }>('cashier', 'GET', '/auth/me');
    expect(me.data.modules).toEqual(['water', 'notes']);
    expect(me.data.permissions).toEqual(expect.arrayContaining(['water.payment.record', 'notes.view']));
    expect(me.data.permissions).not.toContain('notes.write');
  });
});
