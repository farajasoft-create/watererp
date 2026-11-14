import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum, toD128 } from '../../common/money';
import { Db } from '../../database/db.service';
import { SPONSORSHIP_KINDS } from '../../database/operational.schemas';
import { AuditService } from '../audit/audit.service';

type Id = Types.ObjectId;

export interface SponsorshipInput {
  entityId: Id;
  kind: (typeof SPONSORSHIP_KINDS)[number];
  beneficiary: string;
  beneficiaryContact?: string;
  category: string;
  purpose: string;
  eventDate?: Date | null;
  amount: Decimal;
  inKind?: string;
  inKindValue?: Decimal | null;
  benefits?: string;
}

/**
 * The sponsorship and donations register: each request is proposed, approved by someone other than the
 * proposer, and closed against the supplier payment that paid it (amount checked); the beneficiary's
 * acknowledgement is recorded; the yearly report totals cash and in-kind support by kind and category.
 */
export class SponsorshipsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async load(user: AuthUser, id: Id) {
    const s = await this.db.sponsorships.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!s) throw new NotFoundException('Sponsorship not found');
    return s;
  }

  list(user: AuthUser, q: { status?: string; year?: number }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    if (q.year) filter.createdAt = { $gte: new Date(Date.UTC(q.year, 0, 1)), $lt: new Date(Date.UTC(q.year + 1, 0, 1)) };
    return this.db.sponsorships.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  }

  async create(user: AuthUser, input: SponsorshipInput) {
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    if (input.amount.lt(0) || (input.amount.eq(0) && !input.inKindValue?.gt(0))) throw new BadRequestException('Give a cash amount or the value of the in-kind support');
    const number = await this.db.nextNumber(user.organisationId, entity, 'SPN');
    const [doc] = await this.db.sponsorships.create([
      { ...input, organisationId: user.organisationId, number, currency: entity.functionalCurrency, amount: toD128(input.amount), inKindValue: input.inKindValue ? toD128(input.inKindValue) : null, createdBy: user.id },
    ]);
    await this.audit.log(user, { action: 'sponsorship.create', recordType: 'Sponsorship', recordId: doc._id, summary: `Proposed ${number}: ${input.kind.toLowerCase()} to ${input.beneficiary}` });
    return doc.toObject();
  }

  async decide(user: AuthUser, id: Id, input: { approve: boolean; reason?: string }) {
    const s = await this.load(user, id);
    if (s.status !== 'PROPOSED') throw new BadRequestException(`${s.number} is ${s.status.toLowerCase()}`);
    if (s.createdBy.equals(user.id)) throw new ForbiddenException('Segregation of duties: you cannot approve a sponsorship you proposed');
    if (!input.approve && !input.reason?.trim()) throw new BadRequestException('Give the reason');
    const update = input.approve ? { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() } : { status: 'REJECTED', rejectionReason: input.reason };
    await this.db.sponsorships.updateOne({ _id: id }, update);
    await this.audit.log(user, { action: input.approve ? 'sponsorship.approve' : 'sponsorship.reject', recordType: 'Sponsorship', recordId: id, summary: `${input.approve ? 'Approved' : 'Rejected'} ${s.number}` });
    return this.load(user, id);
  }

  /** Closes an approved sponsorship against the posted payment that paid it. */
  async markPaid(user: AuthUser, id: Id, paymentId: Id) {
    const s = await this.load(user, id);
    if (s.status !== 'APPROVED') throw new BadRequestException('Only an approved sponsorship is paid');
    const p = await this.db.payments.findOne({ _id: paymentId, organisationId: user.organisationId }).lean();
    if (!p || p.kind !== 'PAYMENT') throw new BadRequestException('Payment not found');
    if (p.status !== 'POSTED') throw new BadRequestException(`${p.number} is not posted`);
    if (await this.db.sponsorships.exists({ organisationId: user.organisationId, paymentId, _id: { $ne: id } })) throw new BadRequestException(`${p.number} already pays another sponsorship`);
    if (dec(p.amount).plus(dec(p.withholdingAmount)).lt(dec(s.amount))) throw new BadRequestException(`${p.number} is for less than the approved amount`);
    await this.db.sponsorships.updateOne({ _id: id }, { status: 'PAID', paymentId, paymentNumber: p.number, paidAt: p.date });
    await this.audit.log(user, { action: 'sponsorship.paid', recordType: 'Sponsorship', recordId: id, summary: `${s.number} paid by ${p.number}` });
    return this.load(user, id);
  }

  async acknowledge(user: AuthUser, id: Id, text: string) {
    const s = await this.load(user, id);
    if (!['APPROVED', 'PAID'].includes(s.status)) throw new BadRequestException(`${s.number} is ${s.status.toLowerCase()}`);
    await this.db.sponsorships.updateOne({ _id: id }, { acknowledgement: text });
    await this.audit.log(user, { action: 'sponsorship.acknowledge', recordType: 'Sponsorship', recordId: id, summary: `Acknowledgement recorded for ${s.number}` });
    return this.load(user, id);
  }

  async cancel(user: AuthUser, id: Id) {
    const s = await this.load(user, id);
    if (!['PROPOSED', 'APPROVED'].includes(s.status)) throw new BadRequestException(`${s.number} is ${s.status.toLowerCase()}`);
    await this.db.sponsorships.updateOne({ _id: id }, { status: 'CANCELLED' });
    await this.audit.log(user, { action: 'sponsorship.cancel', recordType: 'Sponsorship', recordId: id, summary: `Cancelled ${s.number}` });
    return this.load(user, id);
  }

  /** The year's approved and paid support by kind and category, cash and in kind. */
  async report(user: AuthUser, year: number) {
    const rows = (await this.list(user, { year })).filter((r) => ['APPROVED', 'PAID'].includes(r.status));
    const groups = new Map<string, { kind: string; category: string; count: number; cash: Decimal; inKind: Decimal; paid: Decimal }>();
    for (const r of rows) {
      const key = `${r.kind}|${r.category}`;
      const g = groups.get(key) ?? { kind: r.kind, category: r.category, count: 0, cash: new Decimal(0), inKind: new Decimal(0), paid: new Decimal(0) };
      g.count++;
      g.cash = g.cash.plus(dec(r.amount));
      g.inKind = g.inKind.plus(r.inKindValue ? dec(r.inKindValue) : 0);
      if (r.status === 'PAID') g.paid = g.paid.plus(dec(r.amount));
      groups.set(key, g);
    }
    const out = [...groups.values()].map((g) => ({ ...g, cash: g.cash.toFixed(2), inKind: g.inKind.toFixed(2), paid: g.paid.toFixed(2) }));
    return { year, rows: out, totals: { count: rows.length, cash: sum(rows.map((r) => dec(r.amount))).toFixed(2), inKind: sum(rows.map((r) => (r.inKindValue ? dec(r.inKindValue) : new Decimal(0)))).toFixed(2) } };
  }
}
