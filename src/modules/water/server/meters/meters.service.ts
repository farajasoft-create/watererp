import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { escapeRegex } from '@/platform/common/validation';
import { WaterDb as Db } from '@/modules/water/server/db';
import { METER_STATUSES, METER_TYPES } from '@/modules/water/server/schemas';
import { AuditService } from '@/platform/services/audit.service';

export interface MeterInput {
  serialNo: string;
  make?: string;
  sizeMm?: number;
  dials?: number;
  type: (typeof METER_TYPES)[number];
  zoneId?: Types.ObjectId | null;
  initialReading?: Decimal;
  calibrationDue?: Date | null;
}

export class MetersService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, q: { search?: string; status?: (typeof METER_STATUSES)[number]; type?: (typeof METER_TYPES)[number]; zoneId?: Types.ObjectId; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    if (q.type) filter.type = q.type;
    if (q.zoneId) filter.zoneId = q.zoneId;
    if (q.search) filter.serialNo = new RegExp(escapeRegex(q.search), 'i');
    const [items, total] = await Promise.all([
      this.db.meters
        .find(filter, { history: 0 })
        .sort({ serialNo: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.meters.countDocuments(filter),
    ]);
    const customers = await this.db.customers.find({ _id: { $in: items.map((m) => m.customerId).filter(Boolean) } }, { accountNo: 1, name: 1 }).lean();
    const byId = new Map(customers.map((c) => [c._id.toHexString(), c]));
    return { items: items.map((m) => ({ ...m, customer: m.customerId ? (byId.get(m.customerId.toHexString()) ?? null) : null })), total, page: q.page, pageSize: q.pageSize };
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const meter = await this.db.meters.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!meter) throw new NotFoundException('Meter not found');
    return meter;
  }

  /** Receives a meter into stores; bulk and production meters are installed on their zone directly. */
  async create(user: AuthUser, input: MeterInput) {
    if (input.type !== 'CUSTOMER' && !input.zoneId) throw new BadRequestException('Bulk and production meters need the zone they measure');
    if (input.zoneId && !(await this.db.zones.exists({ _id: input.zoneId, organisationId: user.organisationId }))) throw new BadRequestException('Unknown zone');
    const reading = toD128(input.initialReading ?? 0);
    const installed = input.type !== 'CUSTOMER';
    const [meter] = await this.db.meters.create([
      {
        ...input,
        serialNo: input.serialNo.trim().toUpperCase(),
        organisationId: user.organisationId,
        status: installed ? 'INSTALLED' : 'IN_STORE',
        initialReading: reading,
        lastReading: reading,
        ...(installed && { installedAt: new Date(), lastReadingDate: new Date() }),
        history: [{ event: installed ? 'INSTALLED' : 'RECEIVED', at: new Date(), reading, by: user.id }],
      },
    ]);
    await this.audit.record(user, 'meter.create', 'meter', meter._id, { serialNo: meter.serialNo });
    return meter;
  }

  /** Fits a meter from stores to a customer, replacing (and removing) any meter already there. */
  async install(user: AuthUser, meterId: Types.ObjectId, input: { customerId: Types.ObjectId; reading: Decimal; date: Date; oldMeterFinalReading?: Decimal | null; note?: string }) {
    return this.db.transaction(async (session) => {
      const [meter, customer] = await Promise.all([
        this.db.meters.findOne({ _id: meterId, organisationId: user.organisationId }).session(session),
        this.db.customers.findOne({ _id: input.customerId, organisationId: user.organisationId }).session(session),
      ]);
      if (!meter) throw new NotFoundException('Meter not found');
      if (!customer) throw new NotFoundException('Customer not found');
      if (meter.type !== 'CUSTOMER') throw new BadRequestException('Only customer meters are fitted to accounts');
      if (meter.status !== 'IN_STORE') throw new BadRequestException(`Meter ${meter.serialNo} is ${meter.status.toLowerCase().replace('_', ' ')}, not in stores`);
      if (['CLOSED', 'REJECTED'].includes(customer.status)) throw new BadRequestException('The account is closed');

      if (customer.meterId) {
        const old = await this.db.meters.findById(customer.meterId).session(session);
        if (old) {
          if (input.oldMeterFinalReading === undefined || input.oldMeterFinalReading === null) throw new BadRequestException('Enter the final reading of the meter being replaced');
          if (dec(input.oldMeterFinalReading).lt(dec(old.lastReading))) throw new BadRequestException(`The final reading cannot be below the last reading (${dec(old.lastReading).toFixed()})`);
          // The final reading is billed in the next run as a normal approved reading on the old meter.
          await this.db.readings.create(
            [
              {
                organisationId: user.organisationId,
                period: input.date.toISOString().slice(0, 7),
                meterId: old._id,
                customerId: customer._id,
                zoneId: customer.zoneId,
                previousValue: old.lastReading,
                value: toD128(input.oldMeterFinalReading),
                registerUnits: toD128(dec(input.oldMeterFinalReading).minus(dec(old.lastReading))),
                units: toD128(dec(input.oldMeterFinalReading).minus(dec(old.lastReading))),
                status: 'APPROVED',
                readAt: input.date,
                readerId: user.id,
                note: 'Final reading on meter replacement',
                reviewedBy: user.id,
                reviewedAt: new Date(),
              },
            ],
            { session },
          );
          old.set({ status: 'REMOVED', customerId: null, lastReading: toD128(input.oldMeterFinalReading), lastReadingDate: input.date });
          old.history.push({ event: 'REPLACED', at: input.date, reading: toD128(input.oldMeterFinalReading), customerId: customer._id, by: user.id, note: `Replaced by ${meter.serialNo}` });
          await old.save({ session });
        }
      }

      const reading = toD128(input.reading);
      meter.set({ status: 'INSTALLED', customerId: customer._id, zoneId: customer.zoneId, installedAt: input.date, initialReading: reading, lastReading: reading, lastReadingDate: input.date });
      meter.history.push({ event: 'INSTALLED', at: input.date, reading, customerId: customer._id, by: user.id, note: input.note });
      await meter.save({ session });
      customer.meterId = meter._id;
      await customer.save({ session });
      await this.audit.record(user, 'meter.install', 'meter', meter._id, { customerId: customer._id, accountNo: customer.accountNo }, session);
      return meter;
    });
  }

