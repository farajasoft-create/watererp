import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rentFor } from '../src/modules/estates/server/estates.service';
import { startApp, TestApp } from './helpers';

/**
 * Estates & Tenants: a property with units, a lease with a deposit, monthly rent with escalation billed
 * once per month, payments on a running statement, arrears in the rent roll, deposits held, ending a
 * lease with the deposit applied and refunded, maintenance requests, and the tenant portal link.
 */

let app: TestApp;
const ids: Record<string, string> = {};
type Statement = { balance: string; depositHeld: string; status: string; statement: { kind: string; amount: string; balance: string | null }[] };

beforeAll(async () => {
  app = await startApp('estates_e2e', {
    modules: ['estates'],
    users: [
      { who: 'officer', access: [{ module: 'estates', role: 'MANAGER' }] },
      { who: 'caretaker', access: [{ module: 'estates', role: 'CARETAKER' }] },
    ],
  });
});

afterAll(async () => {
  await app?.stop();
});

describe('estates', () => {
  it('escalates rent on each anniversary', () => {
    const lease = { rent: '10000', escalationPct: 10, startDate: new Date('2025-03-01') };
    expect(rentFor(lease, '2026-02').toFixed(2)).toBe('10000.00');
    expect(rentFor(lease, '2026-03').toFixed(2)).toBe('11000.00');
    expect(rentFor(lease, '2027-03').toFixed(2)).toBe('12100.00');
  });

  it('lets a unit on a lease with a deposit', async () => {
    const p = await app.call<{ id: string; units: { id: string; code: string }[] }>('officer', 'POST', '/estates/properties', { code: 'hq-plaza', name: 'Head office plaza', kind: 'COMMERCIAL', units: [{ code: 'g1', description: 'Ground floor shop 1', marketRent: '25000' }, { code: 'g2', marketRent: '25000' }] }, 201);
    ids.property = p.id;
    ids.unit = p.units[0].id;
    ids.tenant = (await app.call<{ id: string }>('officer', 'POST', '/estates/tenants', { name: 'Mama Mboga Stores', kind: 'COMPANY', phone: '0722000111' }, 201)).id;
    const l = await app.call<{ id: string; number: string }>('officer', 'POST', '/estates/leases', { tenantId: ids.tenant, propertyId: p.id, unitId: ids.unit, startDate: '2026-01-01', endDate: '2027-12-31', rent: '20000', serviceCharge: '2000', deposit: '40000', dueDay: 5 }, 201);
    ids.lease = l.id;
    expect(l.number).toBe('LSE-0001');
    await app.call('officer', 'POST', '/estates/leases', { tenantId: ids.tenant, propertyId: p.id, unitId: ids.unit, startDate: '2026-06-01', endDate: '2026-12-31', rent: '1' }, 409);
    await app.call('caretaker', 'POST', '/estates/leases', { tenantId: ids.tenant, propertyId: p.id, unitId: p.units[1].id, startDate: '2026-06-01', endDate: '2026-12-31', rent: '1' }, 403);
    await app.call('officer', 'POST', `/estates/leases/${l.id}/receive`, { date: '2026-01-02', amount: '40000', kind: 'DEPOSIT', reference: 'DEP1' }, 200);
    await app.call('officer', 'POST', `/estates/leases/${l.id}/receive`, { date: '2026-01-02', amount: '1', kind: 'DEPOSIT' }, 400);
  });

  it('bills rent monthly, takes payments and shows arrears', async () => {
    expect(await app.call<{ billed: number; total: string }>('officer', 'POST', '/estates/rent/bill', { period: '2026-01' }, 200)).toMatchObject({ billed: 1, total: '22000' });
    expect((await app.call<{ billed: number }>('officer', 'POST', '/estates/rent/bill', { period: '2026-01' }, 200)).billed).toBe(0);
    await app.call('officer', 'POST', '/estates/rent/bill', { period: '2026-02' }, 200);
    const s = await app.call<Statement>('officer', 'POST', `/estates/leases/${ids.lease}/receive`, { date: '2026-02-03', amount: '30000', reference: 'MPESA QX1' }, 200);
    expect(s).toMatchObject({ balance: '14000', depositHeld: '40000' });
    expect(s.statement.map((e) => e.kind)).toEqual(['DEPOSIT_PAID', 'RENT', 'SERVICE', 'PAYMENT', 'RENT', 'SERVICE']);
    const roll = await app.call<{ rows: { unit: string; occupied: boolean; lease: { balance: string; arrearsDays: number } | null }[]; totals: { units: number; occupied: number; arrears: string; depositsHeld: string } }>('officer', 'GET', '/estates/rent-roll');
    expect(roll.totals).toMatchObject({ units: 2, occupied: 1, arrears: '14000', depositsHeld: '40000' });
    expect(roll.rows.find((r) => r.unit === 'G1')?.lease?.arrearsDays).toBeGreaterThan(200); // February's bill, part paid
    const sms = await app.platform.core.db.sms.find({ to: '+254722000111', purpose: 'estates:rent' }).lean();
    expect(sms).toHaveLength(2);
  });

  it('takes repair requests from the tenant portal and the caretaker closes them', async () => {
    const link = await app.call<{ path: string }>('officer', 'POST', `/estates/tenants/${ids.tenant}/portal`, undefined, 200);
    const token = link.path.split('/').pop()!;
    const view = await app.call<{ tenant: string; leases: { number: string; balance: string }[] }>('anyone', 'GET', `/estates/tenant-portal/${token}`);
    expect(view).toMatchObject({ tenant: 'Mama Mboga Stores', leases: [expect.objectContaining({ number: 'LSE-0001', balance: '14000' })] });
    const req = await app.call<{ number: string }>('anyone', 'POST', `/estates/tenant-portal/${token}/requests`, { leaseId: ids.lease, category: 'PLUMBING', description: 'The sink in the shop is leaking' }, 201);
    expect(req.number).toBe('MNT-00001');
    const list = await app.call<{ id: string; tenant: string; unit: string; raisedBy: string }[]>('caretaker', 'GET', '/estates/maintenance?status=OPEN');
    expect(list[0]).toMatchObject({ tenant: 'Mama Mboga Stores', unit: 'G1', raisedBy: 'TENANT' });
    await app.call('caretaker', 'PATCH', `/estates/maintenance/${list[0].id}`, { status: 'DONE' }, 400);
    await app.call('caretaker', 'PATCH', `/estates/maintenance/${list[0].id}`, { status: 'DONE', resolution: 'Replaced the trap', cost: '1500' }, 200);
    expect(await app.platform.core.db.sms.countDocuments({ purpose: 'estates:maintenance' })).toBe(2);
    await app.call('anyone', 'GET', '/estates/tenant-portal/not-a-real-token-at-all', undefined, 404);
  });

  it('ends a lease, applying the deposit and refunding the rest', async () => {
    const ended = await app.call<Statement & { depositApplied: string; depositRefunded: string }>('officer', 'POST', `/estates/leases/${ids.lease}/end`, { date: '2026-03-01', reason: 'Tenant moving', deductions: '1000', refundReference: 'CHQ 0091' }, 200);
    expect(ended).toMatchObject({ status: 'TERMINATED', depositApplied: '15000', depositRefunded: '25000', balance: '0' });
    await app.call('officer', 'POST', `/estates/leases/${ids.lease}/end`, { date: '2026-03-01' }, 400);
    const roll = await app.call<{ totals: { occupied: number } }>('officer', 'GET', '/estates/rent-roll');
    expect(roll.totals.occupied).toBe(0);
  });
});
