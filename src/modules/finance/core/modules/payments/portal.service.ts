import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec } from '../../common/money';
import { PERMISSIONS as P } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { PortalLink } from '../../database/payments.schemas';
import { AuditService } from '../audit/audit.service';
import { appUrl, EmailService, escapeHtml, layout } from '../communication/email.service';
import { BillingService } from './billing.service';
import { normaliseMsisdn, SmsService } from '../communication/sms.service';
import { CardPaymentsService } from './cards.service';
import { MpesaService } from './mpesa.service';

const LINK_DAYS = 90;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The customer portal: a private link per customer (no sign-in) to see open invoices, download them
 * and pay by M-Pesa. Links are stored only as hashes, expire, and can be revoked.
 */
export class PortalService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly billing: BillingService,
    private readonly mpesa: MpesaService,
    private readonly sms: SmsService,
    private readonly cards: CardPaymentsService,
  ) {}

  // ----- Staff side -----------------------------------------------------------------------------

  private async customer(user: AuthUser, customerId: Types.ObjectId) {
    const customer = await this.db.customers.findOne({ _id: customerId, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async createLink(user: AuthUser, customerId: Types.ObjectId, entityId: Types.ObjectId, days = LINK_DAYS) {
    if (!hasPermission(user, P.AR_MANAGE)) throw new ForbiddenException('Missing permission: ar.manage');
    const customer = await this.customer(user, customerId);
    if (!(await this.db.entities.exists({ _id: entityId, organisationId: user.organisationId }))) throw new BadRequestException('Entity not found');
    const token = randomBytes(24).toString('base64url');
    const [link] = await this.db.portalLinks.create([{ organisationId: user.organisationId, entityId, customerId, tokenHash: hash(token), expiresAt: new Date(Date.now() + days * 86_400_000), createdBy: user.id }]);
    await this.audit.log(user, { action: 'portal.link', recordType: 'Customer', recordId: customer._id, summary: `Created a customer portal link for ${customer.name}, valid for ${days} days` });
    return { id: link._id, url: `${appUrl()}/finance/portal/${token}`, expiresAt: link.expiresAt };
  }

  async links(user: AuthUser, customerId: Types.ObjectId) {
    if (!hasPermission(user, P.AR_VIEW)) throw new ForbiddenException('Missing permission: ar.view');
    await this.customer(user, customerId);
    const rows = await this.db.portalLinks.find({ organisationId: user.organisationId, customerId }, { tokenHash: 0 }).sort({ createdAt: -1 }).limit(50).lean();
    const users = await this.db.users.find({ _id: { $in: rows.map((r) => r.createdBy) } }, { name: 1 }).lean();
    const now = new Date();
    return rows.map((r) => ({ ...r, createdByName: users.find((u) => u._id.equals(r.createdBy))?.name ?? null, active: !r.revokedAt && r.expiresAt > now }));
  }

  async revoke(user: AuthUser, linkId: Types.ObjectId) {
    if (!hasPermission(user, P.AR_MANAGE)) throw new ForbiddenException('Missing permission: ar.manage');
    const link = await this.db.portalLinks.findOneAndUpdate({ _id: linkId, organisationId: user.organisationId, revokedAt: null }, { revokedAt: new Date() }, { new: true, projection: { tokenHash: 0 } }).lean();
    if (!link) throw new NotFoundException('Active link not found');
    await this.audit.log(user, { action: 'portal.revoke', recordType: 'Customer', recordId: link.customerId, summary: 'Revoked a customer portal link' });
    return link;
  }

  /** Emails a posted invoice or credit note to the customer, with a link to view and pay it online. */
  async emailDocument(user: AuthUser, id: Types.ObjectId, input: { to?: string[]; message?: string }) {
    if (!hasPermission(user, P.AR_MANAGE)) throw new ForbiddenException('Missing permission: ar.manage');
    const doc = await this.db.invoices.findOne({ _id: id, organisationId: user.organisationId, kind: { $in: ['SALES_INVOICE', 'SALES_CREDIT'] } }).lean();
    if (!doc) throw new NotFoundException('Invoice not found');
    assertBranchAccess(user, [doc.branchId]);
    if (doc.status !== 'POSTED') throw new BadRequestException('Only posted documents can be sent to the customer');
    const customer = await this.customer(user, doc.partyId);
    const to = input.to?.length ? input.to : customer.email.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
    if (!to.length) throw new BadRequestException(`${customer.name} has no email address; add one to the customer or enter it here`);
    const view = await this.billing.view(user.organisationId, doc._id);
    const link = await this.createLink(user, customer._id, doc.entityId);
    const url = `${link.url}/invoices/${doc._id.toHexString()}`;
    const credit = doc.kind === 'SALES_CREDIT';
    const dueLine = credit ? `Credit note ${view.number} for ${view.currency} ${view.total}${view.appliesTo ? `, against invoice ${view.appliesTo}` : ''}.` : `Invoice ${view.number} for ${view.currency} ${view.total}, due ${doc.dueDate.toISOString().slice(0, 10)}. Amount due: ${view.currency} ${view.amountDue}.`;
    const paragraphs = [dueLine, ...(input.message ? [input.message] : [])];
    if (!credit && view.mpesa) paragraphs.push(view.mpesa.type === 'TILL' ? `Pay by M-Pesa Buy Goods, till ${view.mpesa.shortCode}, or online from the link below.` : `Pay by M-Pesa paybill ${view.mpesa.shortCode}, account ${view.mpesa.accountNumber}, or online from the link below.`);
    const table = `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:6px 0 14px;font-size:13px;border-collapse:collapse">${view.lines
      .slice(0, 15)
      .map((l) => `<tr><td style="padding:5px 0;border-bottom:1px solid #eeeef4">${escapeHtml(l.description)}</td><td style="padding:5px 0;border-bottom:1px solid #eeeef4;text-align:right;white-space:nowrap">${escapeHtml(l.total)}</td></tr>`)
      .join('')}<tr><td style="padding:7px 0;font-weight:700">Total ${escapeHtml(view.currency)}</td><td style="padding:7px 0;text-align:right;font-weight:700">${escapeHtml(view.total)}</td></tr></table>`;
    const body = layout({
      title: `${view.title} ${view.number} from ${view.seller.name}`,
      intro: `Dear ${customer.name},`,
      paragraphs,
      html: table,
      action: { label: credit ? 'View credit note' : 'View and pay invoice', url },
      footer: `Sent by ${view.seller.name}${view.seller.email ? ` (${view.seller.email})` : ''} using FarajaSoft. The link above is private to your account; it expires in ${LINK_DAYS} days.`,
    });
    const replyTo = view.seller.email || user.email;
    const pdf = await this.billing.pdf(user.organisationId, doc._id);
    await this.email.enqueue({ organisationId: user.organisationId, to, replyTo, subject: `${view.title} ${view.number} from ${view.seller.name}`, ...body, category: 'invoice', related: { type: 'Invoice', id: doc._id }, attachments: [{ filename: pdf.filename, contentType: 'application/pdf', content: pdf.data }] });
    await this.db.invoices.updateOne({ _id: doc._id }, { emailedAt: new Date() });
    await this.audit.log(user, { action: 'invoice.email', recordType: 'Invoice', recordId: doc._id, summary: `Emailed ${doc.number} to ${to.join(', ')}` });
    return { to, emailedAt: new Date() };
  }

  /** Texts the customer a short note with a link to view and pay the document. */
  async smsDocument(user: AuthUser, id: Types.ObjectId, input: { to?: string }) {
    if (!hasPermission(user, P.AR_MANAGE)) throw new ForbiddenException('Missing permission: ar.manage');
    const doc = await this.db.invoices.findOne({ _id: id, organisationId: user.organisationId, kind: { $in: ['SALES_INVOICE', 'SALES_CREDIT'] } }).lean();
    if (!doc) throw new NotFoundException('Invoice not found');
    assertBranchAccess(user, [doc.branchId]);
    if (doc.status !== 'POSTED') throw new BadRequestException('Only posted documents can be sent to the customer');
    const customer = await this.customer(user, doc.partyId);
    const to = input.to || customer.phone;
    if (!to) throw new BadRequestException(`${customer.name} has no phone number; add one to the customer or enter it here`);
    const settings = await this.sms.settings(user.organisationId);
    if (!settings.enabled) throw new BadRequestException('Text messages are turned off; an administrator can turn them on in Organisation settings');
    if (!normaliseMsisdn(to)) throw new BadRequestException('Enter a mobile number such as 0712 345 678 or +256 772 123 456');
    const view = await this.billing.view(user.organisationId, doc._id);
    const link = await this.createLink(user, customer._id, doc.entityId);
    const url = `${link.url}/invoices/${doc._id.toHexString()}`;
    const message =
      doc.kind === 'SALES_CREDIT'
        ? `${view.seller.name}: credit note ${view.number} for ${view.currency} ${view.total}. View: ${url}`
        : `${view.seller.name}: invoice ${view.number} for ${view.currency} ${view.total}, due ${doc.dueDate.toISOString().slice(0, 10)}. View and pay: ${url}`;
    await this.sms.enqueue({ organisationId: user.organisationId, to, message, category: 'invoice', related: { type: 'Invoice', id: doc._id } });
    await this.audit.log(user, { action: 'invoice.sms', recordType: 'Invoice', recordId: doc._id, summary: `Texted ${doc.number} to ${to}` });
    return { to };
  }

  // ----- Customer side (the token is the authority) ---------------------------------------------

  private async resolve(token: string, touch = false): Promise<PortalLink> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('This link is not valid');
    const link = await this.db.portalLinks.findOne({ tokenHash: hash(token) }).lean();
    if (!link || link.revokedAt) throw new NotFoundException('This link is not valid; ask for a new one');
    if (link.expiresAt < new Date()) throw new NotFoundException('This link has expired; ask for a new one');
    if (touch) await this.db.portalLinks.updateOne({ _id: link._id }, { lastViewedAt: new Date(), $inc: { views: 1 } });
    return link;
  }

  /** What the customer sees: who is billing them, what is open, and what was settled recently. */
  async view(token: string) {
    const link = await this.resolve(token, true);
    const [org, entity, customer, open, recent, mpesa] = await Promise.all([
      this.db.organisations.findById(link.organisationId, { name: 1 }).lean(),
      this.db.entities.findById(link.entityId, { name: 1, legalName: 1, email: 1, phone: 1, paymentInstructions: 1 }).lean(),
      this.db.customers.findById(link.customerId, { name: 1, code: 1, currency: 1, isActive: 1 }).lean(),
      this.db.invoices
        .find({ organisationId: link.organisationId, entityId: link.entityId, partyId: link.customerId, kind: 'SALES_INVOICE', status: 'POSTED', paymentStatus: { $ne: 'PAID' } }, { number: 1, date: 1, dueDate: 1, currency: 1, total: 1, amountDue: 1, reference: 1 })
        .sort({ dueDate: 1 })
        .limit(200)
        .lean(),
      this.db.invoices
        .find({ organisationId: link.organisationId, entityId: link.entityId, partyId: link.customerId, kind: { $in: ['SALES_INVOICE', 'SALES_CREDIT'] }, status: 'POSTED', $or: [{ paymentStatus: 'PAID' }, { kind: 'SALES_CREDIT' }] }, { number: 1, kind: 1, date: 1, currency: 1, total: 1 })
        .sort({ date: -1 })
        .limit(20)
        .lean(),
      this.mpesa.collectingAccount(link.organisationId, link.entityId),
    ]);
    const cardCurrencies = new Set((await this.db.bankAccounts.find({ organisationId: link.organisationId, entityId: link.entityId, isActive: true, 'card.enabled': true }, { currency: 1 }).lean()).map((b) => b.currency));
    if (!customer) throw new NotFoundException('This link is not valid');
    const today = new Date();
    const balances = new Map<string, Decimal>();
    for (const i of open) balances.set(i.currency, (balances.get(i.currency) ?? new Decimal(0)).plus(dec(i.amountDue)));
    return {
      organisation: org?.name ?? '',
      seller: { name: entity?.legalName || entity?.name || '', email: entity?.email ?? '', phone: entity?.phone ?? '', paymentInstructions: entity?.paymentInstructions ?? '' },
      customer: { name: customer.name, code: customer.code },
      expiresAt: link.expiresAt,
      mpesa: mpesa ? { available: true, shortCode: mpesa.mpesa!.shortCode, type: mpesa.mpesa!.shortCodeType } : { available: false },
      card: { available: cardCurrencies.size > 0, currencies: [...cardCurrencies] },
      balances: [...balances.entries()].map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) })),
      open: open.map((i) => ({
        id: i._id,
        number: i.number,
        reference: i.reference,
        date: i.date,
        dueDate: i.dueDate,
        overdue: i.dueDate < today,
        currency: i.currency,
        total: dec(i.total).toFixed(2),
        amountDue: dec(i.amountDue).toFixed(2),
        payable: !!mpesa && i.currency === 'KES',
        cardPayable: cardCurrencies.has(i.currency),
      })),
      history: recent.map((i) => ({ id: i._id, number: i.number, kind: i.kind, date: i.date, currency: i.currency, total: dec(i.total).toFixed(2) })),
    };
  }

  private async ownInvoice(link: PortalLink, invoiceId: Types.ObjectId) {
    const doc = await this.db.invoices.findOne({ _id: invoiceId, organisationId: link.organisationId, entityId: link.entityId, partyId: link.customerId, kind: { $in: ['SALES_INVOICE', 'SALES_CREDIT'] }, status: 'POSTED' }, { _id: 1 }).lean();
    if (!doc) throw new NotFoundException('Invoice not found');
    return doc;
  }

  async document(token: string, invoiceId: Types.ObjectId) {
    const link = await this.resolve(token);
    await this.ownInvoice(link, invoiceId);
    return this.billing.render(await this.billing.view(link.organisationId, invoiceId), { payUrl: `${appUrl()}/finance/portal/${token}?pay=${invoiceId.toHexString()}` });
  }

  async pdf(token: string, invoiceId: Types.ObjectId) {
    const link = await this.resolve(token);
    await this.ownInvoice(link, invoiceId);
    return this.billing.pdf(link.organisationId, invoiceId);
  }

  async pay(token: string, invoiceId: Types.ObjectId, input: { phone: string; amount?: Decimal | null }) {
    const link = await this.resolve(token);
    await this.ownInvoice(link, invoiceId);
    return this.mpesa.requestPayment({ organisationId: link.organisationId, invoiceId, phone: input.phone, amount: input.amount ?? null, via: 'portal' });
  }

  /** Starts a card payment (hosted checkout); returns the page to send the customer to. */
  async payByCard(token: string, invoiceId: Types.ObjectId, amount: Decimal | null) {
    const link = await this.resolve(token);
    await this.ownInvoice(link, invoiceId);
    return this.cards.start({ organisationId: link.organisationId, entityId: link.entityId, customerId: link.customerId, invoiceId, amount, portalLinkId: link._id, returnUrl: `${appUrl()}/finance/portal/${token}` });
  }

  async payStatus(token: string, paymentId: Types.ObjectId) {
    const link = await this.resolve(token);
    await this.mpesa.queryPending({ organisationId: link.organisationId, id: paymentId });
    await this.mpesa.expireStale(link.organisationId);
    const tx = await this.db.mobileMoney.findOne({ _id: paymentId, organisationId: link.organisationId, customerId: link.customerId }, { status: 1, resultDescription: 1, transactionId: 1, amount: 1 }).lean();
    if (!tx) throw new NotFoundException('Payment not found');
    const status = tx.status === 'PENDING' ? 'PENDING' : tx.status === 'FAILED' ? 'FAILED' : 'PAID';
    return { status, message: status === 'FAILED' ? tx.resultDescription || 'The payment was not completed' : status === 'PAID' ? `Payment received, M-Pesa reference ${tx.transactionId}` : 'Waiting for you to enter your M-Pesa PIN', amount: tx.amount ? dec(tx.amount).toFixed(2) : null };
  }
}
