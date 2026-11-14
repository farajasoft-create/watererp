import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { BillingService } from '../billing/billing.service';
import { WaterDb as Db } from '../db';

/** A 20-litre jerrican, the unit kiosks sell in. */
export const JERRICAN_M3 = new Decimal('0.02');

/**
 * Water kiosks (daily sales by jerrican, volume and takings) and water bowser deliveries; a chargeable
 * delivery to a customer raises a supplementary bill for approval.
 */
export class KiosksService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
  ) {}

  async recordSale(user: AuthUser, input: { facilityId: Types.ObjectId; date: Date; jerricans: number; amount?: Decimal | null; meterReading?: Decimal | null; note?: string }) {
    const kiosk = await this.db.facilities.findOne({ _id: input.facilityId, organisationId: user.organisationId, type: 'KIOSK' }).lean();
    if (!kiosk) throw new NotFoundException('Kiosk not found');
    const volume = JERRICAN_M3.times(input.jerricans);
    const amount = input.amount ?? dec(kiosk.pricePerJerrican).times(input.jerricans);
    const row = await this.db.kioskSales.findOneAndUpdate(
      { organisationId: user.organisationId, facilityId: input.facilityId, date: input.date },
      { jerricans: input.jerricans, volume: toD128(volume), amount: toD128(amount), meterReading: input.meterReading ? toD128(input.meterReading) : undefined, note: input.note, recordedBy: user.id },
      { upsert: true, new: true },
    ).lean();
    await this.audit.record(user, 'water.kiosk.sale', 'kioskSale', row!._id, { kiosk: kiosk.code, jerricans: input.jerricans });
    return row;
  }

  async sales(user: AuthUser, q: { from: Date; to: Date }) {
    const rows = await this.db.kioskSales.find({ organisationId: user.organisationId, date: { $gte: q.from, $lte: q.to } }).sort({ date: -1 }).limit(2000).lean();
    const kiosks = await this.db.facilities.find({ organisationId: user.organisationId, type: 'KIOSK' }, { code: 1, name: 1, operator: 1 }).lean();
    const summary = kiosks.map((k) => {
      const mine = rows.filter((r) => r.facilityId.equals(k._id));
      return { kioskId: k._id, code: k.code, name: k.name, operator: k.operator?.name, days: mine.length, jerricans: mine.reduce((s, r) => s + (r.jerricans ?? 0), 0), volume: mine.reduce((s, r) => s.plus(dec(r.volume)), new Decimal(0)).toFixed(2), amount: mine.reduce((s, r) => s.plus(dec(r.amount)), new Decimal(0)).toFixed(2) };
    });
    return { rows, summary };
  }

  async recordTrip(user: AuthUser, input: { date: Date; vehicleReg: string; driver?: string; sourceFacilityId?: Types.ObjectId | null; destination: string; customerId?: Types.ObjectId | null; volume: Decimal; rate?: Decimal; chargeable: boolean; note?: string }) {
    if (input.volume.lte(0)) throw new BadRequestException('Give the volume delivered');
    const amount = input.chargeable ? input.volume.times(input.rate ?? 0) : new Decimal(0);
    if (input.chargeable && input.customerId && amount.lte(0)) throw new BadRequestException('Give the rate per m³ for a chargeable delivery');
    const trip = await this.db.transaction(async (session) => {
      const seq = await this.db.next(user.organisationId, 'water:bowser', session);
      const [t] = await this.db.bowserTrips.create(
        [{ ...input, organisationId: user.organisationId, number: `BW-${String(seq).padStart(5, '0')}`, vehicleReg: input.vehicleReg.trim().toUpperCase(), volume: toD128(input.volume), rate: toD128(input.rate ?? 0), amount: toD128(amount), recordedBy: user.id }],
        { session },
      );
      return t.toObject();
    });
    if (input.chargeable && input.customerId && amount.gt(0)) {
      const run = await this.billing.createSupplementary(user, {
        customerId: input.customerId,
        period: input.date.toISOString().slice(0, 7),
        reason: `Bowser delivery ${trip.number}`,
        billDate: input.date,
        charges: [{ description: `Bowser water ${input.volume.toFixed()} m³ to ${input.destination} (${trip.vehicleReg})`, amount }],
      });
      await this.db.bowserTrips.updateOne({ _id: trip._id }, { billRunId: run!._id });
    }
    await this.audit.record(user, 'water.bowser.trip', 'bowserTrip', trip._id, { number: trip.number, volume: input.volume.toFixed() });
    return this.db.bowserTrips.findById(trip._id).lean();
  }

  trips(user: AuthUser, q: { from: Date; to: Date }) {
    return this.db.bowserTrips.find({ organisationId: user.organisationId, date: { $gte: q.from, $lte: q.to } }).sort({ date: -1 }).limit(2000).lean();
  }
}
