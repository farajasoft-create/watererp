import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { WaterDb as Db } from '../db';
import { CHEMICAL_MOVEMENTS, FACILITY_TYPES, SAMPLE_POINTS } from '../ops-schemas';
import { assessQuality, hoursPerDay } from './quality';

type FacilityType = (typeof FACILITY_TYPES)[number];

export interface FacilityInput {
  code: string;
  name: string;
  type: FacilityType;
  zoneId?: Types.ObjectId | null;
  gps?: { lat: number; lng: number } | null;
  capacity?: Decimal;
  operator?: { name?: string; phone?: string };
  customerId?: Types.ObjectId | null;
  pricePerJerrican?: Decimal;
  commissionedOn?: Date | null;
  active?: boolean;
  notes?: string;
}

export interface ProductionInput {
  facilityId: Types.ObjectId;
  date: Date;
  abstracted?: Decimal;
  treated?: Decimal;
  supplied?: Decimal;
  pumpHours?: Decimal;
  powerKwh?: Decimal;
  downtimeHours?: Decimal;
  chemicals?: { chemicalId: Types.ObjectId; quantity: Decimal }[];
  note?: string;
}

export interface QualityInput {
  sampledAt: Date;
  point: (typeof SAMPLE_POINTS)[number];
  facilityId?: Types.ObjectId | null;
  zoneId?: Types.ObjectId | null;
  location?: string;
  residualChlorine?: Decimal | null;
  turbidity?: Decimal | null;
  ph?: Decimal | null;
  eColi?: Decimal | null;
  totalColiforms?: Decimal | null;
  colour?: Decimal | null;
  conductivity?: Decimal | null;
  lab?: string;
  sampledBy?: string;
  note?: string;
}

const d = (v: Decimal | null | undefined) => (v === null || v === undefined ? undefined : toD128(v));

/**
 * Production and treatment records: facilities (intakes, boreholes, works, pump stations, reservoirs,
 * kiosks), daily production with chemicals dosed, chemical stocks, water-quality tests judged against
 * the drinking water standard, reservoir levels and the supply timetable of each zone.
 */
export class ProductionService {
  /** Wired in the container: a failed quality test raises an alert ticket. */
  onQualityFailure: (user: AuthUser, testId: Types.ObjectId, failures: string[]) => Promise<void> = async () => undefined;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // Facilities ---------------------------------------------------------------------------------

  listFacilities(user: AuthUser, type?: FacilityType) {
    return this.db.facilities.find({ organisationId: user.organisationId, ...(type && { type }) }).sort({ type: 1, code: 1 }).lean();
  }

