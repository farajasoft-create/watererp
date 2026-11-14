import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, sum, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { PERMISSIONS as P } from '../../manifest';
import { assertInScope } from '../access';
import { fullName, HrDb as Db } from '../db';
import { INCIDENT_KINDS, MAINTENANCE_KINDS, TripDoc, VEHICLE_TYPES, VehicleDoc } from '../schemas';

type Id = Types.ObjectId;
type Notify = (organisationId: Id, userIds: Id[], n: { title: string; body?: string; link?: string }) => Promise<void>;
const DAY = 86_400_000;
const LIVE = ['ALLOCATED', 'IN_PROGRESS'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface VehicleInput {
  regNo: string;
  make: string;
  model?: string;
  year?: number | null;
  type: (typeof VEHICLE_TYPES)[number];
  fuelType: 'PETROL' | 'DIESEL' | 'ELECTRIC';
  seats?: number | null;
  chassisNo?: string;
  engineNo?: string;
  colour?: string;
  departmentId?: Id | null;
  station?: string;
  odometer?: number;
  purchaseDate?: Date | null;
  purchaseCost?: Decimal | null;
  assetNumber?: string;
  insurance?: { insurer?: string; policyNo?: string; expiresOn?: Date | null };
  inspectionDue?: Date | null;
  serviceEveryKm?: number;
  serviceEveryMonths?: number;
  lastServiceKm?: number;
  lastServiceDate?: Date | null;
  fuelCard?: { number?: string; provider?: string; monthlyLimit?: Decimal | null };
  tracker?: { provider?: string; deviceId?: string };
}

/**
 * Transport and fleet: vehicles and drivers; transport requests approved by the department and
 * allocated by the transport office to a vehicle and driver that are free, roadworthy and licensed;
 * work tickets with odometer readings; fuel and its consumption; repairs and the keep-or-dispose test;
 * incidents; alerts for insurance, inspection, service and licences; fleet and transport reports.
 */
export class FleetService {
  notify: Notify = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async vehicle(user: AuthUser, id: Id) {
    const v = (await this.db.vehicles.findOne({ _id: id, organisationId: user.organisationId }).lean()) as VehicleDoc | null;
    if (!v) throw new NotFoundException('Vehicle not found');
    return v;
  }

  // ----- Vehicles and drivers ------------------------------------------------------------------------

  vehicles(user: AuthUser) {
    return this.db.vehicles.find({ organisationId: user.organisationId }).sort({ status: 1, regNo: 1 }).lean();
  }

  async saveVehicle(user: AuthUser, id: Id | null, input: VehicleInput) {
    const fields = {
      ...input,
      regNo: input.regNo.replace(/\s+/g, ' ').trim().toUpperCase(),
      purchaseCost: input.purchaseCost ? toD128(input.purchaseCost) : null,
      fuelCard: input.fuelCard ? { ...input.fuelCard, monthlyLimit: input.fuelCard.monthlyLimit ? toD128(input.fuelCard.monthlyLimit) : null } : undefined,
    };
    try {
      if (!id) {
        const [doc] = await this.db.vehicles.create([{ ...fields, organisationId: user.organisationId }]);
        await this.audit.record(user, 'hr.fleet.vehicle_add', 'hrVehicle', doc._id, { regNo: fields.regNo });
        return doc.toObject();
      }
      const before = await this.vehicle(user, id);
      if (input.odometer !== undefined && input.odometer < before.odometer) throw new BadRequestException(`The odometer cannot go back from ${before.odometer}`);
      const doc = await this.db.vehicles.findOneAndUpdate({ _id: id }, fields, { new: true }).lean();
      await this.audit.record(user, 'hr.fleet.vehicle_update', 'hrVehicle', id, { regNo: fields.regNo });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`${fields.regNo} is already in the fleet`);
      throw err;
    }
  }

  async setStatus(user: AuthUser, id: Id, status: 'ACTIVE' | 'UNDER_REPAIR' | 'GROUNDED' | 'DISPOSED', note?: string) {
    const v = await this.vehicle(user, id);
    if (v.status === 'DISPOSED') throw new BadRequestException('The vehicle has been disposed of');
    if (status !== 'ACTIVE' && (await this.db.trips.exists({ organisationId: user.organisationId, vehicleId: v._id, status: 'IN_PROGRESS' }))) throw new BadRequestException('The vehicle is out on a trip');
    await this.db.vehicles.updateOne({ _id: v._id }, { status, ...(status === 'DISPOSED' && { disposedAt: new Date() }) });
    // Bookings ahead lose the vehicle and go back for allocation.
    if (status !== 'ACTIVE') await this.db.trips.updateMany({ organisationId: user.organisationId, vehicleId: v._id, status: 'ALLOCATED' }, { status: 'APPROVED', vehicleId: null, driverId: null });
    await this.audit.record(user, 'hr.fleet.vehicle_status', 'hrVehicle', v._id, { from: v.status, to: status, note });
    return this.vehicle(user, id);
  }

  async drivers(user: AuthUser) {
    const rows = await this.db.drivers.find({ organisationId: user.organisationId }).lean();
    const people = await this.db.employees.find({ _id: { $in: rows.map((r) => r.employeeId) } }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1, phone: 1, status: 1 }).lean();
    return rows.map((r) => {
      const p = people.find((x) => x._id.equals(r.employeeId));
      return { ...r, name: p ? fullName(p) : '', employeeNo: p?.employeeNo ?? '', phone: p?.phone ?? '', employeeStatus: p?.status ?? '' };
    });
  }

  async saveDriver(user: AuthUser, input: { employeeId: Id; licenceNo: string; licenceClasses: string[]; licenceExpiry: Date; active?: boolean }) {
    const e = await this.db.employees.findOne({ _id: input.employeeId, organisationId: user.organisationId }, { status: 1 }).lean();
    if (!e) throw new NotFoundException('Employee not found');
    const doc = await this.db.drivers.findOneAndUpdate({ organisationId: user.organisationId, employeeId: e._id }, { $set: { ...input, active: input.active ?? true } }, { upsert: true, new: true }).lean();
    await this.audit.record(user, 'hr.fleet.driver', 'hrDriver', doc!._id, { licenceNo: input.licenceNo });
    return doc;
  }

  // ----- Transport requests, allocation and work tickets -------------------------------------------------

  async trips(user: AuthUser, q: { status?: string; from?: Date; to?: Date }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, ...(q.status && { status: q.status }) };
    if (q.from || q.to) filter.from = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: new Date(q.to.getTime() + DAY) }) };
    if (!hasPermission(user, P.FLEET_MANAGE) && !hasPermission(user, P.FLEET_VIEW)) filter.requestedBy = user.id;
    return this.describe(await this.db.trips.find(filter).sort({ from: -1 }).limit(300).lean());
  }

  private async describe(rows: TripDoc[]) {
    const [vehicles, drivers, departments] = await Promise.all([
      this.db.vehicles.find({ _id: { $in: rows.map((r) => r.vehicleId).filter(Boolean) } }, { regNo: 1, make: 1, model: 1 }).lean(),
      this.db.drivers.find({ _id: { $in: rows.map((r) => r.driverId).filter(Boolean) } }, { employeeId: 1 }).lean(),
      this.db.departments.find({ _id: { $in: rows.map((r) => r.departmentId).filter(Boolean) } }, { name: 1 }).lean(),
    ]);
    const people = await this.db.employees.find({ _id: { $in: [...drivers.map((d) => d.employeeId), ...rows.map((r) => r.employeeId).filter(Boolean)] } }, { firstName: 1, lastName: 1, otherNames: 1 }).lean();
    const nameOf = (id?: Id | null) => {
      const p = id && people.find((x) => x._id.equals(id));
      return p ? fullName(p) : '';
    };
    return rows.map((r) => {
      const v = r.vehicleId ? vehicles.find((x) => x._id.equals(r.vehicleId!)) : null;
      const d = r.driverId ? drivers.find((x) => x._id.equals(r.driverId!)) : null;
      return { ...r, requester: nameOf(r.employeeId), department: departments.find((x) => r.departmentId && x._id.equals(r.departmentId))?.name ?? '', vehicle: v ? `${v.regNo} ${v.make} ${v.model ?? ''}`.trim() : '', driver: d ? nameOf(d.employeeId) : '' };
    });
  }

  /** Anyone may ask for transport; it goes to the department for approval. */
  async request(user: AuthUser, input: { purpose: string; destination: string; from: Date; to: Date; passengers: number }) {
    if (input.to <= input.from) throw new BadRequestException('The return must be after the departure');
    const e = await this.db.employees.findOne({ organisationId: user.organisationId, userId: user.id }, { departmentId: 1 }).lean();
    const number = `TR-${String(await this.db.next(user.organisationId, 'hr:trip')).padStart(5, '0')}`;
    const [doc] = await this.db.trips.create([{ ...input, organisationId: user.organisationId, number, requestedBy: user.id, employeeId: e?._id ?? null, departmentId: e?.departmentId ?? null }]);
    await this.audit.record(user, 'hr.fleet.request', 'hrTrip', doc._id, { number, destination: input.destination });
    return doc.toObject();
  }

  private async trip(user: AuthUser, id: Id) {
    const t = (await this.db.trips.findOne({ _id: id, organisationId: user.organisationId }).lean()) as TripDoc | null;
    if (!t) throw new NotFoundException('Transport request not found');
    return t;
  }

  async decide(user: AuthUser, id: Id, approve: boolean, note?: string) {
    const t = await this.trip(user, id);
    if (t.status !== 'PENDING') throw new BadRequestException('This request has been decided');
    if (t.requestedBy.equals(user.id)) throw new ForbiddenException('Someone else must approve your transport request');
    assertInScope(user, t.departmentId);
    if (!approve && !note?.trim()) throw new BadRequestException('Give the reason');
    await this.db.trips.updateOne({ _id: t._id, status: 'PENDING' }, { status: approve ? 'APPROVED' : 'REJECTED', approvedBy: user.id, decisionNote: note ?? '' });
    await this.audit.record(user, approve ? 'hr.fleet.approve' : 'hr.fleet.reject', 'hrTrip', t._id, { note });
    await this.notify(user.organisationId, [t.requestedBy], { title: `Transport ${t.number} to ${t.destination} ${approve ? 'approved; awaiting a vehicle' : 'not approved'}`, body: note, link: '/hr/fleet' });
    return this.trip(user, id);
  }

  /** What stops a vehicle or driver taking a trip; empty when both are free and fit. */
  private async problems(organisationId: Id, t: Pick<TripDoc, 'from' | 'to' | '_id' | 'passengers'>, vehicle: VehicleDoc, driverId: Id) {
    const out: string[] = [];
    if (vehicle.status !== 'ACTIVE') out.push(`${vehicle.regNo} is ${vehicle.status.toLowerCase().replace('_', ' ')}`);
    if (vehicle.insurance?.expiresOn && vehicle.insurance.expiresOn < t.to) out.push(`${vehicle.regNo}'s insurance expires ${iso(vehicle.insurance.expiresOn)}`);
    if (vehicle.inspectionDue && vehicle.inspectionDue < t.to) out.push(`${vehicle.regNo}'s inspection was due ${iso(vehicle.inspectionDue)}`);
    if (vehicle.seats && t.passengers > vehicle.seats) out.push(`${vehicle.regNo} seats ${vehicle.seats}`);
    const driver = await this.db.drivers.findOne({ _id: driverId, organisationId }).lean();
    if (!driver?.active) out.push('The driver is not active');
    else if (driver.licenceExpiry < t.to) out.push(`The driver's licence expires ${iso(driver.licenceExpiry)}`);
    const clash = { organisationId, status: { $in: LIVE }, _id: { $ne: t._id }, from: { $lt: t.to }, to: { $gt: t.from } };
    const vClash = await this.db.trips.findOne({ ...clash, vehicleId: vehicle._id }, { number: 1 }).lean();
    if (vClash) out.push(`${vehicle.regNo} is booked on ${vClash.number}`);
    const dClash = await this.db.trips.findOne({ ...clash, driverId }, { number: 1 }).lean();
    if (dClash) out.push(`The driver is booked on ${dClash.number}`);
    if (driver) {
      const away = await this.db.leaveRequests.findOne({ organisationId, employeeId: driver.employeeId, status: 'APPROVED', startDate: { $lte: t.to }, endDate: { $gte: t.from } }, { _id: 1 }).lean();
      if (away) out.push('The driver is on leave');
    }
    return out;
  }

  /** The transport office allocates a free, roadworthy vehicle and a licensed driver who is not away. */
  async allocate(user: AuthUser, id: Id, input: { vehicleId: Id; driverId: Id }) {
    const t = await this.trip(user, id);
    if (!['APPROVED', 'ALLOCATED'].includes(t.status)) throw new BadRequestException('Only approved requests are allocated');
    const v = await this.vehicle(user, input.vehicleId);
    const issues = await this.problems(user.organisationId, t, v, input.driverId);
    if (issues.length) throw new BadRequestException(issues.join('; '));
    await this.db.trips.updateOne({ _id: t._id, status: t.status }, { status: 'ALLOCATED', vehicleId: v._id, driverId: input.driverId, allocatedBy: user.id });
    await this.audit.record(user, 'hr.fleet.allocate', 'hrTrip', t._id, { vehicle: v.regNo });
    const driver = await this.db.drivers.findById(input.driverId, { employeeId: 1 }).lean();
    const du = driver ? await this.db.employees.findById(driver.employeeId, { userId: 1 }).lean() : null;
    await this.notify(user.organisationId, [t.requestedBy, ...(du?.userId ? [du.userId] : [])], { title: `${t.number}: ${v.regNo} allocated for ${iso(t.from)} to ${t.destination}`, link: '/hr/fleet' });
    return this.trip(user, id);
  }

  /** Vehicles and drivers free for a trip's dates, with the reasons the others are not. */
  async options(user: AuthUser, id: Id) {
    const t = await this.trip(user, id);
    const [vehicles, drivers] = await Promise.all([this.db.vehicles.find({ organisationId: user.organisationId, status: { $ne: 'DISPOSED' } }).lean(), this.drivers(user)]);
    const anyDriver = drivers.find((d) => d.active)?._id;
    const vehicleRows = await Promise.all(vehicles.map(async (v) => ({ id: v._id, regNo: v.regNo, label: `${v.regNo} ${v.make} ${v.model ?? ''}`.trim(), problems: anyDriver ? (await this.problems(user.organisationId, t, v as VehicleDoc, anyDriver)).filter((p) => !p.startsWith('The driver')) : [] })));
    const driverRows = await Promise.all(
      drivers.map(async (d) => {
        const issues: string[] = [];
        if (!d.active) issues.push('not active');
        if (d.licenceExpiry < t.to) issues.push(`licence expires ${iso(d.licenceExpiry)}`);
        const busy = await this.db.trips.findOne({ organisationId: user.organisationId, status: { $in: LIVE }, _id: { $ne: t._id }, driverId: d._id, from: { $lt: t.to }, to: { $gt: t.from } }, { number: 1 }).lean();
        if (busy) issues.push(`on ${busy.number}`);
        const away = await this.db.leaveRequests.exists({ organisationId: user.organisationId, employeeId: d.employeeId, status: 'APPROVED', startDate: { $lte: t.to }, endDate: { $gte: t.from } });
        if (away) issues.push('on leave');
        return { id: d._id, name: d.name, problems: issues };
      }),
    );
    return { vehicles: vehicleRows, drivers: driverRows };
  }

  /** Issues the work ticket as the vehicle leaves: the odometer reading out. */
  async dispatch(user: AuthUser, id: Id, input: { odometerOut: number }) {
    const t = await this.trip(user, id);
    if (t.status !== 'ALLOCATED') throw new BadRequestException('Allocate a vehicle first');
    const v = await this.vehicle(user, t.vehicleId!);
    if (input.odometerOut < v.odometer) throw new BadRequestException(`The odometer reads at least ${v.odometer}`);
    const number = `WT-${String(await this.db.next(user.organisationId, 'hr:work-ticket')).padStart(5, '0')}`;
    await this.db.trips.updateOne({ _id: t._id, status: 'ALLOCATED' }, { status: 'IN_PROGRESS', ticket: { number, odometerOut: input.odometerOut, issuedAt: new Date() } });
    await this.audit.record(user, 'hr.fleet.dispatch', 'hrTrip', t._id, { ticket: number });
    return this.trip(user, id);
  }

  /** Closes the work ticket on return: the odometer in gives the distance and moves the vehicle's reading on. */
  async close(user: AuthUser, id: Id, input: { odometerIn: number; remarks?: string }) {
    const t = await this.trip(user, id);
    if (t.status !== 'IN_PROGRESS') throw new BadRequestException('The vehicle is not out on this trip');
    const out = t.ticket?.odometerOut ?? 0;
    if (input.odometerIn <= out) throw new BadRequestException(`The odometer in must be more than ${out}`);
    await this.db.trips.updateOne({ _id: t._id, status: 'IN_PROGRESS' }, { status: 'COMPLETED', 'ticket.odometerIn': input.odometerIn, 'ticket.distance': input.odometerIn - out, 'ticket.returnedAt': new Date(), 'ticket.remarks': input.remarks ?? '' });
    await this.db.vehicles.updateOne({ _id: t.vehicleId, odometer: { $lt: input.odometerIn } }, { odometer: input.odometerIn });
    await this.audit.record(user, 'hr.fleet.return', 'hrTrip', t._id, { distance: input.odometerIn - out });
    return this.trip(user, id);
  }

  async cancel(user: AuthUser, id: Id) {
    const t = await this.trip(user, id);
    if (!t.requestedBy.equals(user.id) && !hasPermission(user, P.FLEET_MANAGE)) throw new ForbiddenException('Only the requester or the transport office can cancel');
    if (!['PENDING', 'APPROVED', 'ALLOCATED'].includes(t.status)) throw new BadRequestException(`A ${t.status.toLowerCase().replace('_', ' ')} trip cannot be cancelled`);
    await this.db.trips.updateOne({ _id: t._id }, { status: 'CANCELLED' });
    return this.trip(user, id);
  }

  /** Where every vehicle and driver stands today, and their next booking. */
  async board(user: AuthUser, at = new Date()) {
    const [vehicles, drivers, trips] = await Promise.all([
      this.db.vehicles.find({ organisationId: user.organisationId, status: { $ne: 'DISPOSED' } }).sort({ regNo: 1 }).lean(),
      this.drivers(user),
      this.db.trips.find({ organisationId: user.organisationId, status: { $in: LIVE }, to: { $gte: at } }).sort({ from: 1 }).lean(),
    ]);
    const state = (busy: TripDoc[]) => {
      const now = busy.find((t) => t.status === 'IN_PROGRESS' || (t.from <= at && t.to >= at));
      const next = busy.find((t) => t.from > at);
      return { current: now ? { number: now.number, destination: now.destination, until: now.to, status: now.status } : null, next: next ? { number: next.number, destination: next.destination, from: next.from } : null };
    };
    return {
      vehicles: vehicles.map((v) => {
        const s = state(trips.filter((t) => t.vehicleId?.equals(v._id)) as TripDoc[]);
        return { id: v._id, regNo: v.regNo, label: `${v.make} ${v.model ?? ''}`.trim(), odometer: v.odometer, status: v.status !== 'ACTIVE' ? v.status : s.current ? (s.current.status === 'IN_PROGRESS' ? 'ON_TRIP' : 'BOOKED') : 'AVAILABLE', ...s };
      }),
      drivers: drivers.map((d) => {
        const s = state(trips.filter((t) => t.driverId?.equals(d._id)) as TripDoc[]);
        return { id: d._id, name: d.name, status: !d.active ? 'INACTIVE' : s.current ? (s.current.status === 'IN_PROGRESS' ? 'ON_TRIP' : 'BOOKED') : 'AVAILABLE', licenceExpiry: d.licenceExpiry, ...s };
      }),
    };
  }

  // ----- Fuel, maintenance and incidents ----------------------------------------------------------------

  async addFuel(user: AuthUser, input: { vehicleId: Id; date: Date; litres: number; amount: Decimal; odometer: number; station?: string; receiptNo?: string; viaCard?: boolean; tripId?: Id | null }) {
    const v = await this.vehicle(user, input.vehicleId);
    if (input.litres <= 0) throw new BadRequestException('Enter the litres');
    const last = await this.db.fuel.findOne({ organisationId: user.organisationId, vehicleId: v._id, date: { $lte: input.date } }).sort({ date: -1, odometer: -1 }).lean();
    if (last && input.odometer < last.odometer) throw new BadRequestException(`The odometer was ${last.odometer} at the last fill-up`);
    if (input.viaCard && v.fuelCard?.monthlyLimit) {
      const month = new Date(Date.UTC(input.date.getUTCFullYear(), input.date.getUTCMonth(), 1));
      const used = sum((await this.db.fuel.find({ organisationId: user.organisationId, vehicleId: v._id, viaCard: true, date: { $gte: month } }, { amount: 1 }).lean()).map((f) => dec(f.amount as never)));
      if (used.plus(input.amount).gt(dec(v.fuelCard.monthlyLimit as never))) throw new BadRequestException(`This takes ${v.regNo}'s fuel card over its monthly limit of ${dec(v.fuelCard.monthlyLimit as never).toFixed(2)}`);
    }
    const [doc] = await this.db.fuel.create([{ ...input, amount: toD128(input.amount), organisationId: user.organisationId, recordedBy: user.id }]);
    await this.db.vehicles.updateOne({ _id: v._id, odometer: { $lt: input.odometer } }, { odometer: input.odometer });
    await this.audit.record(user, 'hr.fleet.fuel', 'hrFuel', doc._id, { vehicle: v.regNo, litres: input.litres });
    return doc.toObject();
  }

  async addMaintenance(user: AuthUser, input: { vehicleId: Id; date: Date; kind: (typeof MAINTENANCE_KINDS)[number]; description: string; garage?: string; cost: Decimal; odometer?: number | null; daysOff?: number }) {
    const v = await this.vehicle(user, input.vehicleId);
    const [doc] = await this.db.vehicleMaintenance.create([{ ...input, cost: toD128(input.cost), organisationId: user.organisationId, recordedBy: user.id }]);
    if (input.kind === 'SERVICE') await this.db.vehicles.updateOne({ _id: v._id }, { lastServiceDate: input.date, ...(input.odometer && { lastServiceKm: input.odometer }) });
    if (input.kind === 'INSPECTION') await this.db.vehicles.updateOne({ _id: v._id }, { inspectionDue: new Date(Date.UTC(input.date.getUTCFullYear() + 1, input.date.getUTCMonth(), input.date.getUTCDate())) });
    if (input.odometer) await this.db.vehicles.updateOne({ _id: v._id, odometer: { $lt: input.odometer } }, { odometer: input.odometer });
    await this.audit.record(user, 'hr.fleet.maintenance', 'hrVehicleMaintenance', doc._id, { vehicle: v.regNo, kind: input.kind, cost: input.cost.toFixed(2) });
    return doc.toObject();
  }

  async addIncident(user: AuthUser, input: { vehicleId: Id; driverId?: Id | null; date: Date; kind: (typeof INCIDENT_KINDS)[number]; location?: string; description: string; policeAbstract?: string; insuranceClaimNo?: string; cost?: Decimal; groundVehicle?: boolean }) {
    const v = await this.vehicle(user, input.vehicleId);
    const number = `INC-${String(await this.db.next(user.organisationId, 'hr:vehicle-incident')).padStart(4, '0')}`;
    const { groundVehicle, ...rest } = input;
    const [doc] = await this.db.vehicleIncidents.create([{ ...rest, cost: toD128(input.cost ?? 0), number, organisationId: user.organisationId, recordedBy: user.id }]);
    if (groundVehicle) await this.setStatus(user, v._id, 'UNDER_REPAIR', `Incident ${number}`);
    await this.audit.record(user, 'hr.fleet.incident', 'hrVehicleIncident', doc._id, { number, vehicle: v.regNo, kind: input.kind });
    return doc.toObject();
  }

  async closeIncident(user: AuthUser, id: Id, input: { outcome: string; cost?: Decimal }) {
    const res = await this.db.vehicleIncidents.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: 'OPEN' }, { status: 'CLOSED', outcome: input.outcome, ...(input.cost && { cost: toD128(input.cost) }) }, { new: true }).lean();
    if (!res) throw new BadRequestException('Incident not found or already closed');
    await this.audit.record(user, 'hr.fleet.incident_close', 'hrVehicleIncident', id, {});
    return res;
  }

  /** A vehicle's history: trips, fuel, maintenance and incidents. */
  async history(user: AuthUser, id: Id) {
    const v = await this.vehicle(user, id);
    const [trips, fuel, maintenance, incidents] = await Promise.all([
      this.db.trips.find({ organisationId: user.organisationId, vehicleId: v._id, status: { $in: ['IN_PROGRESS', 'COMPLETED'] } }).sort({ from: -1 }).limit(100).lean(),
      this.db.fuel.find({ organisationId: user.organisationId, vehicleId: v._id }).sort({ date: -1 }).limit(100).lean(),
      this.db.vehicleMaintenance.find({ organisationId: user.organisationId, vehicleId: v._id }).sort({ date: -1 }).limit(100).lean(),
      this.db.vehicleIncidents.find({ organisationId: user.organisationId, vehicleId: v._id }).sort({ date: -1 }).limit(100).lean(),
    ]);
    return { vehicle: v, trips: await this.describe(trips as TripDoc[]), fuel, maintenance, incidents, assessment: (await this.assess(user, [v], new Date()))[0] };
  }

  // ----- Analysis, alerts and reports ---------------------------------------------------------------

  /**
   * Fuel consumption by vehicle for a period: litres, cost, distance (odometer span across fill-ups),
   * km per litre and cost per km, flagged when well below the vehicle type's average.
   */
  async fuelAnalysis(user: AuthUser, q: { from: Date; to: Date }) {
    const end = new Date(q.to.getTime() + DAY);
    const vehicles = await this.db.vehicles.find({ organisationId: user.organisationId }).lean();
    const rows = [];
    for (const v of vehicles) {
      const fills = await this.db.fuel.find({ organisationId: user.organisationId, vehicleId: v._id, date: { $gte: q.from, $lt: end } }).sort({ odometer: 1 }).lean();
      if (!fills.length) continue;
      const before = await this.db.fuel.findOne({ organisationId: user.organisationId, vehicleId: v._id, date: { $lt: q.from } }).sort({ odometer: -1 }).lean();
      const startKm = before?.odometer ?? fills[0].odometer;
      const distance = fills[fills.length - 1].odometer - startKm;
      // Without an earlier fill the first one's litres fuelled kilometres before the period.
      const litres = fills.slice(before ? 0 : 1).reduce((a, f) => a + f.litres, 0);
      const cost = sum(fills.map((f) => dec(f.amount as never)));
      rows.push({ vehicleId: v._id, regNo: v.regNo, type: v.type, fills: fills.length, litres: Math.round(fills.reduce((a, f) => a + f.litres, 0) * 100) / 100, cost, distance, kmPerLitre: litres > 0 && distance > 0 ? Math.round((distance / litres) * 100) / 100 : null, costPerKm: distance > 0 ? cost.div(distance).toDecimalPlaces(2) : null, flag: '' });
    }
    const byType = new Map<string, number[]>();
    for (const r of rows) if (r.kmPerLitre) byType.set(r.type, [...(byType.get(r.type) ?? []), r.kmPerLitre]);
    for (const r of rows) {
      const peers = byType.get(r.type) ?? [];
      const avg = peers.length ? peers.reduce((a, b) => a + b, 0) / peers.length : null;
      if (r.kmPerLitre && avg && peers.length > 1 && r.kmPerLitre < avg * 0.75) r.flag = `Uses ${Math.round((1 - r.kmPerLitre / avg) * 100)}% more fuel than similar vehicles`;
    }
    return rows;
  }

  /**
   * Keep or dispose: age, distance, maintenance in the last 12 months and in total against the purchase
   * cost, and cost per km. Dispose when old and costly, review when one test fails.
   */
  async assess(user: AuthUser, vehicles?: VehicleDoc[], asOf = new Date()) {
    const list = vehicles ?? ((await this.db.vehicles.find({ organisationId: user.organisationId, status: { $ne: 'DISPOSED' } }).lean()) as VehicleDoc[]);
    const yearAgo = new Date(asOf.getTime() - 365 * DAY);
    const rows = [];
    for (const v of list) {
      const all = await this.db.vehicleMaintenance.find({ organisationId: user.organisationId, vehicleId: v._id }, { cost: 1, date: 1 }).lean();
      const total = sum(all.map((m) => dec(m.cost as never)));
      const recent = sum(all.filter((m) => m.date >= yearAgo).map((m) => dec(m.cost as never)));
      const age = v.purchaseDate ? Math.floor((asOf.getTime() - v.purchaseDate.getTime()) / (365.25 * DAY)) : v.year ? asOf.getUTCFullYear() - v.year : null;
      const cost = v.purchaseCost ? dec(v.purchaseCost as never) : null;
      const recentShare = cost && cost.gt(0) ? recent.div(cost).times(100).toDecimalPlaces(1).toNumber() : null;
      const reasons = [age !== null && age >= 10 && `${age} years old`, v.odometer >= 400_000 && `${v.odometer.toLocaleString()} km`, recentShare !== null && recentShare >= 25 && `repairs in the last year are ${recentShare}% of its cost`].filter(Boolean) as string[];
      rows.push({ vehicleId: v._id, regNo: v.regNo, age, odometer: v.odometer, maintenanceTotal: total, maintenanceLastYear: recent, lastYearPercentOfCost: recentShare, costPerKm: v.odometer > 0 ? total.div(v.odometer).toDecimalPlaces(2) : null, recommendation: reasons.length >= 2 ? 'DISPOSE' : reasons.length === 1 ? 'REVIEW' : 'KEEP', reasons });
    }
    return rows;
  }

  /** Insurance, inspection, service and licence dates falling due within `days`, and overdue. */
  async alerts(user: AuthUser, days = 30, asOf = new Date()) {
    const until = new Date(asOf.getTime() + days * DAY);
    const vehicles = await this.db.vehicles.find({ organisationId: user.organisationId, status: { $ne: 'DISPOSED' } }).lean();
    const drivers = await this.drivers(user);
    const out: { kind: string; subject: string; detail: string; due: Date | null; overdue: boolean }[] = [];
    for (const v of vehicles) {
      if (v.insurance?.expiresOn && v.insurance.expiresOn <= until) out.push({ kind: 'INSURANCE', subject: v.regNo, detail: `Insurance${v.insurance.insurer ? ` with ${v.insurance.insurer}` : ''} expires`, due: v.insurance.expiresOn, overdue: v.insurance.expiresOn < asOf });
      if (v.inspectionDue && v.inspectionDue <= until) out.push({ kind: 'INSPECTION', subject: v.regNo, detail: 'Motor vehicle inspection due', due: v.inspectionDue, overdue: v.inspectionDue < asOf });
      const kmLeft = v.lastServiceKm + (v.serviceEveryKm ?? 5000) - v.odometer;
      const serviceDate = v.lastServiceDate ? new Date(Date.UTC(v.lastServiceDate.getUTCFullYear(), v.lastServiceDate.getUTCMonth() + (v.serviceEveryMonths ?? 6), v.lastServiceDate.getUTCDate())) : null;
      if (kmLeft <= 500 || (serviceDate && serviceDate <= until)) out.push({ kind: 'SERVICE', subject: v.regNo, detail: kmLeft <= 0 ? `Service overdue by ${-kmLeft} km` : kmLeft <= 500 ? `Service due in ${kmLeft} km` : 'Service due', due: serviceDate, overdue: kmLeft <= 0 || (!!serviceDate && serviceDate < asOf) });
    }
    for (const d of drivers) if (d.active && d.licenceExpiry <= until) out.push({ kind: 'LICENCE', subject: d.name, detail: `Driving licence ${d.licenceNo} expires`, due: d.licenceExpiry, overdue: d.licenceExpiry < asOf });
    return out.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due?.getTime() ?? 0) - (b.due?.getTime() ?? 0));
  }

  /** Scheduled: tells the transport office about what falls due in the next fortnight (once a day is enough). */
  async sendAlerts(user: AuthUser) {
    const alerts = await this.alerts(user, 14);
    if (!alerts.length) return { sent: 0 };
    const office = await this.db.users.find({ organisationId: user.organisationId, active: true, access: { $elemMatch: { module: 'hr', role: { $in: ['TRANSPORT_OFFICER', 'FULL'] } } } }, { _id: 1 }).lean();
    await this.notify(user.organisationId, office.map((o) => o._id), { title: `${alerts.length} fleet item${alerts.length === 1 ? '' : 's'} need attention`, body: alerts.slice(0, 8).map((a) => `${a.subject}: ${a.detail}${a.due ? ` ${iso(a.due)}` : ''}`).join('\n'), link: '/hr/fleet' });
    return { sent: alerts.length };
  }

  /**
   * Fleet and transport report for a period: trips and distance by department, each vehicle's trips,
   * distance, days in use (utilisation), fuel and repair cost, and incidents.
   */
  async report(user: AuthUser, q: { from: Date; to: Date }) {
    const end = new Date(q.to.getTime() + DAY);
    const days = Math.max(1, Math.round((end.getTime() - q.from.getTime()) / DAY));
    const [vehicles, trips, fuel, maintenance, incidents, departments] = await Promise.all([
      this.db.vehicles.find({ organisationId: user.organisationId }).lean(),
      this.db.trips.find({ organisationId: user.organisationId, from: { $gte: q.from, $lt: end } }).lean(),
      this.db.fuel.find({ organisationId: user.organisationId, date: { $gte: q.from, $lt: end } }).lean(),
      this.db.vehicleMaintenance.find({ organisationId: user.organisationId, date: { $gte: q.from, $lt: end } }).lean(),
      this.db.vehicleIncidents.find({ organisationId: user.organisationId, date: { $gte: q.from, $lt: end } }).lean(),
      this.db.departments.find({ organisationId: user.organisationId }, { name: 1 }).lean(),
    ]);
    const done = trips.filter((t) => t.status === 'COMPLETED');
    const byStatus: Record<string, number> = {};
    for (const t of trips) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const deptRows = new Map<string, { department: string; trips: number; distance: number }>();
    for (const t of done) {
      const name = departments.find((d) => t.departmentId && d._id.equals(t.departmentId))?.name ?? 'No department';
      const cur = deptRows.get(name) ?? { department: name, trips: 0, distance: 0 };
      cur.trips++;
      cur.distance += t.ticket?.distance ?? 0;
      deptRows.set(name, cur);
    }
    return {
      days,
      requests: trips.length,
      byStatus,
      departments: [...deptRows.values()].sort((a, b) => b.distance - a.distance),
      vehicles: vehicles.map((v) => {
        const mine = done.filter((t) => t.vehicleId?.equals(v._id));
        const used = new Set<string>();
        for (const t of mine) for (let d = new Date(Date.UTC(t.from.getUTCFullYear(), t.from.getUTCMonth(), t.from.getUTCDate())); d <= t.to && d < end; d = new Date(d.getTime() + DAY)) if (d >= q.from) used.add(iso(d));
        return {
          vehicleId: v._id,
          regNo: v.regNo,
          status: v.status,
          trips: mine.length,
          distance: mine.reduce((a, t) => a + (t.ticket?.distance ?? 0), 0),
          daysInUse: used.size,
          utilisationPercent: Math.round((used.size / days) * 1000) / 10,
          fuelCost: sum(fuel.filter((f) => f.vehicleId.equals(v._id)).map((f) => dec(f.amount as never))),
          repairCost: sum(maintenance.filter((m) => m.vehicleId.equals(v._id)).map((m) => dec(m.cost as never))),
          incidents: incidents.filter((i) => i.vehicleId.equals(v._id)).length,
        };
      }),
      incidents: incidents.map((i) => ({ number: i.number, date: i.date, kind: i.kind, vehicle: vehicles.find((v) => v._id.equals(i.vehicleId))?.regNo ?? '', status: i.status, cost: i.cost })),
    };
  }
}
