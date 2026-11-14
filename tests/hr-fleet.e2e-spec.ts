import bcrypt from 'bcryptjs';
import mongoose, { Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hrModule } from '../src/modules/hr/module';
import type { HrServices } from '../src/modules/hr/server/container';
import { createApi } from '../src/platform/api';
import { createPlatform, Platform } from '../src/platform/container';

/**
 * Transport and fleet: vehicles and drivers, a transport request approved by the department and
 * allocated only to a fit, free vehicle and licensed driver, the work ticket's odometer readings, fuel
 * consumption and fuel-card limits, repairs and the keep-or-dispose test, incidents, alerts and reports.
 */

let replSet: MongoMemoryReplSet;
let conn: Connection;
let platform: Platform;
let handle: (req: Request) => Promise<Response>;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const PASSWORD = 'password-123456';

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await handle(new Request(`http://platform.test/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(cookies[who] && { cookie: cookies[who] }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null) as T };
}
const ok = async <T = Record<string, unknown>>(p: Promise<{ status: number; data: T }>, status = 200) => {
  const r = await p;
  if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);
  return r.data;
};
const fail = async (p: Promise<{ status: number; data: unknown }>, status = 400) => {
  const r = await p;
  expect(r.status).toBe(status);
  return (r.data as { message: string }).message;
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.JWT_SECRET = 'e2e-test-secret-that-is-at-least-32-characters';
  conn = await mongoose.createConnection(replSet.getUri('hr_fleet_e2e')).asPromise();
  const modules = [hrModule];
  platform = await createPlatform(conn, { modules });
  handle = createApi(async () => platform, modules);
  const { db } = platform.core;
  const [org] = await db.organisations.create([{ name: 'Tachasis Water', code: 'TACH', modules: ['hr'] }]);
  const hr = platform.modules.hr as HrServices;
  await hrModule.seed!({ db, core: platform.core, services: hr, organisationId: org._id, demo: false, demoPassword: PASSWORD });
  ids.TEC = (await hr.db.departments.findOne({ organisationId: org._id, code: 'TEC' }).lean())!._id.toHexString();
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.users.create([
    { organisationId: org._id, email: 'hr@test.co', name: 'HR', access: [{ module: 'hr', role: 'HR_MANAGER' }], passwordHash: hash },
    { organisationId: org._id, email: 'transport@test.co', name: 'Transport', access: [{ module: 'hr', role: 'TRANSPORT_OFFICER' }], passwordHash: hash },
  ]);
  for (const who of ['hr', 'transport']) expect((await call(who, 'POST', '/auth/login', { email: `${who}@test.co`, password: PASSWORD })).status).toBe(200);
  const person = (firstName: string, extra: Record<string, unknown> = {}) => ({ firstName, lastName: 'Test', departmentId: ids.TEC, hireDate: '2020-01-01', nationalId: String(32000000 + firstName.charCodeAt(0) * 11 + firstName.charCodeAt(1)), ...extra });
  for (const n of ['Dan', 'Ruth']) ids[n] = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', person(n)), 201)).id;
  ids.Rita = (await ok<{ id: string }>(call('hr', 'POST', '/hr/employees', person('Rita', { email: 'rita@test.co' })), 201)).id;
  await ok(call('hr', 'POST', `/hr/employees/${ids.Rita}/portal`, { password: PASSWORD }));
  expect((await call('rita', 'POST', '/auth/login', { email: 'rita@test.co', password: PASSWORD })).status).toBe(200);
});

afterAll(async () => {
  await conn?.close();
  await replSet?.stop();
});

describe('Transport and fleet', () => {
  it('keeps vehicles and drivers', async () => {
    ids.KCA = (await ok<{ id: string }>(call('transport', 'POST', '/hr/fleet/vehicles', { regNo: 'kca 123a', make: 'Toyota', model: 'Hilux', type: 'PICKUP', seats: 5, odometer: 10000, lastServiceKm: 9000, purchaseDate: '2018-07-01', purchaseCost: '3000000', insurance: { insurer: 'Jubilee', expiresOn: '2027-06-30' }, inspectionDue: '2027-03-01', fuelCard: { number: 'FC-1', monthlyLimit: '10000' } }), 201)).id;
    ids.KCB = (await ok<{ id: string }>(call('transport', 'POST', '/hr/fleet/vehicles', { regNo: 'KCB 456B', make: 'Isuzu', model: 'D-Max', type: 'PICKUP', seats: 5, odometer: 50000, lastServiceKm: 45500, insurance: { insurer: 'APA', expiresOn: '2026-12-01' } }), 201)).id;
    expect(await fail(call('transport', 'POST', '/hr/fleet/vehicles', { regNo: 'KCA 123A', make: 'Toyota' }), 409)).toMatch(/already in the fleet/);
    expect((await call('hr', 'POST', '/hr/fleet/vehicles', { regNo: 'KCC 1', make: 'X' })).status).toBe(403);
    ids.dan = (await ok<{ id: string }>(call('transport', 'POST', '/hr/fleet/drivers', { employeeId: ids.Dan, licenceNo: 'DL-100', licenceClasses: ['B', 'C'], licenceExpiry: '2028-01-31' }))).id;
    ids.ruth = (await ok<{ id: string }>(call('transport', 'POST', '/hr/fleet/drivers', { employeeId: ids.Ruth, licenceNo: 'DL-200', licenceClasses: ['B'], licenceExpiry: '2026-12-01' }))).id;
  });

  it('allocates only a fit, free vehicle and a licensed driver to an approved request', async () => {
    const t = await ok<{ id: string; number: string; status: string }>(call('rita', 'POST', '/hr/fleet/trips', { purpose: 'Meter audit', destination: 'Kapsabet', from: '2026-12-15T05:00:00Z', to: '2026-12-15T14:00:00Z', passengers: 3 }), 201);
    ids.trip = t.id;
    expect(t.number).toBe('TR-00001');
    expect((await call('rita', 'POST', `/hr/fleet/trips/${t.id}/decide`, { approve: true })).status).toBe(403);
    expect(await fail(call('transport', 'POST', `/hr/fleet/trips/${t.id}/allocate`, { vehicleId: ids.KCA, driverId: ids.dan }))).toMatch(/Only approved/);
    await ok(call('hr', 'POST', `/hr/fleet/trips/${t.id}/decide`, { approve: true }));

    const options = await ok<{ vehicles: { regNo: string; problems: string[] }[]; drivers: { name: string; problems: string[] }[] }>(call('transport', 'GET', `/hr/fleet/trips/${t.id}/options`));
    expect(options.vehicles.find((v) => v.regNo === 'KCB 456B')!.problems.join()).toMatch(/insurance expires 2026-12-01/);
    expect(options.drivers.find((d) => d.name.startsWith('Ruth'))!.problems.join()).toMatch(/licence expires/);
    expect(await fail(call('transport', 'POST', `/hr/fleet/trips/${t.id}/allocate`, { vehicleId: ids.KCB, driverId: ids.dan }))).toMatch(/insurance/);
    expect(await fail(call('transport', 'POST', `/hr/fleet/trips/${t.id}/allocate`, { vehicleId: ids.KCA, driverId: ids.ruth }))).toMatch(/licence expires/);
    expect(await ok(call('transport', 'POST', `/hr/fleet/trips/${t.id}/allocate`, { vehicleId: ids.KCA, driverId: ids.dan }))).toMatchObject({ status: 'ALLOCATED' });

    const clash = await ok<{ id: string }>(call('rita', 'POST', '/hr/fleet/trips', { purpose: 'Site visit', destination: 'Nandi Hills', from: '2026-12-15T10:00:00Z', to: '2026-12-15T12:00:00Z', passengers: 1 }), 201);
    await ok(call('hr', 'POST', `/hr/fleet/trips/${clash.id}/decide`, { approve: true }));
    expect(await fail(call('transport', 'POST', `/hr/fleet/trips/${clash.id}/allocate`, { vehicleId: ids.KCA, driverId: ids.dan }))).toMatch(/KCA 123A is booked on TR-00001; The driver is booked on TR-00001/);

    const board = await ok<{ vehicles: { regNo: string; status: string; next: { number: string } | null }[]; drivers: { name: string; status: string }[] }>(call('transport', 'GET', '/hr/fleet/board?at=2026-12-15T08:00:00Z'));
    expect(board.vehicles.find((v) => v.regNo === 'KCA 123A')).toMatchObject({ status: 'BOOKED' });
    expect(board.drivers.find((d) => d.name.startsWith('Dan'))).toMatchObject({ status: 'BOOKED' });
  });

  it('runs the work ticket from odometer out to odometer in', async () => {
    expect(await fail(call('transport', 'POST', `/hr/fleet/trips/${ids.trip}/dispatch`, { odometerOut: 9000 }))).toMatch(/at least 10000/);
    const out = await ok<{ status: string; ticket: { number: string } }>(call('transport', 'POST', `/hr/fleet/trips/${ids.trip}/dispatch`, { odometerOut: 10050 }));
    expect(out).toMatchObject({ status: 'IN_PROGRESS', ticket: { number: 'WT-00001' } });
    expect(await fail(call('transport', 'POST', `/hr/fleet/trips/${ids.trip}/return`, { odometerIn: 10000 }))).toMatch(/more than 10050/);
    expect(await ok(call('transport', 'POST', `/hr/fleet/trips/${ids.trip}/return`, { odometerIn: 10180, remarks: 'Fine' }))).toMatchObject({ status: 'COMPLETED', ticket: { distance: 130 } });
    expect((await ok<{ vehicle: { odometer: number } }>(call('transport', 'GET', `/hr/fleet/vehicles/${ids.KCA}`))).vehicle.odometer).toBe(10180);
  });

  it('analyses fuel and keeps the fuel card within its limit', async () => {
    await ok(call('transport', 'POST', '/hr/fleet/fuel', { vehicleId: ids.KCA, date: '2026-12-16', litres: 40, amount: '7000', odometer: 10200, viaCard: true }), 201);
    expect(await fail(call('transport', 'POST', '/hr/fleet/fuel', { vehicleId: ids.KCA, date: '2026-12-20', litres: 20, amount: '4000', odometer: 10400, viaCard: true }))).toMatch(/monthly limit of 10000\.00/);
    expect(await fail(call('transport', 'POST', '/hr/fleet/fuel', { vehicleId: ids.KCA, date: '2026-12-20', litres: 20, amount: '4000', odometer: 10100 }))).toMatch(/odometer was 10200/);
    await ok(call('transport', 'POST', '/hr/fleet/fuel', { vehicleId: ids.KCA, date: '2026-12-28', litres: 40, amount: '7200', odometer: 10600, station: 'Kapsabet' }), 201);
    await ok(call('transport', 'POST', '/hr/fleet/fuel', { vehicleId: ids.KCB, date: '2026-12-10', litres: 40, amount: '7000', odometer: 50000 }), 201);
    await ok(call('transport', 'POST', '/hr/fleet/fuel', { vehicleId: ids.KCB, date: '2026-12-29', litres: 40, amount: '7000', odometer: 50200 }), 201);
    const analysis = await ok<{ regNo: string; litres: number; distance: number; kmPerLitre: number; costPerKm: string; flag: string }[]>(call('transport', 'GET', '/hr/fleet/fuel-analysis?from=2026-12-01&to=2026-12-31'));
    expect(analysis.find((r) => r.regNo === 'KCA 123A')).toMatchObject({ litres: 80, distance: 400, kmPerLitre: 10, costPerKm: '35.5', flag: '' });
    expect(analysis.find((r) => r.regNo === 'KCB 456B')!.flag).toMatch(/more fuel than similar vehicles/);
  });

  it('tracks repairs and incidents and judges whether to keep the vehicle', async () => {
    await ok(call('transport', 'POST', '/hr/fleet/maintenance', { vehicleId: ids.KCA, date: '2026-12-28', kind: 'SERVICE', description: '10,000 km service', cost: '15000', odometer: 10600 }), 201);
    await ok(call('transport', 'POST', '/hr/fleet/maintenance', { vehicleId: ids.KCA, date: '2026-12-29', kind: 'REPAIR', description: 'Gearbox overhaul', garage: 'CMC', cost: '900000', daysOff: 10 }), 201);
    const history = await ok<{ vehicle: { lastServiceKm: number }; assessment: { recommendation: string; reasons: string[]; lastYearPercentOfCost: number } }>(call('transport', 'GET', `/hr/fleet/vehicles/${ids.KCA}`));
    expect(history.vehicle.lastServiceKm).toBe(10600);
    expect(history.assessment).toMatchObject({ recommendation: 'REVIEW', lastYearPercentOfCost: 30.5 });

    const inc = await ok<{ id: string; number: string }>(call('transport', 'POST', '/hr/fleet/incidents', { vehicleId: ids.KCA, driverId: ids.dan, date: '2026-12-30', kind: 'ACCIDENT', location: 'Kapsabet road', description: 'Rear-ended at a junction', policeAbstract: 'OB 12/30', groundVehicle: true }), 201);
    expect(inc.number).toBe('INC-0001');
    expect((await ok<{ vehicle: { status: string } }>(call('transport', 'GET', `/hr/fleet/vehicles/${ids.KCA}`))).vehicle.status).toBe('UNDER_REPAIR');
    await ok(call('transport', 'POST', `/hr/fleet/incidents/${inc.id}/close`, { outcome: 'Insurer paid', cost: '80000' }));
  });

  it('alerts on insurance, licences and service, and reports on the fleet', async () => {
    const alerts = await ok<{ kind: string; subject: string; overdue: boolean }[]>(call('transport', 'GET', '/hr/fleet/alerts?days=30&asOf=2026-11-20'));
    expect(alerts.map((a) => `${a.kind}:${a.subject}`).sort()).toEqual(['INSURANCE:KCB 456B', 'LICENCE:Ruth Test', 'SERVICE:KCB 456B'].sort());
    const report = await ok<{ requests: number; byStatus: Record<string, number>; departments: { trips: number; distance: number }[]; vehicles: { regNo: string; trips: number; distance: number; daysInUse: number; utilisationPercent: number; fuelCost: string; repairCost: string; incidents: number }[] }>(call('hr', 'GET', '/hr/fleet/report?from=2026-12-01&to=2026-12-31'));
    expect(report).toMatchObject({ requests: 2, byStatus: { COMPLETED: 1, APPROVED: 1 } });
    expect(report.departments[0]).toMatchObject({ trips: 1, distance: 130 });
    expect(report.vehicles.find((v) => v.regNo === 'KCA 123A')).toMatchObject({ trips: 1, distance: 130, daysInUse: 1, utilisationPercent: 3.2, fuelCost: '14200', repairCost: '915000', incidents: 1 });
  });
});
