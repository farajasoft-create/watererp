import { z } from 'zod';
import { PERMISSIONS as P } from '@/modules/hr/manifest';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { INCIDENT_KINDS, MAINTENANCE_KINDS, TRIP_STATUSES, VEHICLE_TYPES } from '../schemas';
import { route } from '../route';

const text = (max: number) => z.string().trim().max(max);
const VehicleBody = z.object({
  regNo: text(20).min(3),
  make: text(60).min(1),
  model: text(60).optional(),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  type: z.enum(VEHICLE_TYPES).default('PICKUP'),
  fuelType: z.enum(['PETROL', 'DIESEL', 'ELECTRIC']).default('DIESEL'),
  seats: z.number().int().min(1).max(100).nullable().optional(),
  chassisNo: text(40).optional(),
  engineNo: text(40).optional(),
  colour: text(30).optional(),
  departmentId: zId.nullable().optional(),
  station: text(100).optional(),
  odometer: z.number().int().min(0).optional(),
  purchaseDate: zDate.nullable().optional(),
  purchaseCost: zDecimal.nullable().optional(),
  assetNumber: text(40).optional(),
  insurance: z.object({ insurer: text(100).optional(), policyNo: text(60).optional(), expiresOn: zDate.nullable().optional() }).optional(),
  inspectionDue: zDate.nullable().optional(),
  serviceEveryKm: z.number().int().min(500).max(100000).optional(),
  serviceEveryMonths: z.number().int().min(1).max(36).optional(),
  lastServiceKm: z.number().int().min(0).optional(),
  lastServiceDate: zDate.nullable().optional(),
  fuelCard: z.object({ number: text(40).optional(), provider: text(60).optional(), monthlyLimit: zDecimal.nullable().optional() }).optional(),
  tracker: z.object({ provider: text(60).optional(), deviceId: text(60).optional() }).optional(),
});
const range = z.object({ from: zDate, to: zDate });
/** A date and time (ISO 8601), for bookings. */
const zWhen = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Expected a date and time').transform((v) => new Date(v));

