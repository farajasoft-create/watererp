import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/water/manifest';
import { parseId, zBool, zDate, zDecimal, zId, zPage, zPeriod } from '@/platform/common/validation';
import { FACILITY_TYPES, FEATURE_TYPES, SAMPLE_POINTS, WORK_PRIORITIES, WORK_STATUSES, WORK_TYPES } from '../ops-schemas';
import { POINT_KINDS } from '../ops/telemetry.service';
import { ForbiddenException } from '@/platform/common/errors';
import { route } from '../route';

const optionalText = (max: number) => z.string().trim().max(max).optional();
const gps = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const decimalOpt = zDecimal.nullable().optional();

const FacilityBody = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.enum(FACILITY_TYPES),
  zoneId: zId.nullable().optional(),
  gps,
  capacity: zDecimal.optional(),
  operator: z.object({ name: optionalText(120), phone: optionalText(20) }).optional(),
  customerId: zId.nullable().optional(),
  pricePerJerrican: zDecimal.optional(),
  commissionedOn: zDate.nullable().optional(),
  active: z.boolean().optional(),
  notes: optionalText(500),
});

const Geometry = z.object({ type: z.enum(['Point', 'LineString', 'Polygon']), coordinates: z.unknown().refine((v) => Array.isArray(v), 'coordinates must be an array') }).transform((g) => ({ type: g.type, coordinates: g.coordinates as unknown }));

const FeatureBody = z.object({
  type: z.enum(FEATURE_TYPES),
  code: optionalText(40),
  name: optionalText(120),
  zoneId: zId.nullable().optional(),
  geometry: Geometry,
  material: optionalText(40),
  diameterMm: z.number().int().min(10).max(3000).optional(),
  installedYear: z.number().int().min(1900).max(2100).optional(),
  condition: z.enum(['GOOD', 'FAIR', 'POOR', 'CRITICAL', 'UNKNOWN']).optional(),
  status: z.enum(['IN_SERVICE', 'ABANDONED', 'PLANNED']).optional(),
  attributes: z.record(z.unknown()).optional(),
});

const WorkBody = z.object({
  type: z.enum(WORK_TYPES),
  priority: z.enum(WORK_PRIORITIES).optional(),
  title: z.string().trim().min(3).max(200),
  description: optionalText(2000),
  customerId: zId.nullable().optional(),
  facilityId: zId.nullable().optional(),
  featureId: zId.nullable().optional(),
  assetRef: optionalText(60),
  zoneId: zId.nullable().optional(),
  location: optionalText(200),
  gps,
  assignedTo: z.array(zId).max(20).optional(),
  dueAt: zDate.nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});

const PlanBody = z.object({
  name: z.string().trim().min(3).max(150),
  facilityId: zId.nullable().optional(),
  featureId: zId.nullable().optional(),
  assetRef: optionalText(60),
  frequencyDays: z.number().int().min(1).max(3650),
  leadDays: z.number().int().min(0).max(90).optional(),
  nextDue: zDate,
  checklist: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  assignedTo: z.array(zId).max(20).optional(),
  estimatedHours: zDecimal.optional(),
  active: z.boolean().optional(),
});

const range = z.object({ from: zDate, to: zDate });

const PointBody = z.object({ code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9_.-]+$/, 'Letters, digits, . _ - only'), name: z.string().trim().min(2).max(120), kind: z.enum(POINT_KINDS).default('OTHER'), unit: optionalText(20), facilityId: zId.nullable().optional(), zoneId: zId.nullable().optional(), low: z.number().nullable().optional(), high: z.number().nullable().optional(), active: z.boolean().optional() });
const When = z.string().datetime({ offset: true }).transform((v) => new Date(v));