  /** Marks a meter faulty (connections are then estimated until it is replaced), or back in stores after testing. */
  async setStatus(user: AuthUser, meterId: Types.ObjectId, input: { status: 'FAULTY' | 'IN_STORE' | 'SCRAPPED'; note?: string; calibrationDue?: Date | null }) {
    const meter = await this.db.meters.findOne({ _id: meterId, organisationId: user.organisationId });
    if (!meter) throw new NotFoundException('Meter not found');
    if (input.status === 'IN_STORE' && meter.customerId) throw new BadRequestException('Replace the meter on the account before returning it to stores');
    meter.status = input.status;
    if (input.calibrationDue !== undefined) meter.calibrationDue = input.calibrationDue;
    meter.history.push({ event: input.status === 'IN_STORE' ? 'TESTED' : input.status === 'SCRAPPED' ? 'SCRAPPED' : 'FAULTY', at: new Date(), by: user.id, note: input.note });
    await meter.save();
    await this.audit.record(user, 'meter.status', 'meter', meter._id, input);
    return meter;
  }

  /**
   * Records an accuracy test (bench or in situ) with its certificate and the next calibration date. A
   * failed test on an installed meter marks it faulty, so the account is estimated until it is replaced.
   */
  async recordTest(user: AuthUser, meterId: Types.ObjectId, input: { at: Date; result: 'PASS' | 'FAIL'; errorPercent?: Decimal | null; testFlow?: string; certificateNo?: string; testedBy?: string; nextCalibration?: Date | null; note?: string }) {
    const meter = await this.db.meters.findOne({ _id: meterId, organisationId: user.organisationId });
    if (!meter) throw new NotFoundException('Meter not found');
    meter.tests.push({ at: input.at, by: user.id, result: input.result, errorPercent: input.errorPercent ? toD128(input.errorPercent) : undefined, testFlow: input.testFlow, certificateNo: input.certificateNo, testedBy: input.testedBy, note: input.note });
    if (input.nextCalibration !== undefined) meter.calibrationDue = input.nextCalibration;
    const failed = input.result === 'FAIL';
    if (failed && meter.status === 'INSTALLED') meter.status = 'FAULTY';
    meter.history.push({ event: failed ? 'FAULTY' : 'TESTED', at: input.at, by: user.id, note: `Test ${input.result}${input.errorPercent ? ` (${input.errorPercent.toFixed()}% error)` : ''}${input.certificateNo ? `, certificate ${input.certificateNo}` : ''}` });
    await meter.save();
    await this.audit.record(user, 'meter.test', 'meter', meter._id, { result: input.result, errorPercent: input.errorPercent?.toFixed(), certificateNo: input.certificateNo });
    return meter;
  }

  /** Meters whose calibration falls due by the given date (default: in the next 30 days), oldest first. */
  async calibrationDue(user: AuthUser, by?: Date) {
    const limit = by ?? new Date(Date.now() + 30 * 86_400_000);
    const meters = await this.db.meters
      .find({ organisationId: user.organisationId, status: { $in: ['INSTALLED', 'IN_STORE', 'FAULTY'] }, calibrationDue: { $ne: null, $lte: limit } }, { history: 0 })
      .sort({ calibrationDue: 1 })
      .limit(500)
      .lean();
    const customers = await this.db.customers.find({ _id: { $in: meters.map((m) => m.customerId).filter(Boolean) } }, { accountNo: 1, name: 1 }).lean();
    const byId = new Map(customers.map((c) => [c._id.toHexString(), c]));
    return meters.map((m) => ({ ...m, lastTest: m.tests?.[m.tests.length - 1] ?? null, customer: m.customerId ? (byId.get(m.customerId.toHexString()) ?? null) : null }));
  }
}
