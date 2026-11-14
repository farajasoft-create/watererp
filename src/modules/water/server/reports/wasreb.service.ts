import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { csvResponse } from '@/platform/common/csv';
import { Decimal, dec } from '@/platform/common/money';
import { WaterDb as Db, waterSettings } from '../db';
import { nrwRating, waterBalance } from '../nrw/water-balance';
import { ProductionService } from '../ops/production.service';
import { ReportsService } from './reports.service';

function range(period: string, months: number) {
  const [y, m] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - months, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

const pct = (a: Decimal | number, b: Decimal | number) => {
  const den = dec(b as Decimal);
  return den.gt(0) ? dec(a as Decimal).dividedBy(den).times(100).toDecimalPlaces(1).toNumber() : null;
};

/** WASREB benchmarks for each indicator (Impact report): good, acceptable, otherwise not acceptable. */
const BENCHMARKS = {
  coverage: { good: 90, acceptable: 80, higherIsBetter: true },
  nrw: { good: 20, acceptable: 25, higherIsBetter: false },
  metering: { good: 100, acceptable: 95, higherIsBetter: true },
  collection: { good: 95, acceptable: 85, higherIsBetter: true },
  hours: { good: 21, acceptable: 16, higherIsBetter: true },
  chlorine: { good: 95, acceptable: 90, higherIsBetter: true },
  bacteria: { good: 98, acceptable: 95, higherIsBetter: true },
  staff: { good: 5, acceptable: 8, higherIsBetter: false },
  complaints: { good: 90, acceptable: 75, higherIsBetter: true },
} as const;

function rate(key: keyof typeof BENCHMARKS, value: number | null) {
  if (value === null) return 'NO_DATA';
  const b = BENCHMARKS[key];
  if (b.higherIsBetter) return value >= b.good ? 'GOOD' : value >= b.acceptable ? 'ACCEPTABLE' : 'NOT_ACCEPTABLE';
  return value <= b.good ? 'GOOD' : value <= b.acceptable ? 'ACCEPTABLE' : 'NOT_ACCEPTABLE';
}

/**
 * The WASREB key performance indicators for a period, worked from the system's own records: water
 * coverage, non-revenue water, metering ratio, collection efficiency, hours of supply, drinking water
 * quality, staff per 1,000 connections and complaints resolved on time; with the WASREB benchmarks.
 */
export class WasrebService {
  constructor(
    private readonly db: Db,
    private readonly reports: ReportsService,
    private readonly production: ProductionService,
  ) {}

  async indicators(user: AuthUser, period: string, months = 1) {
    const orgId = user.organisationId;
    const { from, to } = range(period, months);
    const settings = await waterSettings(this.db, orgId);
    const reg = (settings.regulatory ?? {}) as { populationInArea?: number; peoplePerConnection?: number; peoplePerKiosk?: number; staffCount?: number };

    const [active, metered, domestic, kiosks, billed, collected, production, quality, hours, zoneConnections, tickets] = await Promise.all([
      this.db.customers.countDocuments({ organisationId: orgId, status: 'ACTIVE' }),
      this.db.customers.countDocuments({ organisationId: orgId, status: 'ACTIVE', meterId: { $ne: null } }),
      this.db.customers.countDocuments({ organisationId: orgId, status: 'ACTIVE', category: 'DOMESTIC' }),
      this.db.facilities.countDocuments({ organisationId: orgId, type: 'KIOSK', active: true }),
      this.db.bills.aggregate<{ units: Types.Decimal128; amount: Types.Decimal128 }>([
        { $match: { organisationId: orgId, status: 'ISSUED', billDate: { $gte: from, $lt: to } } },
        { $group: { _id: null, units: { $sum: '$units' }, amount: { $sum: '$currentCharges' } } },
      ]),
      this.db.payments.aggregate<{ total: Types.Decimal128 }>([{ $match: { organisationId: orgId, status: 'POSTED', paidAt: { $gte: from, $lt: to } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      this.db.productionLogs.aggregate<{ supplied: Types.Decimal128 }>([{ $match: { organisationId: orgId, date: { $gte: from, $lt: to } } }, { $group: { _id: null, supplied: { $sum: '$supplied' } } }]),
      this.production.qualityCompliance(orgId, from, to),
      this.production.hoursOfSupply(orgId),
      this.db.customers.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { organisationId: orgId, status: 'ACTIVE' } }, { $group: { _id: '$zoneId', n: { $sum: 1 } } }]),
      this.db.tickets.find({ organisationId: orgId, resolvedAt: { $gte: from, $lt: to } }, { resolvedAt: 1, slaDueAt: 1 }).lean(),
    ]);

    const billedUnits = dec(billed[0]?.units?.toString());
    const billedAmount = dec(billed[0]?.amount?.toString());
    const collectedAmount = dec(collected[0]?.total?.toString());
    const produced = dec(production[0]?.supplied?.toString());

    // NRW: production records when kept, otherwise the bulk meters of each zone.
    let nrw: { systemInput: string; revenueWater: string; nrwPercent: number | null; source: string };
    if (produced.gt(0)) {
      const b = waterBalance({ systemInput: produced, billedMetered: billedUnits, billedUnmetered: 0 });
      nrw = { systemInput: b.systemInput.toFixed(2), revenueWater: b.revenueWater.toFixed(2), nrwPercent: b.nrwPercent === null ? null : Number(b.nrwPercent), source: 'Production records' };
    } else {
      const wb = await this.reports.waterBalance(user, period);
      nrw = { systemInput: wb.total.systemInput.toFixed(2), revenueWater: wb.total.revenueWater.toFixed(2), nrwPercent: wb.total.nrwPercent === null ? null : Number(wb.total.nrwPercent), source: 'Bulk meters' };
    }

    const perZone = new Map(zoneConnections.map((z) => [String(z._id), z.n]));
    const weighted = hours.reduce((s, h) => s + h.hours * (perZone.get(h.zoneId.toHexString()) ?? 0), 0);
    const connectionsWithZone = hours.reduce((s, h) => s + (perZone.get(h.zoneId.toHexString()) ?? 0), 0);
    const hoursOfSupply = connectionsWithZone ? Math.round((weighted / connectionsWithZone) * 10) / 10 : null;

    const served = domestic * (reg.peoplePerConnection ?? 5) + kiosks * (reg.peoplePerKiosk ?? 300);
    const coverage = reg.populationInArea ? Math.min(100, pct(served, reg.populationInArea) ?? 0) : null;
    const staffPer1000 = reg.staffCount && active ? Math.round((reg.staffCount / active) * 10_000) / 10 : null;
    const onTime = tickets.length ? pct(tickets.filter((t) => t.slaDueAt && t.resolvedAt! <= t.slaDueAt).length, tickets.length) : null;

    const rows = [
      { key: 'coverage', name: 'Water coverage', value: coverage, unit: '%', basis: reg.populationInArea ? `${served.toLocaleString()} people served of ${reg.populationInArea.toLocaleString()} in the licence area` : 'Set the population of the licence area in Water settings' },
      { key: 'nrw', name: 'Non-revenue water', value: nrw.nrwPercent, unit: '%', basis: `${nrw.source}: ${nrw.systemInput} m³ in, ${nrw.revenueWater} m³ billed` },
      { key: 'metering', name: 'Metering ratio', value: pct(metered, active), unit: '%', basis: `${metered} of ${active} active connections metered` },
      { key: 'collection', name: 'Revenue collection efficiency', value: pct(collectedAmount, billedAmount), unit: '%', basis: `KES ${collectedAmount.toFixed(2)} collected of KES ${billedAmount.toFixed(2)} billed` },
      { key: 'hours', name: 'Hours of supply', value: hoursOfSupply, unit: 'h/day', basis: 'Supply timetables weighted by connections per zone' },
      { key: 'chlorine', name: 'Drinking water quality: residual chlorine', value: quality.chlorineCompliancePercent, unit: '%', basis: `${quality.chlorineTests} tests` },
      { key: 'bacteria', name: 'Drinking water quality: bacteriological', value: quality.bacteriaCompliancePercent, unit: '%', basis: `${quality.bacteriaTests} tests` },
      { key: 'staff', name: 'Staff per 1,000 connections', value: staffPer1000, unit: '', basis: reg.staffCount ? `${reg.staffCount} staff, ${active} connections` : 'Set the number of staff in Water settings' },
      { key: 'complaints', name: 'Complaints resolved on time', value: onTime, unit: '%', basis: `${tickets.length} resolved in the period` },
    ].map((r) => ({ ...r, rating: rate(r.key as keyof typeof BENCHMARKS, r.value), benchmark: BENCHMARKS[r.key as keyof typeof BENCHMARKS] }));

    return { period, months, from, to, rows, totals: { activeConnections: active, meteredConnections: metered, billedUnits: billedUnits.toFixed(2), billedAmount: billedAmount.toFixed(2), collected: collectedAmount.toFixed(2), produced: produced.toFixed(2), nrwRating: nrwRating(nrw.nrwPercent === null ? null : new Decimal(nrw.nrwPercent)) } };
  }

  /**
   * The WASPA (Water Services Providers Association) annual benchmarking return for a financial year
   * (July to June): connections, volumes, non-revenue water, billing and collection by customer category,
   * debtors, customer service, water quality and staffing, worked from the system's own records. Lines the
   * system cannot know (audited costs) are listed for the finance office to fill in.
   */
  async waspa(user: AuthUser, fyEnd: number) {
    const orgId = user.organisationId;
    const from = new Date(Date.UTC(fyEnd - 1, 6, 1));
    const to = new Date(Date.UTC(fyEnd, 6, 1));
    const k = await this.indicators(user, `${fyEnd}-06`, 12);
    const settings = await waterSettings(this.db, orgId);
    const reg = (settings.regulatory ?? {}) as { staffCount?: number };
    const [byCategory, newConnections, disconnected, reconnected, debtors, ticketCount, kiosks] = await Promise.all([
      this.db.bills.aggregate<{ _id: string; bills: number; units: Types.Decimal128; amount: Types.Decimal128 }>([
        { $match: { organisationId: orgId, status: 'ISSUED', billDate: { $gte: from, $lt: to } } },
        { $group: { _id: { $ifNull: ['$category', 'OTHER'] }, bills: { $sum: 1 }, units: { $sum: '$units' }, amount: { $sum: '$currentCharges' } } },
        { $sort: { _id: 1 } },
      ]),
      this.db.customers.countDocuments({ organisationId: orgId, status: { $ne: 'APPLIED' }, createdAt: { $gte: from, $lt: to } }),
      this.db.disconnections.countDocuments({ organisationId: orgId, disconnectedAt: { $gte: from, $lt: to } }),
      this.db.disconnections.countDocuments({ organisationId: orgId, reconnectedAt: { $gte: from, $lt: to } }),
      this.db.customers.aggregate<{ total: Types.Decimal128; accounts: number }>([{ $match: { organisationId: orgId, balance: { $gt: Types.Decimal128.fromString('0') } } }, { $group: { _id: null, total: { $sum: '$balance' }, accounts: { $sum: 1 } } }]),
      this.db.tickets.countDocuments({ organisationId: orgId, createdAt: { $gte: from, $lt: to } }),
      this.db.facilities.countDocuments({ organisationId: orgId, type: 'KIOSK', active: true }),
    ]);
    const val = (key: string) => k.rows.find((r) => r.key === key)?.value ?? null;
    const billedUnits = dec(k.totals.billedUnits);
    const billedAmount = dec(k.totals.billedAmount);
    const debt = dec(debtors[0]?.total?.toString());
    const active = k.totals.activeConnections;
    type Line = { section: string; item: string; value: string | number | null; unit: string; source: string };
    const lines: Line[] = [
      { section: 'Connections', item: 'Active connections', value: active, unit: 'no.', source: 'Customer register' },
      { section: 'Connections', item: 'Metered connections', value: k.totals.meteredConnections, unit: 'no.', source: 'Customer register' },
      { section: 'Connections', item: 'Metering ratio', value: val('metering'), unit: '%', source: 'Customer register' },
      { section: 'Connections', item: 'New connections in the year', value: newConnections, unit: 'no.', source: 'Customer register' },
      { section: 'Connections', item: 'Water kiosks', value: kiosks, unit: 'no.', source: 'Facilities' },
      { section: 'Connections', item: 'Disconnections for arrears', value: disconnected, unit: 'no.', source: 'Disconnections' },
      { section: 'Connections', item: 'Reconnections', value: reconnected, unit: 'no.', source: 'Disconnections' },
      { section: 'Water', item: 'Water produced (system input)', value: k.totals.produced, unit: 'm³', source: 'Production records' },
      { section: 'Water', item: 'Water billed', value: billedUnits.toFixed(2), unit: 'm³', source: 'Bills' },
      { section: 'Water', item: 'Non-revenue water', value: val('nrw'), unit: '%', source: k.rows.find((r) => r.key === 'nrw')?.basis ?? '' },
      { section: 'Water', item: 'Hours of supply', value: val('hours'), unit: 'h/day', source: 'Supply timetables' },
      { section: 'Water', item: 'Coverage', value: val('coverage'), unit: '%', source: 'Licence area population (settings)' },
      ...byCategory.flatMap((c) => [
        { section: 'Billing by category', item: `${c._id.toLowerCase()}: bills`, value: c.bills, unit: 'no.', source: 'Bills' },
        { section: 'Billing by category', item: `${c._id.toLowerCase()}: volume`, value: dec(c.units.toString()).toFixed(2), unit: 'm³', source: 'Bills' },
        { section: 'Billing by category', item: `${c._id.toLowerCase()}: amount`, value: dec(c.amount.toString()).toFixed(2), unit: 'KES', source: 'Bills' },
      ]),
      { section: 'Revenue', item: 'Water and sewer billed', value: billedAmount.toFixed(2), unit: 'KES', source: 'Bills' },
      { section: 'Revenue', item: 'Average tariff', value: billedUnits.gt(0) ? billedAmount.dividedBy(billedUnits).toFixed(2) : null, unit: 'KES/m³', source: 'Billed amount ÷ billed volume' },
      { section: 'Revenue', item: 'Collected', value: k.totals.collected, unit: 'KES', source: 'Payments' },
      { section: 'Revenue', item: 'Collection efficiency', value: val('collection'), unit: '%', source: 'Collected ÷ billed' },
      { section: 'Revenue', item: 'Customer debtors at year end', value: debt.toFixed(2), unit: 'KES', source: `${debtors[0]?.accounts ?? 0} accounts in arrears` },
      { section: 'Revenue', item: 'Debtor days', value: billedAmount.gt(0) ? debt.dividedBy(billedAmount).times(365).toDecimalPlaces(0).toNumber() : null, unit: 'days', source: 'Debtors ÷ annual billing × 365' },
      { section: 'Customer service', item: 'Complaints received', value: ticketCount, unit: 'no.', source: 'Service desk' },
      { section: 'Customer service', item: 'Complaints per 1,000 connections', value: active ? Math.round((ticketCount / active) * 10_000) / 10 : null, unit: 'no.', source: 'Service desk' },
      { section: 'Customer service', item: 'Resolved on time', value: val('complaints'), unit: '%', source: 'Service desk' },
      { section: 'Water quality', item: 'Residual chlorine compliance', value: val('chlorine'), unit: '%', source: 'Laboratory results' },
      { section: 'Water quality', item: 'Bacteriological compliance', value: val('bacteria'), unit: '%', source: 'Laboratory results' },
      { section: 'Staff', item: 'Staff', value: reg.staffCount ?? null, unit: 'no.', source: 'Water settings' },
      { section: 'Staff', item: 'Staff per 1,000 connections', value: val('staff'), unit: 'no.', source: 'Staff ÷ connections' },
      { section: 'Finance (from the audited accounts)', item: 'Operation and maintenance costs', value: null, unit: 'KES', source: 'Finance office' },
      { section: 'Finance (from the audited accounts)', item: 'Personnel costs', value: null, unit: 'KES', source: 'Finance office' },
      { section: 'Finance (from the audited accounts)', item: 'Energy costs', value: null, unit: 'KES', source: 'Finance office' },
    ];
    return { financialYear: `${fyEnd - 1}/${String(fyEnd).slice(2)}`, from, to, lines };
  }

  async waspaCsv(user: AuthUser, fyEnd: number) {
    const r = await this.waspa(user, fyEnd);
    return csvResponse(`waspa-return-${fyEnd - 1}-${fyEnd}.csv`, [['Section', 'Item', 'Value', 'Unit', 'Source'], ...r.lines.map((l) => [l.section, l.item, l.value ?? '', l.unit, l.source])]);
  }

  async indicatorsCsv(user: AuthUser, period: string, months = 1) {
    const r = await this.indicators(user, period, months);
    return csvResponse(`wasreb-indicators-${period}.csv`, [['Indicator', 'Value', 'Unit', 'Rating', 'Good', 'Acceptable', 'Basis'], ...r.rows.map((x) => [x.name, x.value ?? '', x.unit, x.rating, x.benchmark.good, x.benchmark.acceptable, x.basis])]);
  }
}
