import { createHash, randomBytes } from 'node:crypto';
import { mongo, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { openPortal } from '@/platform/common/branding';
import { csvResponse } from '@/platform/common/csv';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { EmailService } from '@/platform/services/email.service';
import { SmsService } from '@/platform/services/sms.service';
import { TendersDb as Db } from './db';
import { CATEGORIES, METHODS, RESERVATIONS } from './schemas';

type Id = Types.ObjectId;
type Method = (typeof METHODS)[number];
type Role = 'CHAIR' | 'SECRETARY' | 'MEMBER';
const DAY = 86_400_000;
const n = (v: unknown) => dec((v as { toString(): string } | null | undefined)?.toString() ?? '0');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const kes = (v: unknown) => `KES ${n(v).toNumber().toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Methods that need written reasons for not tendering openly (PPADA s.91(2)). */
const NEEDS_JUSTIFICATION: Method[] = ['RESTRICTED', 'DIRECT', 'SPECIALLY_PERMITTED', 'LOW_VALUE'];
/** Methods advertised publicly with a minimum notice period. */
const ADVERTISED: Method[] = ['OPEN_NATIONAL', 'OPEN_INTERNATIONAL', 'RFP', 'TWO_STAGE', 'DESIGN_COMPETITION', 'FRAMEWORK'];

/**
 * Default ceilings (KES) per method, from the PPAD Regulations 2020 Second Schedule for a state
 * corporation of this size. Each organisation can change them under Tenders → Thresholds.
 */
export const DEFAULT_THRESHOLDS: Partial<Record<Method, string>> = { LOW_VALUE: '50000', RFQ: '5000000', RESTRICTED: '20000000' };

export interface TenderInput {
  title: string;
  description?: string;
  method: Method;
  category: (typeof CATEGORIES)[number];
  reservedFor: (typeof RESERVATIONS)[number];
  estimate: Decimal;
  planReference?: string;
  budgetLine?: string;
  justification?: string;
  bidSecurity: Decimal;
  bidValidityDays: number;
  documentIds: Id[];
  closingAt: Date;
  openingAt: Date;
  openingVenue?: string;
  mandatory: string[];
  criteria: { name: string; weight: number }[];
  passMark: number;
  financialWeight: number;
}

export interface BidInput {
  name: string;
  kraPin: string;
  email?: string;
  phone: string;
  agpo: 'NONE' | 'YOUTH' | 'WOMEN' | 'PWD';
  agpoCertificate?: string;
  local: boolean;
  amount: Decimal;
  validityDays: number;
  bidSecurityReference?: string;
  mandatory: { requirement: string; provided: boolean; reference?: string }[];
  technicalProposal?: string;
}

interface RankRow { bidId: Id; technical: number | null; financial: number | null; combined: number | null; rank: number | null; passed: boolean }

/** Ranks bids: technical average of every member's weighted scores, then price (lowest evaluated price, or quality and cost). */
export function rankBids(
  bids: { _id: Id; amount: unknown; responsive?: boolean | null }[],
  scores: { memberId: Id; bidId: Id; criterion: string; score: number }[],
  t: { criteria: { name: string; weight: number }[]; passMark: number; financialWeight: number },
): RankRow[] {
  const rows: RankRow[] = bids.map((b) => {
    if (b.responsive !== true) return { bidId: b._id, technical: null, financial: null, combined: null, rank: null, passed: false };
    if (!t.criteria.length) return { bidId: b._id, technical: null, financial: null, combined: null, rank: null, passed: true };
    const mine = scores.filter((s) => s.bidId.equals(b._id));
    const members = [...new Set(mine.map((s) => s.memberId.toHexString()))];
    const totals = members.map((m) => t.criteria.reduce((sum, c) => sum + ((mine.find((s) => s.memberId.toHexString() === m && s.criterion === c.name)?.score ?? 0) * c.weight) / 100, 0));
    const technical = totals.length ? Math.round((totals.reduce((a, x) => a + x, 0) / totals.length) * 100) / 100 : 0;
    return { bidId: b._id, technical, financial: null, combined: null, rank: null, passed: technical >= t.passMark };
  });
  const passed = rows.filter((r) => r.passed);
  const amount = (id: Id) => n(bids.find((b) => b._id.equals(id))!.amount);
  const lowest = passed.reduce<Decimal | null>((low, r) => (low === null || amount(r.bidId).lt(low) ? amount(r.bidId) : low), null);
  for (const r of passed) {
    r.financial = lowest && amount(r.bidId).gt(0) ? Math.round(lowest.div(amount(r.bidId)).times(10000).toNumber()) / 100 : 0;
    r.combined = t.financialWeight >= 100 || r.technical === null ? r.financial : Math.round((r.technical * (100 - t.financialWeight) + r.financial * t.financialWeight)) / 100;
  }
  passed.sort((a, b) => (b.combined ?? 0) - (a.combined ?? 0) || amount(a.bidId).cmp(amount(b.bidId)));
  passed.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

/**
 * Tendering under the Public Procurement and Asset Disposal Act, 2015: the notice is published on the
 * tenders portal with its documents, addenda and answers to clarifications; bidders submit sealed bids
 * online and can change or withdraw them until closing; at least three members of the opening
 * committee open them and read the prices into the register; the evaluation committee checks the
 * mandatory requirements, scores the technical criteria and ranks the bids; the head of procurement
 * gives a professional opinion; the accounting officer awards (or cancels with reasons); every bidder
 * is told the outcome at the same time with reasons; the contract can only be signed after the
 * standstill period and while no request for review is pending.
 */
export class TendersService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
    private readonly email: EmailService,
  ) {}

  // Settings ----------------------------------------------------------------------------------------

  async settings(user: AuthUser) {
    const s = await this.db.settings.findOne({ organisationId: user.organisationId }).lean();
    const set = new Map((s?.thresholds ?? []).map((t) => [t.method, t.max ? t.max.toString() : null]));
    return {
      thresholds: METHODS.map((m) => ({ method: m, max: set.has(m) ? set.get(m) : (DEFAULT_THRESHOLDS[m] ?? null) })),
      minNoticeDays: s?.minNoticeDays ?? 14,
      standstillDays: s?.standstillDays ?? 14,
    };
  }

  async saveSettings(user: AuthUser, input: { thresholds: { method: Method; max: Decimal | null }[]; minNoticeDays: number; standstillDays: number }) {
    await this.db.settings.updateOne(
      { organisationId: user.organisationId },
      { thresholds: input.thresholds.map((t) => ({ method: t.method, max: t.max ? toD128(t.max) : null })), minNoticeDays: input.minNoticeDays, standstillDays: input.standstillDays },
      { upsert: true },
    );
    await this.audit.record(user, 'tenders.settings', 'tenderSettings', user.organisationId, input);
    return this.settings(user);
  }

  // Preparing and publishing -------------------------------------------------------------------------

  private async validate(user: AuthUser, input: TenderInput) {
    if (input.openingAt < input.closingAt) throw new BadRequestException('Bids are opened at or after the closing time');
    if (NEEDS_JUSTIFICATION.includes(input.method) && !input.justification?.trim()) throw new BadRequestException('Give the reasons for using this method instead of open tendering');
    const cap = (await this.settings(user)).thresholds.find((t) => t.method === input.method)?.max;
    if (cap && input.estimate.gt(cap)) throw new BadRequestException(`The estimate is above the ${input.method.replace(/_/g, ' ').toLowerCase()} ceiling of ${kes(cap)}; use open tendering`);
    if (input.criteria.length && input.criteria.reduce((t, c) => t + c.weight, 0) !== 100) throw new BadRequestException('The technical criteria weights must add up to 100');
    if (new Set(input.criteria.map((c) => c.name.toLowerCase())).size !== input.criteria.length) throw new BadRequestException('Each criterion needs its own name');
    if (input.category === 'CONSULTANCY' && input.financialWeight >= 100 && input.criteria.length) throw new BadRequestException('Consultancy is evaluated on quality and cost: give price a weight below 100');
    if (input.documentIds.length) {
      const found = await this.db.documents.countDocuments({ _id: { $in: input.documentIds }, organisationId: user.organisationId, deletedAt: null });
      if (found !== new Set(input.documentIds.map(String)).size) throw new BadRequestException('A tender document was not found');
    }
  }

  private fields(input: TenderInput) {
    return { ...input, estimate: toD128(input.estimate), bidSecurity: toD128(input.bidSecurity) };
  }

  async create(user: AuthUser, input: TenderInput) {
    await this.validate(user, input);
    const year = new Date().getUTCFullYear();
    const seq = await this.db.next(user.organisationId, `tenders:${year}`);
    const org = await this.db.organisations.findById(user.organisationId, { code: 1 }).lean();
    const [doc] = await this.db.tenders.create([{ ...this.fields(input), organisationId: user.organisationId, number: `${org?.code ?? 'ORG'}/T/${String(seq).padStart(3, '0')}/${year}`, createdBy: user.id }]);
    await this.audit.record(user, 'tenders.create', 'tender', doc._id, { number: doc.number, method: input.method, estimate: input.estimate.toString() });
    return this.get(user, doc._id);
  }

  async update(user: AuthUser, id: Id, input: TenderInput) {
    const t = await this.load(user, id);
    if (t.status !== 'DRAFT') throw new BadRequestException('Only a draft can be changed; issue an addendum instead');
    await this.validate(user, input);
    await this.db.tenders.updateOne({ _id: id }, this.fields(input));
    await this.audit.record(user, 'tenders.update', 'tender', id, { number: t.number });
    return this.get(user, id);
  }

  /** Appoints the opening and evaluation committees (the accounting officer's job, s.78 and s.46). */
  async appoint(user: AuthUser, id: Id, input: { opening: { userId: Id; role: Role }[]; evaluation: { userId: Id; role: Role }[] }) {
    const t = await this.load(user, id);
    if (!['DRAFT', 'PUBLISHED', 'CLOSED'].includes(t.status)) throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    if (t.scores.length) throw new BadRequestException('Members have started scoring');
    for (const [name, list] of [['opening', input.opening], ['evaluation', input.evaluation]] as const) {
      if (new Set(list.map((m) => String(m.userId))).size !== list.length) throw new BadRequestException(`Someone is listed twice on the ${name} committee`);
      if (list.length < 3) throw new BadRequestException(`The ${name} committee needs at least three members`);
      if (list.filter((m) => m.role === 'CHAIR').length !== 1) throw new BadRequestException(`Name one chairperson of the ${name} committee`);
    }
    const all = [...new Set([...input.opening, ...input.evaluation].map((m) => String(m.userId)))];
    const users = await this.db.users.countDocuments({ _id: { $in: all.map((x) => new Types.ObjectId(x)) }, organisationId: user.organisationId, active: true });
    if (users !== all.length) throw new BadRequestException('Committee members must be active users');
    if (input.evaluation.some((m) => m.userId.equals(user.id))) throw new BadRequestException('The accounting officer who awards cannot sit on the evaluation committee');
    await this.db.tenders.updateOne({ _id: id }, { openingCommittee: input.opening, evaluationCommittee: input.evaluation });
    await this.audit.record(user, 'tenders.committees', 'tender', id, { opening: input.opening.length, evaluation: input.evaluation.length });
    return this.get(user, id);
  }

  async publish(user: AuthUser, id: Id) {
    const t = await this.load(user, id);
    if (t.status !== 'DRAFT') throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    if (t.openingCommittee.length < 3) throw new BadRequestException('Appoint the opening and evaluation committees first');
    const s = await this.settings(user);
    if (ADVERTISED.includes(t.method as Method) && t.closingAt.getTime() - Date.now() < s.minNoticeDays * DAY) throw new BadRequestException(`An advertised tender must stay open at least ${s.minNoticeDays} days`);
    if (t.closingAt.getTime() <= Date.now()) throw new BadRequestException('The closing date has passed');
    await this.db.tenders.updateOne({ _id: id }, { status: 'PUBLISHED', publishedAt: new Date() });
    await this.audit.record(user, 'tenders.publish', 'tender', id, { number: t.number });
    return this.get(user, id);
  }

  /** An addendum, published to everyone; it may extend the closing and opening times. */
  async addendum(user: AuthUser, id: Id, input: { text: string; closingAt?: Date; openingAt?: Date }) {
    const t = await this.load(user, id);
    if (t.status !== 'PUBLISHED') throw new BadRequestException('Addenda are issued while the tender is open');
    const closingAt = input.closingAt ?? t.closingAt;
    const openingAt = input.openingAt ?? (input.closingAt && t.openingAt < input.closingAt ? input.closingAt : t.openingAt);
    if (closingAt < t.closingAt) throw new BadRequestException('An addendum can extend the closing time but not bring it forward');
    if (openingAt < closingAt) throw new BadRequestException('Bids are opened at or after the closing time');
    const number = t.addenda.length + 1;
    await this.db.tenders.updateOne({ _id: id }, { $push: { addenda: { number, text: input.text, at: new Date(), by: user.id } }, closingAt, openingAt });
    await this.audit.record(user, 'tenders.addendum', 'tender', id, { number, closingAt });
    const bids = await this.db.bids.find({ tenderId: id, status: 'SUBMITTED' }).lean();
    for (const b of bids) await this.tell(user.organisationId, b, `${t.number} addendum ${number}`, `${t.number} ${t.title}: addendum ${number} was issued. ${input.text}${input.closingAt ? ` Closing is now ${closingAt.toISOString().slice(0, 16).replace('T', ' ')}.` : ''}`);
    await this.flush(user.organisationId);
    return this.get(user, id);
  }

  async answer(user: AuthUser, id: Id, clarificationId: Id, answer: string) {
    const t = await this.load(user, id);
    if (!['PUBLISHED', 'CLOSED'].includes(t.status)) throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    const r = await this.db.tenders.updateOne({ _id: id, 'clarifications._id': clarificationId }, { $set: { 'clarifications.$.answer': answer, 'clarifications.$.answeredAt': new Date(), 'clarifications.$.answeredBy': user.id } });
    if (!r.matchedCount) throw new NotFoundException('Question not found');
    await this.audit.record(user, 'tenders.clarification', 'tender', id, { clarificationId });
    return this.get(user, id);
  }

  // Reading -----------------------------------------------------------------------------------------

  /** Loads a tender, moving it to CLOSED once its closing time has passed. */
  private async load(user: AuthUser, id: Id) {
    let t = await this.db.tenders.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!t) throw new NotFoundException('Tender not found');
    if (t.status === 'PUBLISHED' && t.closingAt.getTime() <= Date.now()) {
      await this.db.tenders.updateOne({ _id: id, status: 'PUBLISHED' }, { status: 'CLOSED' });
      t = { ...t, status: 'CLOSED' };
    }
    return t;
  }

  async list(user: AuthUser, q: { status?: string; search?: string }) {
    await this.db.tenders.updateMany({ organisationId: user.organisationId, status: 'PUBLISHED', closingAt: { $lte: new Date() } }, { status: 'CLOSED' });
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    if (q.search) filter.$or = [{ title: new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { number: new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
    const rows = await this.db.tenders.find(filter, { title: 1, number: 1, method: 1, category: 1, estimate: 1, status: 1, closingAt: 1, openingAt: 1, reservedFor: 1, award: 1 }).sort({ createdAt: -1 }).limit(500).lean();
    const counts = await this.db.bids.aggregate<{ _id: Id; n: number }>([{ $match: { tenderId: { $in: rows.map((r) => r._id) }, status: 'SUBMITTED' } }, { $group: { _id: '$tenderId', n: { $sum: 1 } } }]);
    return rows.map((r) => ({ ...r, bids: counts.find((c) => c._id.equals(r._id))?.n ?? 0 }));
  }

  /** The tender with its bids; before opening only the number of bids received is shown (bids are sealed). */
  async get(user: AuthUser, id: Id) {
    const t = await this.load(user, id);
    const bids = await this.db.bids.find({ tenderId: id }, { tokenHash: 0 }).sort({ number: 1 }).lean();
    const sealed = ['DRAFT', 'PUBLISHED', 'CLOSED'].includes(t.status);
    const ids = [...new Set([...t.openingCommittee, ...t.evaluationCommittee].map((m) => String(m.userId)))];
    const names = new Map((await this.db.users.find({ _id: { $in: ids.map((x) => new Types.ObjectId(x)) } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
    const named = (list: { userId: Id; role: string }[]) => list.map((m) => ({ userId: m.userId, role: m.role, name: names.get(String(m.userId)) ?? '' }));
    const myScores = t.scores.filter((s) => s.memberId?.equals(user.id));
    return {
      ...t,
      scores: undefined,
      openingCommittee: named(t.openingCommittee),
      evaluationCommittee: named(t.evaluationCommittee),
      myRoles: { opening: t.openingCommittee.some((m) => m.userId.equals(user.id)), evaluation: t.evaluationCommittee.find((m) => m.userId.equals(user.id))?.role ?? null },
      myScores,
      scoredBy: [...new Set(t.scores.map((s) => String(s.memberId)))].length,
      sealed,
      bidsReceived: bids.filter((b) => b.status === 'SUBMITTED').length,
      bids: sealed ? [] : bids,
    };
  }

  // Bidders (public) -------------------------------------------------------------------------------

  private async orgByCode(code: string) {
    const org = await this.db.organisations.findOne({ code: code.toUpperCase() }, { name: 1, code: 1, modules: 1 }).lean();
    if (!org || !org.modules?.includes('tenders')) throw new NotFoundException('Organisation not found');
    return org;
  }

  /** Open tenders, and award notices of the last 90 days (s.138 publication). */
  async notices(code: string) {
    const org = await this.orgByCode(code);
    const branding = await openPortal(this.db.connection, org._id, 'tenders');
    const now = new Date();
    const open = await this.db.tenders.find({ organisationId: org._id, status: 'PUBLISHED', closingAt: { $gt: now } }, { number: 1, title: 1, method: 1, category: 1, reservedFor: 1, closingAt: 1, openingAt: 1, bidSecurity: 1, publishedAt: 1, addenda: 1 }).sort({ closingAt: 1 }).lean();
    const awarded = await this.db.tenders.find({ organisationId: org._id, status: { $in: ['AWARDED', 'CONTRACTED'] }, 'award.at': { $gte: new Date(now.getTime() - 90 * DAY) } }, { number: 1, title: 1, award: 1 }).sort({ 'award.at': -1 }).lean();
    const winners = await this.db.bids.find({ _id: { $in: awarded.map((a) => a.award?.bidId).filter(Boolean) as Id[] } }, { 'bidder.name': 1 }).lean();
    return {
      organisation: org.name,
      branding,
      open: open.map((t) => ({ ...t, addenda: t.addenda.length })),
      awards: awarded.map((a) => ({ id: a._id, number: a.number, title: a.title, awardedTo: winners.find((w) => w._id.equals(a.award!.bidId!))?.bidder?.name ?? '', amount: a.award?.amount, at: a.award?.at })),
    };
  }

  async notice(code: string, id: Id) {
    const org = await this.orgByCode(code);
    const branding = await openPortal(this.db.connection, org._id, 'tenders');
    const t = await this.db.tenders.findOne({ _id: id, organisationId: org._id, status: { $ne: 'DRAFT' } }).lean();
    if (!t) throw new NotFoundException('Tender not found');
    const docs = await this.db.documents.find({ _id: { $in: t.documentIds }, deletedAt: null }, { name: 1, size: 1, contentType: 1 }).lean();
    return {
      organisation: org.name,
      branding,
      id: t._id,
      number: t.number,
      title: t.title,
      description: t.description,
      method: t.method,
      category: t.category,
      reservedFor: t.reservedFor,
      bidSecurity: t.bidSecurity,
      bidValidityDays: t.bidValidityDays,
      closingAt: t.closingAt,
      openingAt: t.openingAt,
      openingVenue: t.openingVenue,
      mandatory: t.mandatory,
      criteria: t.criteria,
      passMark: t.criteria.length ? t.passMark : null,
      open: t.status === 'PUBLISHED' && t.closingAt > new Date(),
      status: t.status,
      addenda: t.addenda.map((a) => ({ number: a.number, text: a.text, at: a.at })),
      clarifications: t.clarifications.filter((c) => c.answer).map((c) => ({ question: c.question, answer: c.answer, answeredAt: c.answeredAt })),
      documents: docs,
    };
  }

  async document(code: string, id: Id, documentId: Id) {
    const org = await this.orgByCode(code);
    await openPortal(this.db.connection, org._id, 'tenders');
    const t = await this.db.tenders.exists({ _id: id, organisationId: org._id, status: { $ne: 'DRAFT' }, documentIds: documentId });
    if (!t) throw new NotFoundException('Document not found');
    const d = await this.db.documents.findOne({ _id: documentId, organisationId: org._id, deletedAt: null }).lean();
    if (!d) throw new NotFoundException('Document not found');
    const bucket = new mongo.GridFSBucket(this.db.connection.db!, { bucketName: 'documents' });
    const chunks: Buffer[] = [];
    for await (const chunk of bucket.openDownloadStream(d.fileId)) chunks.push(chunk as Buffer);
    return new Response(Buffer.concat(chunks), { headers: { 'content-type': d.contentType, 'content-disposition': `attachment; filename="${d.name.replace(/[^\w.\- ]/g, '_')}"` } });
  }

  async ask(code: string, id: Id, input: { question: string; askedBy?: string }) {
    const org = await this.orgByCode(code);
    await openPortal(this.db.connection, org._id, 'tenders');
    const r = await this.db.tenders.updateOne({ _id: id, organisationId: org._id, status: 'PUBLISHED', closingAt: { $gt: new Date() } }, { $push: { clarifications: { question: input.question, askedBy: input.askedBy ?? '', askedAt: new Date() } } });
    if (!r.matchedCount) throw new BadRequestException('This tender is not taking questions');
    return { received: true };
  }

  private checkBid(t: { reservedFor?: string | null; mandatory: string[]; bidValidityDays?: number | null }, input: BidInput) {
    if (t.reservedFor === 'LOCAL' && !input.local) throw new BadRequestException('This tender is reserved for local firms');
    if (t.reservedFor === 'ALL_AGPO' && input.agpo === 'NONE') throw new BadRequestException('This tender is reserved for youth, women and persons with disability (AGPO)');
    if (['YOUTH', 'WOMEN', 'PWD'].includes(t.reservedFor ?? '') && input.agpo !== t.reservedFor) throw new BadRequestException(`This tender is reserved for ${t.reservedFor === 'PWD' ? 'persons with disability' : (t.reservedFor ?? '').toLowerCase()} (AGPO)`);
    if (input.agpo !== 'NONE' && !input.agpoCertificate?.trim()) throw new BadRequestException('Give the AGPO certificate number');
    const missing = t.mandatory.filter((m) => !input.mandatory.some((x) => x.requirement === m));
    if (missing.length) throw new BadRequestException(`Answer every mandatory requirement: ${missing.join(', ')}`);
    if (input.validityDays < (t.bidValidityDays ?? 0)) throw new BadRequestException(`The bid must be valid for at least ${t.bidValidityDays} days`);
  }

  private bidFields(input: BidInput) {
    return {
      bidder: { name: input.name, kraPin: input.kraPin.toUpperCase(), email: input.email, phone: input.phone, agpo: input.agpo, agpoCertificate: input.agpoCertificate, local: input.local },
      amount: toD128(input.amount),
      validityDays: input.validityDays,
      bidSecurityReference: input.bidSecurityReference,
      mandatory: input.mandatory,
      technicalProposal: input.technicalProposal,
    };
  }

  async submitBid(code: string, id: Id, input: BidInput) {
    const org = await this.orgByCode(code);
    await openPortal(this.db.connection, org._id, 'tenders');
    const t = await this.db.tenders.findOne({ _id: id, organisationId: org._id }).lean();
    if (!t || t.status === 'DRAFT') throw new NotFoundException('Tender not found');
    if (t.status !== 'PUBLISHED' || t.closingAt.getTime() <= Date.now()) throw new BadRequestException('This tender has closed; late bids are not accepted');
    this.checkBid(t, input);
    if (n(t.bidSecurity).gt(0) && !input.bidSecurityReference?.trim()) throw new BadRequestException(`Give the reference of the bid security of ${kes(t.bidSecurity)}`);
    const token = randomBytes(24).toString('base64url');
    const number = (await this.db.bids.countDocuments({ tenderId: id })) + 1;
    try {
      const [bid] = await this.db.bids.create([{ ...this.bidFields(input), organisationId: org._id, tenderId: id, number, tokenHash: hash(token) }]);
      await this.tell(org._id, bid, `Bid received: ${t.number}`, `${org.name}: your bid ${number} for ${t.number} ${t.title} was received ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. It stays sealed until opening. Change or withdraw it before closing at /bids/${token}`);
      await this.flush(org._id);
      return { number, path: `/bids/${token}` };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException('This firm has already bid; change the existing bid through its link');
      throw err;
    }
  }

  private async byToken(token: string) {
    if (!token || token.length < 20) throw new NotFoundException('This link is not valid');
    const bid = await this.db.bids.findOne({ tokenHash: hash(token) }).lean();
    if (!bid) throw new NotFoundException('This link is not valid');
    const t = await this.db.tenders.findById(bid.tenderId).lean();
    if (!t) throw new NotFoundException('This link is not valid');
    await openPortal(this.db.connection, t.organisationId, 'tenders');
    return { bid, t };
  }

  async bid(token: string) {
    const { bid, t } = await this.byToken(token);
    const open = t.status === 'PUBLISHED' && t.closingAt.getTime() > Date.now();
    const notified = Boolean(t.award?.notifiedAt) || t.status === 'CANCELLED';
    return {
      tender: { number: t.number, title: t.title, closingAt: t.closingAt, openingAt: t.openingAt, status: t.status, mandatory: t.mandatory, cancellation: t.status === 'CANCELLED' ? t.cancellation?.reason : undefined },
      number: bid.number,
      bidder: bid.bidder,
      amount: bid.amount,
      validityDays: bid.validityDays,
      bidSecurityReference: bid.bidSecurityReference,
      mandatory: bid.mandatory,
      technicalProposal: bid.technicalProposal,
      status: bid.status,
      canChange: open && bid.status === 'SUBMITTED',
      outcome: notified ? bid.outcome : 'PENDING',
      outcomeReason: notified ? bid.outcomeReason : undefined,
    };
  }

  async changeBid(token: string, input: BidInput) {
    const { bid, t } = await this.byToken(token);
    if (bid.status !== 'SUBMITTED' || t.status !== 'PUBLISHED' || t.closingAt.getTime() <= Date.now()) throw new BadRequestException('Bids cannot be changed after closing');
    this.checkBid(t, input);
    await this.db.bids.updateOne({ _id: bid._id }, this.bidFields(input));
    return this.bid(token);
  }

  async withdrawBid(token: string) {
    const { bid, t } = await this.byToken(token);
    if (bid.status !== 'SUBMITTED' || t.status !== 'PUBLISHED' || t.closingAt.getTime() <= Date.now()) throw new BadRequestException('Bids cannot be withdrawn after closing');
    await this.db.bids.updateOne({ _id: bid._id }, { status: 'WITHDRAWN' });
    return this.bid(token);
  }

  // Opening and evaluation ---------------------------------------------------------------------------

  /** Opens the bids in front of at least three opening committee members and reads the prices into the register. */
  async open(user: AuthUser, id: Id, input: { attendees: Id[]; bidderRepresentatives?: string; minutes?: string }) {
    const t = await this.load(user, id);
    if (!t.openingCommittee.some((m) => m.userId.equals(user.id))) throw new ForbiddenException('Only a member of the opening committee records the opening');
    if (t.status !== 'CLOSED') throw new BadRequestException(t.status === 'PUBLISHED' ? 'The tender has not closed yet' : `The tender is ${t.status.toLowerCase()}`);
    if (t.openingAt.getTime() > Date.now()) throw new BadRequestException(`Bids are opened at ${t.openingAt.toISOString().slice(0, 16).replace('T', ' ')}`);
    const present = [...new Set([...input.attendees, user.id].map(String))].filter((a) => t.openingCommittee.some((m) => String(m.userId) === a));
    if (present.length < 3) throw new BadRequestException('At least three opening committee members must be present');
    await this.db.tenders.updateOne({ _id: id }, { status: 'OPENED', opening: { at: new Date(), attendees: present.map((x) => new Types.ObjectId(x)), bidderRepresentatives: input.bidderRepresentatives, minutes: input.minutes } });
    await this.audit.record(user, 'tenders.open', 'tender', id, { number: t.number, present: present.length });
    return this.register(user, id);
  }

  /** The opening register: every bid read out with its price and bid security. */
  async register(user: AuthUser, id: Id) {
    const t = await this.load(user, id);
    if (['DRAFT', 'PUBLISHED', 'CLOSED'].includes(t.status)) throw new BadRequestException('The bids are still sealed');
    const bids = await this.db.bids.find({ tenderId: id, status: 'SUBMITTED' }).sort({ number: 1 }).lean();
    return { number: t.number, title: t.title, openedAt: t.opening?.at, bids: bids.map((b) => ({ id: b._id, number: b.number, bidder: b.bidder?.name ?? '', kraPin: b.bidder?.kraPin ?? '', amount: b.amount, bidSecurityReference: b.bidSecurityReference, submittedAt: (b as { createdAt?: Date }).createdAt })) };
  }

  private evaluator(t: { evaluationCommittee: { userId: Id; role: string }[] }, user: AuthUser) {
    const m = t.evaluationCommittee.find((x) => x.userId.equals(user.id));
    if (!m) throw new ForbiddenException('Only a member of the evaluation committee can do this');
    return m;
  }

  /** Preliminary evaluation: whether each bid meets every mandatory requirement. */
  async preliminary(user: AuthUser, id: Id, input: { results: { bidId: Id; responsive: boolean; reason?: string }[] }) {
    const t = await this.load(user, id);
    this.evaluator(t, user);
    if (t.status !== 'OPENED') throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    for (const r of input.results) {
      if (!r.responsive && !r.reason?.trim()) throw new BadRequestException('Give the reason a bid is non-responsive; the bidder is told');
      const ok = await this.db.bids.updateOne({ _id: r.bidId, tenderId: id, status: 'SUBMITTED' }, { responsive: r.responsive, nonResponsiveReason: r.responsive ? '' : r.reason });
      if (!ok.matchedCount) throw new NotFoundException('Bid not found');
    }
    await this.audit.record(user, 'tenders.preliminary', 'tender', id, { results: input.results.length });
    return this.get(user, id);
  }

  async score(user: AuthUser, id: Id, input: { bidId: Id; scores: { criterion: string; score: number }[] }) {
    const t = await this.load(user, id);
    this.evaluator(t, user);
    if (t.status !== 'OPENED') throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    const bid = await this.db.bids.findOne({ _id: input.bidId, tenderId: id, status: 'SUBMITTED' }).lean();
    if (!bid) throw new NotFoundException('Bid not found');
    if (bid.responsive !== true) throw new BadRequestException('Only bids that passed the preliminary evaluation are scored');
    for (const c of t.criteria) if (!input.scores.some((s) => s.criterion === c.name)) throw new BadRequestException(`Score ${c.name}`);
    if (input.scores.some((s) => !t.criteria.some((c) => c.name === s.criterion))) throw new BadRequestException('Unknown criterion');
    await this.db.tenders.updateOne({ _id: id }, { $pull: { scores: { memberId: user.id, bidId: input.bidId } } });
    await this.db.tenders.updateOne({ _id: id }, { $push: { scores: { $each: input.scores.map((s) => ({ memberId: user.id, bidId: input.bidId, criterion: s.criterion, score: s.score })) } } });
    await this.audit.record(user, 'tenders.score', 'tender', id, { bidId: input.bidId });
    return this.get(user, id);
  }

  /** The chair completes the evaluation: ranks the bids and signs the report recommending the lowest evaluated (or best combined) bid. */
  async complete(user: AuthUser, id: Id, input: { report: string }) {
    const t = await this.load(user, id);
    if (this.evaluator(t, user).role !== 'CHAIR') throw new ForbiddenException('The chair completes the evaluation');
    if (t.status !== 'OPENED') throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    const bids = await this.db.bids.find({ tenderId: id, status: 'SUBMITTED' }).lean();
    if (bids.some((b) => b.responsive === null)) throw new BadRequestException('Finish the preliminary evaluation of every bid');
    if (t.criteria.length) {
      for (const b of bids.filter((x) => x.responsive)) {
        for (const m of t.evaluationCommittee) {
          if (!t.scores.some((s) => s.bidId?.equals(b._id) && s.memberId?.equals(m.userId))) throw new BadRequestException(`Bid ${b.number} has not been scored by every member`);
        }
      }
    }
    const ranking = rankBids(bids, t.scores as { memberId: Id; bidId: Id; criterion: string; score: number }[], { criteria: t.criteria, passMark: t.passMark ?? 70, financialWeight: t.financialWeight ?? 100 });
    const best = ranking.find((r) => r.rank === 1);
    await this.db.tenders.updateOne({ _id: id }, { status: 'EVALUATED', evaluation: { completedAt: new Date(), completedBy: user.id, report: input.report, recommendedBidId: best?.bidId ?? null, ranking } });
    await this.audit.record(user, 'tenders.evaluate', 'tender', id, { number: t.number, recommended: best?.bidId });
    return this.get(user, id);
  }

  /** The head of procurement's professional opinion to the accounting officer. */
  async opinion(user: AuthUser, id: Id, input: { text: string; concurs: boolean }) {
    const t = await this.load(user, id);
    if (t.status !== 'EVALUATED') throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    if (t.evaluationCommittee.some((m) => m.userId.equals(user.id))) throw new BadRequestException('A member of the evaluation committee cannot give the professional opinion');
    await this.db.tenders.updateOne({ _id: id }, { status: 'RECOMMENDED', opinion: { by: user.id, at: new Date(), text: input.text, concurs: input.concurs } });
    await this.audit.record(user, 'tenders.opinion', 'tender', id, { concurs: input.concurs });
    return this.get(user, id);
  }

  /** The accounting officer awards; every bidder is told at the same time, with reasons, and the standstill starts. */
  async award(user: AuthUser, id: Id, input: { bidId?: Id; reason?: string }) {
    const t = await this.load(user, id);
    if (t.status !== 'RECOMMENDED') throw new BadRequestException(t.status === 'EVALUATED' ? 'The professional opinion comes first' : `The tender is ${t.status.toLowerCase()}`);
    if (t.evaluationCommittee.some((m) => m.userId.equals(user.id))) throw new BadRequestException('A member of the evaluation committee cannot award');
    const bidId = input.bidId ?? t.evaluation?.recommendedBidId;
    if (!bidId) throw new BadRequestException('No bid passed the evaluation; cancel the tender');
    const row = t.evaluation?.ranking.find((r) => r.bidId?.equals(bidId));
    if (!row?.passed) throw new BadRequestException('Only a bid that passed the evaluation can be awarded');
    if (!bidId.equals(t.evaluation!.recommendedBidId!) && !input.reason?.trim()) throw new BadRequestException('Give the reasons for not awarding the recommended bid');
    const bids = await this.db.bids.find({ tenderId: id, status: 'SUBMITTED' }).lean();
    const winner = bids.find((b) => b._id.equals(bidId))!;
    const { standstillDays } = await this.settings(user);
    const now = new Date();
    const standstillEnds = new Date(now.getTime() + standstillDays * DAY);
    await this.db.tenders.updateOne({ _id: id }, { status: 'AWARDED', award: { bidId, amount: winner.amount, by: user.id, at: now, reason: input.reason ?? '', notifiedAt: now, standstillEnds } });
    for (const b of bids) {
      const won = b._id.equals(bidId);
      const r = t.evaluation?.ranking.find((x) => x.bidId?.equals(b._id));
      const reason = won
        ? `Your bid of ${kes(b.amount)} was successful.`
        : b.responsive === false
          ? `Your bid did not meet the mandatory requirements: ${b.nonResponsiveReason}.`
          : r && !r.passed
            ? `Your technical score of ${r.technical} was below the pass mark of ${t.passMark}.`
            : `Your bid was ranked ${r?.rank ?? '-'}; the tender was awarded to ${winner.bidder?.name} at ${kes(winner.amount)}.`;
      await this.db.bids.updateOne({ _id: b._id }, { outcome: won ? 'SUCCESSFUL' : 'UNSUCCESSFUL', outcomeReason: reason });
      await this.tell(t.organisationId, b, won ? `Notification of award: ${t.number}` : `Outcome of ${t.number}`, `${t.number} ${t.title}: ${reason}${won ? ` Please accept in writing; the contract will be signed after ${standstillEnds.toISOString().slice(0, 10)}.` : ` You may seek a review by the Public Procurement Administrative Review Board within 14 days.`}`);
    }
    await this.flush(t.organisationId);
    await this.audit.record(user, 'tenders.award', 'tender', id, { number: t.number, bidId, amount: winner.amount.toString(), departedFromRecommendation: !bidId.equals(t.evaluation!.recommendedBidId!) });
    return this.get(user, id);
  }

  async cancel(user: AuthUser, id: Id, input: { reason: string }) {
    const t = await this.load(user, id);
    if (['CONTRACTED', 'CANCELLED'].includes(t.status)) throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    await this.db.tenders.updateOne({ _id: id }, { status: 'CANCELLED', cancellation: { reason: input.reason, at: new Date(), by: user.id } });
    const bids = await this.db.bids.find({ tenderId: id, status: 'SUBMITTED' }).lean();
    for (const b of bids) await this.tell(t.organisationId, b, `${t.number} cancelled`, `${t.number} ${t.title} has been cancelled: ${input.reason}`);
    await this.flush(t.organisationId);
    await this.audit.record(user, 'tenders.cancel', 'tender', id, { number: t.number, reason: input.reason });
    return this.get(user, id);
  }

  // Appeals and contracts ----------------------------------------------------------------------------

  async appeal(user: AuthUser, id: Id, input: { applicant: string; filedAt: Date; grounds: string }) {
    const t = await this.load(user, id);
    if (!['EVALUATED', 'RECOMMENDED', 'AWARDED', 'CANCELLED'].includes(t.status)) throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    await this.db.tenders.updateOne({ _id: id }, { $push: { appeals: { ...input, status: 'PENDING' } } });
    await this.audit.record(user, 'tenders.appeal', 'tender', id, { applicant: input.applicant });
    return this.get(user, id);
  }

  /** Records the Review Board's decision; when it annuls the award the tender goes back for a new opinion and award. */
  async decideAppeal(user: AuthUser, id: Id, appealId: Id, input: { status: 'DISMISSED' | 'UPHELD' | 'WITHDRAWN'; decision?: string }) {
    const t = await this.load(user, id);
    const a = t.appeals.find((x) => x._id.equals(appealId));
    if (!a) throw new NotFoundException('Appeal not found');
    if (a.status !== 'PENDING') throw new BadRequestException('This appeal is decided');
    await this.db.tenders.updateOne({ _id: id, 'appeals._id': appealId }, { $set: { 'appeals.$.status': input.status, 'appeals.$.decision': input.decision ?? '', 'appeals.$.decidedAt': new Date() } });
    if (input.status === 'UPHELD' && t.status === 'AWARDED') {
      await this.db.tenders.updateOne({ _id: id }, { status: 'EVALUATED', $unset: { award: 1, opinion: 1 } });
      await this.db.bids.updateMany({ tenderId: id }, { outcome: 'PENDING', outcomeReason: '' });
    }
    await this.audit.record(user, 'tenders.appeal.decide', 'tender', id, { appealId, status: input.status });
    return this.get(user, id);
  }

  async contract(user: AuthUser, id: Id, input: { number: string; signedAt: Date; value: Decimal; startDate: Date; endDate: Date; performanceSecurity: Decimal }) {
    const t = await this.load(user, id);
    if (t.status !== 'AWARDED') throw new BadRequestException(`The tender is ${t.status.toLowerCase()}`);
    if (t.appeals.some((a) => a.status === 'PENDING')) throw new BadRequestException('A request for review is pending before the Review Board');
    if (t.award?.standstillEnds && Date.now() < t.award.standstillEnds.getTime()) throw new BadRequestException(`The contract cannot be signed before the standstill ends on ${t.award.standstillEnds.toISOString().slice(0, 10)}`);
    if (input.endDate < input.startDate) throw new BadRequestException('The contract ends before it starts');
    if (input.value.gt(n(t.award?.amount))) throw new BadRequestException(`The contract value cannot exceed the awarded ${kes(t.award?.amount)}`);
    await this.db.tenders.updateOne({ _id: id }, { status: 'CONTRACTED', contract: { ...input, value: toD128(input.value), performanceSecurity: toD128(input.performanceSecurity), by: user.id } });
    await this.audit.record(user, 'tenders.contract', 'tender', id, { number: input.number, value: input.value.toString() });
    return this.get(user, id);
  }

  async contracts(user: AuthUser) {
    const rows = await this.db.tenders.find({ organisationId: user.organisationId, status: 'CONTRACTED' }, { number: 1, title: 1, method: 1, category: 1, contract: 1, award: 1, reservedFor: 1 }).sort({ 'contract.signedAt': -1 }).lean();
    const bids = await this.db.bids.find({ _id: { $in: rows.map((r) => r.award?.bidId).filter(Boolean) as Id[] } }, { bidder: 1 }).lean();
    const today = Date.now();
    return rows.map((r) => {
      const b = bids.find((x) => x._id.equals(r.award!.bidId!));
      const end = r.contract?.endDate?.getTime() ?? 0;
      return { id: r._id, tender: r.number, title: r.title, method: r.method, category: r.category, contractor: b?.bidder?.name ?? '', kraPin: b?.bidder?.kraPin ?? '', agpo: b?.bidder?.agpo ?? 'NONE', ...r.contract, state: end < today ? 'EXPIRED' : end - today < 60 * DAY ? 'ENDING' : 'RUNNING' };
    });
  }

  async contractsCsv(user: AuthUser) {
    const rows = await this.contracts(user);
    return csvResponse('contracts-register.csv', [['Contract', 'Tender', 'Title', 'Method', 'Contractor', 'KRA PIN', 'AGPO', 'Value', 'Signed', 'Start', 'End', 'Performance security', 'State'], ...rows.map((r) => [r.number, r.tender, r.title, r.method, r.contractor, r.kraPin, r.agpo, r.value?.toString() ?? '', r.signedAt?.toISOString().slice(0, 10) ?? '', r.startDate?.toISOString().slice(0, 10) ?? '', r.endDate?.toISOString().slice(0, 10) ?? '', r.performanceSecurity?.toString() ?? '', r.state])]);
  }

  /** Every tender, its method, bids, outcome and value: the procurement register for PPRA returns. */
  async registerCsv(user: AuthUser) {
    const rows = await this.list(user, {});
    const winners = await this.db.bids.find({ _id: { $in: rows.map((r) => r.award?.bidId).filter(Boolean) as Id[] } }, { bidder: 1 }).lean();
    return csvResponse('tender-register.csv', [['Number', 'Title', 'Method', 'Category', 'Reserved for', 'Estimate', 'Closing', 'Bids', 'Status', 'Awarded to', 'Award amount'], ...rows.map((r) => [r.number, r.title, r.method, r.category, r.reservedFor ?? 'NONE', r.estimate?.toString() ?? '', r.closingAt.toISOString().slice(0, 10), r.bids, r.status, winners.find((w) => r.award?.bidId && w._id.equals(r.award.bidId))?.bidder?.name ?? '', r.award?.amount?.toString() ?? ''])]);
  }

  /**
   * Notices and awards laid out for upload to the Public Procurement Information Portal (tenders.go.ke)
   * and the PPRA quarterly returns: one row per tender with its notice and, once awarded, the contractor.
   */
  async ppipCsv(user: AuthUser, q: { from?: Date; to?: Date }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, status: { $ne: 'DRAFT' } };
    if (q.from || q.to) filter.publishedAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lt: new Date(q.to.getTime() + DAY) }) };
    const rows = await this.db.tenders.find(filter).sort({ publishedAt: 1 }).lean();
    const winners = await this.db.bids.find({ _id: { $in: rows.map((r) => r.award?.bidId).filter(Boolean) as Id[] } }, { bidder: 1 }).lean();
    const counts = await this.db.bids.aggregate<{ _id: Id; n: number }>([{ $match: { tenderId: { $in: rows.map((r) => r._id) }, status: 'SUBMITTED' } }, { $group: { _id: '$tenderId', n: { $sum: 1 } } }]);
    const d = (x?: Date | null) => x?.toISOString().slice(0, 10) ?? '';
    return csvResponse('ppip-upload.csv', [
      ['Tender reference', 'Title', 'Procurement method', 'Category', 'Reserved (AGPO)', 'Published', 'Closing', 'Bids received', 'Status', 'Awarded to', 'KRA PIN', 'AGPO category', 'Award value (KES)', 'Award date', 'Contract number', 'Contract value (KES)', 'Contract start', 'Contract end'],
      ...rows.map((r) => {
        const w = winners.find((x) => r.award?.bidId && x._id.equals(r.award.bidId));
        return [r.number, r.title, r.method, r.category, r.reservedFor ?? 'NONE', d(r.publishedAt), d(r.closingAt), counts.find((c) => c._id.equals(r._id))?.n ?? 0, r.status, w?.bidder?.name ?? '', w?.bidder?.kraPin ?? '', w?.bidder?.agpo ?? '', r.award?.amount?.toString() ?? '', d(r.award?.at), r.contract?.number ?? '', r.contract?.value?.toString() ?? '', d(r.contract?.startDate), d(r.contract?.endDate)];
      }),
    ]);
  }

  // Messages ----------------------------------------------------------------------------------------

  private async tell(organisationId: Id, bid: { _id: Id; bidder?: { phone: string; email?: string | null } | null }, subject: string, text: string) {
    if (!bid.bidder) return;
    await this.sms.queue(organisationId, bid.bidder.phone, text, 'tenders:bid', bid._id);
    if (bid.bidder.email) await this.email.queue(organisationId, bid.bidder.email, subject, text, 'tenders:bid', bid._id);
  }

  private async flush(organisationId: Id) {
    await this.sms.deliverDue(organisationId);
    await this.email.deliverDue(organisationId);
  }
}
