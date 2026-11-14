import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { RequestForQuote } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { assertSupplierUsable } from './supplier-management.service';
import { AuditService } from '../audit/audit.service';
import { EmailService, escapeHtml, layout } from '../communication/email.service';
import { renderTemplate } from '../communication/email-templates';
import { CurrenciesService } from '../currencies/currencies.service';
import { InventoryService } from '../inventory/inventory.service';
import { ProcurementService } from './procurement.service';

export interface RfqInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  title: string;
  date: Date;
  dueDate: Date;
  notes?: string;
  deliveryAddress?: string;
  requisitionId?: Types.ObjectId | null;
  supplierIds: Types.ObjectId[];
  lines: { description: string; quantity: Decimal; accountId?: Types.ObjectId | null; itemId?: Types.ObjectId | null; warehouseId?: Types.ObjectId | null; taxCodeId?: Types.ObjectId | null }[];
}

export interface QuoteInput {
  supplierId: Types.ObjectId;
  reference?: string;
  validUntil?: Date | null;
  declined?: boolean;
  lines: { lineNo: number; unitPrice: Decimal; leadTimeDays?: number | null; notes?: string }[];
}

/**
 * Requests for quotes: ask several suppliers to price the same lines, record their quotes, compare them
 * in functional currency and award each line; awarding raises a draft purchase order per winner.
 */
