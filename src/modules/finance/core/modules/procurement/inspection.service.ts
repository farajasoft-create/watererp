import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { issuerOf, renderDocumentPdf } from '../../common/document-pdf';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { dec } from '../../common/money';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { WorkflowService } from '../workflow/workflow.service';
import { ProcurementService } from './procurement.service';

type Id = Types.ObjectId;

/**
 * Inspection and acceptance of deliveries: a committee of at least three (not including whoever
 * received the goods) inspects each goods received note; each member accepts or rejects it. The
 * majority decides: accepted goods can be billed, rejected goods are reversed out of stock and the
 * order is reopened for a replacement delivery.
 */
export class InspectionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly workflow: WorkflowService,
    private readonly procurement: ProcurementService,
  ) {}

  private async load(user: AuthUser, id: Id) {
    const grn = await this.db.goodsReceipts.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!grn) throw new NotFoundException('Goods received note not found');
    return grn;
  }

  /** Receipts awaiting a committee or decisions, and those decided recently. */
  async list(user: AuthUser, q: { entityId: Id; status?: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'UNASSIGNED' }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, entityId: q.entityId };
    if (q.status === 'UNASSIGNED') Object.assign(filter, { status: 'POSTED', inspection: null });
    else if (q.status) filter['inspection.status'] = q.status;
    return this.db.goodsReceipts.find(filter).sort({ date: -1 }).limit(200).lean();
  }

  async appoint(user: AuthUser, id: Id, memberIds: Id[]) {
    const grn = await this.load(user, id);
    if (grn.status !== 'POSTED') throw new BadRequestException(`${grn.number} has been reversed`);
    if (grn.inspection?.decisions.length) throw new BadRequestException('Inspection has started; the committee can no longer change');
    const unique = [...new Map(memberIds.map((m) => [m.toHexString(), m])).values()];
    if (unique.length < 3) throw new BadRequestException('An inspection and acceptance committee needs at least three members');
    if (unique.some((m) => m.equals(grn.createdBy))) throw new BadRequestException('Whoever received the goods cannot inspect them');
    const users = await this.db.users.find({ organisationId: user.organisationId, isActive: true, _id: { $in: unique } }, { name: 1 }).lean();
    if (users.length !== unique.length) throw new BadRequestException('Committee members must be active users');
    const inspection = { committee: users.map((u) => ({ userId: u._id, name: u.name })), appointedBy: user.id, appointedAt: new Date(), decisions: [], status: 'PENDING', completedAt: null };
    await this.db.goodsReceipts.updateOne({ _id: grn._id }, { $set: { inspection } });
    await this.workflow.notify(user.organisationId, unique, { kind: 'inspection', title: `Inspect delivery ${grn.number}`, body: `${grn.purchaseOrderNumber}: you are on the inspection and acceptance committee.`, link: `/finance/purchases/inspections?open=${grn._id}` });
    await this.audit.log(user, { action: 'goods_receipt.committee', recordType: 'GoodsReceipt', recordId: grn._id, summary: `Inspection committee for ${grn.number}: ${users.map((u) => u.name).join(', ')}` });
    return this.load(user, id);
  }

  async decide(user: AuthUser, id: Id, input: { decision: 'ACCEPT' | 'REJECT'; remarks?: string }) {
    const grn = await this.load(user, id);
    const ins = grn.inspection;
    if (!ins) throw new BadRequestException('No inspection committee has been appointed');
    if (ins.status !== 'PENDING') throw new BadRequestException('The inspection is complete');
    const me = ins.committee.find((m) => m.userId.equals(user.id));
    if (!me) throw new ForbiddenException('Only committee members record the inspection');
    if (ins.decisions.some((d) => d.userId.equals(user.id))) throw new BadRequestException('You have already recorded your decision');
    if (input.decision === 'REJECT' && !input.remarks?.trim()) throw new BadRequestException('Say why the goods are rejected');
    const decisions = [...ins.decisions, { userId: user.id, name: me.name, decision: input.decision, remarks: input.remarks ?? '', at: new Date() }];
    const done = decisions.length === ins.committee.length;
    const accepts = decisions.filter((d) => d.decision === 'ACCEPT').length;
    const status = done ? (accepts * 2 > decisions.length ? 'ACCEPTED' : 'REJECTED') : 'PENDING';
    const res = await this.db.goodsReceipts.updateOne(
      { _id: grn._id, 'inspection.status': 'PENDING', 'inspection.decisions': { $size: ins.decisions.length } },
      { $set: { 'inspection.decisions': decisions, 'inspection.status': status, ...(done && { 'inspection.completedAt': new Date() }) } },
    );
    if (!res.modifiedCount) throw new BadRequestException('Another member recorded a decision at the same time; try again');
    await this.audit.log(user, { action: 'goods_receipt.inspect', recordType: 'GoodsReceipt', recordId: grn._id, summary: `${me.name} ${input.decision === 'ACCEPT' ? 'accepted' : 'rejected'} ${grn.number}${input.remarks ? `: ${input.remarks}` : ''}` });
    if (status === 'REJECTED') {
      const today = new Date(new Date().toISOString().slice(0, 10));
      const reasons = decisions.filter((d) => d.decision === 'REJECT').map((d) => d.remarks).join('; ');
      await this.procurement.reverseReceipt(user, grn._id, { date: today < grn.date ? grn.date : today, reason: `Rejected on inspection: ${reasons}` });
    }
    return this.load(user, id);
  }

  /** Inspection and acceptance certificate. */
  async certificate(user: AuthUser, id: Id) {
    const grn = await this.load(user, id);
    const ins = grn.inspection;
    if (!ins) throw new BadRequestException('No inspection committee has been appointed');
    const supplier = await this.db.suppliers.findById(grn.supplierId, { name: 1 }).lean();
    const outcome = ins.status === 'ACCEPTED' ? 'ACCEPTED' : ins.status === 'REJECTED' ? 'REJECTED' : 'PENDING';
    const data = await renderDocumentPdf({
      title: 'Inspection and acceptance certificate',
      number: grn.number,
      date: ins.completedAt ?? grn.date,
      stamp: outcome === 'PENDING' ? 'PENDING' : outcome === 'REJECTED' ? 'REJECTED' : null,
      issuer: await issuerOf(this.db, grn.entityId, grn.branchId),
      party: { heading: 'Supplier', name: supplier?.name ?? '', lines: [`Order ${grn.purchaseOrderNumber}`, grn.reference && `Delivery note ${grn.reference}`].filter(Boolean) as string[] },
      facts: [
        ['Delivered', grn.date.toISOString().slice(0, 10)],
        ['Outcome', outcome.charAt(0) + outcome.slice(1).toLowerCase()],
      ],
      intro: 'We, the undersigned members of the inspection and acceptance committee, have inspected the goods below delivered against the order shown.',
      tables: [
        { heading: 'Goods', columns: [{ label: 'Line', width: 0.1 }, { label: 'Description', width: 0.7 }, { label: 'Quantity', width: 0.2, align: 'right' }], rows: grn.lines.map((l) => [String(l.poLineNo), l.description ?? '', dec(l.quantity).toFixed()]) },
        { heading: 'Committee decisions', columns: [{ label: 'Member', width: 0.3 }, { label: 'Decision', width: 0.15 }, { label: 'Remarks', width: 0.55 }], rows: ins.committee.map((m) => { const d = ins.decisions.find((x) => x.userId.equals(m.userId)); return [m.name, d ? (d.decision === 'ACCEPT' ? 'Accept' : 'Reject') : 'Pending', d?.remarks ?? '']; }) },
      ],
      signatures: ins.committee.map((m) => {
        const d = ins.decisions.find((x) => x.userId.equals(m.userId));
        return { role: 'Committee member', name: m.name, date: d?.at ?? null, note: d ? 'Signed electronically' : undefined };
      }),
      footer: 'Electronic signatures are the times each member recorded their decision in the system.',
    });
    return { data, filename: `Inspection certificate ${grn.number}.pdf` };
  }
}
