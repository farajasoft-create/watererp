import { Schema, Types } from 'mongoose';
import { AuthUser } from '../auth';
import { BadRequestException } from '../common/errors';
import { Db } from '../db';

const { ObjectId } = Schema.Types;

/** One figure on one day: the warehouse keeps them for good, so trends survive changes to the live records. */
export const warehouseFactSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    date: { type: String, required: true },
    module: { type: String, required: true },
    metric: { type: String, required: true },
    label: { type: String, required: true },
    value: { type: Number, required: true },
  },
  { versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
warehouseFactSchema.index({ organisationId: 1, metric: 1, date: 1 }, { unique: true });
warehouseFactSchema.index({ organisationId: 1, date: -1 });

type Match = Record<string, unknown>;
interface Metric { key: string; module: string; label: string; collection: string; match: (day: { start: Date; end: Date; monthStart: Date }) => Match; agg: 'count' | { sum: string } }

const num = (path: string) => ({ $convert: { input: `$${path}`, to: 'double', onError: 0, onNull: 0 } });

/** The figures snapshotted each day, across every module. */
export const METRICS: Metric[] = [
  { key: 'water.activeCustomers', module: 'water', label: 'Active water connections', collection: 'water_customers', match: () => ({ status: 'ACTIVE' }), agg: 'count' },
  { key: 'water.arrears', module: 'water', label: 'Water customer arrears (KES)', collection: 'water_customers', match: () => ({ balance: { $gt: Types.Decimal128.fromString('0') } }), agg: { sum: 'balance' } },
  { key: 'water.billedMonth', module: 'water', label: 'Water billed this month to date (KES)', collection: 'water_bills', match: (d) => ({ status: 'ISSUED', billDate: { $gte: d.monthStart, $lt: d.end } }), agg: { sum: 'currentCharges' } },
  { key: 'water.collectedMonth', module: 'water', label: 'Water collected this month to date (KES)', collection: 'water_payments', match: (d) => ({ status: 'POSTED', paidAt: { $gte: d.monthStart, $lt: d.end } }), agg: { sum: 'amount' } },
  { key: 'water.openComplaints', module: 'water', label: 'Open customer complaints', collection: 'water_tickets', match: () => ({ status: { $nin: ['RESOLVED', 'CLOSED', 'CANCELLED'] } }), agg: 'count' },
  { key: 'water.producedDay', module: 'water', label: 'Water produced that day (m³)', collection: 'water_production_logs', match: (d) => ({ date: { $gte: d.start, $lt: d.end } }), agg: { sum: 'supplied' } },
  { key: 'hr.headcount', module: 'hr', label: 'Staff in post', collection: 'hr_employees', match: () => ({ status: { $in: ['ACTIVE', 'PROBATION', 'SUSPENDED'] } }), agg: 'count' },
  { key: 'hr.onLeave', module: 'hr', label: 'Staff on leave', collection: 'hr_leave_requests', match: (d) => ({ status: 'APPROVED', startDate: { $lt: d.end }, endDate: { $gte: d.start } }), agg: 'count' },
  { key: 'finance.receivables', module: 'finance', label: 'Customer invoices due (KES)', collection: 'finance_invoices', match: () => ({ kind: 'SALES_INVOICE', status: 'POSTED' }), agg: { sum: 'amountDueFunctional' } },
  { key: 'finance.payables', module: 'finance', label: 'Supplier bills due (KES)', collection: 'finance_invoices', match: () => ({ kind: 'PURCHASE_BILL', status: 'POSTED' }), agg: { sum: 'amountDueFunctional' } },
  { key: 'finance.stockValue', module: 'finance', label: 'Stock value (KES)', collection: 'finance_stockbalances', match: () => ({}), agg: { sum: 'value' } },
  { key: 'finance.openRequisitions', module: 'finance', label: 'Purchase requisitions in progress', collection: 'finance_purchaserequisitions', match: () => ({ status: { $in: ['SUBMITTED', 'APPROVED'] } }), agg: 'count' },
  { key: 'ict.openTickets', module: 'ict', label: 'Open IT help desk tickets', collection: 'ict_tickets', match: () => ({ status: { $nin: ['RESOLVED', 'CLOSED', 'CANCELLED'] } }), agg: 'count' },
  { key: 'internalaudit.openActions', module: 'internalaudit', label: 'Audit actions not yet implemented', collection: 'internalaudit_findings', match: () => ({ status: { $in: ['AGREED', 'IN_PROGRESS'] } }), agg: 'count' },
  { key: 'core.pendingApprovals', module: 'core', label: 'Approvals waiting', collection: 'approval_requests', match: () => ({ status: 'PENDING' }), agg: 'count' },
];

const EAT = 3 * 3_600_000;

/**
 * The organisation-wide data warehouse: once a day (and on demand) every module's key figures are
 * written as dated facts that never change afterwards, so the history (arrears, connections, headcount,
 * stock, backlogs) can be reported however the live records later move. BI reports on it like any other
 * dataset.
 */
export class WarehouseService {
  constructor(private readonly db: Db) {}

  async snapshot(organisationId: Types.ObjectId, modules: string[], date = new Date(Date.now() + EAT).toISOString().slice(0, 10)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Give the date as YYYY-MM-DD');
    const start = new Date(new Date(`${date}T00:00:00Z`).getTime() - EAT);
    const end = new Date(start.getTime() + 86_400_000);
    const monthStart = new Date(new Date(`${date.slice(0, 8)}01T00:00:00Z`).getTime() - EAT);
    const existing = new Set((await this.db.connection.db!.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    const written: { metric: string; value: number }[] = [];
    for (const m of METRICS) {
      if ((m.module !== 'core' && !modules.includes(m.module)) || !existing.has(m.collection)) continue;
      const [row] = await this.db.connection
        .collection(m.collection)
        .aggregate<{ v: number }>([{ $match: { organisationId, ...m.match({ start, end, monthStart }) } }, { $group: { _id: null, v: m.agg === 'count' ? { $sum: 1 } : { $sum: num(m.agg.sum) } } }])
        .toArray();
      const value = Math.round((row?.v ?? 0) * 100) / 100;
      await this.db.warehouseFacts.updateOne({ organisationId, metric: m.key, date }, { $set: { module: m.module, label: m.label, value } }, { upsert: true });
      written.push({ metric: m.key, value });
    }
    return { date, facts: written.length, written };
  }

  /** Every organisation's snapshot for today; called by the scheduler once a day. */
  async snapshotAll() {
    const orgs = await this.db.organisations.find({}, { modules: 1 }).lean();
    let facts = 0;
    for (const o of orgs) facts += (await this.snapshot(o._id, o.modules ?? [])).facts;
    return { organisations: orgs.length, facts };
  }

  async facts(user: AuthUser, q: { metric?: string; from?: string; to?: string }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.metric) filter.metric = q.metric;
    if (q.from || q.to) filter.date = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    const rows = await this.db.warehouseFacts.find(filter, { _id: 0, organisationId: 0 }).sort({ date: 1, metric: 1 }).limit(20_000).lean();
    return { metrics: METRICS.map(({ key, label, module }) => ({ key, label, module })), rows };
  }
}
