import { ClientSession, Types } from 'mongoose';
import { AuthUser, hasPermission } from '../../common/auth';
import { renderDocumentPdf, issuerOf } from '../../common/document-pdf';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal } from '../../common/money';
import { PERMISSIONS } from '../../common/permissions';
import { RequestForQuote } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { RfqService } from './rfq.service';

type Id = Types.ObjectId;
type Evaluation = NonNullable<RequestForQuote['evaluation']>;

export interface AppointInput {
  members: { userId: Id; role: 'CHAIR' | 'SECRETARY' | 'MEMBER' }[];
  criteria: { name: string; weight: number }[];
  passMark: number;
  financialWeight: number;
}

const ROLE_LABEL = { CHAIR: 'Chairperson', SECRETARY: 'Secretary', MEMBER: 'Member' } as const;

/**
 * Tender evaluation by a committee: the accounting officer appoints at least three members (one
 * chairing) and sets weighted technical criteria with a pass mark; each member scores each responsive
 * bidder; the result combines the members' average technical score with price (lowest evaluated price
 * scores 100), ranks the bidders, and once the chair completes it the report carries every member's
 * electronic sign-off and the award follows its recommendation.
 */
export class RfqEvaluationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly rfqs: RfqService,
  ) {}

  private async load(user: AuthUser, id: Id, session?: ClientSession) {
    const rfq = (await this.db.rfqs.findOne({ _id: id, organisationId: user.organisationId }).session(session ?? null).lean()) as RequestForQuote | null;
    if (!rfq) throw new NotFoundException('Request for quotes not found');
    return rfq;
  }

  private member(rfq: RequestForQuote, user: AuthUser) {
    return rfq.evaluation?.committee.find((m) => m.userId.equals(user.id)) ?? null;
  }

  async appoint(user: AuthUser, id: Id, input: AppointInput) {
    const rfq = await this.load(user, id);
    if (!['SENT', 'CLOSED'].includes(rfq.status)) throw new BadRequestException(`${rfq.number} is ${rfq.status.toLowerCase()}`);
    if (rfq.evaluation?.status === 'COMPLETED') throw new BadRequestException('The evaluation is already complete');
    if (rfq.evaluation?.scores.length) throw new BadRequestException('Members have started scoring; the committee and criteria can no longer change');
    const ids = [...new Set(input.members.map((m) => m.userId.toHexString()))];
    if (ids.length !== input.members.length) throw new BadRequestException('A member is listed twice');
    if (ids.length < 3) throw new BadRequestException('An evaluation committee needs at least three members');
    if (input.members.filter((m) => m.role === 'CHAIR').length !== 1) throw new BadRequestException('Name one chairperson');
    const users = await this.db.users.find({ organisationId: user.organisationId, isActive: true, _id: { $in: input.members.map((m) => m.userId) } }, { name: 1 }).lean();
    if (users.length !== ids.length) throw new BadRequestException('Committee members must be active users');
    const names = new Set<string>();
    for (const c of input.criteria) {
      if (names.has(c.name.toLowerCase())) throw new BadRequestException(`Criterion "${c.name}" is listed twice`);
      names.add(c.name.toLowerCase());
    }
    if (!input.criteria.length || input.criteria.reduce((a, c) => a + c.weight, 0) !== 100) throw new BadRequestException('The criteria weights must add up to 100');
    const now = new Date();
    const evaluation = {
      committee: input.members.map((m) => ({ userId: m.userId, name: users.find((u) => u._id.equals(m.userId))!.name, role: m.role, appointedAt: now })),
      criteria: input.criteria,
      passMark: input.passMark,
      financialWeight: input.financialWeight,
      scores: [],
      status: 'OPEN',
      appointedBy: user.id,
      appointedAt: now,
      recommendedSupplierId: null,
      recommendation: '',
      completedBy: null,
      completedAt: null,
    };
    await this.db.rfqs.updateOne({ _id: rfq._id }, { $set: { evaluation } });
    await this.audit.log(user, { action: 'rfq.committee', recordType: 'RequestForQuote', recordId: rfq._id, summary: `Appointed evaluation committee for ${rfq.number}: ${evaluation.committee.map((m) => `${m.name} (${ROLE_LABEL[m.role]})`).join(', ')}` });
    return this.view(user, id);
  }

  /** A member's scores for one bidder, replacing any earlier ones. */
  async score(user: AuthUser, id: Id, input: { supplierId: Id; scores: { criterion: string; score: number; comment?: string }[] }) {
    const rfq = await this.load(user, id);
    const ev = rfq.evaluation;
    if (!ev) throw new BadRequestException('No evaluation committee has been appointed');
    if (!this.member(rfq, user)) throw new ForbiddenException('Only committee members can score');
    if (ev.status === 'COMPLETED') throw new BadRequestException('The evaluation is complete');
    if (rfq.status !== 'CLOSED') throw new BadRequestException('Close the request for quotes before evaluating the bids');
    const bidder = rfq.suppliers.find((s) => s.supplierId.equals(input.supplierId));
    if (!bidder || bidder.declined || !bidder.quotes.length) throw new BadRequestException('That supplier did not submit a quote');
    for (const c of ev.criteria) if (!input.scores.some((s) => s.criterion === c.name)) throw new BadRequestException(`Score "${c.name}"`);
    for (const s of input.scores) {
      if (!ev.criteria.some((c) => c.name === s.criterion)) throw new BadRequestException(`"${s.criterion}" is not a criterion`);
      if (s.score < 0 || s.score > 100) throw new BadRequestException('Scores are out of 100');
    }
    const now = new Date();
    const scores = [
      ...ev.scores.filter((s) => !(s.userId.equals(user.id) && s.supplierId.equals(input.supplierId))),
      ...input.scores.map((s) => ({ userId: user.id, supplierId: input.supplierId, criterion: s.criterion, score: s.score, comment: s.comment ?? '', at: now })),
    ];
    await this.db.rfqs.updateOne({ _id: rfq._id, 'evaluation.status': 'OPEN' }, { $set: { 'evaluation.scores': scores } });
    await this.audit.log(user, { action: 'rfq.score', recordType: 'RequestForQuote', recordId: rfq._id, summary: `${user.name} scored ${bidder.supplierName} on ${rfq.number}` });
    return this.view(user, id);
  }

  /** The evaluation as it stands: per bidder averages, technical, price, combined score and rank. */
  async view(user: AuthUser, id: Id) {
    const rfq = await this.load(user, id);
    const ev = rfq.evaluation;
    if (!ev) return { evaluation: null };
    if (!this.member(rfq, user) && !hasPermission(user, PERMISSIONS.AP_VIEW)) throw new ForbiddenException('You are not on this evaluation committee');
    return { evaluation: await this.compute(user, rfq, ev) };
  }

  private async compute(user: AuthUser, rfq: RequestForQuote, ev: Evaluation) {
    const comparison = await this.rfqs.compare(user, rfq);
    const bidders = rfq.suppliers.filter((s) => !s.declined && s.quotes.length);
    const rows = bidders.map((b) => {
      const mine = ev.scores.filter((s) => s.supplierId.equals(b.supplierId));
      const criteria = ev.criteria.map((c) => {
        const given = mine.filter((s) => s.criterion === c.name);
        const average = given.length ? given.reduce((a, s) => a + s.score, 0) / given.length : null;
        return { name: c.name, weight: c.weight, average: average === null ? null : Math.round(average * 100) / 100 };
      });
      const scoredBy = ev.committee.filter((m) => mine.some((s) => s.userId.equals(m.userId))).map((m) => m.userId);
      const complete = criteria.every((c) => c.average !== null);
      const technical = complete ? Math.round(criteria.reduce((a, c) => a + (c.average! * c.weight) / 100, 0) * 100) / 100 : null;
      const totals = comparison.lines.map((l) => l.quotes.find((q) => q.supplierId.equals(b.supplierId))?.functionalTotal ?? null);
      const price = totals.some((t) => t === null) ? null : totals.reduce<Decimal>((a, t) => a.plus(t!), new Decimal(0)).toDecimalPlaces(2);
      return { supplierId: b.supplierId, supplierName: b.supplierName, criteria, technical, responsive: technical !== null && technical >= ev.passMark, price, linesQuoted: totals.filter((t) => t !== null).length, scoredBy, financial: null as number | null, combined: null as number | null, rank: null as number | null };
    });
    const lowest = rows.filter((r) => r.responsive && r.price).reduce<Decimal | null>((a, r) => (a === null || r.price!.lt(a) ? r.price! : a), null);
    for (const r of rows) {
      if (!r.responsive || !r.price || !lowest) continue;
      r.financial = r.price.isZero() ? 100 : Math.round(lowest.div(r.price).times(100).toNumber() * 100) / 100;
      r.combined = Math.round((r.technical! * (100 - ev.financialWeight) + r.financial * ev.financialWeight)) / 100;
    }
    // With no financial weight the evaluated bid with the lowest price wins among those that pass.
    const ranked = rows.filter((r) => r.combined !== null).sort((a, b) => (ev.financialWeight > 0 ? b.combined! - a.combined! : a.price!.comparedTo(b.price!)));
    ranked.forEach((r, i) => (r.rank = i + 1));
    const pending = ev.committee.flatMap((m) => bidders.filter((b) => !ev.scores.some((s) => s.userId.equals(m.userId) && s.supplierId.equals(b.supplierId))).map((b) => ({ member: m.name, supplier: b.supplierName })));
    return {
      status: ev.status,
      committee: ev.committee.map((m) => ({ userId: m.userId, name: m.name, role: m.role, signedAt: ev.status === 'COMPLETED' ? ev.scores.filter((s) => s.userId.equals(m.userId)).reduce<Date | null>((a, s) => (!a || s.at > a ? s.at : a), null) : null })),
      criteria: ev.criteria,
      passMark: ev.passMark,
      financialWeight: ev.financialWeight,
      functionalCurrency: comparison.functionalCurrency,
      rows: rows.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
      pending,
      recommendedSupplierId: ev.recommendedSupplierId ?? ranked[0]?.supplierId ?? null,
      recommendation: ev.recommendation,
      completedAt: ev.completedAt,
      mine: ev.scores.filter((s) => s.userId.equals(user.id)).map((s) => ({ supplierId: s.supplierId, criterion: s.criterion, score: s.score, comment: s.comment })),
    };
  }

  /** The chair closes the evaluation once every member has scored every bidder. */
  async complete(user: AuthUser, id: Id, recommendation?: string) {
    const rfq = await this.load(user, id);
    const ev = rfq.evaluation;
    if (!ev) throw new BadRequestException('No evaluation committee has been appointed');
    if (ev.committee.find((m) => m.role === 'CHAIR')?.userId.equals(user.id) !== true) throw new ForbiddenException('Only the chairperson completes the evaluation');
    if (ev.status === 'COMPLETED') throw new BadRequestException('The evaluation is already complete');
    const result = await this.compute(user, rfq, ev);
    if (result.pending.length) throw new BadRequestException(`Still to score: ${result.pending.map((p) => `${p.member} → ${p.supplier}`).join('; ')}`);
    const winner = result.rows.find((r) => r.rank === 1);
    if (!winner) throw new BadRequestException('No bid passed the technical evaluation; cancel and re-advertise');
    await this.db.rfqs.updateOne(
      { _id: rfq._id, 'evaluation.status': 'OPEN' },
      { $set: { 'evaluation.status': 'COMPLETED', 'evaluation.recommendedSupplierId': winner.supplierId, 'evaluation.recommendation': recommendation ?? '', 'evaluation.completedBy': user.id, 'evaluation.completedAt': new Date() } },
    );
    await this.audit.log(user, { action: 'rfq.evaluated', recordType: 'RequestForQuote', recordId: rfq._id, summary: `Evaluation of ${rfq.number} completed; recommended ${winner.supplierName}` });
    return this.view(user, id);
  }

  /** Evaluation report: committee, criteria, every bidder's scores, ranking, recommendation and sign-off. */
  async report(user: AuthUser, id: Id) {
    const rfq = await this.load(user, id);
    if (!rfq.evaluation) throw new BadRequestException('No evaluation committee has been appointed');
    const { evaluation: e } = (await this.view(user, id)) as { evaluation: Awaited<ReturnType<RfqEvaluationService['compute']>> };
    const n = (v: number | null) => (v === null ? '—' : v.toFixed(2));
    const recommended = e.rows.find((r) => e.recommendedSupplierId && r.supplierId.equals(e.recommendedSupplierId));
    const data = await renderDocumentPdf({
      title: 'Tender evaluation report',
      number: rfq.number,
      date: rfq.evaluation.completedAt ?? new Date(),
      stamp: e.status === 'COMPLETED' ? null : 'DRAFT',
      issuer: await issuerOf(this.db, rfq.entityId, rfq.branchId),
      party: null,
      facts: [
        ['Subject', rfq.title],
        ['Quotes due', rfq.dueDate.toISOString().slice(0, 10)],
        ['Bids evaluated', String(e.rows.length)],
        ['Technical pass mark', `${e.passMark}%`],
        ['Weighting', `technical ${100 - e.financialWeight}% / price ${e.financialWeight}%`],
      ],
      intro: `The committee below evaluated the quotations received for "${rfq.title}" against the criteria and weights set out, each member scoring each bid independently out of 100.`,
      tables: [
        { heading: 'Evaluation committee', columns: [{ label: 'Name', width: 0.6 }, { label: 'Role', width: 0.4 }], rows: e.committee.map((m) => [m.name, ROLE_LABEL[m.role as keyof typeof ROLE_LABEL]]) },
        { heading: 'Criteria', columns: [{ label: 'Criterion', width: 0.8 }, { label: 'Weight', width: 0.2, align: 'right' }], rows: e.criteria.map((c) => [c.name, `${c.weight}%`]) },
        {
          heading: 'Technical scores (average of members)',
          columns: [{ label: 'Bidder', width: 0.3 }, ...e.criteria.map((c) => ({ label: c.name, width: 0.5 / e.criteria.length, align: 'right' as const })), { label: 'Technical', width: 0.2, align: 'right' }],
          rows: e.rows.map((r) => [r.supplierName, ...r.criteria.map((c) => n(c.average)), n(r.technical)]),
        },
        {
          heading: `Financial evaluation and ranking (${e.functionalCurrency})`,
          columns: [{ label: 'Bidder', width: 0.3 }, { label: 'Responsive', width: 0.14 }, { label: 'Evaluated price', width: 0.18, align: 'right' }, { label: 'Financial', width: 0.12, align: 'right' }, { label: 'Combined', width: 0.14, align: 'right' }, { label: 'Rank', width: 0.12, align: 'right' }],
          rows: e.rows.map((r) => [r.supplierName, r.responsive ? 'Yes' : 'No', r.price ? r.price.toFixed(2) : 'Not all lines', n(r.financial), n(r.combined), r.rank ? String(r.rank) : '—']),
        },
      ],
      sections: [{ heading: 'Recommendation', text: recommended ? `The committee recommends award to ${recommended.supplierName}, the highest-ranked responsive bidder.${e.recommendation ? ` ${e.recommendation}` : ''}` : 'Evaluation not yet complete.' }],
      signatures: e.committee.map((m) => ({ role: ROLE_LABEL[m.role as keyof typeof ROLE_LABEL], name: m.name, date: m.signedAt, note: m.signedAt ? 'Signed electronically' : undefined })),
      footer: e.status === 'COMPLETED' ? `Electronic signatures are the times each member recorded their scores, completed by the chairperson on ${rfq.evaluation.completedAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC. Generated from the system audit trail.` : 'Draft: the evaluation is still open.',
    });
    return { data, filename: `Evaluation report ${rfq.number}.pdf` };
  }
}