export class RfqService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly inventory: InventoryService,
    private readonly procurement: ProcurementService,
    private readonly email: EmailService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  private async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession) {
    const rfq = await this.db.rfqs.findOne({ _id: id, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!rfq) throw new NotFoundException('Request for quotes not found');
    assertBranchAccess(user, [rfq.branchId]);
    return rfq;
  }

  async list(user: AuthUser, query: { entityId?: Types.ObjectId; status?: string }) {
    return this.db.rfqs
      .find({ ...this.scope(user), ...(query.entityId && { entityId: query.entityId }), ...(query.status && { status: query.status }) }, { lines: 0, awards: 0 })
      .sort({ date: -1, number: -1 })
      .limit(500)
      .lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const rfq = await this.load(user, id);
    const orders = await this.db.purchaseOrders.find({ organisationId: user.organisationId, _id: { $in: rfq.awards.map((a) => a.purchaseOrderId).filter(Boolean) } }, { number: 1, status: 1, supplierName: 1 }).lean();
    return { ...(await withTrail(this.db, rfq)), comparison: await this.compare(user, rfq), orders };
  }

  private async fields(user: AuthUser, input: RfqInput, session: ClientSession) {
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).session(session).lean();
    if (!entity?.isActive) throw new BadRequestException('Entity not found or inactive');
    const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: user.organisationId, entityId: entity._id }).session(session).lean();
    if (!branch) throw new BadRequestException('Branch not found in this entity');
    assertBranchAccess(user, [branch._id]);
    if (input.dueDate < input.date) throw new BadRequestException('Quotes cannot be due before the request date');
    const ids = [...new Set(input.supplierIds.map((s) => s.toHexString()))];
    if (ids.length < 1) throw new BadRequestException('Choose at least one supplier');
    const suppliers = await this.db.suppliers.find({ _id: { $in: ids }, organisationId: user.organisationId, isActive: true }).session(session).lean();
    if (suppliers.length !== ids.length) throw new BadRequestException('Supplier not found or inactive');
    for (const supplier of suppliers) assertSupplierUsable(supplier, 'ORDER');
    const lines = [];
    for (const [i, l] of input.lines.entries()) {
      if (!dec(l.quantity).gt(0)) throw new BadRequestException(`Line ${i + 1}: the quantity must be positive`);
      let accountId = l.accountId ?? null;
      if (l.itemId) {
        const item = await this.inventory.item(user.organisationId, l.itemId, session);
        if (item.type === 'STOCK') {
          if (!l.warehouseId) throw new BadRequestException(`Line ${i + 1}: choose the warehouse receiving ${item.code}`);
          await this.inventory.warehouse(user.organisationId, l.warehouseId, entity._id, session);
          accountId = item.inventoryAccountId ?? accountId;
        } else accountId = accountId ?? item.purchaseAccountId ?? null;
      }
      if (!accountId) throw new BadRequestException(`Line ${i + 1}: choose the account`);
      if (!(await this.db.accounts.exists({ _id: accountId, organisationId: user.organisationId }).session(session))) throw new BadRequestException(`Line ${i + 1}: account not found`);
      lines.push({ lineNo: i + 1, description: l.description, quantity: toD128(l.quantity), accountId, itemId: l.itemId ?? null, warehouseId: l.itemId ? (l.warehouseId ?? null) : null, taxCodeId: l.taxCodeId ?? null });
    }
    return {
      entity,
      fields: {
        entityId: entity._id,
        branchId: branch._id,
        title: input.title,
        date: input.date,
        dueDate: input.dueDate,
        notes: input.notes ?? '',
        deliveryAddress: input.deliveryAddress ?? '',
        requisitionId: input.requisitionId ?? null,
        lines,
        suppliers: suppliers.map((s) => ({ supplierId: s._id, supplierName: s.name, email: s.email ?? '', currency: s.currency, quotes: [] })),
      },
    };
  }

  async create(user: AuthUser, input: RfqInput) {
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.fields(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, 'RFQ', session);
      const [rfq] = await this.db.rfqs.create([{ ...fields, organisationId: user.organisationId, number, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'rfq.create', recordType: 'RequestForQuote', recordId: rfq._id, summary: `Created ${number}: ${input.title}`, after: rfq }, session);
      return rfq.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: RfqInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'DRAFT') throw new BadRequestException('Only draft requests can be edited');
      const { fields } = await this.fields(user, input, session);
      await this.db.rfqs.updateOne({ _id: id }, fields, { session });
      await this.audit.log(user, { action: 'rfq.update', recordType: 'RequestForQuote', recordId: id, summary: `Updated ${before.number}`, before }, session);
      return this.db.rfqs.findById(id).session(session).lean();
    });
  }

  /** Emails the request to each supplier (those without an email address are marked sent for a manual follow-up). */
  async send(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const rfq = await this.load(user, id, session);
      if (!['DRAFT', 'SENT'].includes(rfq.status)) throw new BadRequestException(`${rfq.number} is ${rfq.status.toLowerCase()}`);
      const entity = (await this.db.entities.findById(rfq.entityId).session(session).lean())!;
      const actor = await this.db.users.findById(user.id).session(session).lean();
      const due = rfq.dueDate.toISOString().slice(0, 10);
      const rows = rfq.lines.map((l) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e4e4ec">${l.lineNo}</td><td style="padding:6px 8px;border-bottom:1px solid #e4e4ec">${escapeHtml(l.description)}</td><td style="padding:6px 8px;border-bottom:1px solid #e4e4ec;text-align:right">${dec(l.quantity).toFixed()}</td></tr>`).join('');
      const table = `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 14px"><tr><th style="text-align:left;padding:6px 8px">#</th><th style="text-align:left;padding:6px 8px">Description</th><th style="text-align:right;padding:6px 8px">Quantity</th></tr>${rows}</table>`;
      let emailed = 0;
      const now = new Date();
      const suppliers = [];
      for (const s of rfq.suppliers) {
        if (!s.sentAt && s.email) {
          const t = await renderTemplate(this.db, user.organisationId, 'rfq', { organisation: entity.name, supplier: s.supplierName, number: rfq.number, title: rfq.title, due, currency: s.currency, sender: actor?.name ?? 'FarajaSoft' }, session);
          const body = layout({
            title: `Request for quotation ${rfq.number}`,
            intro: t.intro,
            paragraphs: [...t.paragraphs, ...(rfq.deliveryAddress ? [`Delivery to: ${rfq.deliveryAddress}`] : []), ...(rfq.notes ? [rfq.notes] : [])],
            html: table,
            footer: t.footer,
          });
          if (await this.email.enqueue({ organisationId: user.organisationId, to: [s.email], replyTo: actor?.email ?? null, subject: t.subject, ...body, category: 'procurement', related: { type: 'RequestForQuote', id: rfq._id } }, session)) emailed++;
        }
        suppliers.push({ ...s, sentAt: s.sentAt ?? now });
      }
      await this.db.rfqs.updateOne({ _id: id }, { status: 'SENT', suppliers }, { session });
      await this.audit.log(user, { action: 'rfq.send', recordType: 'RequestForQuote', recordId: id, summary: `Sent ${rfq.number} to ${rfq.suppliers.length} supplier(s); ${emailed} emailed` }, session);
      return { ...(await this.db.rfqs.findById(id).session(session).lean()), emailed };
    });
  }

  /** Records (or replaces) a supplier's quote. */
  async recordQuote(user: AuthUser, id: Types.ObjectId, input: QuoteInput) {
    return this.db.transaction(async (session) => {
      const rfq = await this.load(user, id, session);
      if (!['SENT', 'CLOSED'].includes(rfq.status)) throw new BadRequestException(rfq.status === 'DRAFT' ? 'Send the request before recording quotes' : `${rfq.number} is ${rfq.status.toLowerCase()}`);
      const supplier = rfq.suppliers.find((s) => s.supplierId.equals(input.supplierId));
      if (!supplier) throw new BadRequestException('That supplier was not asked to quote');
      const seen = new Set<number>();
      for (const q of input.lines) {
        if (!rfq.lines.some((l) => l.lineNo === q.lineNo)) throw new BadRequestException(`There is no line ${q.lineNo}`);
        if (seen.has(q.lineNo)) throw new BadRequestException(`Line ${q.lineNo} is quoted twice`);
        seen.add(q.lineNo);
        if (dec(q.unitPrice).lt(0)) throw new BadRequestException(`Line ${q.lineNo}: the price cannot be negative`);
      }
      if (!input.declined && !input.lines.length) throw new BadRequestException('Enter at least one price, or mark the supplier as declined');
      const suppliers = rfq.suppliers.map((s) =>
        s.supplierId.equals(input.supplierId)
          ? {
              ...s,
              respondedAt: new Date(),
              reference: input.reference ?? '',
              validUntil: input.validUntil ?? null,
              declined: !!input.declined,
              quotes: input.declined ? [] : input.lines.map((q) => ({ lineNo: q.lineNo, unitPrice: toD128(q.unitPrice), leadTimeDays: q.leadTimeDays ?? null, notes: q.notes ?? '' })),
            }
          : s,
      );
      await this.db.rfqs.updateOne({ _id: id }, { suppliers }, { session });
      await this.audit.log(user, { action: 'rfq.quote', recordType: 'RequestForQuote', recordId: id, summary: `${supplier.supplierName} ${input.declined ? 'declined' : `quoted ${input.lines.length} line(s)`} on ${rfq.number}` }, session);
      return this.db.rfqs.findById(id).session(session).lean();
    });
  }

  async close(user: AuthUser, id: Types.ObjectId) {
    return this.setStatus(user, id, ['SENT'], 'CLOSED', 'rfq.close', 'Closed to further quotes');
  }

  async cancel(user: AuthUser, id: Types.ObjectId, reason?: string) {
    return this.setStatus(user, id, ['DRAFT', 'SENT', 'CLOSED'], 'CANCELLED', 'rfq.cancel', `Cancelled${reason ? `: ${reason}` : ''}`);
  }

  private async setStatus(user: AuthUser, id: Types.ObjectId, from: string[], to: string, action: string, summary: string) {
    return this.db.transaction(async (session) => {
      const rfq = await this.load(user, id, session);
      if (!from.includes(rfq.status)) throw new BadRequestException(`${rfq.number} is ${rfq.status.toLowerCase()}`);
      await this.db.rfqs.updateOne({ _id: id }, { status: to }, { session });
      await this.audit.log(user, { action, recordType: 'RequestForQuote', recordId: id, summary: `${rfq.number}: ${summary}` }, session);
      return this.db.rfqs.findById(id).session(session).lean();
    });
  }

  /** The quote matrix: each line's quotes converted to functional currency at the request date, cheapest first. */
  /** Whether a bidder's average weighted technical score is below the evaluation's pass mark. */
  private async evaluatedBelowPassMark(ev: NonNullable<RequestForQuote['evaluation']>, supplierId: Types.ObjectId) {
    const mine = ev.scores.filter((s) => s.supplierId.equals(supplierId));
    const technical = ev.criteria.reduce((a, c) => {
      const given = mine.filter((s) => s.criterion === c.name);
      return a + (given.length ? given.reduce((x, s) => x + s.score, 0) / given.length : 0) * (c.weight / 100);
    }, 0);
    return technical < ev.passMark;
  }

  async compare(user: AuthUser, rfq: RequestForQuote, session?: ClientSession) {
    const entity = (await this.db.entities.findById(rfq.entityId).session(session ?? null).lean())!;
    const functional = entity.functionalCurrency;
    const rates = new Map<string, Decimal | null>([[functional, new Decimal(1)]]);
    for (const s of rfq.suppliers) {
      if (rates.has(s.currency)) continue;
      const found = await this.currencies.findRate(user.organisationId, s.currency, functional, rfq.date, 'SPOT', session);
      rates.set(s.currency, found?.rate ?? null);
    }
    const lines = rfq.lines.map((l) => {
      const quotes = rfq.suppliers
        .filter((s) => !s.declined)
        .flatMap((s) => {
          const q = s.quotes.find((x) => x.lineNo === l.lineNo);
          if (!q) return [];
          const rate = rates.get(s.currency) ?? null;
          const unitPrice = dec(q.unitPrice);
          return [{ supplierId: s.supplierId, supplierName: s.supplierName, currency: s.currency, unitPrice, leadTimeDays: q.leadTimeDays, notes: q.notes, functionalUnitPrice: rate ? unitPrice.times(rate) : null, functionalTotal: rate ? unitPrice.times(rate).times(dec(l.quantity)) : null }];
        })
        .sort((a, b) => (a.functionalUnitPrice && b.functionalUnitPrice ? a.functionalUnitPrice.comparedTo(b.functionalUnitPrice) : a.functionalUnitPrice ? -1 : 1));
      const cheapest = quotes[0]?.functionalUnitPrice ? quotes[0].supplierId : null;
      return { lineNo: l.lineNo, description: l.description, quantity: dec(l.quantity), quotes, cheapestSupplierId: cheapest };
    });
    const missingRates = [...rates.entries()].filter(([, r]) => !r).map(([c]) => c);
    return { functionalCurrency: functional, lines, missingRates };
  }

  /**
   * Awards each line to a supplier and raises one draft purchase order per winner, at the quoted price.
   * Choosing anything but the cheapest quote needs a reason.
   */
  async award(user: AuthUser, id: Types.ObjectId, input: { date: Date; lines: { lineNo: number; supplierId: Types.ObjectId; reason?: string }[] }) {
    return this.db.transaction(async (session) => {
      const rfq = await this.load(user, id, session);
      if (!['SENT', 'CLOSED'].includes(rfq.status)) throw new BadRequestException(`${rfq.number} is ${rfq.status.toLowerCase()}`);
      if (!input.lines.length) throw new BadRequestException('Award at least one line');
      const comparison = await this.compare(user, rfq, session);
      const ev = rfq.evaluation;
      if (ev && ev.status !== 'COMPLETED') throw new BadRequestException('The evaluation committee has not completed its evaluation');
      const awards: { lineNo: number; supplierId: Types.ObjectId; unitPrice: Decimal; reason: string }[] = [];
      for (const a of input.lines) {
        const line = comparison.lines.find((l) => l.lineNo === a.lineNo);
        if (!line) throw new BadRequestException(`There is no line ${a.lineNo}`);
        if (awards.some((x) => x.lineNo === a.lineNo)) throw new BadRequestException(`Line ${a.lineNo} is awarded twice`);
        const quote = line.quotes.find((q) => q.supplierId.equals(a.supplierId));
        if (!quote) throw new BadRequestException(`Line ${a.lineNo}: that supplier did not quote for it`);
        const reason = a.reason?.trim() ?? '';
        if (ev) {
          // After a committee evaluation the award follows its recommendation; departing from it needs a reason.
          const failed = !ev.scores.some((s) => s.supplierId.equals(a.supplierId)) || (await this.evaluatedBelowPassMark(ev, a.supplierId));
          if (failed) throw new BadRequestException(`Line ${a.lineNo}: ${quote.supplierName} did not pass the technical evaluation`);
          if (ev.recommendedSupplierId && !ev.recommendedSupplierId.equals(a.supplierId) && reason.length < 3) {
            throw new BadRequestException(`Line ${a.lineNo}: ${quote.supplierName} is not the committee's recommendation; give the reason`);
          }
        } else if (line.cheapestSupplierId && !line.cheapestSupplierId.equals(a.supplierId) && reason.length < 3) {
          throw new BadRequestException(`Line ${a.lineNo}: ${quote.supplierName} is not the cheapest quote; give the reason for choosing it`);
        }
        awards.push({ lineNo: a.lineNo, supplierId: a.supplierId, unitPrice: quote.unitPrice, reason });
      }
      const bySupplier = new Map<string, typeof awards>();
      for (const a of awards) bySupplier.set(a.supplierId.toHexString(), [...(bySupplier.get(a.supplierId.toHexString()) ?? []), a]);
      const orderIds = new Map<string, Types.ObjectId>();
      for (const [supplierId, list] of bySupplier) {
        const po = await this.procurement.createOrderIn(
          user,
          {
            entityId: rfq.entityId,
            branchId: rfq.branchId,
            supplierId: new Types.ObjectId(supplierId),
            date: input.date,
            reference: rfq.number,
            notes: rfq.title,
            deliveryAddress: rfq.deliveryAddress,
            requisitionId: rfq.requisitionId,
            lines: list.map((a) => {
              const l = rfq.lines.find((x) => x.lineNo === a.lineNo)!;
              return { description: l.description, accountId: l.accountId!, quantity: dec(l.quantity), unitPrice: a.unitPrice, taxCodeId: l.taxCodeId, itemId: l.itemId, warehouseId: l.warehouseId };
            }),
          },
          session,
          rfq.number,
        );
        orderIds.set(supplierId, po._id);
      }
      await this.db.rfqs.updateOne(
        { _id: id },
        { status: 'AWARDED', awardedBy: user.id, awardedAt: new Date(), awards: awards.map((a) => ({ ...a, unitPrice: toD128(a.unitPrice), purchaseOrderId: orderIds.get(a.supplierId.toHexString()) ?? null })) },
        { session },
      );
      const overrides = awards.filter((a) => a.reason);
      await this.audit.log(
        user,
        { action: 'rfq.award', recordType: 'RequestForQuote', recordId: id, summary: `Awarded ${rfq.number}: ${awards.length} line(s), ${orderIds.size} purchase order(s)${overrides.length ? `; not the cheapest on ${overrides.map((o) => `line ${o.lineNo} (${o.reason})`).join(', ')}` : ''}` },
        session,
      );
      return this.db.rfqs.findById(id).session(session).lean();
    });
  }
}
