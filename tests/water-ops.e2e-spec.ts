import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WaterServices } from '../src/modules/water/server/container';
import { ACCOUNTS, connectLedger, seedWater, startApp, TestApp } from './helpers';

/**
 * Technical operations: facilities, production with chemical dosing, water quality, reservoirs and
 * supply timetables, the network map, field jobs from complaints, preventive maintenance, kiosks,
 * bowsers and the WASREB indicators.
 */

let app: TestApp;
let s: WaterServices;
let w: Awaited<ReturnType<typeof seedWater>>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await startApp('water_ops_e2e', {
    modules: ['water'],
    users: [
      { who: 'admin', isAdmin: true },
      { who: 'operator', access: [{ module: 'water', role: 'OPERATOR' }] },
      { who: 'tech', access: [{ module: 'water', role: 'TECHNICAL' }] },
      { who: 'crew', access: [{ module: 'water', role: 'FIELD_CREW' }] },
      { who: 'manager', access: [{ module: 'water', role: 'MANAGER' }] },
    ],
  });
  s = app.platform.modules.water as WaterServices;
  w = await seedWater(app, ['Kiprono Kirui', 'Chebet Jepkosgei']);
  await connectLedger(app, ACCOUNTS);
});

afterAll(async () => app?.stop());

describe('production and quality', () => {
  it('records a day of production and books the chlorine used', async () => {
    const works = await app.call<{ id: string }>('tech', 'POST', '/water/facilities', { code: 'tws', name: 'Tachasis treatment works', type: 'TREATMENT_WORKS', capacity: '2000', gps: { lat: 0.05, lng: 35.3 } });
    ids.works = works.id;
    const hth = await app.call<{ id: string }>('operator', 'POST', '/water/chemicals', { code: 'HTH', name: 'HTH chlorine granules', unit: 'kg', reorderLevel: '20' });
    await app.call('operator', 'POST', '/water/chemicals/movements', { chemicalId: hth.id, date: '2026-10-01', quantity: '50', type: 'RECEIPT', reference: 'GRN-0001' });
    await app.call('operator', 'POST', '/water/production', { facilityId: works.id, date: '2026-10-02', abstracted: '1500', treated: '1450', supplied: '1400', powerKwh: '700', chemicals: [{ chemicalId: hth.id, quantity: '12' }] });
    // Entering the same day again replaces it rather than double-booking the chemical.
    await app.call('operator', 'POST', '/water/production', { facilityId: works.id, date: '2026-10-02', abstracted: '1500', treated: '1450', supplied: '1400', powerKwh: '700', chemicals: [{ chemicalId: hth.id, quantity: '35' }] });
    const [chem] = await app.call<{ stock: string; low: boolean }[]>('operator', 'GET', '/water/chemicals');
    expect(chem).toMatchObject({ stock: '15', low: true });
    await app.call('operator', 'POST', '/water/production', { facilityId: works.id, date: '2026-10-03', supplied: '1', chemicals: [{ chemicalId: hth.id, quantity: '100' }] }, 400);
    const prod = await app.call<{ totals: { supplied: string }; kwhPerM3: string }>('operator', 'GET', '/water/production?from=2026-10-01&to=2026-10-31');
    expect(prod.totals.supplied).toBe('1400.00');
    expect(prod.kwhPerM3).toBe('0.500');
  });

  it('judges water tests and raises an incident for a failure', async () => {
    const ok = await app.call<{ passed: boolean }>('operator', 'POST', '/water/quality', { sampledAt: '2026-10-05T09:00:00+03:00', point: 'NETWORK', zoneId: w.zoneId, residualChlorine: '0.3', turbidity: '1', ph: '7.2', eColi: '0' });
    expect(ok.passed).toBe(true);
    const bad = await app.call<{ passed: boolean; failures: string[] }>('operator', 'POST', '/water/quality', { sampledAt: '2026-10-06T09:00:00+03:00', point: 'CONSUMER_TAP', zoneId: w.zoneId, location: 'Kapsoen market tap', residualChlorine: '0.05', eColi: '4' });
    expect(bad.passed).toBe(false);
    expect(bad.failures).toHaveLength(2);
    const incident = await s.db.tickets.findOne({ category: 'WATER_QUALITY' }).lean();
    expect(incident).toMatchObject({ priority: 'EMERGENCY', location: 'Kapsoen market tap' });
    const c = await app.call<{ chlorineCompliancePercent: number; bacteriaCompliancePercent: number }>('operator', 'GET', '/water/quality/compliance?from=2026-10-01&to=2026-10-31');
    expect(c).toMatchObject({ chlorineCompliancePercent: 50, bacteriaCompliancePercent: 50 });
  });

  it('keeps reservoir levels and supply timetables', async () => {
    const tank = await app.call<{ id: string }>('tech', 'POST', '/water/facilities', { code: 'R1', name: 'Kamelil reservoir', type: 'RESERVOIR', capacity: '500', zoneId: w.zoneId });
    const level = await app.call<{ volume: string }>('operator', 'POST', '/water/reservoirs/levels', { facilityId: tank.id, at: '2026-11-01T06:00:00+03:00', levelPercent: 60 });
    expect(level.volume).toBe('300');
    await app.call('operator', 'POST', '/water/supply-schedules', { zoneId: w.zoneId, days: [1, 3, 5], from: '06:00', to: '18:00' });
    const hours = await app.call<{ hours: number }[]>('operator', 'GET', '/water/supply-schedules/hours');
    expect(hours[0].hours).toBe(5.1);
  });
});

