import { Schema, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ConflictException, NotFoundException } from '@/platform/common/errors';
import { Decimal } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { NotificationsService } from '@/platform/services/notifications.service';
import type { WaterDb as Db } from '../db';
import type { ReadingsService } from '../readings/readings.service';

const { ObjectId } = Schema.Types;
export const POINT_KINDS = ['LEVEL', 'FLOW', 'PRESSURE', 'PUMP', 'CHLORINE', 'TURBIDITY', 'POWER', 'OTHER'] as const;

/** A SCADA or telemetry tag: a reservoir level, flow meter, pressure logger, pump state or analyser. */
export const telemetryPointSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    kind: { type: String, enum: POINT_KINDS, default: 'OTHER' },
    unit: { type: String, default: '' },
    facilityId: { type: ObjectId, default: null },
    zoneId: { type: ObjectId, default: null },
    /** Alarm when a value falls below `low` or rises above `high`. */
    low: { type: Number, default: null },
    high: { type: Number, default: null },
    lastValue: { type: Number, default: null },
    lastAt: { type: Date, default: null },
    alarm: { type: String, enum: ['NONE', 'LOW', 'HIGH'], default: 'NONE' },
    alarmSince: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
telemetryPointSchema.index({ organisationId: 1, code: 1 }, { unique: true });

/** Every value received, kept 400 days for trends. */
export const telemetrySampleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    pointId: { type: ObjectId, required: true },
    value: { type: Number, required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false },
);
telemetrySampleSchema.index({ pointId: 1, at: -1 });
telemetrySampleSchema.index({ pointId: 1, at: 1 }, { unique: true });
telemetrySampleSchema.index({ at: 1 }, { expireAfterSeconds: 400 * 24 * 3600 });

export interface PointInput { code: string; name: string; kind: (typeof POINT_KINDS)[number]; unit?: string; facilityId?: Types.ObjectId | null; zoneId?: Types.ObjectId | null; low?: number | null; high?: number | null; active?: boolean }

/**
 * Telemetry from SCADA, data loggers and smart (AMR/AMI) meters, from any vendor's gateway: point values
 * are stored as time series with low and high alarms (operations staff are told when a point goes into or
 * out of alarm), and smart-meter readings go through the same checks as a meter reader's.
 */
export class TelemetryService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly readings: ReadingsService,
  ) {}

  async points(user: AuthUser) {
    return this.db.telemetryPoints.find({ organisationId: user.organisationId }).sort({ alarm: -1, code: 1 }).lean();
  }

  async savePoint(user: AuthUser, id: Types.ObjectId | null, input: PointInput) {
    if (input.low !== null && input.low !== undefined && input.high !== null && input.high !== undefined && input.low >= input.high) throw new BadRequestException('The low alarm must be below the high alarm');
    const fields = { ...input, code: input.code.toUpperCase() };
    try {
      const doc = id ? await this.db.telemetryPoints.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.telemetryPoints.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Point not found');
      await this.audit.record(user, id ? 'water.telemetry.point.update' : 'water.telemetry.point.create', 'telemetryPoint', doc._id, { code: fields.code, low: input.low, high: input.high });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Point ${fields.code} already exists`);
      throw err;
    }
  }

  async series(user: AuthUser, id: Types.ObjectId, from: Date, to: Date) {
    const p = await this.db.telemetryPoints.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Point not found');
    const rows = await this.db.telemetrySamples.find({ pointId: id, at: { $gte: from, $lt: new Date(to.getTime() + 86_400_000) } }, { value: 1, at: 1 }).sort({ at: 1 }).limit(20_000).lean();
    const values = rows.map((r) => r.value);
    return { point: p, samples: rows.map((r) => ({ at: r.at, value: r.value })), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, avg: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null };
  }

  /** Takes a batch from a gateway: point values and smart-meter readings. Safe to resend. */
  async ingest(user: AuthUser, input: { points: { code: string; value: number; at: Date }[]; meters: { serialNo: string; reading: Decimal; at: Date }[] }) {
    const codes = [...new Set(input.points.map((p) => p.code.toUpperCase()))];
    const points = await this.db.telemetryPoints.find({ organisationId: user.organisationId, code: { $in: codes }, active: true }).lean();
    const byCode = new Map(points.map((p) => [p.code, p]));
    const unknown = codes.filter((c) => !byCode.has(c));
    let stored = 0;
    if (input.points.length) {
      const docs = input.points.filter((v) => byCode.has(v.code.toUpperCase())).map((v) => ({ organisationId: user.organisationId, pointId: byCode.get(v.code.toUpperCase())!._id, value: v.value, at: v.at }));
      const res = await this.db.telemetrySamples.insertMany(docs, { ordered: false }).catch((err: { insertedDocs?: unknown[] }) => err.insertedDocs ?? []);
      stored = Array.isArray(res) ? res.length : 0;
    }
    const alarms: { code: string; alarm: string; value: number }[] = [];
    for (const p of points) {
      const latest = input.points.filter((v) => v.code.toUpperCase() === p.code).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
      if (!latest || (p.lastAt && latest.at <= p.lastAt)) continue;
      const state = p.low !== null && p.low !== undefined && latest.value < p.low ? 'LOW' : p.high !== null && p.high !== undefined && latest.value > p.high ? 'HIGH' : 'NONE';
      await this.db.telemetryPoints.updateOne({ _id: p._id }, { lastValue: latest.value, lastAt: latest.at, alarm: state, ...(state !== p.alarm && { alarmSince: state === 'NONE' ? null : latest.at }) });
      if (state !== p.alarm) {
        alarms.push({ code: p.code, alarm: state, value: latest.value });
        const ops = await this.db.users.find({ organisationId: user.organisationId, active: true, $or: [{ isAdmin: true }, { access: { $elemMatch: { module: 'water', role: { $in: ['MANAGER', 'TECHNICAL'] } } } }] }, { _id: 1 }).lean();
        await this.notifications.notify(user.organisationId, ops.map((u) => u._id), {
          title: state === 'NONE' ? `${p.name} back to normal (${latest.value} ${p.unit})` : `ALARM ${state}: ${p.name} at ${latest.value} ${p.unit}`,
          body: state === 'NONE' ? undefined : `Limit ${state === 'LOW' ? `low ${p.low}` : `high ${p.high}`} ${p.unit}`,
          link: '/water/telemetry',
          module: 'water',
          email: state !== 'NONE',
        });
      }
    }
    // Smart meters: the latest reading of each meter in the batch, checked like any other reading.
    const latestPerMeter = new Map<string, { serialNo: string; reading: Decimal; at: Date }>();
    for (const m of input.meters) {
      const k = m.serialNo.trim().toUpperCase();
      const cur = latestPerMeter.get(k);
      if (!cur || m.at > cur.at) latestPerMeter.set(k, m);
    }
    const meterResult = latestPerMeter.size ? await this.readings.importRows(user, [...latestPerMeter.values()].map((m) => ({ serialNo: m.serialNo, value: m.reading, readAt: m.at, note: 'Smart meter (AMR)' }))) : null;
    return { points: { stored, unknownCodes: unknown, alarms }, meters: meterResult && { imported: meterResult.imported, failed: meterResult.failed, results: meterResult.results } };
  }
}
