import { createHash } from 'node:crypto';
import { mongo, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ConflictException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { WaterDb as Db, waterSettings } from '@/modules/water/server/db';
import { MeterDoc, READING_STATUSES } from '@/modules/water/server/schemas';
import { AuditService } from '@/platform/services/audit.service';
import { averageConsumption, classify, consumption, estimateUnits, FIELD_EXCEPTIONS, ReadingException } from './consumption';

export interface CaptureInput {
  /** Generated on the device; makes offline sync safe to repeat. */
  clientId: string;
  meterId: Types.ObjectId;
  value?: Decimal | null;
  /** A reason the meter could not be read, instead of a value. */
  fieldException?: (typeof FIELD_EXCEPTIONS)[number] | null;
  readAt: Date;
  gps?: { lat: number; lng: number; accuracy?: number } | null;
  photoId?: Types.ObjectId | null;
  note?: string;
}

const PHOTO_BUCKET = 'readingPhotos';
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

/** Zones a user is limited to in water (a meter reader's route); empty means every zone. */
export const readerZones = (user: AuthUser) => user.access.water?.scope ?? [];

export class ReadingsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Cycles
  // -------------------------------------------------------------------------------------------

  listCycles(user: AuthUser) {
    return this.db.cycles.find({ organisationId: user.organisationId }).sort({ period: -1 }).limit(36).lean();
  }

  async openCycle(user: AuthUser, input: { period: string; readingFrom?: Date; readingTo?: Date }) {
    const open = await this.db.cycles.findOne({ organisationId: user.organisationId, status: 'OPEN' }).lean();
    if (open) throw new ConflictException(`Close the ${open.period} reading cycle first`);
    const [cycle] = await this.db.cycles.create([{ ...input, organisationId: user.organisationId, status: 'OPEN', openedBy: user.id }]);
    await this.audit.record(user, 'cycle.open', 'cycle', cycle._id, input);
    return cycle;
  }

  async closeCycle(user: AuthUser, period: string) {
    const cycle = await this.db.cycles.findOneAndUpdate({ organisationId: user.organisationId, period, status: 'OPEN' }, { status: 'CLOSED' }, { new: true });
    if (!cycle) throw new NotFoundException('No open cycle for that period');
    await this.audit.record(user, 'cycle.close', 'cycle', cycle._id, { period });
    return cycle;
  }

  private async openPeriod(organisationId: Types.ObjectId): Promise<string> {
    const cycle = await this.db.cycles.findOne({ organisationId, status: 'OPEN' }).lean();
    if (!cycle) throw new BadRequestException('No reading cycle is open; ask the billing office to open one');
    return cycle.period;
  }

  // -------------------------------------------------------------------------------------------
  // Field route and capture
  // -------------------------------------------------------------------------------------------

  /** Everything a reader needs offline for their zones: meters, last readings and expected range. */
  async route(user: AuthUser, zoneId?: Types.ObjectId) {
    const period = await this.openPeriod(user.organisationId);
    const zoneFilter = zoneId ? [zoneId] : readerZones(user).length ? readerZones(user) : null;
    if (zoneId && readerZones(user).length && !readerZones(user).some((z) => z.equals(zoneId))) throw new BadRequestException('That zone is not on your route');
    const meterFilter: Record<string, unknown> = { organisationId: user.organisationId, status: { $in: ['INSTALLED', 'FAULTY'] } };
    if (zoneFilter) meterFilter.zoneId = { $in: zoneFilter };
    const meters = await this.db.meters.find(meterFilter, { history: 0 }).lean();
    const customers = await this.db.customers
      .find({ _id: { $in: meters.map((m) => m.customerId).filter(Boolean) }, status: { $in: ['ACTIVE', 'DISCONNECTED'] } }, { accountNo: 1, name: 1, plotNo: 1, location: 1, gps: 1, phone: 1, status: 1 })
      .lean();
    const byCustomer = new Map(customers.map((c) => [c._id.toHexString(), c]));
    const done = await this.db.readings.find({ organisationId: user.organisationId, period, meterId: { $in: meters.map((m) => m._id) }, status: { $ne: 'REJECTED' } }, { meterId: 1, type: 1 }).lean();
    const read = new Set(done.filter((r) => r.type !== 'ESTIMATED').map((r) => r.meterId.toHexString()));
    const averages = await this.averages(user.organisationId, meters.map((m) => m._id));
    const zones = await this.db.zones.find({ organisationId: user.organisationId, ...(zoneFilter && { _id: { $in: zoneFilter } }) }, { code: 1, name: 1 }).lean();

    const stops = meters
      .filter((m) => m.type !== 'CUSTOMER' || (m.customerId && byCustomer.has(m.customerId.toHexString())))
      .map((m) => {
        const c = m.customerId ? byCustomer.get(m.customerId.toHexString()) : null;
        return {
          meterId: m._id,
          serialNo: m.serialNo,
          meterType: m.type,
          dials: m.dials,
          zoneId: m.zoneId,
          lastReading: m.lastReading,
          lastReadingDate: m.lastReadingDate,
          average: averages.get(m._id.toHexString()) ?? null,
          read: read.has(m._id.toHexString()),
          customer: c ? { accountNo: c.accountNo, name: c.name, plotNo: c.plotNo, location: c.location, gps: c.gps, status: c.status } : null,
        };
      })
      .sort((a, b) => (a.customer?.accountNo ?? a.serialNo).localeCompare(b.customer?.accountNo ?? b.serialNo));
    return { period, generatedAt: new Date(), zones, stops };
  }

  /** Average billed units of each meter's latest three actual readings. */
  private async averages(organisationId: Types.ObjectId, meterIds: Types.ObjectId[]): Promise<Map<string, Decimal>> {
    const rows = await this.db.readings.aggregate<{ _id: Types.ObjectId; units: Types.Decimal128[] }>([
      { $match: { organisationId, meterId: { $in: meterIds }, type: 'ACTUAL', status: { $in: ['APPROVED', 'BILLED'] } } },
      { $sort: { readAt: -1 } },
      { $group: { _id: '$meterId', units: { $push: '$registerUnits' } } },
      { $project: { units: { $slice: ['$units', 3] } } },
    ]);
    const out = new Map<string, Decimal>();
    for (const r of rows) {
      const avg = averageConsumption(r.units.map((u) => u.toString()));
      if (avg) out.set(r._id.toHexString(), avg);
    }
    return out;
  }

  /** Billed estimates since the meter was last actually read; the next actual reading bills only the rest. */
  private async estimatedSinceActual(meter: Pick<MeterDoc, '_id' | 'organisationId' | 'lastReadingDate'>): Promise<Decimal> {
    const rows = await this.db.readings
      .find({ organisationId: meter.organisationId, meterId: meter._id, type: 'ESTIMATED', status: { $in: ['APPROVED', 'BILLED'] }, ...(meter.lastReadingDate && { readAt: { $gt: meter.lastReadingDate } }) }, { units: 1 })
      .lean();
    return rows.reduce((s, r) => s.plus(dec(r.units)), new Decimal(0));
  }

  /** Records one reading from the field or the office. A clean reading is approved at once; exceptions wait for review. */
  async capture(user: AuthUser, input: CaptureInput) {
    const existing = await this.db.readings.findOne({ organisationId: user.organisationId, clientId: input.clientId }).lean();
    if (existing) return { reading: existing, duplicate: true };

    const period = await this.openPeriod(user.organisationId);
    const meter = await this.db.meters.findOne({ _id: input.meterId, organisationId: user.organisationId }).lean();
    if (!meter) throw new NotFoundException('Meter not found');
    if (!['INSTALLED', 'FAULTY'].includes(meter.status)) throw new BadRequestException(`Meter ${meter.serialNo} is not installed`);
    if (readerZones(user).length && meter.zoneId && !readerZones(user).some((z) => z.equals(meter.zoneId!))) throw new BadRequestException('That meter is not on your route');
    const hasValue = input.value !== null && input.value !== undefined;
    if (!hasValue && !input.fieldException) throw new BadRequestException('Enter the reading or say why the meter could not be read');
    if (hasValue && input.value!.isNegative()) throw new BadRequestException('A reading cannot be negative');

    const prior = await this.db.readings.findOne({ organisationId: user.organisationId, period, meterId: meter._id, type: { $ne: 'ESTIMATED' }, status: { $in: ['PENDING', 'APPROVED', 'BILLED'] } }).lean();
    if (prior && prior.status !== 'PENDING') throw new ConflictException(`Meter ${meter.serialNo} already has an approved reading for ${period}`);

    let exception: ReadingException = input.fieldException ?? 'NONE';
    let registerUnits = new Decimal(0);
    let units = new Decimal(0);
    if (hasValue) {
      const result = consumption(meter.lastReading?.toString() ?? 0, input.value!, meter.dials);
      const avg = (await this.averages(user.organisationId, [meter._id])).get(meter._id.toHexString()) ?? null;
      const org = await waterSettings(this.db, user.organisationId);
      exception = classify(result, avg, { highFactor: org?.billing?.highFactor ?? 2, lowFactor: org?.billing?.lowFactor ?? 0.3 });
      if (result.ok) {
        registerUnits = result.units;
        units = Decimal.max(registerUnits.minus(await this.estimatedSinceActual(meter)), 0);
      }
    }
    const autoApprove = exception === 'NONE' && hasValue && meter.status === 'INSTALLED';

    return this.db.transaction(async (session) => {
      // A re-read replaces the pending reading it corrects.
      if (prior) await this.db.readings.updateOne({ _id: prior._id }, { status: 'REJECTED', reviewNote: 'Superseded by a re-read', reviewedAt: new Date() }, { session });
      const [reading] = await this.db.readings.create(
        [
          {
            organisationId: user.organisationId,
            period,
            meterId: meter._id,
            customerId: meter.customerId,
            zoneId: meter.zoneId,
            meterType: meter.type,
            previousValue: meter.lastReading,
            value: hasValue ? toD128(input.value!) : null,
            registerUnits: toD128(registerUnits),
            units: toD128(units),
            type: 'ACTUAL',
            exception,
            status: autoApprove ? 'APPROVED' : 'PENDING',
            readAt: input.readAt,
            readerId: user.id,
            gps: input.gps ?? undefined,
            photoId: input.photoId ?? null,
            note: input.note,
            clientId: input.clientId,
          },
        ],
        { session },
      );
      if (autoApprove) await this.advanceMeter(meter._id, input.value!, input.readAt, session);
      return { reading, duplicate: false };
    });
  }

  /** Syncs a batch from an offline device; each reading succeeds or fails on its own. */
  async sync(user: AuthUser, readings: CaptureInput[]) {
    const results = [];
    for (const r of readings) {
      try {
        const { reading, duplicate } = await this.capture(user, r);
        results.push({ clientId: r.clientId, ok: true, duplicate, id: reading._id, status: reading.status, exception: reading.exception });
      } catch (err) {
        results.push({ clientId: r.clientId, ok: false, error: err instanceof Error ? err.message : 'Failed' });
      }
    }
    return { results };
  }

  /**
   * Bulk upload of readings from a spreadsheet or a handheld logger export: rows of meter serial number
   * and reading. Each row goes through the same checks as a field reading; re-uploading the same file
   * does not record anything twice.
   */
  async importRows(user: AuthUser, rows: { serialNo: string; value: Decimal; readAt: Date; note?: string }[]) {
    const serials = [...new Set(rows.map((r) => r.serialNo.trim().toUpperCase()))];
    const meters = await this.db.meters.find({ organisationId: user.organisationId, serialNo: { $in: serials } }, { serialNo: 1 }).lean();
    const bySerial = new Map(meters.map((m) => [m.serialNo, m._id]));
    const results = [];
    for (const [i, r] of rows.entries()) {
      const serialNo = r.serialNo.trim().toUpperCase();
      const meterId = bySerial.get(serialNo);
      if (!meterId) {
        results.push({ row: i + 1, serialNo, ok: false, error: 'No meter with this serial number' });
        continue;
      }
      const clientId = `import-${createHash('sha1').update(`${user.organisationId.toHexString()}|${serialNo}|${r.value.toFixed()}|${r.readAt.toISOString()}`).digest('hex').slice(0, 32)}`;
      try {
        const { reading, duplicate } = await this.capture(user, { clientId, meterId, value: r.value, readAt: r.readAt, note: r.note ?? 'Bulk upload' });
        results.push({ row: i + 1, serialNo, ok: true, duplicate, status: reading.status, exception: reading.exception });
      } catch (err) {
        results.push({ row: i + 1, serialNo, ok: false, error: err instanceof Error ? err.message : 'Failed' });
      }
    }
    await this.audit.record(user, 'reading.import', 'reading', null, { rows: rows.length, ok: results.filter((r) => r.ok).length });
    return { results, imported: results.filter((r) => r.ok && !r.duplicate).length, failed: results.filter((r) => !r.ok).length };
  }

  private advanceMeter(meterId: Types.ObjectId, value: Decimal, at: Date, session: mongo.ClientSession) {
    return this.db.meters.updateOne({ _id: meterId }, { lastReading: toD128(value), lastReadingDate: at }, { session });
  }

  // -------------------------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------------------------

  async list(user: AuthUser, q: { period?: string; status?: (typeof READING_STATUSES)[number]; exception?: ReadingException; zoneId?: Types.ObjectId; exceptionsOnly?: boolean; page: number; pageSize: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.period) filter.period = q.period;
    if (q.status) filter.status = q.status;
    if (q.exception) filter.exception = q.exception;
    else if (q.exceptionsOnly) filter.exception = { $ne: 'NONE' };
    if (q.zoneId) filter.zoneId = q.zoneId;
    const [items, total] = await Promise.all([
      this.db.readings
        .find(filter)
        .sort({ readAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.readings.countDocuments(filter),
    ]);
    const [meters, customers, readers] = await Promise.all([
      this.db.meters.find({ _id: { $in: items.map((r) => r.meterId) } }, { serialNo: 1 }).lean(),
      this.db.customers.find({ _id: { $in: items.map((r) => r.customerId).filter(Boolean) } }, { accountNo: 1, name: 1 }).lean(),
      this.db.users.find({ _id: { $in: items.map((r) => r.readerId).filter(Boolean) } }, { name: 1 }).lean(),
    ]);
    const m = new Map(meters.map((x) => [x._id.toHexString(), x.serialNo]));
    const c = new Map(customers.map((x) => [x._id.toHexString(), x]));
    const u = new Map(readers.map((x) => [x._id.toHexString(), x.name]));
    return {
      items: items.map((r) => ({
        ...r,
        meterSerial: m.get(r.meterId.toHexString()) ?? null,
        customer: r.customerId ? (c.get(r.customerId.toHexString()) ?? null) : null,
        readerName: r.readerId ? (u.get(r.readerId.toHexString()) ?? null) : null,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Approves a pending reading (optionally corrected by the office) or rejects it so the meter is re-read or estimated. */
  async review(user: AuthUser, id: Types.ObjectId, input: { action: 'APPROVE' | 'REJECT'; correctedValue?: Decimal | null; note?: string }) {
    return this.db.transaction(async (session) => {
      const reading = await this.db.readings.findOne({ _id: id, organisationId: user.organisationId }).session(session);
      if (!reading) throw new NotFoundException('Reading not found');
      if (reading.status !== 'PENDING') throw new BadRequestException(`The reading is already ${reading.status.toLowerCase()}`);
      if (input.action === 'REJECT') {
        reading.set({ status: 'REJECTED', reviewedBy: user.id, reviewedAt: new Date(), reviewNote: input.note });
        await reading.save({ session });
        await this.audit.record(user, 'reading.reject', 'reading', reading._id, { note: input.note }, session);
        return reading;
      }
      const meter = await this.db.meters.findById(reading.meterId).session(session).lean();
      if (!meter) throw new NotFoundException('Meter not found');
      const value = input.correctedValue ?? (reading.value ? dec(reading.value) : null);
      if (value === null) throw new BadRequestException('There is no reading to approve; enter the corrected value or reject it so the meter is estimated');
      const result = consumption(meter.lastReading?.toString() ?? 0, value, meter.dials);
      if (!result.ok) throw new BadRequestException(`The reading is below the meter's last reading (${dec(meter.lastReading).toFixed()}); correct it or reject it`);
      const units = Decimal.max(result.units.minus(await this.estimatedSinceActual(meter)), 0);
      reading.set({
        value: toD128(value),
        registerUnits: toD128(result.units),
        units: toD128(units),
        status: 'APPROVED',
        reviewedBy: user.id,
        reviewedAt: new Date(),
        reviewNote: input.note ?? (input.correctedValue ? 'Corrected by the office' : undefined),
      });
      await reading.save({ session });
      await this.advanceMeter(meter._id, value, reading.readAt, session);
      await this.audit.record(user, 'reading.approve', 'reading', reading._id, { value: value.toFixed(), corrected: Boolean(input.correctedValue) }, session);
      return reading;
    });
  }

  /**
   * Estimates every active connection in the period that has no approved reading (not read, no access,
   * faulty meter, or rejected), from its recent average or the tariff's default.
   */
  async estimateMissing(user: AuthUser, period: string, zoneId?: Types.ObjectId) {
    const customerFilter: Record<string, unknown> = { organisationId: user.organisationId, status: 'ACTIVE', meterId: { $ne: null } };
    if (zoneId) customerFilter.zoneId = zoneId;
    const customers = await this.db.customers.find(customerFilter, { meterId: 1, tariffId: 1, zoneId: 1 }).lean();
    const readings = await this.db.readings.find({ organisationId: user.organisationId, period, customerId: { $in: customers.map((c) => c._id) }, status: { $in: ['APPROVED', 'BILLED', 'PENDING'] } }, { customerId: 1, status: 1, value: 1 }).lean();
    const pendingWithValue = new Set(readings.filter((r) => r.status === 'PENDING' && r.value !== null).map((r) => r.customerId!.toHexString()));
    const covered = new Set(readings.filter((r) => r.status !== 'PENDING').map((r) => r.customerId!.toHexString()));
    const missing = customers.filter((c) => !covered.has(c._id.toHexString()) && !pendingWithValue.has(c._id.toHexString()));
    const tariffs = new Map((await this.db.tariffs.find({ organisationId: user.organisationId }, { defaultEstimate: 1 }).lean()).map((t) => [t._id.toHexString(), t]));
    const averages = await this.averages(user.organisationId, missing.map((c) => c.meterId!));

    let created = 0;
    for (const c of missing) {
      const avg = averages.get(c.meterId!.toHexString());
      const units = estimateUnits(avg ? [avg] : [], tariffs.get(c.tariffId.toHexString())?.defaultEstimate?.toString() ?? 0);
      await this.db.transaction(async (session) => {
        // A field exception (no access, faulty) is closed off by the estimate that replaces it.
        await this.db.readings.updateMany({ organisationId: user.organisationId, period, customerId: c._id, status: 'PENDING' }, { status: 'REJECTED', reviewNote: 'Estimated', reviewedBy: user.id, reviewedAt: new Date() }, { session });
        await this.db.readings.create(
          [
            {
              organisationId: user.organisationId,
              period,
              meterId: c.meterId,
              customerId: c._id,
              zoneId: c.zoneId,
              units: toD128(units),
              type: 'ESTIMATED',
              status: 'APPROVED',
              readAt: new Date(),
              readerId: user.id,
              note: avg ? `Estimated from the average of ${avg.toFixed()} m³` : 'Estimated from the tariff default',
              reviewedBy: user.id,
              reviewedAt: new Date(),
            },
          ],
          { session },
        );
      });
      created++;
    }
    await this.audit.record(user, 'reading.estimate', 'cycle', null, { period, created, awaitingReview: pendingWithValue.size });
    return { estimated: created, awaitingReview: pendingWithValue.size };
  }

  // -------------------------------------------------------------------------------------------
  // Photos
  // -------------------------------------------------------------------------------------------

  private bucket() {
    return new mongo.GridFSBucket(this.db.connection.db!, { bucketName: PHOTO_BUCKET });
  }

  async uploadPhoto(user: AuthUser, req: Request): Promise<{ id: Types.ObjectId }> {
    const type = req.headers.get('content-type') ?? '';
    if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new BadRequestException('Upload a JPEG, PNG or WebP photo');
    const data = Buffer.from(await req.arrayBuffer());
    if (!data.length) throw new BadRequestException('The photo is empty');
    if (data.length > MAX_PHOTO_BYTES) throw new BadRequestException('The photo is larger than 3 MB');
    const id = new Types.ObjectId();
    await new Promise<void>((resolve, reject) => {
      const stream = this.bucket().openUploadStreamWithId(id, `${id.toHexString()}`, { metadata: { organisationId: user.organisationId, contentType: type, by: user.id } });
      stream.on('finish', () => resolve()).on('error', reject);
      stream.end(data);
    });
    return { id };
  }

  async photo(user: AuthUser, id: Types.ObjectId): Promise<Response> {
    const [file] = await this.bucket().find({ _id: id, 'metadata.organisationId': user.organisationId }).toArray();
    if (!file) throw new NotFoundException('Photo not found');
    const chunks: Buffer[] = [];
    for await (const chunk of this.bucket().openDownloadStream(id)) chunks.push(chunk as Buffer);
    return new Response(Buffer.concat(chunks), { headers: { 'content-type': file.metadata?.contentType ?? 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
  }
}