describe('network and field jobs', () => {
  it('draws pipes, measures them and exchanges GeoJSON', async () => {
    const pipe = await app.call<{ lengthM: number }>('tech', 'POST', '/water/network', { type: 'PIPE', code: 'P-001', material: 'uPVC', diameterMm: 110, geometry: { type: 'LineString', coordinates: [[35.3, 0.05], [35.301, 0.05]] } });
    expect(pipe.lengthM).toBeGreaterThan(110);
    expect(pipe.lengthM).toBeLessThan(112);
    await app.call('tech', 'POST', '/water/network', { type: 'VALVE', geometry: { type: 'Point', coordinates: [200, 0] } }, 400);
    const imported = await app.call<{ created: number; updated: number }>('tech', 'POST', '/water/network/import', {
      collection: { features: [{ geometry: { type: 'Point', coordinates: [35.3005, 0.05] }, properties: { type: 'VALVE', code: 'V-01' } }, { geometry: { type: 'LineString', coordinates: [[35.3, 0.05], [35.302, 0.051]] }, properties: { code: 'P-001', material: 'HDPE' } }] },
    }, 200);
    expect(imported).toMatchObject({ created: 1, updated: 1 });
    await s.db.customers.updateOne({ _id: w.customers[0].id }, { gps: { lat: 0.0501, lng: 35.3002 } });
    const fc = await app.call<{ features: { properties: { layer: string } }[] }>('tech', 'GET', '/water/network/geojson?layers=network,customers,meters,facilities');
    expect(fc.features.map((f) => f.properties.layer).sort()).toEqual(['customers', 'facilities', 'meters', 'network', 'network']);
    const near = await app.call<unknown[]>('tech', 'GET', '/water/network?bbox=35.2999,0.0499,35.3006,0.0501');
    expect(near.length).toBe(2);
  });

  it('turns a leak complaint into a job card that resolves it when done', async () => {
    const ticket = await app.call<{ id: string }>('manager', 'POST', '/water/tickets', { category: 'LEAK', channel: 'PHONE', customerId: w.customers[1].id, subject: 'Leak on the service line' });
    const job = await app.call<{ id: string; number: string; type: string }>('manager', 'POST', `/water/tickets/${ticket.id}/work-order`, {});
    expect(job.type).toBe('LEAK_REPAIR');
    const crew = await s.db.users.findOne({ email: 'crew@test.co' }).lean();
    await app.call('crew', 'POST', `/water/work-orders/${job.id}/start`, undefined, 403);
    await app.call('manager', 'POST', `/water/work-orders/${job.id}/assign`, { assignedTo: [crew!._id.toHexString()] }, 200);
    const mine = await app.call<{ items: { number: string }[] }>('crew', 'GET', '/water/work-orders?mine=true&active=true');
    expect(mine.items.map((j) => j.number)).toEqual([job.number]);
    await app.call('crew', 'POST', `/water/work-orders/${job.id}/start`, undefined, 200);
    const done = await app.call<{ status: string; materialsCost: string }>('crew', 'POST', `/water/work-orders/${job.id}/complete`, { findings: 'Replaced 2 m of 20 mm pipe', labourHours: '2', materials: [{ itemCode: 'PPR20', description: '20 mm PPR pipe', quantity: '2', unitCost: '150' }] }, 200);
    expect(done).toMatchObject({ status: 'DONE', materialsCost: '300' });
    expect((await s.db.tickets.findById(ticket.id).lean())?.status).toBe('RESOLVED');
    await app.call('manager', 'POST', `/water/work-orders/${job.id}/close`, { accept: true }, 200);
  });

  it('raises preventive maintenance jobs when they come due', async () => {
    await app.call('tech', 'POST', '/water/maintenance-plans', { name: 'Service raw water pump 1', facilityId: ids.works, frequencyDays: 90, leadDays: 7, nextDue: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), checklist: ['Grease bearings', 'Check gland packing'] });
    const first = await app.call<{ raised: string[] }>('tech', 'POST', '/water/maintenance-plans/raise-due', {}, 200);
    expect(first.raised).toHaveLength(1);
    const again = await app.call<{ raised: string[] }>('tech', 'POST', '/water/maintenance-plans/raise-due', {}, 200);
    expect(again.raised).toHaveLength(0);
  });
});

