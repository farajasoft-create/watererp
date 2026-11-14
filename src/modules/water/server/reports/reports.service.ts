import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { Decimal, dec, round } from '@/platform/common/money';
import { WaterDb as Db } from '@/modules/water/server/db';
import { ageingBucket, AGEING_BUCKETS, AgeingBucket } from '../billing/arrears';
import { nrwRating, waterBalance } from '../nrw/water-balance';

function periodRange(period: string): { from: Date; to: Date } {
  const [y, m] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

const sumField = (rows: { total?: Types.Decimal128 | null }[]) => dec(rows[0]?.total?.toString());

export class ReportsService {
  constructor(private readonly db: Db) {}

  /** The water balance per zone for a period, from bulk-meter readings and issued bills. */
  async waterBalance(user: AuthUser, period: string) {
    const orgId = user.organisationId;
    const [zones, inflow, billed] = await Promise.all([
      this.db.zones.find({ organisationId: orgId }, { code: 1, name: 1, type: 1 }).sort({ code: 1 }).lean(),
      this.db.readings.aggregate<{ _id: Types.ObjectId; units: Types.Decimal128 }>([
        { $match: { organisationId: orgId, period, meterType: { $in: ['BULK', 'PRODUCTION'] }, status: { $in: ['APPROVED', 'BILLED'] } } },
        { $group: { _id: '$zoneId', units: { $sum: '$registerUnits' } } },
      ]),
      this.db.bills.aggregate<{ _id: { zone: Types.ObjectId; estimated: boolean }; units: Types.Decimal128 }>([
        { $match: { organisationId: orgId, period, status: 'ISSUED' } },
        { $group: { _id: { zone: '$zoneId', estimated: '$estimated' }, units: { $sum: '$units' } } },
      ]),
    ]);
    const input = new Map(inflow.map((r) => [String(r._id), dec(r.units?.toString())]));
    const metered = new Map<string, Decimal>();
    const unmetered = new Map<string, Decimal>();
    for (const b of billed) {
      const target = b._id.estimated ? unmetered : metered;
      const key = String(b._id.zone);
      target.set(key, (target.get(key) ?? new Decimal(0)).plus(dec(b.units?.toString())));
    }
    const rows = zones.map((z) => {
      const key = z._id.toHexString();
      const balance = waterBalance({ systemInput: input.get(key) ?? 0, billedMetered: metered.get(key) ?? 0, billedUnmetered: unmetered.get(key) ?? 0 });
      return { zoneId: z._id, code: z.code, name: z.name, type: z.type, hasBulkMeter: input.has(key), ...balance, rating: nrwRating(balance.nrwPercent) };
    });
    const sum = (f: (r: (typeof rows)[number]) => Decimal) => rows.reduce((s, r) => s.plus(f(r)), new Decimal(0));
    const measured = rows.filter((r) => r.hasBulkMeter);
    const total = waterBalance({
      systemInput: measured.reduce((s, r) => s.plus(r.systemInput), new Decimal(0)),
      billedMetered: measured.reduce((s, r) => s.plus(metered.get(r.zoneId.toHexString()) ?? 0), new Decimal(0)),
      billedUnmetered: measured.reduce((s, r) => s.plus(unmetered.get(r.zoneId.toHexString()) ?? 0), new Decimal(0)),
    });
    return { period, zones: rows, total: { ...total, rating: nrwRating(total.nrwPercent), billedAllZones: sum((r) => r.revenueWater) } };
  }

  /** Debt by age of the oldest unpaid bill, by customer category. */
  async ageing(user: AuthUser) {
    const today = new Date();
    const debtors = await this.db.customers.find({ organisationId: user.organisationId, balance: { $gt: 0 } }, { balance: 1, oldestUnpaidDueDate: 1, category: 1 }).lean();
    const zero = () => Object.fromEntries(AGEING_BUCKETS.map((b) => [b, new Decimal(0)])) as Record<AgeingBucket, Decimal>;
    const byCategory: Record<string, Record<AgeingBucket, Decimal>> = {};
    const total = zero();
    for (const d of debtors) {
      const bucket = d.oldestUnpaidDueDate ? ageingBucket(d.oldestUnpaidDueDate, today) : 'current';
      const amount = dec(d.balance);
      byCategory[d.category] ??= zero();
      byCategory[d.category][bucket] = byCategory[d.category][bucket].plus(amount);
      total[bucket] = total[bucket].plus(amount);
    }
    return { asAt: today, debtors: debtors.length, byCategory, total };
  }

  /** Headline figures and WASREB indicators for the period. */
  async dashboard(user: AuthUser, period: string) {
    const orgId = user.organisationId;
    const { from, to } = periodRange(period);
    const [statusCounts, billedRows, collectedRows, arrearsRows, metered, readingsPending, unmatched, disconnections, readCount, activeWithMeter, balance] = await Promise.all([
      this.db.customers.aggregate<{ _id: string; n: number }>([{ $match: { organisationId: orgId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      this.db.bills.aggregate<{ total: Types.Decimal128; units: Types.Decimal128; n: number }>([
        { $match: { organisationId: orgId, period, status: 'ISSUED' } },
        { $group: { _id: null, total: { $sum: '$currentCharges' }, units: { $sum: '$units' }, n: { $sum: 1 } } },
      ]),
      this.db.payments.aggregate<{ total: Types.Decimal128; n: number }>([
        { $match: { organisationId: orgId, status: 'POSTED', paidAt: { $gte: from, $lt: to } } },
        { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } },
      ]),
      this.db.customers.aggregate<{ total: Types.Decimal128 }>([{ $match: { organisationId: orgId, balance: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$balance' } } }]),
      this.db.customers.countDocuments({ organisationId: orgId, status: 'ACTIVE', meterId: { $ne: null } }),
      this.db.readings.countDocuments({ organisationId: orgId, period, status: 'PENDING' }),
      this.db.payments.countDocuments({ organisationId: orgId, status: 'UNMATCHED' }),
      this.db.disconnections.countDocuments({ organisationId: orgId, status: { $in: ['LISTED', 'NOTICE_SENT'] } }),
      this.db.readings.distinct('meterId', { organisationId: orgId, period, type: 'ACTUAL', meterType: 'CUSTOMER', status: { $in: ['APPROVED', 'BILLED', 'PENDING'] } }),
      this.db.customers.countDocuments({ organisationId: orgId, status: 'ACTIVE', meterId: { $ne: null } }),
      this.waterBalance(user, period),
    ]);
    const counts = Object.fromEntries(statusCounts.map((s) => [s._id, s.n]));
    const active = counts.ACTIVE ?? 0;
    const billed = sumField(billedRows);
    const collected = sumField(collectedRows);
    const pct = (a: Decimal, b: Decimal | number) => (dec(b).gt(0) ? round(a.div(dec(b)).times(100), 1) : null);
    const recentRuns = await this.db.billRuns.find({ organisationId: orgId }, { period: 1, status: 1, billCount: 1, totalAmount: 1, accounting: 1 }).sort({ createdAt: -1 }).limit(5).lean();
    return {
      period,
      customers: { active, byStatus: counts },
      billing: { billed, units: dec(billedRows[0]?.units?.toString()), bills: billedRows[0]?.n ?? 0 },
      collections: { collected, payments: collectedRows[0]?.n ?? 0 },
      arrears: sumField(arrearsRows),
      readings: { read: readCount.length, expected: activeWithMeter, pendingReview: readingsPending },
      work: { unmatchedPayments: unmatched, disconnectionList: disconnections },
      indicators: {
        /** Collected this month against billed this month. */
        collectionEfficiency: pct(collected, billed),
        /** Share of active connections with a working meter. */
        meteringRatio: pct(new Decimal(metered), active),
        /** Share of metered connections actually read this cycle. */
        readingCoverage: pct(new Decimal(readCount.length), activeWithMeter),
        nrwPercent: balance.total.nrwPercent,
        nrwRating: balance.total.rating,
      },
      recentRuns,
    };
  }

  /** Billing register for a period as CSV (one row per bill), for audit and the regulator. */
  async billingRegisterCsv(user: AuthUser, period: string): Promise<Response> {
    const bills = await this.db.bills.find({ organisationId: user.organisationId, period, status: 'ISSUED' }).sort({ accountNo: 1 }).lean();
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lineAmount = (b: (typeof bills)[number], code: string) => dec(b.lines.find((l) => l.code === code)?.amount?.toString()).toFixed(2);
    const rows = [
      ['Bill no', 'Account', 'Name', 'Category', 'Tariff', 'Meter', 'Previous', 'Current', 'Units', 'Estimated', 'Water', 'Sewer', 'Meter rent', 'Penalty', 'Current charges', 'Brought forward', 'Amount due', 'Due date'],
      ...bills.map((b) => [
        b.billNo,
        b.accountNo,
        b.customerName,
        b.category,
        b.tariffCode,
        b.meterSerial,
        b.previousReading?.toString() ?? '',
        b.currentReading?.toString() ?? '',
        b.units?.toString(),
        b.estimated ? 'Y' : 'N',
        lineAmount(b, 'WATER'),
        lineAmount(b, 'SEWER'),
        lineAmount(b, 'METER_RENT'),
        lineAmount(b, 'PENALTY'),
        dec(b.currentCharges).toFixed(2),
        dec(b.balanceBroughtForward).toFixed(2),
        dec(b.amountDue).toFixed(2),
        b.dueDate?.toISOString().slice(0, 10),
      ]),
    ];
    return new Response(rows.map((r) => r.map(esc).join(',')).join('\n'), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="billing-register-${period}.csv"` },
    });
  }
}