export const fleetRoutes = [
  route({ method: 'GET', path: '/fleet/board', permissions: [P.FLEET_VIEW], query: z.object({ at: zWhen.optional() }), handler: ({ s, user, query }) => s.fleet.board(user, query.at ?? new Date()) }),
  route({ method: 'GET', path: '/fleet/vehicles', permissions: [P.FLEET_VIEW], handler: ({ s, user }) => s.fleet.vehicles(user) }),
  route({ method: 'GET', path: '/fleet/vehicles/:id', permissions: [P.FLEET_VIEW], handler: ({ s, user, params }) => s.fleet.history(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/fleet/vehicles', permissions: [P.FLEET_MANAGE], body: VehicleBody, handler: ({ s, user, body }) => s.fleet.saveVehicle(user, null, body) }),
  route({ method: 'PATCH', path: '/fleet/vehicles/:id', permissions: [P.FLEET_MANAGE], body: VehicleBody, handler: ({ s, user, params, body }) => s.fleet.saveVehicle(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/fleet/vehicles/:id/status',
    permissions: [P.FLEET_MANAGE],
    status: 200,
    body: z.object({ status: z.enum(['ACTIVE', 'UNDER_REPAIR', 'GROUNDED', 'DISPOSED']), note: text(300).optional() }),
    handler: ({ s, user, params, body }) => s.fleet.setStatus(user, parseId(params.id), body.status, body.note),
  }),
  route({ method: 'GET', path: '/fleet/drivers', permissions: [P.FLEET_VIEW], handler: ({ s, user }) => s.fleet.drivers(user) }),
  route({
    method: 'POST',
    path: '/fleet/drivers',
    permissions: [P.FLEET_MANAGE],
    status: 200,
    body: z.object({ employeeId: zId, licenceNo: text(40).min(3), licenceClasses: z.array(text(10).min(1)).max(15).default([]), licenceExpiry: zDate, active: z.boolean().optional() }),
    handler: ({ s, user, body }) => s.fleet.saveDriver(user, body),
  }),

  route({ method: 'GET', path: '/fleet/trips', query: z.object({ status: z.enum(TRIP_STATUSES).optional(), from: zDate.optional(), to: zDate.optional() }), handler: ({ s, user, query }) => s.fleet.trips(user, query) }),
  route({
    method: 'POST',
    path: '/fleet/trips',
    body: z.object({ purpose: text(300).min(3), destination: text(200).min(2), from: zWhen, to: zWhen, passengers: z.number().int().min(1).max(100).default(1) }),
    handler: ({ s, user, body }) => s.fleet.request(user, body),
  }),
  route({
    method: 'POST',
    path: '/fleet/trips/:id/decide',
    permissions: [P.FLEET_APPROVE],
    status: 200,
    body: z.object({ approve: z.boolean(), note: text(300).optional() }),
    handler: ({ s, user, params, body }) => s.fleet.decide(user, parseId(params.id), body.approve, body.note),
  }),
  route({ method: 'GET', path: '/fleet/trips/:id/options', permissions: [P.FLEET_MANAGE], handler: ({ s, user, params }) => s.fleet.options(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/fleet/trips/:id/allocate', permissions: [P.FLEET_MANAGE], status: 200, body: z.object({ vehicleId: zId, driverId: zId }), handler: ({ s, user, params, body }) => s.fleet.allocate(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/fleet/trips/:id/dispatch', permissions: [P.FLEET_MANAGE], status: 200, body: z.object({ odometerOut: z.number().int().min(0) }), handler: ({ s, user, params, body }) => s.fleet.dispatch(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/fleet/trips/:id/return',
    permissions: [P.FLEET_MANAGE],
    status: 200,
    body: z.object({ odometerIn: z.number().int().min(0), remarks: text(500).optional() }),
    handler: ({ s, user, params, body }) => s.fleet.close(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/fleet/trips/:id/cancel', status: 200, handler: ({ s, user, params }) => s.fleet.cancel(user, parseId(params.id)) }),

  route({
    method: 'POST',
    path: '/fleet/fuel',
    permissions: [P.FLEET_MANAGE],
    body: z.object({ vehicleId: zId, date: zDate, litres: z.number().positive().max(2000), amount: zDecimal, odometer: z.number().int().min(0), station: text(100).optional(), receiptNo: text(40).optional(), viaCard: z.boolean().optional(), tripId: zId.nullable().optional() }),
    handler: ({ s, user, body }) => s.fleet.addFuel(user, body),
  }),
  route({
    method: 'POST',
    path: '/fleet/maintenance',
    permissions: [P.FLEET_MANAGE],
    body: z.object({ vehicleId: zId, date: zDate, kind: z.enum(MAINTENANCE_KINDS), description: text(500).min(2), garage: text(100).optional(), cost: zDecimal.default('0'), odometer: z.number().int().min(0).nullable().optional(), daysOff: z.number().int().min(0).max(365).optional() }),
    handler: ({ s, user, body }) => s.fleet.addMaintenance(user, body),
  }),
  route({
    method: 'POST',
    path: '/fleet/incidents',
    permissions: [P.FLEET_MANAGE],
    body: z.object({ vehicleId: zId, driverId: zId.nullable().optional(), date: zDate, kind: z.enum(INCIDENT_KINDS), location: text(200).optional(), description: text(2000).min(3), policeAbstract: text(60).optional(), insuranceClaimNo: text(60).optional(), cost: zDecimal.optional(), groundVehicle: z.boolean().optional() }),
    handler: ({ s, user, body }) => s.fleet.addIncident(user, body),
  }),
  route({ method: 'POST', path: '/fleet/incidents/:id/close', permissions: [P.FLEET_MANAGE], status: 200, body: z.object({ outcome: text(1000).min(2), cost: zDecimal.optional() }), handler: ({ s, user, params, body }) => s.fleet.closeIncident(user, parseId(params.id), body) }),

  route({ method: 'GET', path: '/fleet/fuel-analysis', permissions: [P.FLEET_VIEW], query: range, handler: ({ s, user, query }) => s.fleet.fuelAnalysis(user, query) }),
  route({ method: 'GET', path: '/fleet/assessment', permissions: [P.FLEET_VIEW], handler: ({ s, user }) => s.fleet.assess(user) }),
  route({ method: 'GET', path: '/fleet/alerts', permissions: [P.FLEET_VIEW], query: z.object({ days: z.coerce.number().int().min(0).max(366).default(30), asOf: zDate.optional() }), handler: ({ s, user, query }) => s.fleet.alerts(user, query.days, query.asOf ?? new Date()) }),
  route({ method: 'POST', path: '/fleet/alerts/send', permissions: [P.FLEET_MANAGE], status: 200, handler: ({ s, user }) => s.fleet.sendAlerts(user) }),
  route({ method: 'GET', path: '/fleet/report', permissions: [P.FLEET_VIEW], query: range, handler: ({ s, user, query }) => s.fleet.report(user, query) }),
];
