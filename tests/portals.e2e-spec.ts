import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, TestApp } from './helpers';

/**
 * Portals: the e-library (staff-only and public items), the MSME products portal (register, approve with
 * a self-service link, keep products up to date, suspend), and per-portal branding and closing, which
 * every public portal honours.
 */

let app: TestApp;
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await startApp('portals_e2e', {
    modules: ['portals', 'estates'],
    users: [
      { who: 'manager', access: [{ module: 'portals', role: 'MANAGER' }, { module: 'estates', role: 'MANAGER' }] },
      { who: 'librarian', access: [{ module: 'portals', role: 'LIBRARIAN' }] },
      { who: 'staff', access: [{ module: 'estates', role: 'CARETAKER' }] },
      { who: 'dpo', isAdmin: true },
    ],
  });
});

afterAll(async () => {
  await app?.stop();
});

describe('portals', () => {
  it('keeps a library with staff-only and public items', async () => {
    const pub = await app.call<{ id: string }>('librarian', 'POST', '/portals/library', { title: 'Strategic plan 2026-2030', category: 'STRATEGIC_PLAN', year: 2026, url: 'https://example.org/plan.pdf', audience: 'PUBLIC', tags: ['Strategy'] }, 201);
    ids.public = pub.id;
    ids.staff = (await app.call<{ id: string }>('librarian', 'POST', '/portals/library', { title: 'Procurement manual', category: 'MANUAL', url: 'https://example.org/manual.pdf' }, 201)).id;
    await app.call('librarian', 'POST', '/portals/library', { title: 'No file' }, 400);
    await app.call('staff', 'POST', '/portals/library', { title: 'Sneaky', url: 'https://x.org' }, 403);
    expect(await app.call<unknown[]>('staff', 'GET', '/portals/library')).toHaveLength(2);
    const publicView = await app.call<{ items: { title: string }[]; branding: { enabled: boolean } }>('anyone', 'GET', '/portals/public/twc/library');
    expect(publicView.items.map((i) => i.title)).toEqual(['Strategic plan 2026-2030']);
    expect((await app.raw('anyone', 'GET', `/portals/public/twc/library/${ids.public}`)).status).toBe(302);
    await app.call('anyone', 'GET', `/portals/public/twc/library/${ids.staff}`, undefined, 404);
    expect((await app.raw('staff', 'GET', `/portals/library/${ids.staff}/open`)).status).toBe(302);
    expect((await app.call<{ title: string }[]>('staff', 'GET', '/portals/library?search=strategy'))[0].title).toBe('Strategic plan 2026-2030');
  });

  it('registers MSMEs, approves them with a self-service link and lists them', async () => {
    const reg = await app.call<{ reference: string }>('anyone', 'POST', '/portals/public/twc/msmes', { businessName: 'Kapsoya Youth Welders', ownerName: 'Brian Kip', phone: '0711222333', sector: 'MANUFACTURING', agpo: 'YOUTH', agpoCertificate: 'AGPO/1234', products: [{ name: 'Steel gates', price: '45000', unit: 'gate' }] }, 201);
    expect(reg.reference).toBe('MSME-00001');
    await app.call('anyone', 'POST', '/portals/public/twc/msmes', { businessName: 'Again', ownerName: 'Brian Kip', phone: '0711222333' }, 409);
    expect((await app.call<{ businesses: unknown[] }>('anyone', 'GET', '/portals/public/twc/msmes')).businesses).toHaveLength(0);
    const [m] = await app.call<{ id: string }[]>('librarian', 'GET', '/portals/msmes?status=PENDING');
    ids.msme = m.id;
    await app.call('librarian', 'POST', `/portals/msmes/${m.id}/decide`, { status: 'REJECTED' }, 400);
    await app.call('staff', 'POST', `/portals/msmes/${m.id}/decide`, { status: 'APPROVED' }, 403);
    const ok = await app.call<{ path: string }>('librarian', 'POST', `/portals/msmes/${m.id}/decide`, { status: 'APPROVED' }, 200);
    const token = ok.path.split('/').pop()!;
    const cat = await app.call<{ businesses: { businessName: string; products: { name: string; price: string }[] }[] }>('anyone', 'GET', '/portals/public/twc/msmes?agpo=YOUTH&search=gates');
    expect(cat.businesses[0]).toMatchObject({ businessName: 'Kapsoya Youth Welders', products: [expect.objectContaining({ name: 'Steel gates', price: '45000' })] });
    const acc = await app.call<{ products: { name: string }[] }>('anyone', 'PUT', `/portals/msme-account/${token}`, { description: 'Gates, grills and windows', products: [{ name: 'Steel gates', price: '42000' }, { name: 'Window grills', price: '6000', unit: 'm2' }] }, 200);
    expect(acc.products.map((p) => p.name)).toEqual(['Steel gates', 'Window grills']);
    expect(await app.platform.core.db.sms.countDocuments({ purpose: 'portals:msme' })).toBe(2);
    await app.call('librarian', 'POST', `/portals/msmes/${m.id}/decide`, { status: 'SUSPENDED', reason: 'Expired AGPO certificate' }, 200);
    expect((await app.call<{ businesses: unknown[] }>('anyone', 'GET', '/portals/public/twc/msmes')).businesses).toHaveLength(0);
    await app.call('anyone', 'GET', `/portals/msme-account/${token}`, undefined, 404);
  });

  it('brands each portal separately and closes one without touching the others', async () => {
    await app.call('librarian', 'GET', '/portals/settings', undefined, 403);
    const all = await app.call<{ portal: string; enabled: boolean }[]>('manager', 'GET', '/portals/settings');
    expect(all.map((s) => s.portal)).toEqual(['jobs', 'customers', 'vendors', 'tenants', 'donors', 'library', 'msme', 'tenders']);
    await app.call('manager', 'PUT', '/portals/settings/library', { enabled: true, accent: 'red' }, 400);
    await app.call('manager', 'PUT', '/portals/settings/library', { enabled: true, title: 'TWC Resource Centre', accent: '#0f766e', welcome: 'Our published documents' }, 200);
    const lib = await app.call<{ branding: { title: string; accent: string } }>('anyone', 'GET', '/portals/public/twc/library');
    expect(lib.branding).toMatchObject({ title: 'TWC Resource Centre', accent: '#0f766e' });
    expect((await app.call<{ accent: string }>('anyone', 'GET', '/portals/public/twc/branding/msme')).accent).toBe('#1d4ed8');

    // Close the tenant portal: a tenant link stops working, the library stays open.
    const tenant = await app.call<{ id: string }>('manager', 'POST', '/estates/tenants', { name: 'Shop Ltd', kind: 'COMPANY', phone: '0722000999' }, 201);
    const link = await app.call<{ path: string }>('manager', 'POST', `/estates/tenants/${tenant.id}/portal`, undefined, 200);
    const token = link.path.split('/').pop()!;
    await app.call('anyone', 'GET', `/estates/tenant-portal/${token}`, undefined, 200);
    await app.call('manager', 'PUT', '/portals/settings/tenants', { enabled: false }, 200);
    await app.call('anyone', 'GET', `/estates/tenant-portal/${token}`, undefined, 404);
    await app.call('anyone', 'GET', '/portals/public/twc/library', undefined, 200);
    await app.call('manager', 'PUT', '/portals/settings/msme', { enabled: false }, 200);
    await app.call('anyone', 'POST', '/portals/public/twc/msmes', { businessName: 'Closed Co', ownerName: 'Someone', phone: '0711000000' }, 404);
  });
  it('finds everything held about a person for a data subject request', async () => {
    await app.call('staff', 'POST', '/privacy/subject-search', { phone: '0711222333', reason: 'Access request' }, 403);
    await app.call('dpo', 'POST', '/privacy/subject-search', { reason: 'Access request' }, 400);
    const found = await app.call<{ results: { label: string; summary: string; matchedOn: string[] }[] }>('dpo', 'POST', '/privacy/subject-search', { phone: '+254711222333', reason: 'Access request DSR-001' }, 200);
    expect(found.results.map((r) => r.label)).toEqual(['MSME listing']);
    expect(found.results[0]).toMatchObject({ summary: expect.stringContaining('Kapsoya Youth Welders'), matchedOn: ['phone'] });
    const tenant = await app.call<{ results: { label: string; record: Record<string, unknown> }[] }>('dpo', 'POST', '/privacy/subject-search', { phone: '0722000999', reason: 'Access request DSR-002' }, 200);
    expect(tenant.results[0].label).toBe('Tenant');
    expect(tenant.results[0].record.portalTokenHash).toBeUndefined();
    expect(await app.platform.core.db.audit.countDocuments({ action: 'privacy.subject-search' })).toBe(2);

    // Every opened record and downloaded file is in the access log, across modules.
    await app.call('staff', 'GET', '/access-log', undefined, 403);
    await new Promise((r) => setTimeout(r, 50)); // the log is written after the response
    const log = await app.call<{ user: string; module: string; kind: string; path: string }[]>('dpo', 'GET', '/access-log?module=portals');
    expect(log.some((l) => l.user === 'Staff' && l.kind === 'VIEW' && l.path.includes(`/portals/library/${ids.staff}/open`))).toBe(true);
  });
});