  async saveFacility(user: AuthUser, input: FacilityInput, id?: Types.ObjectId) {
    const doc = {
      ...input,
      code: input.code.trim().toUpperCase(),
      capacity: toD128(input.capacity ?? 0),
      pricePerJerrican: toD128(input.pricePerJerrican ?? 0),
    };
    if (input.zoneId && !(await this.db.zones.exists({ _id: input.zoneId, organisationId: user.organisationId }))) throw new BadRequestException('Unknown zone');
    const saved = id
      ? await this.db.facilities.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, doc, { new: true }).lean()
      : (await this.db.facilities.create([{ ...doc, organisationId: user.organisationId }]))[0].toObject();
    if (!saved) throw new NotFoundException('Facility not found');
    await this.audit.record(user, id ? 'water.facility.update' : 'water.facility.create', 'facility', saved._id, { code: doc.code });
    return saved;
  }

  // Chemicals ----------------------------------------------------------------------------------

  async listChemicals(user: AuthUser) {
    const items = await this.db.chemicals.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean();
    return items.map((c) => ({ ...c, low: dec(c.stock).lte(dec(c.reorderLevel)) }));
  }

  async saveChemical(user: AuthUser, input: { code: string; name: string; unit?: string; reorderLevel?: Decimal; unitCost?: Decimal; active?: boolean }, id?: Types.ObjectId) {
    const doc = { ...input, code: input.code.trim().toUpperCase(), reorderLevel: toD128(input.reorderLevel ?? 0), unitCost: toD128(input.unitCost ?? 0) };
    const saved = id ? await this.db.chemicals.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, doc, { new: true }).lean() : (await this.db.chemicals.create([{ ...doc, organisationId: user.organisationId }]))[0].toObject();
    if (!saved) throw new NotFoundException('Chemical not found');
    await this.audit.record(user, 'water.chemical.save', 'chemical', saved._id, { code: doc.code });
    return saved;
  }

  private async move(organisationId: Types.ObjectId, m: { chemicalId: Types.ObjectId; date: Date; type: (typeof CHEMICAL_MOVEMENTS)[number]; quantity: Decimal; facilityId?: Types.ObjectId | null; reference?: string; sourceId?: Types.ObjectId; by?: Types.ObjectId }, session: ClientSession) {
    const chem = await this.db.chemicals.findOneAndUpdate({ _id: m.chemicalId, organisationId }, { $inc: { stock: toD128(m.quantity) } }, { new: true, session });
    if (!chem) throw new BadRequestException('Unknown chemical');
    if (dec(chem.stock).isNegative()) throw new BadRequestException(`Not enough ${chem.name} in stock (${dec(chem.stock).plus(m.quantity.negated()).toFixed()} ${chem.unit})`);
    await this.db.chemicalMovements.create([{ ...m, organisationId, quantity: toD128(m.quantity), balance: chem.stock }], { session });
  }

  /** Stock received (from stores or a supplier delivery), or a stock-take correction. */
  async receiveChemical(user: AuthUser, input: { chemicalId: Types.ObjectId; date: Date; quantity: Decimal; type: 'RECEIPT' | 'ADJUSTMENT'; reference?: string }) {
    if (input.type === 'RECEIPT' && input.quantity.lte(0)) throw new BadRequestException('A receipt must be above zero');
    await this.db.transaction((session) => this.move(user.organisationId, { ...input, by: user.id }, session));
    await this.audit.record(user, 'water.chemical.movement', 'chemical', input.chemicalId, { type: input.type, quantity: input.quantity.toFixed() });
    return this.db.chemicals.findById(input.chemicalId).lean();
  }

  chemicalMovements(user: AuthUser, chemicalId: Types.ObjectId) {
    return this.db.chemicalMovements.find({ organisationId: user.organisationId, chemicalId }).sort({ createdAt: -1 }).limit(200).lean();
  }

  // Production ---------------------------------------------------------------------------------

  async listProduction(user: AuthUser, q: { from: Date; to: Date; facilityId?: Types.ObjectId }) {
    const rows = await this.db.productionLogs
      .find({ organisationId: user.organisationId, date: { $gte: q.from, $lte: q.to }, ...(q.facilityId && { facilityId: q.facilityId }) })
      .sort({ date: -1 })
      .limit(1000)
      .lean();
    const totals = { abstracted: new Decimal(0), treated: new Decimal(0), supplied: new Decimal(0), powerKwh: new Decimal(0), pumpHours: new Decimal(0) };
    for (const r of rows) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = totals[k].plus(dec(r[k]));
    return { rows, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)])), kwhPerM3: totals.supplied.gt(0) ? totals.powerKwh.dividedBy(totals.supplied).toFixed(3) : null };
  }

  /** One day at a facility. Saving the same day again replaces it, and its chemicals are re-booked. */
  async recordProduction(user: AuthUser, input: ProductionInput) {
    const facility = await this.db.facilities.findOne({ _id: input.facilityId, organisationId: user.organisationId }).lean();
    if (!facility) throw new NotFoundException('Facility not found');
    const result = await this.db.transaction(async (session) => {
      const previous = await this.db.productionLogs.findOne({ organisationId: user.organisationId, facilityId: input.facilityId, date: input.date }).session(session);
      if (previous) {
        for (const c of previous.chemicals) await this.move(user.organisationId, { chemicalId: c.chemicalId!, date: input.date, type: 'ADJUSTMENT', quantity: dec(c.quantity), facilityId: input.facilityId, reference: 'Day re-entered: earlier dosing returned', sourceId: previous._id, by: user.id }, session);
        await previous.deleteOne({ session });
      }
      const [log] = await this.db.productionLogs.create(
        [
          {
            organisationId: user.organisationId,
            facilityId: input.facilityId,
            date: input.date,
            abstracted: d(input.abstracted),
            treated: d(input.treated),
            supplied: d(input.supplied),
            pumpHours: d(input.pumpHours),
            powerKwh: d(input.powerKwh),
            downtimeHours: d(input.downtimeHours),
            chemicals: (input.chemicals ?? []).map((c) => ({ chemicalId: c.chemicalId, quantity: toD128(c.quantity) })),
            note: input.note,
            recordedBy: user.id,
          },
        ],
        { session },
      );
      for (const c of input.chemicals ?? []) {
        if (c.quantity.lte(0)) throw new BadRequestException('Chemical quantities must be above zero');
        await this.move(user.organisationId, { chemicalId: c.chemicalId, date: input.date, type: 'USAGE', quantity: c.quantity.negated(), facilityId: input.facilityId, reference: `Dosing at ${facility.code}`, sourceId: log._id, by: user.id }, session);
      }
      return log.toObject();
    });
    await this.audit.record(user, 'water.production.record', 'productionLog', result._id, { facility: facility.code, date: input.date });
    return result;
  }

  // Water quality ------------------------------------------------------------------------------

  async listQuality(user: AuthUser, q: { from: Date; to: Date; failedOnly?: boolean }) {
    return this.db.qualityTests
      .find({ organisationId: user.organisationId, sampledAt: { $gte: q.from, $lte: new Date(q.to.getTime() + 86_399_999) }, ...(q.failedOnly && { passed: false }) })
      .sort({ sampledAt: -1 })
      .limit(1000)
      .lean();
  }

  async recordQuality(user: AuthUser, input: QualityInput) {
    const { passed, failures } = assessQuality(input.point, input);
    const [test] = await this.db.qualityTests.create([
      {
        ...input,
        organisationId: user.organisationId,
        residualChlorine: d(input.residualChlorine),
        turbidity: d(input.turbidity),
        ph: d(input.ph),
        eColi: d(input.eColi),
        totalColiforms: d(input.totalColiforms),
        colour: d(input.colour),
        conductivity: d(input.conductivity),
        passed,
        failures,
        recordedBy: user.id,
      },
    ]);
    await this.audit.record(user, 'water.quality.record', 'qualityTest', test._id, { point: input.point, passed });
    if (!passed) await this.onQualityFailure(user, test._id, failures);
    return test.toObject();
  }

  /** Share of samples meeting the standard, for chlorine and for bacteria (WASREB drinking water quality indicators). */
  async qualityCompliance(organisationId: Types.ObjectId, from: Date, to: Date) {
    const tests = await this.db.qualityTests.find({ organisationId, point: { $ne: 'RAW' }, sampledAt: { $gte: from, $lt: to } }, { residualChlorine: 1, eColi: 1, totalColiforms: 1, failures: 1, passed: 1 }).lean();
    const chlorine = tests.filter((t) => t.residualChlorine !== null && t.residualChlorine !== undefined);
    const bacteria = tests.filter((t) => (t.eColi !== null && t.eColi !== undefined) || (t.totalColiforms !== null && t.totalColiforms !== undefined));
    const pct = (ok: number, n: number) => (n ? Math.round((ok / n) * 1000) / 10 : null);
    return {
      samples: tests.length,
      passed: tests.filter((t) => t.passed).length,
      chlorineTests: chlorine.length,
      chlorineCompliancePercent: pct(chlorine.filter((t) => !t.failures.some((f) => f.startsWith('Residual chlorine'))).length, chlorine.length),
      bacteriaTests: bacteria.length,
      bacteriaCompliancePercent: pct(bacteria.filter((t) => !t.failures.some((f) => f.startsWith('E. coli') || f.startsWith('Total coliforms'))).length, bacteria.length),
    };
  }

  // Reservoirs and the supply timetable --------------------------------------------------------

  async recordLevel(user: AuthUser, input: { facilityId: Types.ObjectId; at: Date; levelPercent?: number; volume?: Decimal | null; note?: string }) {
    const f = await this.db.facilities.findOne({ _id: input.facilityId, organisationId: user.organisationId }, { type: 1, capacity: 1 }).lean();
    if (!f || !['RESERVOIR', 'TANK'].includes(f.type)) throw new BadRequestException('Pick a reservoir or tank');
    const volume = input.volume ?? (input.levelPercent !== undefined && dec(f.capacity).gt(0) ? dec(f.capacity).times(input.levelPercent).dividedBy(100) : null);
    const [row] = await this.db.reservoirLevels.create([{ ...input, organisationId: user.organisationId, volume: volume ? toD128(volume) : undefined, recordedBy: user.id }]);
    return row.toObject();
  }

  /** The latest level of every reservoir and tank, with the last week's readings. */
  async levels(user: AuthUser) {
    const tanks = await this.db.facilities.find({ organisationId: user.organisationId, type: { $in: ['RESERVOIR', 'TANK'] }, active: true }).sort({ code: 1 }).lean();
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await this.db.reservoirLevels.find({ organisationId: user.organisationId, facilityId: { $in: tanks.map((t) => t._id) }, at: { $gte: since } }).sort({ at: 1 }).lean();
    return tanks.map((t) => {
      const mine = rows.filter((r) => r.facilityId.equals(t._id));
      return { facility: t, latest: mine[mine.length - 1] ?? null, week: mine.map((r) => ({ at: r.at, levelPercent: r.levelPercent })) };
    });
  }

  listSchedules(user: AuthUser) {
    return this.db.supplySchedules.find({ organisationId: user.organisationId }).sort({ zoneId: 1, from: 1 }).lean();
  }

  async saveSchedule(user: AuthUser, input: { zoneId: Types.ObjectId; days: number[]; from: string; to: string; note?: string; active?: boolean }, id?: Types.ObjectId) {
    if (!(await this.db.zones.exists({ _id: input.zoneId, organisationId: user.organisationId }))) throw new BadRequestException('Unknown zone');
    const saved = id ? await this.db.supplySchedules.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, input, { new: true }).lean() : (await this.db.supplySchedules.create([{ ...input, organisationId: user.organisationId }]))[0].toObject();
    if (!saved) throw new NotFoundException('Timetable row not found');
    await this.audit.record(user, 'water.schedule.save', 'supplySchedule', saved._id, input);
    return saved;
  }

  async deleteSchedule(user: AuthUser, id: Types.ObjectId) {
    await this.db.supplySchedules.deleteOne({ _id: id, organisationId: user.organisationId });
    await this.audit.record(user, 'water.schedule.delete', 'supplySchedule', id, {});
    return { ok: true };
  }

  /** Average hours of supply a day per zone from the timetable (24 where a zone has none). */
  async hoursOfSupply(organisationId: Types.ObjectId) {
    const [zones, rows] = await Promise.all([this.db.zones.find({ organisationId, active: true }, { code: 1, name: 1 }).lean(), this.db.supplySchedules.find({ organisationId, active: true }).lean()]);
    return zones.map((z) => ({ zoneId: z._id, code: z.code, name: z.name, hours: hoursPerDay(rows.filter((r) => r.zoneId.equals(z._id)).map((r) => ({ days: r.days, from: r.from, to: r.to }))) }));
  }
}