export const opsRoutes = [
  // Telemetry: SCADA points with alarms, and smart-meter readings, from any gateway (use an API key).
  route({ method: 'GET', path: '/telemetry/points', permissions: [P.OPS_VIEW], handler: ({ s, user }) => s.telemetry.points(user) }),
  route({ method: 'POST', path: '/telemetry/points', permissions: [P.NETWORK_MANAGE], body: PointBody, handler: ({ s, user, body }) => s.telemetry.savePoint(user, null, body) }),
  route({ method: 'PUT', path: '/telemetry/points/:id', permissions: [P.NETWORK_MANAGE], body: PointBody, handler: ({ s, user, params, body }) => s.telemetry.savePoint(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/telemetry/points/:id/series', permissions: [P.OPS_VIEW], query: range, handler: ({ s, user, params, query }) => s.telemetry.series(user, parseId(params.id), query.from, query.to) }),
  route({
    method: 'POST',
    path: '/telemetry',
    permissions: [P.PRODUCTION_RECORD],
    status: 200,
    body: z.object({ points: z.array(z.object({ code: z.string().trim().min(1).max(30), value: z.number(), at: When })).max(10_000).default([]), meters: z.array(z.object({ serialNo: z.string().trim().min(1).max(40), reading: zDecimal, at: When })).max(10_000).default([]) }),
    handler: ({ s, user, body }) => {
      if (body.meters.length && !user.permissions.includes(P.READING_CAPTURE)) throw new ForbiddenException('Missing permission: water.reading.capture');
      return s.telemetry.ingest(user, body);
    },
  }),
  // Facilities -------------------------------------------------------------------------------
  route({ method: 'GET', path: '/facilities', permissions: [P.OPS_VIEW], query: z.object({ type: z.enum(FACILITY_TYPES).optional() }), handler: ({ s, user, query }) => s.production.listFacilities(user, query.type) }),
  route({ method: 'POST', path: '/facilities', permissions: [P.NETWORK_MANAGE], body: FacilityBody, handler: ({ s, user, body }) => s.production.saveFacility(user, body) }),
  route({ method: 'PATCH', path: '/facilities/:id', permissions: [P.NETWORK_MANAGE], body: FacilityBody, handler: ({ s, user, params, body }) => s.production.saveFacility(user, body, parseId(params.id)) }),

  // Production, chemicals, quality, reservoirs, timetables ---------------------------------------
  route({ method: 'GET', path: '/production', permissions: [P.OPS_VIEW], query: range.extend({ facilityId: zId.optional() }), handler: ({ s, user, query }) => s.production.listProduction(user, query) }),
  route({
    method: 'POST',
    path: '/production',
    permissions: [P.PRODUCTION_RECORD],
    body: z.object({
      facilityId: zId,
      date: zDate,
      abstracted: zDecimal.optional(),
      treated: zDecimal.optional(),
      supplied: zDecimal.optional(),
      pumpHours: zDecimal.optional(),
      powerKwh: zDecimal.optional(),
      downtimeHours: zDecimal.optional(),
      chemicals: z.array(z.object({ chemicalId: zId, quantity: zDecimal })).max(20).optional(),
      note: optionalText(500),
    }),
    handler: ({ s, user, body }) => s.production.recordProduction(user, body),
  }),
  route({ method: 'GET', path: '/chemicals', permissions: [P.OPS_VIEW], handler: ({ s, user }) => s.production.listChemicals(user) }),
  route({
    method: 'POST',
    path: '/chemicals',
    permissions: [P.PRODUCTION_RECORD],
    body: z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(80), unit: optionalText(10), reorderLevel: zDecimal.optional(), unitCost: zDecimal.optional(), active: z.boolean().optional() }),
    handler: ({ s, user, body }) => s.production.saveChemical(user, body),
  }),
  route({
    method: 'POST',
    path: '/chemicals/movements',
    permissions: [P.PRODUCTION_RECORD],
    body: z.object({ chemicalId: zId, date: zDate, quantity: zDecimal, type: z.enum(['RECEIPT', 'ADJUSTMENT']), reference: optionalText(80) }),
    handler: ({ s, user, body }) => s.production.receiveChemical(user, body),
  }),
  route({ method: 'GET', path: '/chemicals/:id/movements', permissions: [P.OPS_VIEW], handler: ({ s, user, params }) => s.production.chemicalMovements(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/quality', permissions: [P.OPS_VIEW], query: range.extend({ failedOnly: zBool.optional() }), handler: ({ s, user, query }) => s.production.listQuality(user, query) }),
  route({ method: 'GET', path: '/quality/compliance', permissions: [P.OPS_VIEW], query: range, handler: ({ s, user, query }) => s.production.qualityCompliance(user.organisationId, query.from, new Date(query.to.getTime() + 86_400_000)) }),
  route({
    method: 'POST',
    path: '/quality',
    permissions: [P.QUALITY_RECORD],
    body: z.object({
      sampledAt: z.string().datetime({ offset: true }).transform((v) => new Date(v)),
      point: z.enum(SAMPLE_POINTS),
      facilityId: zId.nullable().optional(),
      zoneId: zId.nullable().optional(),
      location: optionalText(200),
      residualChlorine: decimalOpt,
      turbidity: decimalOpt,
      ph: decimalOpt,
      eColi: decimalOpt,
      totalColiforms: decimalOpt,
      colour: decimalOpt,
      conductivity: decimalOpt,
      lab: optionalText(120),
      sampledBy: optionalText(120),
      note: optionalText(500),
    }),
    handler: ({ s, user, body }) => s.production.recordQuality(user, body),
  }),
  route({ method: 'GET', path: '/reservoirs', permissions: [P.OPS_VIEW], handler: ({ s, user }) => s.production.levels(user) }),
  route({
    method: 'POST',
    path: '/reservoirs/levels',
    permissions: [P.PRODUCTION_RECORD],
    body: z.object({ facilityId: zId, at: z.string().datetime({ offset: true }).transform((v) => new Date(v)), levelPercent: z.number().min(0).max(100).optional(), volume: decimalOpt, note: optionalText(300) }),
    handler: ({ s, user, body }) => s.production.recordLevel(user, body),
  }),
  route({ method: 'GET', path: '/supply-schedules', permissions: [P.OPS_VIEW], handler: ({ s, user }) => s.production.listSchedules(user) }),
  route({ method: 'GET', path: '/supply-schedules/hours', permissions: [P.OPS_VIEW], handler: ({ s, user }) => s.production.hoursOfSupply(user.organisationId) }),
  route({
    method: 'POST',
    path: '/supply-schedules',
    permissions: [P.PRODUCTION_RECORD],
    body: z.object({ zoneId: zId, days: z.array(z.number().int().min(0).max(6)).min(1).max(7), from: time, to: time, note: optionalText(200), active: z.boolean().optional() }),
    handler: ({ s, user, body }) => s.production.saveSchedule(user, body),
  }),
  route({ method: 'DELETE', path: '/supply-schedules/:id', permissions: [P.PRODUCTION_RECORD], handler: ({ s, user, params }) => s.production.deleteSchedule(user, parseId(params.id)) }),

  // Network (GIS) --------------------------------------------------------------------------------
  route({
    method: 'GET',
    path: '/network',
    permissions: [P.OPS_VIEW],
    query: z.object({ type: z.enum(FEATURE_TYPES).optional(), bbox: z.string().regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/).transform((v) => v.split(',').map(Number) as [number, number, number, number]).optional() }),
    handler: ({ s, user, query }) => s.network.list(user, query),
  }),
  route({ method: 'GET', path: '/network/summary', permissions: [P.OPS_VIEW], handler: ({ s, user }) => s.network.summary(user) }),
  route({
    method: 'GET',
    path: '/network/geojson',
    permissions: [P.OPS_VIEW],
    query: z.object({ layers: z.string().default('network,customers,meters,facilities,tickets'), download: zBool.optional() }),
    handler: async ({ s, user, query }) => {
      const fc = await s.network.geojson(user, query.layers.split(','));
      if (!query.download) return fc;
      return new Response(JSON.stringify(fc), { headers: { 'content-type': 'application/geo+json', 'content-disposition': 'attachment; filename="water-network.geojson"' } });
    },
  }),
  route({ method: 'POST', path: '/network', permissions: [P.NETWORK_MANAGE], body: FeatureBody, handler: ({ s, user, body }) => s.network.save(user, body) }),
  route({ method: 'PATCH', path: '/network/:id', permissions: [P.NETWORK_MANAGE], body: FeatureBody, handler: ({ s, user, params, body }) => s.network.save(user, body, parseId(params.id)) }),
  route({ method: 'DELETE', path: '/network/:id', permissions: [P.NETWORK_MANAGE], handler: ({ s, user, params }) => s.network.remove(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/network/import',
    permissions: [P.NETWORK_MANAGE],
    status: 200,
    body: z.object({ collection: z.object({ features: z.array(z.object({ geometry: Geometry, properties: z.record(z.unknown()).nullable().optional() })).max(20000) }), defaultType: z.enum(FEATURE_TYPES).default('PIPE'), zoneId: zId.nullable().optional() }),
    handler: ({ s, user, body }) => s.network.importGeojson(user, { ...body, collection: { features: body.collection.features.map((f) => ({ geometry: f.geometry, properties: f.properties ?? {} })) } }),
  }),

  // Field jobs and maintenance --------------------------------------------------------------------
  route({
    method: 'GET',
    path: '/work-orders',
    permissions: [P.OPS_VIEW],
    query: z.object({ status: z.enum(WORK_STATUSES).optional(), active: zBool.optional(), mine: zBool.optional(), type: z.enum(WORK_TYPES).optional(), overdue: zBool.optional(), search: optionalText(60), ...zPage }),
    handler: ({ s, user, query }) => s.works.list(user, query),
  }),
  route({ method: 'GET', path: '/work-orders/stats', permissions: [P.OPS_VIEW], query: range, handler: ({ s, user, query }) => s.works.stats(user, query.from, new Date(query.to.getTime() + 86_400_000)) }),
  route({ method: 'GET', path: '/work-orders/:id', permissions: [P.OPS_VIEW], handler: ({ s, user, params }) => s.works.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/work-orders', permissions: [P.WORKS_MANAGE], body: WorkBody, handler: ({ s, user, body }) => s.works.create(user, body) }),
  route({ method: 'POST', path: '/work-orders/:id/assign', permissions: [P.WORKS_MANAGE], status: 200, body: z.object({ assignedTo: z.array(zId).min(1).max(20), note: optionalText(300) }), handler: ({ s, user, params, body }) => s.works.assign(user, parseId(params.id), body.assignedTo, body.note) }),
  route({ method: 'POST', path: '/work-orders/:id/start', permissions: [P.WORKS_FIELD], status: 200, handler: ({ s, user, params }) => s.works.start(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/work-orders/:id/hold', permissions: [P.WORKS_FIELD], status: 200, body: z.object({ note: z.string().trim().min(3).max(300) }), handler: ({ s, user, params, body }) => s.works.hold(user, parseId(params.id), body.note) }),
  route({
    method: 'POST',
    path: '/work-orders/:id/complete',
    permissions: [P.WORKS_FIELD],
    status: 200,
    body: z.object({
      findings: z.string().trim().min(3).max(2000),
      labourHours: zDecimal.optional(),
      materials: z.array(z.object({ itemCode: optionalText(40), description: z.string().trim().min(1).max(150), quantity: zDecimal, unitCost: zDecimal.optional() })).max(50).optional(),
      checklist: z.array(z.object({ item: z.string().max(200), done: z.boolean() })).max(50).optional(),
      gps,
    }),
    handler: ({ s, user, params, body }) => s.works.complete(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/work-orders/:id/close', permissions: [P.WORKS_MANAGE], status: 200, body: z.object({ accept: z.boolean(), note: optionalText(300) }), handler: ({ s, user, params, body }) => s.works.close(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/work-orders/:id/cancel', permissions: [P.WORKS_MANAGE], status: 200, body: z.object({ note: z.string().trim().min(3).max(300) }), handler: ({ s, user, params, body }) => s.works.cancel(user, parseId(params.id), body.note) }),
  route({ method: 'GET', path: '/maintenance-plans', permissions: [P.OPS_VIEW], handler: ({ s, user }) => s.works.listPlans(user) }),
  route({ method: 'POST', path: '/maintenance-plans', permissions: [P.WORKS_MANAGE], body: PlanBody, handler: ({ s, user, body }) => s.works.savePlan(user, body) }),
  route({ method: 'PATCH', path: '/maintenance-plans/:id', permissions: [P.WORKS_MANAGE], body: PlanBody, handler: ({ s, user, params, body }) => s.works.savePlan(user, body, parseId(params.id)) }),
  route({ method: 'POST', path: '/maintenance-plans/raise-due', permissions: [P.WORKS_MANAGE], status: 200, handler: ({ s, user }) => s.works.raiseDue(user) }),

  // Kiosks and bowsers --------------------------------------------------------------------------
  route({ method: 'GET', path: '/kiosks/sales', permissions: [P.OPS_VIEW], query: range, handler: ({ s, user, query }) => s.kiosks.sales(user, query) }),
  route({
    method: 'POST',
    path: '/kiosks/sales',
    permissions: [P.KIOSK_MANAGE],
    body: z.object({ facilityId: zId, date: zDate, jerricans: z.number().int().min(0).max(100_000), amount: decimalOpt, meterReading: decimalOpt, note: optionalText(300) }),
    handler: ({ s, user, body }) => s.kiosks.recordSale(user, body),
  }),
  route({ method: 'GET', path: '/bowser-trips', permissions: [P.OPS_VIEW], query: range, handler: ({ s, user, query }) => s.kiosks.trips(user, query) }),
  route({
    method: 'POST',
    path: '/bowser-trips',
    permissions: [P.KIOSK_MANAGE],
    body: z.object({ date: zDate, vehicleReg: z.string().trim().min(3).max(15), driver: optionalText(120), sourceFacilityId: zId.nullable().optional(), destination: z.string().trim().min(2).max(200), customerId: zId.nullable().optional(), volume: zDecimal, rate: zDecimal.optional(), chargeable: z.boolean().default(true), note: optionalText(300) }),
    handler: ({ s, user, body }) => s.kiosks.recordTrip(user, body),
  }),

  // WASREB indicators ---------------------------------------------------------------------------
  route({ method: 'GET', path: '/reports/wasreb', permissions: [P.REPORTS_VIEW], query: z.object({ period: zPeriod, months: z.coerce.number().int().min(1).max(12).default(1), csv: zBool.optional() }), handler: ({ s, user, query }) => (query.csv ? s.wasreb.indicatorsCsv(user, query.period, query.months) : s.wasreb.indicators(user, query.period, query.months)) }),
  route({ method: 'GET', path: '/reports/waspa', permissions: [P.REPORTS_VIEW], query: z.object({ fyEnd: z.coerce.number().int().min(2000).max(2100), csv: zBool.optional() }), handler: ({ s, user, query }) => (query.csv ? s.wasreb.waspaCsv(user, query.fyEnd) : s.wasreb.waspa(user, query.fyEnd)) }),
];
