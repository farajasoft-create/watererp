import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, TestApp } from './helpers';

/**
 * Roles changed without a release: an administrator defines a role in a module from that module's
 * permissions, gives it to a user, widens it, and the user's rights follow on the next request; standard
 * role keys and foreign permissions are refused; a role in use cannot be deleted.
 */

let app: TestApp;

beforeAll(async () => {
  app = await startApp('custom_roles_e2e', {
    modules: ['ict'],
    users: [{ who: 'admin', isAdmin: true }, { who: 'clerk' }],
  });
});

afterAll(async () => {
  await app?.stop();
});

describe('custom roles', () => {
  it('lets an administrator define, assign and change a role', async () => {
    const modules = await app.call<{ module: string; permissions: string[]; roles: { key: string; custom: boolean }[] }[]>('admin', 'GET', '/roles');
    const ict = modules.find((m) => m.module === 'ict')!;
    const view = ict.permissions.find((p) => p.endsWith('.view') || p.includes('view'))!;
    const other = ict.permissions.find((p) => p !== view)!;
    const standard = ict.roles.find((r) => !r.custom)!.key;

    await app.call('clerk', 'PUT', '/roles/custom', { module: 'ict', key: 'DESK_READER', label: 'Desk reader', permissions: [view] }, 403);
    await app.call('admin', 'PUT', '/roles/custom', { module: 'ict', key: standard, label: 'Clash', permissions: [view] }, 400);
    await app.call('admin', 'PUT', '/roles/custom', { module: 'ict', key: 'DESK_READER', label: 'Desk reader', permissions: ['hr.payroll.run'] }, 400);
    await app.call('admin', 'PUT', '/roles/custom', { module: 'ict', key: 'desk_reader', label: 'Desk reader', permissions: [view] }, 200);
    expect((await app.call<typeof modules>('admin', 'GET', '/roles')).find((m) => m.module === 'ict')!.roles.find((r) => r.key === 'DESK_READER')?.custom).toBe(true);

    const users = await app.call<{ id: string; email: string; name: string }[]>('admin', 'GET', '/users');
    const clerk = users.find((u) => u.email === 'clerk@test.co')!;
    await app.call('admin', 'PATCH', `/users/${clerk.id}`, { name: clerk.name, email: clerk.email, access: [{ module: 'ict', role: 'DESK_READER' }] }, 200);
    let me = await app.call<{ permissions: string[]; access: { roleLabel: string }[] }>('clerk', 'GET', '/auth/me');
    expect(me.permissions).toEqual([view]);
    expect(me.access[0].roleLabel).toBe('Desk reader');

    await app.call('admin', 'PUT', '/roles/custom', { module: 'ict', key: 'DESK_READER', label: 'Desk reader', permissions: [view, other] }, 200);
    me = await app.call('clerk', 'GET', '/auth/me');
    expect(me.permissions.sort()).toEqual([view, other].sort());

    await app.call('admin', 'DELETE', '/roles/custom/ict/DESK_READER', undefined, 400); // still held
    await app.call('admin', 'PATCH', `/users/${clerk.id}`, { name: clerk.name, email: clerk.email, access: [] }, 200);
    await app.call('admin', 'DELETE', '/roles/custom/ict/DESK_READER', undefined, 200);
    expect(await app.call<unknown[]>('admin', 'GET', '/roles/custom')).toEqual([]);
  });
  it('publishes the API description and lets another system call it with a key', async () => {
    const { handleApi } = await import('../src/platform/api');
    const bearer = (key: string, path: string) => handleApi(new Request(`http://app.test/api/v1${path}`, { headers: { authorization: `Bearer ${key}` } }));
    const spec = await (await handleApi(new Request('http://app.test/api/v1/openapi.json'))).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/ict/circulars', '/tenders/public/{org}']));
    expect(spec.paths['/ict/circulars'].post['x-permissions']).toEqual(['ict.circulars.issue']);

    const users = await app.call<{ id: string; email: string; name: string }[]>('admin', 'GET', '/users');
    const clerk = users.find((u) => u.email === 'clerk@test.co')!;
    const admin = users.find((u) => u.email === 'admin@test.co')!;
    await app.call('admin', 'POST', `/users/${admin.id}/api-keys`, { label: 'Too strong' }, 400);
    await app.call('admin', 'PATCH', `/users/${clerk.id}`, { name: clerk.name, email: clerk.email, access: [{ module: 'ict', role: 'AGENT' }] }, 200);
    const issued = await app.call<{ key: string }>('admin', 'POST', `/users/${clerk.id}/api-keys`, { label: 'Monitoring system', days: 30 }, 201);
    expect(issued.key.startsWith('gk_')).toBe(true);
    expect((await bearer(issued.key, '/ict/helpdesk/categories')).status).toBe(200);
    expect((await bearer(issued.key, '/users')).status).toBe(403); // only the user's own rights
    expect((await bearer('gk_not-a-real-key-0000000000000000', '/ict/helpdesk/categories')).status).toBe(401);
    const keys = await app.call<{ id: string; prefix: string; lastUsedAt: string | null }[]>('admin', 'GET', `/users/${clerk.id}/api-keys`);
    expect(keys[0].lastUsedAt).not.toBeNull();
    expect(JSON.stringify(keys)).not.toContain(issued.key);
    await app.call('admin', 'DELETE', `/users/${clerk.id}/api-keys/${keys[0].id}`, undefined, 200);
    expect((await bearer(issued.key, '/ict/helpdesk/categories')).status).toBe(401);
  });
});
