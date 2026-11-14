import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { openPortal } from '@/platform/common/branding';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec } from '../../common/money';
import { PERMISSIONS as P } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { appUrl } from '../communication/email.service';

type Id = Types.ObjectId;
const LINK_DAYS = 180;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const money = (v: unknown) => dec((v as { toString(): string } | null | undefined)?.toString() ?? '0');

/**
 * The vendor portal: a private link per supplier (no account to manage) to follow their purchase
 * orders, the invoices entered for them and what is still owed, the payments made (with what each
 * settled and the tax withheld), and to send in a new invoice for accounts payable to enter. Links are
 * stored only as hashes, expire, and can be revoked.
 */
export class SupplierPortalService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ----- Staff side -----------------------------------------------------------------------------

  private canManage(user: AuthUser) {
    if (!hasPermission(user, P.AP_MANAGE) && !hasPermission(user, P.PROCUREMENT_MANAGE)) throw new ForbiddenException('Missing permission: ap.manage');
  }

  private async supplier(user: AuthUser, id: Id) {
    const s = await this.db.suppliers.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!s) throw new NotFoundException('Supplier not found');
    return s;
  }

  async createLink(user: AuthUser, supplierId: Id, days = LINK_DAYS) {
    this.canManage(user);
    const s = await this.supplier(user, supplierId);
    const token = randomBytes(24).toString('base64url');
    const [link] = await this.db.supplierPortalLinks.create([{ organisationId: user.organisationId, supplierId, tokenHash: hash(token), expiresAt: new Date(Date.now() + days * 86_400_000), createdBy: user.id }]);
    await this.audit.log(user, { action: 'supplier_portal.link', recordType: 'Supplier', recordId: s._id, summary: `Created a vendor portal link for ${s.name}, valid for ${days} days` });
    return { id: link._id, url: `${appUrl()}/vendors/${token}`, expiresAt: link.expiresAt };
  }

  async links(user: AuthUser, supplierId: Id) {
    if (!hasPermission(user, P.AP_VIEW) && !hasPermission(user, P.PROCUREMENT_MANAGE)) throw new ForbiddenException('Missing permission: ap.view');
    await this.supplier(user, supplierId);
    const now = new Date();
    const rows = await this.db.supplierPortalLinks.find({ organisationId: user.organisationId, supplierId }, { tokenHash: 0 }).sort({ createdAt: -1 }).limit(50).lean();
    return rows.map((r) => ({ ...r, active: !r.revokedAt && r.expiresAt > now }));
  }

  async revoke(user: AuthUser, linkId: Id) {
    this.canManage(user);
    const link = await this.db.supplierPortalLinks.findOneAndUpdate({ _id: linkId, organisationId: user.organisationId, revokedAt: null }, { revokedAt: new Date() }, { new: true, projection: { tokenHash: 0 } }).lean();
    if (!link) throw new NotFoundException('Active link not found');
    await this.audit.log(user, { action: 'supplier_portal.revoke', recordType: 'Supplier', recordId: link.supplierId, summary: 'Revoked a vendor portal link' });
    return link;
  }

  /** Invoices suppliers sent through the portal, for accounts payable to enter or turn back. */
  async submissions(user: AuthUser, status?: string) {
    if (!hasPermission(user, P.AP_VIEW)) throw new ForbiddenException('Missing permission: ap.view');
    const rows = await this.db.supplierInvoiceSubmissions.find({ organisationId: user.organisationId, ...(status && { status }) }).sort({ createdAt: -1 }).limit(300).lean();
    const [suppliers, orders] = await Promise.all([
      this.db.suppliers.find({ _id: { $in: rows.map((r) => r.supplierId) } }, { name: 1 }).lean(),
      this.db.purchaseOrders.find({ _id: { $in: rows.map((r) => r.purchaseOrderId).filter(Boolean) } }, { number: 1 }).lean(),
    ]);
    return rows.map((r) => ({ ...r, supplier: suppliers.find((s) => s._id.equals(r.supplierId))?.name ?? '', purchaseOrder: orders.find((o) => r.purchaseOrderId && o._id.equals(r.purchaseOrderId))?.number ?? null }));
  }

  async decide(user: AuthUser, id: Id, input: { status: 'ENTERED' | 'REJECTED'; billId?: Id | null; reason?: string }) {
    if (!hasPermission(user, P.AP_MANAGE)) throw new ForbiddenException('Missing permission: ap.manage');
    if (input.status === 'REJECTED' && !input.reason?.trim()) throw new BadRequestException('Say why the invoice is turned back; the supplier sees it');
    if (input.billId && !(await this.db.invoices.exists({ _id: input.billId, organisationId: user.organisationId, kind: 'PURCHASE_BILL' }))) throw new BadRequestException('Bill not found');
    const doc = await this.db.supplierInvoiceSubmissions.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: 'SUBMITTED' }, { status: input.status, billId: input.billId ?? null, reason: input.reason ?? '', decidedBy: user.id, decidedAt: new Date() }, { new: true }).lean();
    if (!doc) throw new NotFoundException('Invoice waiting for entry not found');
    await this.audit.log(user, { action: `supplier_portal.${input.status.toLowerCase()}`, recordType: 'Supplier', recordId: doc.supplierId, summary: `${input.status === 'ENTERED' ? 'Entered' : 'Turned back'} supplier invoice ${doc.invoiceNumber}${input.reason ? `: ${input.reason}` : ''}` });
    return doc;
  }

  // ----- Supplier side (the token is the authority) -----------------------------------------------

  private async link(token: string) {
    if (!token || token.length < 20) throw new NotFoundException('This link is not valid');
    const link = await this.db.supplierPortalLinks.findOne({ tokenHash: hash(token) }).lean();
    if (!link || link.revokedAt || link.expiresAt < new Date()) throw new NotFoundException('This link has expired or was withdrawn; ask for a new one');
    await openPortal(this.db.connection, link.organisationId, 'vendors');
    return link;
  }

  async view(token: string) {
    const link = await this.link(token);
    const org = link.organisationId;
    await this.db.supplierPortalLinks.updateOne({ _id: link._id }, { lastViewedAt: new Date(), $inc: { views: 1 } });
    const [supplier, organisation, orders, bills, payments, submissions] = await Promise.all([
      this.db.suppliers.findById(link.supplierId, { name: 1, code: 1, email: 1, taxId: 1 }).lean(),
      this.db.organisations.findById(org, { name: 1 }).lean(),
      this.db.purchaseOrders.find({ organisationId: org, supplierId: link.supplierId, status: { $nin: ['DRAFT', 'PENDING_APPROVAL', 'REJECTED'] } }, { number: 1, date: 1, expectedDate: 1, status: 1, currency: 1, total: 1, lines: 1, reference: 1 }).sort({ date: -1 }).limit(100).lean(),
      this.db.invoices.find({ organisationId: org, partyId: link.supplierId, kind: { $in: ['PURCHASE_BILL', 'PURCHASE_CREDIT'] }, status: 'POSTED' }, { kind: 1, number: 1, supplierInvoiceNumber: 1, date: 1, dueDate: 1, currency: 1, total: 1, amountDue: 1, paymentStatus: 1, purchaseOrderId: 1 }).sort({ date: -1 }).limit(200).lean(),
      this.db.payments.find({ organisationId: org, partyId: link.supplierId, kind: 'PAYMENT', status: 'POSTED' }, { number: 1, date: 1, method: 1, reference: 1, currency: 1, amount: 1, withholdingAmount: 1 }).sort({ date: -1 }).limit(100).lean(),
      this.db.supplierInvoiceSubmissions.find({ organisationId: org, supplierId: link.supplierId }).sort({ createdAt: -1 }).limit(100).lean(),
    ]);
    const allocations = await this.db.allocations.find({ organisationId: org, sourceId: { $in: payments.map((p) => p._id) }, status: { $ne: 'REVERSED' } }, { sourceId: 1, documentNumber: 1, amount: 1 }).lean();
    const owed = bills.reduce((t, b) => (b.kind === 'PURCHASE_CREDIT' ? t.minus(money(b.amountDue)) : t.plus(money(b.amountDue))), new Decimal(0));
    const now = new Date();
    return {
      organisation: organisation?.name ?? '',
      branding: await openPortal(this.db.connection, org, 'vendors'),
      supplier: { name: supplier?.name ?? '', code: supplier?.code ?? '' },
      expiresAt: link.expiresAt,
      summary: { owed, overdue: bills.filter((b) => b.kind === 'PURCHASE_BILL' && money(b.amountDue).gt(0) && b.dueDate && b.dueDate < now).reduce((t, b) => t.plus(money(b.amountDue)), new Decimal(0)), openOrders: orders.filter((o) => !['CLOSED', 'CANCELLED', 'RECEIVED'].includes(String(o.status))).length },
      orders: orders.map((o) => ({ id: o._id, number: o.number, date: o.date, expectedDate: o.expectedDate, status: o.status, currency: o.currency, total: o.total, reference: o.reference, lines: (o.lines ?? []).map((l: { description?: string; quantity?: unknown; receivedQuantity?: unknown; unitPrice?: unknown }) => ({ description: l.description, quantity: l.quantity, received: l.receivedQuantity ?? 0, unitPrice: l.unitPrice })) })),
      invoices: bills.map((b) => ({ id: b._id, kind: b.kind, number: b.number, supplierInvoiceNumber: b.supplierInvoiceNumber, date: b.date, dueDate: b.dueDate, currency: b.currency, total: b.total, amountDue: b.amountDue, paymentStatus: b.paymentStatus, overdue: b.kind === 'PURCHASE_BILL' && money(b.amountDue).gt(0) && Boolean(b.dueDate && b.dueDate < now) })),
      payments: payments.map((p) => ({ id: p._id, number: p.number, date: p.date, method: p.method, reference: p.reference, currency: p.currency, amount: p.amount, withholding: p.withholdingAmount, settled: allocations.filter((a) => a.sourceId.equals(p._id)).map((a) => ({ document: a.documentNumber, amount: a.amount })) })),
      submissions: submissions.map((x) => ({ id: x._id, invoiceNumber: x.invoiceNumber, invoiceDate: x.invoiceDate, amount: x.amount, currency: x.currency, status: x.status, reason: x.reason, submittedAt: x.createdAt })),
    };
  }

  /** The supplier sends an invoice; accounts payable enters it as a bill (matched to the order and GRN). */
  async submitInvoice(token: string, input: { invoiceNumber: string; invoiceDate: Date; amount: Decimal; purchaseOrderId?: Id | null; etimsNumber?: string; note?: string }) {
    const link = await this.link(token);
    if (input.amount.lte(0)) throw new BadRequestException('Enter the invoice amount');
    if (input.invoiceDate > new Date(Date.now() + 86_400_000)) throw new BadRequestException('The invoice date is in the future');
    let currency = 'KES';
    if (input.purchaseOrderId) {
      const po = await this.db.purchaseOrders.findOne({ _id: input.purchaseOrderId, organisationId: link.organisationId, supplierId: link.supplierId }).lean();
      if (!po) throw new BadRequestException('That order is not yours');
      currency = String(po.currency ?? 'KES');
      if (input.amount.gt(money(po.total))) throw new BadRequestException(`The invoice is more than order ${po.number} (${money(po.total).toFixed(2)})`);
    }
    try {
      const [doc] = await this.db.supplierInvoiceSubmissions.create([{ organisationId: link.organisationId, supplierId: link.supplierId, purchaseOrderId: input.purchaseOrderId ?? null, invoiceNumber: input.invoiceNumber.trim(), invoiceDate: input.invoiceDate, amount: Types.Decimal128.fromString(input.amount.toFixed(2)), currency, etimsNumber: input.etimsNumber ?? '', note: input.note ?? '' }]);
      return { id: doc._id, status: doc.status };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new ConflictException(`Invoice ${input.invoiceNumber} was already sent`);
      throw err;
    }
  }
}
