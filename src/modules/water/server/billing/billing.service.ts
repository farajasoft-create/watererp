import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { WaterDb as Db, waterSettings } from '@/modules/water/server/db';
import { TariffDoc } from '@/modules/water/server/schemas';
import { AuditService } from '@/platform/services/audit.service';
import { StatementService } from '../customers/statement.service';
import { penalty } from './arrears';
import { billCharges, ChargeLine } from './tariff';

const DAY = 86_400_000;

export interface BillRunInput {
  period: string;
  zoneId?: Types.ObjectId | null;
  billDate: Date;
  dueDate?: Date | null;
}

export interface SupplementaryInput {
  customerId: Types.ObjectId;
  period: string;
  reason: string;
  billDate: Date;
  dueDate?: Date | null;
  /** Consumption missed on earlier bills, priced on the account's tariff. */
  units?: Decimal | null;
  /** Other one-off charges (bowser water, damaged meter, …). */
  charges?: { description: string; amount: Decimal }[];
}

/** Hooks run after a run is issued; wired to SMS and accounting in the container. */
export interface BillingHooks {
  afterIssue(user: AuthUser, runId: Types.ObjectId): Promise<void>;
}

export class BillingService {
  hooks: BillingHooks = { afterIssue: async () => undefined };

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly statement: StatementService,
  ) {}

  listRuns(user: AuthUser) {
    return this.db.billRuns.find({ organisationId: user.organisationId }).sort({ period: -1, createdAt: -1 }).limit(60).lean();
  }

  async getRun(user: AuthUser, id: Types.ObjectId, q: { search?: string; page: number; pageSize: number }) {
    const run = await this.db.billRuns.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Billing run not found');
    const filter: Record<string, unknown> = { organisationId: user.organisationId, billRunId: id };
    if (q.search) filter.$or = [{ accountNo: new RegExp(q.search.replace(/[^\w-]/g, ''), 'i') }, { customerName: new RegExp(q.search.replace(/[^\w ]/g, ''), 'i') }];
    const [bills, total, estimated] = await Promise.all([
      this.db.bills
        .find(filter)
        .sort({ accountNo: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.bills.countDocuments(filter),
      this.db.bills.countDocuments({ organisationId: user.organisationId, billRunId: id, estimated: true }),
    ]);
    return { ...run, estimatedCount: estimated, bills: { items: bills, total, page: q.page, pageSize: q.pageSize } };
  }

  /**
   * Prices every active connection with approved readings for the period into draft bills. Connections
   * still unread are reported, not billed: estimate or read them first.
   */
  async createRun(user: AuthUser, input: BillRunInput) {
    const org = await waterSettings(this.db, user.organisationId);
    const cycle = await this.db.cycles.findOne({ organisationId: user.organisationId, period: input.period }).lean();
    if (!cycle) throw new BadRequestException(`There is no reading cycle for ${input.period}`);
    const open = await this.db.billRuns.exists({ organisationId: user.organisationId, period: input.period, kind: { $ne: 'SUPPLEMENTARY' }, status: { $in: ['DRAFT', 'APPROVING'] } });
    if (open) throw new ConflictException(`A ${input.period} billing run is already waiting; approve or cancel it first`);
    const dueDate = input.dueDate ?? new Date(input.billDate.getTime() + (org.billing?.dueDays ?? 14) * DAY);
    if (dueDate < input.billDate) throw new BadRequestException('The due date cannot be before the bill date');

    const customerFilter: Record<string, unknown> = { organisationId: user.organisationId, status: 'ACTIVE' };
    if (input.zoneId) customerFilter.zoneId = input.zoneId;
    const customers = await this.db.customers.find(customerFilter, { statusHistory: 0 }).lean();
    const ids = customers.map((c) => c._id);
    const [readings, alreadyBilled, tariffs, meters] = await Promise.all([
      this.db.readings.find({ organisationId: user.organisationId, period: input.period, customerId: { $in: ids }, status: 'APPROVED' }).sort({ readAt: 1 }).lean(),
      this.db.bills.distinct('customerId', { organisationId: user.organisationId, period: input.period, status: { $ne: 'CANCELLED' }, supplementary: { $ne: true }, customerId: { $in: ids } }),
      this.db.tariffs.find({ organisationId: user.organisationId }).lean(),
      this.db.meters.find({ organisationId: user.organisationId, customerId: { $in: ids } }, { serialNo: 1, customerId: 1 }).lean(),
    ]);
    const billed = new Set(alreadyBilled.map(String));
    const tariffById = new Map(tariffs.map((t) => [t._id.toHexString(), t]));
    const meterSerial = new Map(meters.map((m) => [m.customerId!.toHexString(), m.serialNo]));
    const readingsBy = new Map<string, typeof readings>();
    for (const r of readings) {
      const key = r.customerId!.toHexString();
      readingsBy.set(key, [...(readingsBy.get(key) ?? []), r]);
    }
    const penaltyRate = dec(org.billing?.penaltyPercent);

    const [run] = await this.db.billRuns.create([{ organisationId: user.organisationId, period: input.period, zoneId: input.zoneId ?? null, billDate: input.billDate, dueDate, createdBy: user.id }]);
    const bills = [];
    const unread: string[] = [];
    const totals: Record<string, Decimal> = {};
    let totalUnits = new Decimal(0);
    for (const c of customers) {
      const key = c._id.toHexString();
      if (billed.has(key)) continue;
      const rs = readingsBy.get(key) ?? [];
      const tariff = tariffById.get(c.tariffId.toHexString());
      if (!tariff) continue;
      // Kiosks without a meter pay the fixed charges only.
      if (!rs.length && c.meterId) {
        unread.push(c.accountNo);
        continue;
      }
      const units = rs.reduce((s, r) => s.plus(dec(r.units)), new Decimal(0));
      const lines: (Omit<ChargeLine, 'code'> & { code: ChargeLine['code'] | 'PENALTY' })[] = billCharges(tariffRules(tariff), units, { sewered: Boolean(c.sewered) });
      const balance = dec(c.balance);
      if (penaltyRate.gt(0) && balance.gt(0) && c.oldestUnpaidDueDate && c.oldestUnpaidDueDate < input.billDate) {
        const p = penalty(balance, penaltyRate);
        if (p.gt(0)) lines.push({ code: 'PENALTY', description: `Late payment penalty (${penaltyRate.toFixed()}% of ${balance.toFixed(2)})`, quantity: new Decimal(1), rate: penaltyRate, amount: p });
      }
      const current = lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
      for (const l of lines) totals[l.code] = (totals[l.code] ?? new Decimal(0)).plus(l.amount);
      totalUnits = totalUnits.plus(units);
      const actual = rs.filter((r) => r.type !== 'ESTIMATED' && r.value !== null);
      bills.push({
        organisationId: user.organisationId,
        billRunId: run._id,
        customerId: c._id,
        accountNo: c.accountNo,
        customerName: c.name,
        zoneId: c.zoneId,
        category: c.category,
        period: input.period,
        readingIds: rs.map((r) => r._id),
        meterSerial: meterSerial.get(key) ?? null,
        previousReading: actual.length ? actual[0].previousValue : null,
        currentReading: actual.length ? actual[actual.length - 1].value : null,
        units: toD128(units),
        estimated: rs.some((r) => r.type === 'ESTIMATED'),
        tariffCode: tariff.code,
        lines: lines.map((l) => ({ ...l, quantity: toD128(l.quantity), rate: l.rate ? toD128(l.rate) : null, amount: toD128(l.amount) })),
        currentCharges: toD128(current),
        balanceBroughtForward: toD128(balance),
        amountDue: toD128(balance.plus(current)),
        billDate: input.billDate,
        dueDate,
      });
    }
    if (bills.length) await this.db.bills.insertMany(bills);
    const totalAmount = Object.values(totals).reduce((s, v) => s.plus(v), new Decimal(0));
    run.set({ billCount: bills.length, totalUnits: toD128(totalUnits), totalAmount: toD128(totalAmount), totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, toD128(v)])) });
    await run.save();
    await this.audit.record(user, 'billrun.create', 'billRun', run._id, { period: input.period, bills: bills.length, unread: unread.length });
    return { run, unread };
  }

  async cancelRun(user: AuthUser, id: Types.ObjectId) {
    const run = await this.db.billRuns.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: 'DRAFT' }, { status: 'CANCELLED' }, { new: true });
    if (!run) throw new BadRequestException('Only a draft run can be cancelled');
    await this.db.bills.updateMany({ organisationId: user.organisationId, billRunId: id }, { status: 'CANCELLED' });
    await this.audit.record(user, 'billrun.cancel', 'billRun', id, {});
    return run;
  }

  /**
   * Issues every bill in the run. Each bill is issued in its own transaction (number, statement line,
   * readings marked billed), so an interrupted approval simply continues where it stopped when retried.
   */
  async approveRun(user: AuthUser, id: Types.ObjectId) {
    const run = await this.db.billRuns.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Billing run not found');
    if (run.status !== 'DRAFT' && run.status !== 'APPROVING') throw new BadRequestException(`The run is already ${run.status.toLowerCase()}`);
    if (run.createdBy?.equals(user.id) && !user.isAdmin) throw new ForbiddenException('Segregation of duties: someone else must approve a run you prepared');
    await this.db.billRuns.updateOne({ _id: id }, { status: 'APPROVING', approvedBy: user.id });

    const drafts = await this.db.bills.find({ organisationId: user.organisationId, billRunId: id, status: 'DRAFT' }, { _id: 1 }).lean();
    for (const { _id } of drafts) {
      await this.db.transaction(async (session) => {
        const bill = await this.db.bills.findOne({ _id, status: 'DRAFT' }).session(session);
        if (!bill) return;
        const seq = await this.db.next(user.organisationId, `bill:${run.period}`, session);
        bill.billNo = `${run.period.replace('-', '')}-${String(seq).padStart(6, '0')}${bill.supplementary ? 'S' : ''}`;
        bill.status = 'ISSUED';
        await bill.save({ session });
        await this.db.readings.updateMany({ _id: { $in: bill.readingIds } }, { status: 'BILLED' }, { session });
        await this.statement.post(
          {
            organisationId: user.organisationId,
            customerId: bill.customerId,
            date: bill.billDate!,
            type: 'BILL',
            reference: bill.billNo,
            description: bill.supplementary ? `Supplementary bill ${run.period}: ${bill.reason ?? ''}`.trim() : `Water bill ${run.period}${bill.estimated ? ' (estimated)' : ''}`,
            debit: dec(bill.currentCharges),
            sourceId: bill._id,
          },
          session,
        );
      });
    }
    const approved = await this.db.billRuns.findOneAndUpdate({ _id: id }, { status: 'APPROVED', approvedAt: new Date() }, { new: true }).lean();
    const remaining = await this.db.billRuns.exists({ organisationId: user.organisationId, period: run.period, kind: { $ne: 'SUPPLEMENTARY' }, status: { $in: ['DRAFT', 'APPROVING'] } });
    if (!remaining && !run.zoneId && run.kind !== 'SUPPLEMENTARY') await this.db.cycles.updateOne({ organisationId: user.organisationId, period: run.period }, { status: 'BILLED' });
    await this.audit.record(user, 'billrun.approve', 'billRun', id, { bills: drafts.length });
    await this.hooks.afterIssue(user, id);
    return approved;
  }

  /**
   * A one-off bill for one account: back-billing missed consumption (priced on the account's tariff),
   * bowser deliveries or other charges. It goes through the same second-person approval as a run, and
   * does not stop the account's regular bill for the period.
   */
  async createSupplementary(user: AuthUser, input: SupplementaryInput) {
    const customer = await this.db.customers.findOne({ _id: input.customerId, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    if (['APPLIED', 'REJECTED'].includes(customer.status)) throw new BadRequestException('The account is not connected');
    const settings = await waterSettings(this.db, user.organisationId);
    const dueDate = input.dueDate ?? new Date(input.billDate.getTime() + (settings.billing?.dueDays ?? 14) * DAY);
    if (dueDate < input.billDate) throw new BadRequestException('The due date cannot be before the bill date');
    const lines: { code: string; description: string; quantity: Decimal; rate: Decimal | null; amount: Decimal }[] = [];
    const units = input.units ?? new Decimal(0);
    if (units.gt(0)) {
      const tariff = await this.db.tariffs.findOne({ _id: customer.tariffId, organisationId: user.organisationId }).lean();
      if (!tariff) throw new BadRequestException('The account has no tariff');
      // Back-billed units pay the consumption bands only; fixed monthly charges were already billed.
      const priced = billCharges(tariffRules(tariff), units, { sewered: Boolean(customer.sewered) }).filter((l) => l.code === 'WATER' || l.code === 'SEWER');
      lines.push(...priced.map((l) => ({ ...l, description: `${l.description} (back-billed)` })));
    }
    for (const l of input.charges ?? []) {
      if (l.amount.lte(0)) throw new BadRequestException('Each charge must be above zero');
      lines.push({ code: 'OTHER', description: l.description, quantity: new Decimal(1), rate: null, amount: l.amount });
    }
    if (!lines.length) throw new BadRequestException('Give the units to back-bill or at least one charge');
    const current = lines.reduce((s, l) => s.plus(l.amount), new Decimal(0));
    const totals: Record<string, Decimal> = {};
    for (const l of lines) totals[l.code] = (totals[l.code] ?? new Decimal(0)).plus(l.amount);
    const balance = dec(customer.balance);
    const run = await this.db.transaction(async (session) => {
      const [r] = await this.db.billRuns.create(
        [
          {
            organisationId: user.organisationId,
            period: input.period,
            kind: 'SUPPLEMENTARY',
            customerId: customer._id,
            reason: input.reason,
            zoneId: customer.zoneId,
            billDate: input.billDate,
            dueDate,
            billCount: 1,
            totalUnits: toD128(units),
            totalAmount: toD128(current),
            totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, toD128(v)])),
            createdBy: user.id,
          },
        ],
        { session },
      );
      await this.db.bills.create(
        [
          {
            organisationId: user.organisationId,
            billRunId: r._id,
            customerId: customer._id,
            accountNo: customer.accountNo,
            customerName: customer.name,
            zoneId: customer.zoneId,
            category: customer.category,
            period: input.period,
            units: toD128(units),
            supplementary: true,
            reason: input.reason,
            lines: lines.map((l) => ({ ...l, quantity: toD128(l.quantity), rate: l.rate ? toD128(l.rate) : null, amount: toD128(l.amount) })),
            currentCharges: toD128(current),
            balanceBroughtForward: toD128(balance),
            amountDue: toD128(balance.plus(current)),
            billDate: input.billDate,
            dueDate,
          },
        ],
        { session },
      );
      await this.audit.record(user, 'billrun.supplementary', 'billRun', r._id, { accountNo: customer.accountNo, amount: current.toFixed(2), reason: input.reason }, session);
      return r;
    });
    return this.db.billRuns.findById(run._id).lean();
  }

  async getBill(user: AuthUser, id: Types.ObjectId) {
    const bill = await this.db.bills.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!bill) throw new NotFoundException('Bill not found');
    const [org, customer] = await Promise.all([
      Promise.all([this.db.organisations.findById(user.organisationId, { name: 1, address: 1, phone: 1, email: 1, kraPin: 1 }).lean(), waterSettings(this.db, user.organisationId)]),
      this.db.customers.findById(bill.customerId, { name: 1, accountNo: 1, plotNo: 1, location: 1, phone: 1, category: 1 }).lean(),
    ]);
    const [o, settings] = org;
    return { ...bill, organisation: o ? { name: o.name, address: o.address, phone: o.phone, email: o.email, kraPin: o.kraPin, paybill: settings.billing?.paybill, footer: settings.billing?.billFooter } : null, customer };
  }

  /** Charges a bill would carry, for the tariff calculator and checks before a run. */
  async preview(user: AuthUser, input: { tariffId: Types.ObjectId; units: Decimal; sewered: boolean }) {
    const tariff = await this.db.tariffs.findOne({ _id: input.tariffId, organisationId: user.organisationId }).lean();
    if (!tariff) throw new NotFoundException('Tariff not found');
    const lines = billCharges(tariffRules(tariff), input.units, { sewered: input.sewered });
    return { lines, total: lines.reduce((s, l) => s.plus(l.amount), new Decimal(0)) };
  }
}

export function tariffRules(t: Pick<TariffDoc, 'blocks' | 'meterRent' | 'sewerPercent' | 'minimumCharge'>) {
  return {
    blocks: t.blocks.map((b) => ({ upTo: b.upTo ? b.upTo.toString() : null, rate: b.rate?.toString() ?? '0', fixedAmount: b.fixedAmount ? b.fixedAmount.toString() : null })),
    meterRent: t.meterRent?.toString(),
    sewerPercent: t.sewerPercent?.toString(),
    minimumCharge: t.minimumCharge?.toString(),
  };
}
