import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { issuerOf, renderDocumentPdf } from '../../common/document-pdf';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { dec } from '../../common/money';
import { userNames } from '../../common/names';
import { assertApprovalLimit, assertSegregation } from '../../common/workflow';
import { PurchaseOrder } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { BudgetsService } from '../budgets/budgets.service';
import { EmailService, layout } from '../communication/email.service';
import { renderTemplate } from '../communication/email-templates';
import { PurchaseOrderInput, ProcurementService } from './procurement.service';

type Id = Types.ObjectId;
const AMENDABLE = ['APPROVED', 'PARTIALLY_RECEIVED'];
const ISSUED = ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

export interface AmendmentInput {
  reason: string;
  expectedDate?: Date | null;
  deliveryAddress?: string;
  notes?: string;
  lines: PurchaseOrderInput['lines'];
}

/**
 * Local purchase orders after approval: amendments (a new version, approved by someone other than the
 * requester, with the earlier version kept), the printed LPO and emailing it to the supplier.
 */
export class PoAmendmentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly procurement: ProcurementService,
    private readonly budgets: BudgetsService,
    private readonly email: EmailService,
  ) {}

  private async load(user: AuthUser, id: Id) {
    const po = (await this.db.purchaseOrders.findOne({ _id: id, organisationId: user.organisationId }).lean()) as PurchaseOrder | null;
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  /**
   * Proposes a new version. Existing lines keep their place (goods received notes refer to them by line
   * number) and cannot go below what was received or billed; new lines are added at the end.
   */
  async request(user: AuthUser, id: Id, input: AmendmentInput) {
    const po = await this.load(user, id);
    if (!AMENDABLE.includes(po.status)) throw new BadRequestException(`A ${po.status.toLowerCase().replace('_', ' ')} order cannot be amended`);
    if (po.amendment) throw new BadRequestException('An amendment is already awaiting approval');
    if (input.lines.length < po.lines.length) throw new BadRequestException('Existing lines cannot be removed; reduce their quantity instead');
    po.lines.forEach((old, i) => {
      const next = input.lines[i];
      const received = dec(old.quantityReceived);
      const billed = dec(old.quantityBilled);
      if (!next.accountId.equals(old.accountId) || String(next.itemId ?? null) !== String(old.itemId ?? null)) throw new BadRequestException(`Line ${i + 1}: the account and item of an existing line cannot change`);
      if (next.quantity.lt(received) || next.quantity.lt(billed)) throw new BadRequestException(`Line ${i + 1}: ${received.gt(billed) ? received.toFixed() : billed.toFixed()} has already been received or billed`);
      if (billed.gt(0) && !next.unitPrice.eq(dec(old.unitPrice))) throw new BadRequestException(`Line ${i + 1}: the price of a billed line cannot change`);
    });
    const { fields } = await this.procurement.buildOrder(user, {
      entityId: po.entityId,
      branchId: po.branchId,
      supplierId: po.supplierId,
      date: po.date,
      expectedDate: input.expectedDate === undefined ? po.expectedDate : input.expectedDate,
      reference: po.reference,
      notes: input.notes ?? po.notes,
      deliveryAddress: input.deliveryAddress ?? po.deliveryAddress,
      requisitionId: po.requisitionId,
      exchangeRate: dec(po.exchangeRate),
      priceIncludesTax: po.priceIncludesTax,
      lines: input.lines,
    });
    // Carry what has happened on each existing line into the new version.
    const lines = fields.lines.map((l, i) => {
      const old = po.lines[i];
      return old ? { ...l, quantityReceived: old.quantityReceived, quantityBilled: old.quantityBilled, receivedValue: old.receivedValue ?? l.receivedValue, billedValue: old.billedValue ?? null } : l;
    });
    const proposed = { expectedDate: fields.expectedDate, notes: fields.notes, deliveryAddress: fields.deliveryAddress, lines, subtotal: fields.subtotal, taxTotal: fields.taxTotal, total: fields.total, totalFunctional: fields.totalFunctional };
    const res = await this.db.purchaseOrders.updateOne({ _id: po._id, status: po.status, amendment: null }, { $set: { amendment: { reason: input.reason, proposed, requestedBy: user.id, requestedAt: new Date() } } });
    if (!res.modifiedCount) throw new BadRequestException('The order was changed by someone else; reload and try again');
    await this.audit.log(user, { action: 'purchase_order.amend_request', recordType: 'PurchaseOrder', recordId: po._id, summary: `Proposed amendment to ${po.number} (total ${dec(po.total).toFixed()} → ${dec(fields.total).toFixed()}): ${input.reason}` });
    return this.db.purchaseOrders.findById(po._id).lean();
  }

  async decide(user: AuthUser, id: Id, approve: boolean, reason?: string) {
    return this.db.transaction(async (session) => {
      const po = (await this.db.purchaseOrders.findOne({ _id: id, organisationId: user.organisationId }).session(session).lean()) as PurchaseOrder | null;
      if (!po) throw new NotFoundException('Purchase order not found');
      const a = po.amendment;
      if (!a?.proposed) throw new BadRequestException('There is no amendment awaiting approval');
      const proposed = a.proposed;
      if (!approve) {
        if (!reason?.trim()) throw new BadRequestException('Give the reason');
        await this.db.purchaseOrders.updateOne({ _id: po._id }, { $set: { amendment: null } }, { session });
        await this.audit.log(user, { action: 'purchase_order.amend_reject', recordType: 'PurchaseOrder', recordId: po._id, summary: `Rejected amendment to ${po.number}: ${reason}` }, session);
        return this.db.purchaseOrders.findById(po._id).session(session).lean();
      }
      if (a.requestedBy.equals(user.id)) throw new ForbiddenException('Segregation of duties: you cannot approve an amendment you requested');
      assertSegregation(user, { createdBy: a.requestedBy, submittedBy: null }, 'an amendment');
      const entity = (await this.db.entities.findById(po.entityId).session(session).lean())!;
      assertApprovalLimit(user, dec(proposed.totalFunctional), entity.functionalCurrency, 'The amended purchase order');
      const budgetNotes = await this.budgets.enforce(user, { entityId: po.entityId, date: po.date, excludeOrderId: po._id, amounts: proposed.lines.map((l) => ({ accountId: l.accountId, amount: dec(l.netAmount).times(dec(po.exchangeRate)) })) }, session);
      const full = proposed.lines.every((l) => dec(l.quantityReceived).gte(dec(l.quantity)));
      const some = proposed.lines.some((l) => dec(l.quantityReceived).gt(0));
      const version = (po.version ?? 1) + 1;
      const revision = { version: po.version ?? 1, reason: a.reason, requestedBy: a.requestedBy, requestedAt: a.requestedAt, approvedBy: user.id, approvedAt: new Date(), total: po.total, newTotal: proposed.total, expectedDate: po.expectedDate, lines: po.lines };
      const res = await this.db.purchaseOrders.updateOne(
        { _id: po._id, status: po.status, 'amendment.requestedAt': a.requestedAt },
        {
          $set: { ...proposed, status: full ? 'RECEIVED' : some ? 'PARTIALLY_RECEIVED' : 'APPROVED', version, amendment: null },
          $push: { revisions: revision },
        },
        { session },
      );
      if (!res.modifiedCount) throw new BadRequestException('The order was changed by someone else; reload and try again');
      await this.audit.log(
        user,
        { action: 'purchase_order.amend', recordType: 'PurchaseOrder', recordId: po._id, summary: `Approved amendment ${version} to ${po.number}: ${a.reason}${budgetNotes.length ? ` — over budget: ${budgetNotes.join('; ')}` : ''}` },
        session,
      );
      return this.db.purchaseOrders.findById(po._id).session(session).lean();
    });
  }

  /** The printed local purchase order (current version). */
  async pdf(user: AuthUser, id: Id) {
    const po = await this.load(user, id);
    const supplier = await this.db.suppliers.findById(po.supplierId).lean();
    const name = await userNames(this.db, [po.createdBy, po.approvedBy]);
    const accounts = await this.db.accounts.find({ _id: { $in: po.lines.map((l) => l.accountId) } }, { code: 1 }).lean();
    const money = (v: unknown) => dec(v as never).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const stamp = po.status === 'CANCELLED' ? 'CANCELLED' : ISSUED.includes(po.status) ? null : po.status === 'DRAFT' ? 'DRAFT' : 'NOT APPROVED';
    const data = await renderDocumentPdf({
      title: 'Local purchase order',
      number: po.number,
      date: po.date,
      stamp,
      issuer: await issuerOf(this.db, po.entityId, po.branchId),
      party: { heading: 'Supplier', name: po.supplierName, lines: [supplier?.taxId ? `PIN ${supplier.taxId}` : '', supplier?.address ?? '', [supplier?.phone, supplier?.email].filter(Boolean).join(' · ')] },
      facts: [
        ['Version', (po.version ?? 1) > 1 ? `Amendment ${(po.version ?? 1) - 1}` : 'Original'],
        ['Deliver by', po.expectedDate ? po.expectedDate.toISOString().slice(0, 10) : ''],
        ['Currency', po.currency],
        ['Reference', po.reference],
      ],
      intro: po.deliveryAddress ? `Please supply the following, delivered to: ${po.deliveryAddress}` : 'Please supply the following:',
      tables: [
        {
          columns: [{ label: '#', width: 0.05 }, { label: 'Description', width: 0.41 }, { label: 'Vote', width: 0.1 }, { label: 'Qty', width: 0.1, align: 'right' }, { label: 'Unit price', width: 0.16, align: 'right' }, { label: 'Amount', width: 0.18, align: 'right' }],
          rows: po.lines.map((l) => [String(l.lineNo), l.description, accounts.find((a) => a._id.equals(l.accountId))?.code ?? '', dec(l.quantity).toFixed(), money(l.unitPrice), money(l.netAmount)]),
          foot: [
            ['', '', '', '', 'Subtotal', money(po.subtotal)],
            ['', '', '', '', 'Tax', money(po.taxTotal)],
            ['', '', '', '', 'Total', `${po.currency} ${money(po.total)}`],
          ],
        },
      ],
      sections: [
        ...(po.notes ? [{ heading: 'Notes', text: po.notes }] : []),
        { heading: 'Terms', text: 'Quote this order number on your delivery note and invoice. Goods are accepted subject to inspection. This order is valid only when approved and is not transferable.' },
      ],
      signatures: [
        { role: 'Prepared by', name: name(po.createdBy) ?? '', date: po.createdAt ?? null },
        { role: 'Authorised by', name: name(po.approvedBy) ?? '', date: po.approvedAt ?? null, note: po.approvedAt ? 'Approved electronically' : undefined },
        { role: 'Accepted by supplier', name: '', date: null },
      ],
    });
    return { data, filename: `LPO ${po.number}${(po.version ?? 1) > 1 ? ` v${po.version}` : ''}.pdf` };
  }

  /** Emails the approved LPO to the supplier with the PDF attached. */
  async send(user: AuthUser, id: Id, to?: string) {
    const po = await this.load(user, id);
    if (!ISSUED.includes(po.status)) throw new BadRequestException('Only an approved order can be sent to the supplier');
    const supplier = await this.db.suppliers.findById(po.supplierId).lean();
    const address = (to ?? supplier?.email ?? '').trim();
    if (!address) throw new BadRequestException(`${po.supplierName} has no email address; enter one`);
    const { data, filename } = await this.pdf(user, id);
    const entity = (await this.db.entities.findById(po.entityId).lean())!;
    const t = await renderTemplate(this.db, user.organisationId, 'lpo', { organisation: entity.legalName || entity.name, supplier: po.supplierName, number: po.number, amendment: (po.version ?? 1) > 1 ? ` (amendment ${(po.version ?? 1) - 1})` : '', currency: po.currency, amount: dec(po.total).toFixed(2) });
    const body = layout({ title: `Purchase order ${po.number}`, intro: t.intro, paragraphs: t.paragraphs, footer: t.footer });
    const queued = await this.email.enqueue({
      organisationId: user.organisationId,
      to: [address],
      replyTo: user.email,
      subject: t.subject,
      ...body,
      category: 'procurement',
      related: { type: 'PurchaseOrder', id: po._id },
      attachments: [{ filename, contentType: 'application/pdf', content: data }],
    });
    if (!queued) throw new BadRequestException(`${address} is not a valid email address`);
    await this.db.purchaseOrders.updateOne({ _id: po._id }, { $push: { sentTo: { email: address, version: po.version ?? 1, at: new Date(), by: user.id } } });
    await this.audit.log(user, { action: 'purchase_order.email', recordType: 'PurchaseOrder', recordId: po._id, summary: `Emailed ${po.number} v${po.version ?? 1} to ${address}` });
    return { sent: true, to: address };
  }
}
