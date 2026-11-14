import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { openPortal } from '@/platform/common/branding';
import { csvResponse } from '@/platform/common/csv';
import { BadRequestException, ConflictException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { SmsService } from '@/platform/services/sms.service';
import { EstatesDb as Db } from './db';

type Id = Types.ObjectId;
const ZERO = new Decimal(0);
const DAY = 86_400_000;
const n = (v: unknown) => dec((v as { toString(): string } | null | undefined)?.toString() ?? '0');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const periodStart = (p: string) => new Date(`${p}-01T00:00:00Z`);
const periodEnd = (p: string) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0));

type EntryKind = 'RENT' | 'SERVICE' | 'PENALTY' | 'PAYMENT' | 'DEPOSIT_PAID' | 'DEPOSIT_APPLIED' | 'DEPOSIT_REFUND' | 'ADJUSTMENT';
/** Entries about the deposit, which is held separately from the rent account. */
const DEPOSIT_KINDS: EntryKind[] = ['DEPOSIT_PAID', 'DEPOSIT_REFUND'];

export interface LeaseInput { tenantId: Id; propertyId: Id; unitId: Id; startDate: Date; endDate: Date; rent: Decimal; serviceCharge: Decimal; escalationPct: number; dueDay: number; deposit: Decimal }

/** Balance owed on the rent account (deposit movements are kept apart). */
export function balanceOf(entries: { kind: string; amount?: unknown }[]) {
  return entries.filter((e) => !DEPOSIT_KINDS.includes(e.kind as EntryKind)).reduce((t, e) => t.plus(n(e.amount)), ZERO);
}

/** Rent for a period after yearly escalations from the start date. */
export function rentFor(lease: { rent?: unknown; escalationPct?: number | null; startDate: Date }, period: string) {
  const start = lease.startDate;
  const p = periodStart(period);
  let years = p.getUTCFullYear() - start.getUTCFullYear();
  if (p.getUTCMonth() < start.getUTCMonth()) years--;
  return n(lease.rent).times(new Decimal(1).plus((lease.escalationPct ?? 0) / 100).pow(Math.max(0, years))).toDecimalPlaces(2);
}

/**
 * Rented property: units and their tenants under leases with a deposit, rent and service charge billed
 * monthly (with yearly escalation), payments received against a running statement, arrears by age,
 * deposits held (a liability to the tenants), maintenance requests, and a tenant portal link.
 */