describe('kiosks, bowsers and WASREB', () => {
  it('records kiosk sales and bills a bowser delivery', async () => {
    const kiosk = await app.call<{ id: string }>('tech', 'POST', '/water/facilities', { code: 'K1', name: 'Kapsoen kiosk', type: 'KIOSK', pricePerJerrican: '5', operator: { name: 'Jane' } });
    await app.call('tech', 'POST', '/water/kiosks/sales', { facilityId: kiosk.id, date: '2026-10-10', jerricans: 400 });
    const sales = await app.call<{ summary: { volume: string; amount: string }[] }>('tech', 'GET', '/water/kiosks/sales?from=2026-10-01&to=2026-10-31');
    expect(sales.summary[0]).toMatchObject({ volume: '8.00', amount: '2000.00' });
    const trip = await app.call<{ number: string; billRunId: string }>('tech', 'POST', '/water/bowser-trips', { date: '2026-10-12', vehicleReg: 'kca 123x', destination: 'Kamelil school', customerId: w.customers[0].id, volume: '10', rate: '150' });
    expect(trip.billRunId).toBeTruthy();
    const run = await s.db.billRuns.findById(trip.billRunId).lean();
    expect(run).toMatchObject({ kind: 'SUPPLEMENTARY', status: 'DRAFT' });
    expect(run?.totalAmount?.toString()).toBe('1500');
  });

  it('works out the WASREB indicators', async () => {
    await app.call('admin', 'PATCH', '/water/settings/regulatory', { populationInArea: 40, peoplePerConnection: 5, staffCount: 1 });
    const r = await app.call<{ rows: { key: string; value: number | null; rating: string }[] }>('admin', 'GET', '/water/reports/wasreb?period=2026-10');
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    // 2 domestic connections × 5 people + 1 kiosk × 300, capped at 100% of 40 people.
    expect(by.coverage.value).toBe(100);
    expect(by.metering).toMatchObject({ value: 100, rating: 'GOOD' });
    expect(by.hours.value).toBe(5.1);
    expect(by.chlorine).toMatchObject({ value: 50, rating: 'NOT_ACCEPTABLE' });
    expect(by.staff.value).toBe(500);
    const csv = await (await app.raw('admin', 'GET', '/water/reports/wasreb?period=2026-10&csv=true')).text();
    expect(csv.split('\n')[0]).toBe('Indicator,Value,Unit,Rating,Good,Acceptable,Basis');
  });

  it('takes SCADA telemetry with alarms and smart-meter readings from a gateway', async () => {
    await app.call('admin', 'POST', '/water/telemetry/points', { code: 'RES1.LVL', name: 'Kapsoya reservoir level', kind: 'LEVEL', unit: 'm', low: 1.5, high: 5 }, 201);
    await app.call('admin', 'POST', '/water/telemetry/points', { code: 'BAD', name: 'Bad', low: 5, high: 1 }, 400);
    const t0 = new Date('2026-10-20T06:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000).toISOString();
    const r1 = await app.call<{ points: { stored: number; unknownCodes: string[]; alarms: { alarm: string }[] } }>('admin', 'POST', '/water/telemetry', { points: [{ code: 'res1.lvl', value: 3.2, at: at(0) }, { code: 'RES1.LVL', value: 1.2, at: at(15) }, { code: 'PUMP9', value: 1, at: at(0) }] }, 200);
    expect(r1.points).toMatchObject({ stored: 2, unknownCodes: ['PUMP9'], alarms: [{ alarm: 'LOW' }] });
    expect((await app.call<{ points: { stored: number } }>('admin', 'POST', '/water/telemetry', { points: [{ code: 'RES1.LVL', value: 1.2, at: at(15) }] }, 200)).points.stored).toBe(0); // resent
    const back = await app.call<{ points: { alarms: { alarm: string }[] } }>('admin', 'POST', '/water/telemetry', { points: [{ code: 'RES1.LVL', value: 2.8, at: at(30) }] }, 200);
    expect(back.points.alarms).toEqual([expect.objectContaining({ alarm: 'NONE' })]);
    const points = await app.call<{ id: string; alarm: string; lastValue: number }[]>('tech', 'GET', '/water/telemetry/points');
    expect(points[0]).toMatchObject({ alarm: 'NONE', lastValue: 2.8 });
    const s = await app.call<{ samples: unknown[]; min: number; max: number }>('tech', 'GET', `/water/telemetry/points/${points[0].id}/series?from=2026-10-20&to=2026-10-20`);
    expect(s).toMatchObject({ min: 1.2, max: 3.2 });
    expect(s.samples).toHaveLength(3);
    expect(await app.platform.core.db.notifications.countDocuments({ title: /ALARM LOW/ })).toBeGreaterThan(0);

    // Smart meters: the latest value per meter is captured as a reading.
    await app.call('admin', 'POST', '/water/cycles', { period: '2026-11' }).catch(() => undefined);
    const m = await app.call<{ meters: { imported: number; failed: number } }>('admin', 'POST', '/water/telemetry', { meters: [{ serialNo: w.customers[0].serialNo, reading: '130', at: '2026-11-02T08:00:00Z' }, { serialNo: w.customers[0].serialNo, reading: '131', at: '2026-11-03T08:00:00Z' }, { serialNo: 'NOPE', reading: '1', at: '2026-11-03T08:00:00Z' }] }, 200);
    expect(m.meters).toMatchObject({ imported: 1, failed: 1 });
  });

  it('prepares the WASPA annual return for the financial year', async () => {
    const r = await app.call<{ financialYear: string; lines: { section: string; item: string; value: string | number | null }[] }>('admin', 'GET', '/water/reports/waspa?fyEnd=2027');
    expect(r.financialYear).toBe('2026/27');
    const line = (item: string) => r.lines.find((l) => l.item === item)?.value;
    expect(line('Active connections')).toBe(2);
    expect(line('Metering ratio')).toBe(100);
    expect(line('Water kiosks')).toBe(1);
    expect(line('Staff per 1,000 connections')).toBe(500);
    expect(r.lines.filter((l) => l.section.startsWith('Finance')).every((l) => l.value === null)).toBe(true);
    const csv = await (await app.raw('admin', 'GET', '/water/reports/waspa?fyEnd=2027&csv=true')).text();
    expect(csv.split('\n')[0]).toBe('Section,Item,Value,Unit,Source');
  });
});