export class EstatesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
  ) {}

  // Properties and tenants --------------------------------------------------------------------------

  properties(user: AuthUser) {
    return this.db.properties.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean();
  }

  async saveProperty(user: AuthUser, id: Id | null, input: { code: string; name: string; location?: string; kind: 'RESIDENTIAL' | 'COMMERCIAL' | 'LAND' | 'MIXED'; units: { id?: Id; code: string; description?: string; sizeSqm?: number | null; marketRent: Decimal; active?: boolean }[] }) {
    const codes = input.units.map((u) => u.code.toUpperCase());
    if (new Set(codes).size !== codes.length) throw new BadRequestException('Each unit needs its own code');
    const fields = { ...input, code: input.code.toUpperCase(), units: input.units.map((u) => ({ ...(u.id && { _id: u.id }), code: u.code.toUpperCase(), description: u.description, sizeSqm: u.sizeSqm ?? null, marketRent: toD128(u.marketRent), active: u.active ?? true })) };
    try {
      const doc = id ? await this.db.properties.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, fields, { new: true }).lean() : (await this.db.properties.create({ ...fields, organisationId: user.organisationId })).toObject();
      if (!doc) throw new NotFoundException('Property not found');
      await this.audit.record(user, id ? 'estates.property.update' : 'estates.property.create', 'estatesProperty', doc._id, { code: fields.code, units: codes.length });
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Property code ${fields.code} is already used`);
      throw err;
    }
  }

  tenants(user: AuthUser) {
    return this.db.tenants.find({ organisationId: user.organisationId }, { portalTokenHash: 0 }).sort({ name: 1 }).lean();
  }

  async saveTenant(user: AuthUser, id: Id | null, input: { name: string; kind: 'INDIVIDUAL' | 'COMPANY'; idNumber?: string; kraPin?: string; phone?: string; email?: string }) {
    const doc = id ? await this.db.tenants.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, input, { new: true, projection: { portalTokenHash: 0 } }).lean() : (await this.db.tenants.create({ ...input, organisationId: user.organisationId })).toObject();
    if (!doc) throw new NotFoundException('Tenant not found');
    await this.audit.record(user, id ? 'estates.tenant.update' : 'estates.tenant.create', 'estatesTenant', doc._id, { name: input.name });
    return { ...doc, portalTokenHash: undefined };
  }

  /** A new tenant portal link (shown once); earlier links stop working. */
  async portalLink(user: AuthUser, tenantId: Id) {
    const t = await this.db.tenants.findOne({ _id: tenantId, organisationId: user.organisationId }).lean();
    if (!t) throw new NotFoundException('Tenant not found');
    const token = randomBytes(24).toString('base64url');
    await this.db.tenants.updateOne({ _id: t._id }, { portalTokenHash: hash(token) });
    await this.audit.record(user, 'estates.tenant.portal', 'estatesTenant', t._id, {});
    if (t.phone) {
      await this.sms.queue(user.organisationId, t.phone, `Your tenant portal: statement, bills and repairs at /tenants/${token}`, 'estates:portal', t._id);
      await this.sms.deliverDue(user.organisationId);
    }
    return { path: `/tenants/${token}` };
  }

  // Leases ------------------------------------------------------------------------------------------

  async createLease(user: AuthUser, input: LeaseInput) {
    const org = user.organisationId;
    if (input.endDate <= input.startDate) throw new BadRequestException('The lease must end after it starts');
    const [tenant, property] = await Promise.all([this.db.tenants.findOne({ _id: input.tenantId, organisationId: org }).lean(), this.db.properties.findOne({ _id: input.propertyId, organisationId: org }).lean()]);
    if (!tenant) throw new BadRequestException('Tenant not found');
    const unit = property?.units.find((u) => u._id.equals(input.unitId));
    if (!property || !unit) throw new BadRequestException('Unit not found');
    const clash = await this.db.leases.findOne({ organisationId: org, unitId: input.unitId, status: 'ACTIVE', startDate: { $lt: input.endDate }, endDate: { $gt: input.startDate } }).lean();
    if (clash) throw new ConflictException(`${unit.code} is let under ${clash.number} for those dates`);
    const seq = await this.db.next(org, 'estates:lease');
    const [lease] = await this.db.leases.create([{ organisationId: org, number: `LSE-${String(seq).padStart(4, '0')}`, ...input, rent: toD128(input.rent), serviceCharge: toD128(input.serviceCharge), deposit: toD128(input.deposit) }]);
    await this.audit.record(user, 'estates.lease.create', 'estatesLease', lease._id, { number: lease.number, unit: unit.code, tenant: tenant.name, rent: input.rent.toFixed(2) });
    return this.lease(user, lease._id);
  }

  private async load(organisationId: Id, id: Id) {
    const l = await this.db.leases.findOne({ _id: id, organisationId }).lean();
    if (!l) throw new NotFoundException('Lease not found');
    return l;
  }

  /** The lease with its statement (running balance), deposit held, and who and where it is. */
  async statement(organisationId: Id, id: Id) {
    const l = await this.load(organisationId, id);
    const [tenant, property] = await Promise.all([this.db.tenants.findById(l.tenantId, { name: 1, phone: 1, email: 1 }).lean(), this.db.properties.findById(l.propertyId, { code: 1, name: 1, units: 1 }).lean()]);
    let running = ZERO;
    const lines = [...l.entries]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((e) => {
        const deposit = DEPOSIT_KINDS.includes(e.kind as EntryKind);
        if (!deposit) running = running.plus(n(e.amount));
        return { id: e._id, date: e.date, kind: e.kind, period: e.period, description: e.description, reference: e.reference, amount: n(e.amount), balance: deposit ? null : running };
      });
    const depositHeld = n(l.depositPaid).minus(n(l.depositRefunded)).minus(l.entries.filter((e) => e.kind === 'DEPOSIT_APPLIED').reduce((t, e) => t.plus(n(e.amount).abs()), ZERO));
    return {
      ...l,
      entries: undefined,
      tenant,
      property: property ? { id: property._id, code: property.code, name: property.name } : null,
      unit: property?.units.find((u) => u._id.equals(l.unitId))?.code ?? '',
      statement: lines,
      balance: running,
      depositHeld,
      currentRent: rentFor(l, new Date().toISOString().slice(0, 7)),
    };
  }

  lease(user: AuthUser, id: Id) {
    return this.statement(user.organisationId, id);
  }

  private async post(user: AuthUser | { organisationId: Id; id?: Id }, leaseId: Id, entry: { date: Date; kind: EntryKind; amount: Decimal; period?: string; description?: string; reference?: string }) {
    await this.db.leases.updateOne({ _id: leaseId }, { $push: { entries: { ...entry, amount: toD128(entry.amount), by: user.id ?? null } } });
  }

  /**
   * Bills rent and service charge for a month on every active lease covering it, once per lease and
   * month; the tenant gets an SMS with the amount and the balance.
   */
  async billRent(user: AuthUser, period: string) {
    const start = periodStart(period);
    const end = periodEnd(period);
    const leases = await this.db.leases.find({ organisationId: user.organisationId, status: 'ACTIVE', startDate: { $lte: end }, endDate: { $gte: start } }).lean();
    let billed = 0;
    let total = ZERO;
    for (const l of leases) {
      if (l.entries.some((e) => e.kind === 'RENT' && e.period === period)) continue;
      const rent = rentFor(l, period);
      const due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), l.dueDay ?? 5));
      await this.post(user, l._id, { date: due, kind: 'RENT', amount: rent, period, description: `Rent ${period}` });
      if (n(l.serviceCharge).gt(0)) await this.post(user, l._id, { date: due, kind: 'SERVICE', amount: n(l.serviceCharge), period, description: `Service charge ${period}` });
      const balance = balanceOf(l.entries).plus(rent).plus(n(l.serviceCharge));
      const tenant = await this.db.tenants.findById(l.tenantId, { phone: 1 }).lean();
      if (tenant?.phone) await this.sms.queue(user.organisationId, tenant.phone, `Rent for ${period} (${l.number}): KES ${rent.plus(n(l.serviceCharge)).toFixed(2)}, due ${due.toISOString().slice(0, 10)}. Balance now KES ${balance.toFixed(2)}.`, 'estates:rent', l._id);
      billed++;
      total = total.plus(rent).plus(n(l.serviceCharge));
    }
    if (billed) await this.sms.deliverDue(user.organisationId);
    await this.audit.record(user, 'estates.rent.bill', 'estatesLease', null, { period, billed, total: total.toFixed(2) });
    return { period, billed, total };
  }

  async receive(user: AuthUser, id: Id, input: { date: Date; amount: Decimal; reference?: string; kind: 'RENT' | 'DEPOSIT' }) {
    const l = await this.load(user.organisationId, id);
    if (input.amount.lte(0)) throw new BadRequestException('Enter the amount received');
    if (input.kind === 'DEPOSIT') {
      if (n(l.depositPaid).plus(input.amount).gt(n(l.deposit))) throw new BadRequestException(`The deposit is ${n(l.deposit).toFixed(2)}`);
      await this.post(user, id, { date: input.date, kind: 'DEPOSIT_PAID', amount: input.amount, reference: input.reference, description: 'Deposit received' });
      await this.db.leases.updateOne({ _id: id }, { $set: { depositPaid: toD128(n(l.depositPaid).plus(input.amount)) } });
    } else await this.post(user, id, { date: input.date, kind: 'PAYMENT', amount: input.amount.neg(), reference: input.reference, description: 'Payment received' });
    await this.audit.record(user, 'estates.lease.receive', 'estatesLease', id, { kind: input.kind, amount: input.amount.toFixed(2), reference: input.reference });
    return this.lease(user, id);
  }

  async adjust(user: AuthUser, id: Id, input: { amount: Decimal; description: string; kind: 'ADJUSTMENT' | 'PENALTY' }) {
    await this.load(user.organisationId, id);
    await this.post(user, id, { date: new Date(), kind: input.kind, amount: input.amount, description: input.description });
    await this.audit.record(user, 'estates.lease.adjust', 'estatesLease', id, { amount: input.amount.toFixed(2), description: input.description });
    return this.lease(user, id);
  }

  /** Ends a lease: the deposit first clears what is owed, and the rest is refunded to the tenant. */
  async end(user: AuthUser, id: Id, input: { date: Date; reason?: string; refundReference?: string; deductions?: Decimal }) {
    const s = await this.statement(user.organisationId, id);
    if (s.status !== 'ACTIVE') throw new BadRequestException('The lease has already ended');
    let held = s.depositHeld;
    if (input.deductions && input.deductions.gt(0)) {
      await this.post(user, id, { date: input.date, kind: 'ADJUSTMENT', amount: input.deductions, description: `Damages and other charges on exit${input.reason ? `: ${input.reason}` : ''}` });
    }
    const owed = s.balance.plus(input.deductions ?? 0);
    const applied = Decimal.min(Decimal.max(owed, 0), held);
    if (applied.gt(0)) {
      await this.post(user, id, { date: input.date, kind: 'DEPOSIT_APPLIED', amount: applied.neg(), description: 'Deposit applied to the balance' });
      held = held.minus(applied);
    }
    if (held.gt(0)) await this.post(user, id, { date: input.date, kind: 'DEPOSIT_REFUND', amount: held.neg(), reference: input.refundReference, description: 'Deposit refunded' });
    await this.db.leases.updateOne({ _id: id }, { status: input.date < s.endDate ? 'TERMINATED' : 'ENDED', endedAt: input.date, depositRefunded: toD128(n(s.depositRefunded).plus(held)) });
    await this.audit.record(user, 'estates.lease.end', 'estatesLease', id, { applied: applied.toFixed(2), refunded: held.toFixed(2), reason: input.reason });
    return { ...(await this.lease(user, id)), depositApplied: applied, depositRefunded: held };
  }

  /** Every unit: who is in it, the rent, what they owe and how old the debt is; and the deposits held. */
  async rentRoll(user: AuthUser) {
    const [properties, leases, tenants] = await Promise.all([this.db.properties.find({ organisationId: user.organisationId }).lean(), this.db.leases.find({ organisationId: user.organisationId, status: 'ACTIVE' }).lean(), this.db.tenants.find({ organisationId: user.organisationId }, { name: 1 }).lean()]);
    const now = Date.now();
    const rows = properties.flatMap((p) =>
      p.units.filter((u) => u.active).map((u) => {
        const l = leases.find((x) => x.unitId.equals(u._id));
        if (!l) return { propertyId: p._id, property: p.code, unit: u.code, description: u.description, occupied: false, marketRent: n(u.marketRent), lease: null };
        const balance = balanceOf(l.entries);
        // Arrears age from the oldest bill not covered by payments (first in, first out).
        let paid = l.entries.filter((e) => n(e.amount).lt(0) && !DEPOSIT_KINDS.includes(e.kind as EntryKind)).reduce((t, e) => t.plus(n(e.amount).abs()), ZERO);
        let oldest: Date | null = null;
        for (const e of [...l.entries].filter((x) => n(x.amount).gt(0) && !DEPOSIT_KINDS.includes(x.kind as EntryKind)).sort((a, b) => a.date.getTime() - b.date.getTime())) {
          if (paid.gte(n(e.amount))) paid = paid.minus(n(e.amount));
          else {
            oldest = e.date;
            break;
          }
        }
        const days = oldest && balance.gt(0) ? Math.max(0, Math.floor((now - oldest.getTime()) / DAY)) : 0;
        return {
          propertyId: p._id,
          property: p.code,
          unit: u.code,
          description: u.description,
          occupied: true,
          marketRent: n(u.marketRent),
          lease: { id: l._id, number: l.number, tenant: tenants.find((t) => t._id.equals(l.tenantId))?.name ?? '', rent: rentFor(l, new Date().toISOString().slice(0, 7)), endDate: l.endDate, balance, arrearsDays: days, band: days === 0 ? 'Current' : days <= 30 ? '1–30' : days <= 90 ? '31–90' : 'Over 90', depositHeld: n(l.depositPaid).minus(n(l.depositRefunded)) },
        };
      }),
    );
    const occupied = rows.filter((r) => r.occupied);
    return {
      rows,
      totals: {
        units: rows.length,
        occupied: occupied.length,
        occupancyPct: rows.length ? Math.round((occupied.length / rows.length) * 1000) / 10 : null,
        monthlyRent: occupied.reduce((t, r) => t.plus(r.lease!.rent), ZERO),
        arrears: occupied.reduce((t, r) => t.plus(Decimal.max(r.lease!.balance, 0)), ZERO),
        depositsHeld: occupied.reduce((t, r) => t.plus(r.lease!.depositHeld), ZERO),
        expiringIn90Days: occupied.filter((r) => r.lease!.endDate.getTime() - now < 90 * DAY).length,
      },
    };
  }

  async rentRollCsv(user: AuthUser) {
    const r = await this.rentRoll(user);
    return csvResponse('rent-roll.csv', [
      ['Property', 'Unit', 'Occupied', 'Lease', 'Tenant', 'Rent', 'Balance', 'Arrears days', 'Deposit held', 'Lease ends'],
      ...r.rows.map((x) => [x.property, x.unit, x.occupied ? 'Yes' : 'No', x.lease?.number ?? '', x.lease?.tenant ?? '', x.lease?.rent.toFixed(2) ?? x.marketRent.toFixed(2), x.lease?.balance.toFixed(2) ?? '', x.lease?.arrearsDays ?? '', x.lease?.depositHeld.toFixed(2) ?? '', x.lease ? x.lease.endDate.toISOString().slice(0, 10) : '']),
    ]);
  }

  // Maintenance -------------------------------------------------------------------------------------

  async maintenanceList(user: AuthUser, status?: string) {
    const rows = await this.db.maintenance.find({ organisationId: user.organisationId, ...(status && { status }) }).sort({ createdAt: -1 }).limit(500).lean();
    const [properties, tenants] = await Promise.all([this.db.properties.find({ _id: { $in: rows.map((r) => r.propertyId) } }, { code: 1, units: 1 }).lean(), this.db.tenants.find({ _id: { $in: rows.map((r) => r.tenantId).filter(Boolean) } }, { name: 1 }).lean()]);
    return rows.map((r) => {
      const p = properties.find((x) => x._id.equals(r.propertyId));
      return { ...r, property: p?.code ?? '', unit: r.unitId ? (p?.units.find((u) => u._id.equals(r.unitId!))?.code ?? '') : '', tenant: r.tenantId ? (tenants.find((t) => t._id.equals(r.tenantId!))?.name ?? '') : '' };
    });
  }

  private async raise(organisationId: Id, input: { propertyId: Id; unitId?: Id | null; leaseId?: Id | null; tenantId?: Id | null; category: string; description: string; priority: string; raisedBy: 'TENANT' | 'STAFF' }) {
    const seq = await this.db.next(organisationId, 'estates:maintenance');
    const [doc] = await this.db.maintenance.create([{ organisationId, number: `MNT-${String(seq).padStart(5, '0')}`, ...input }]);
    return doc.toObject();
  }

  async createMaintenance(user: AuthUser, input: { propertyId: Id; unitId?: Id | null; category: string; description: string; priority: string }) {
    const p = await this.db.properties.findOne({ _id: input.propertyId, organisationId: user.organisationId }).lean();
    if (!p || (input.unitId && !p.units.some((u) => u._id.equals(input.unitId!)))) throw new BadRequestException('Property or unit not found');
    const doc = await this.raise(user.organisationId, { ...input, raisedBy: 'STAFF' });
    await this.audit.record(user, 'estates.maintenance.create', 'estatesMaintenance', doc._id, { number: doc.number });
    return doc;
  }

  async updateMaintenance(user: AuthUser, id: Id, input: { status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'; assignedTo?: Id | null; resolution?: string; cost?: Decimal }) {
    if (input.status === 'DONE' && !input.resolution?.trim()) throw new BadRequestException('Say what was done');
    const doc = await this.db.maintenance.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, { status: input.status, ...(input.assignedTo !== undefined && { assignedTo: input.assignedTo }), ...(input.resolution && { resolution: input.resolution }), ...(input.cost && { cost: toD128(input.cost) }), ...(input.status === 'DONE' && { doneAt: new Date() }) }, { new: true }).lean();
    if (!doc) throw new NotFoundException('Request not found');
    await this.audit.record(user, 'estates.maintenance.update', 'estatesMaintenance', id, { status: input.status });
    if (input.status === 'DONE' && doc.tenantId) {
      const t = await this.db.tenants.findById(doc.tenantId, { phone: 1 }).lean();
      if (t?.phone) {
        await this.sms.queue(user.organisationId, t.phone, `Repair ${doc.number} is done: ${input.resolution}`.slice(0, 300), 'estates:maintenance', doc._id);
        await this.sms.deliverDue(user.organisationId);
      }
    }
    return doc;
  }

  // Tenant portal -----------------------------------------------------------------------------------

  private async tenantFor(token: string) {
    if (!token || token.length < 20) throw new NotFoundException('This link is not valid');
    const t = await this.db.tenants.findOne({ portalTokenHash: hash(token) }).lean();
    if (!t) throw new NotFoundException('This link is not valid');
    const org = await this.db.organisations.findById(t.organisationId, { name: 1, modules: 1 }).lean();
    if (!org?.modules?.includes('estates')) throw new NotFoundException('This link is not valid');
    const branding = await openPortal(this.db.connection, t.organisationId, 'tenants');
    return { t, org, branding };
  }

  async portal(token: string) {
    const { t, org, branding } = await this.tenantFor(token);
    const leases = await this.db.leases.find({ organisationId: t.organisationId, tenantId: t._id }, { _id: 1 }).sort({ startDate: -1 }).lean();
    const statements = await Promise.all(leases.map((l) => this.statement(t.organisationId, l._id)));
    const requests = await this.db.maintenance.find({ organisationId: t.organisationId, tenantId: t._id }).sort({ createdAt: -1 }).limit(50).lean();
    return { organisation: org.name, branding, tenant: t.name, leases: statements.map((s) => ({ id: s._id, number: s.number, property: s.property?.name, unit: s.unit, status: s.status, startDate: s.startDate, endDate: s.endDate, currentRent: s.currentRent, serviceCharge: s.serviceCharge, balance: s.balance, depositHeld: s.depositHeld, statement: s.statement })), requests: requests.map((r) => ({ id: r._id, number: r.number, category: r.category, description: r.description, status: r.status, resolution: r.resolution, createdAt: r.createdAt, doneAt: r.doneAt })) };
  }

  async portalRequest(token: string, input: { leaseId: Id; category: string; description: string; priority: string }) {
    const { t } = await this.tenantFor(token);
    const l = await this.db.leases.findOne({ _id: input.leaseId, organisationId: t.organisationId, tenantId: t._id, status: 'ACTIVE' }).lean();
    if (!l) throw new BadRequestException('Choose one of your current leases');
    const doc = await this.raise(t.organisationId, { propertyId: l.propertyId, unitId: l.unitId, leaseId: l._id, tenantId: t._id, category: input.category, description: input.description, priority: input.priority, raisedBy: 'TENANT' });
    if (t.phone) {
      await this.sms.queue(t.organisationId, t.phone, `We have your repair request ${doc.number}. We will let you know when it is done.`, 'estates:maintenance', doc._id);
      await this.sms.deliverDue(t.organisationId);
    }
    return { number: doc.number, status: doc.status };
  }
}
