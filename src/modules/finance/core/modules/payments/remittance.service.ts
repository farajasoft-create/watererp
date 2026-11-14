import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { dec } from '../../common/money';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { renderTemplate } from '../communication/email-templates';
import { EmailService, layout } from '../communication/email.service';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (v: unknown) => dec(v as string).toNumber().toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Remittance advice: once a supplier payment is posted the supplier is emailed what was paid, how and
 * when, which of their invoices it settles, and the tax withheld. Sent automatically on posting and can
 * be sent again (to another address too) from the payment.
 */
export class RemittanceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  /** Builds and queues the advice; `auto` skips quietly where there is nobody to send to. */
  async send(user: AuthUser, paymentId: Types.ObjectId, opts: { to?: string; auto?: boolean } = {}) {
    const p = await this.db.payments.findOne({ _id: paymentId, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Payment not found');
    if (p.kind !== 'PAYMENT' || p.partyType !== 'SUPPLIER') {
      if (opts.auto) return null;
      throw new BadRequestException('Remittance advice is for payments to suppliers');
    }
    if (p.status !== 'POSTED') {
      if (opts.auto) return null;
      throw new BadRequestException('Only a posted payment has a remittance advice');
    }
    const supplier = await this.db.suppliers.findOne({ _id: p.partyId, organisationId: user.organisationId }, { name: 1, email: 1 }).lean();
    const to = opts.to ?? supplier?.email ?? '';
    if (!to) {
      if (opts.auto) return null;
      throw new BadRequestException(`${p.partyName} has no email address; give one`);
    }
    const [entity, bank, allocations, invoices] = await Promise.all([
      this.db.entities.findById(p.entityId, { name: 1 }).lean(),
      this.db.bankAccounts.findById(p.bankAccountId, { name: 1 }).lean(),
      this.db.allocations.find({ organisationId: user.organisationId, sourceId: p._id, status: 'ACTIVE' }).sort({ date: 1 }).lean(),
      this.db.invoices.find({ organisationId: user.organisationId, _id: { $in: p.plannedAllocations.map((a) => a.documentId) } }, { number: 1, supplierInvoiceNumber: 1 }).lean(),
    ]);
    const theirRef = (id: Types.ObjectId) => invoices.find((i) => i._id.equals(id))?.supplierInvoiceNumber || '';
    const docs = await this.db.invoices.find({ _id: { $in: allocations.map((a) => a.documentId) } }, { supplierInvoiceNumber: 1 }).lean();
    const ref = (id: Types.ObjectId) => docs.find((d) => d._id.equals(id))?.supplierInvoiceNumber || theirRef(id);
    const date = p.date.toISOString().slice(0, 10);
    const withheld = dec(p.withholdingAmount);
    const rows = allocations.map((a) => `<tr><td style="padding:4px 8px">${esc(ref(a.documentId) || a.documentNumber)}</td><td style="padding:4px 8px">${esc(a.documentNumber)}</td><td style="padding:4px 8px;text-align:right">${money(a.amount)}</td></tr>`).join('');
    const t = await renderTemplate(this.db, user.organisationId, 'remittance', { organisation: entity?.name ?? '', supplier: supplier?.name ?? p.partyName, number: p.number, currency: p.currency, amount: money(p.amount), date, method: p.method.replace(/_/g, ' ').toLowerCase(), reference: p.reference ? ` (reference ${p.reference})` : '' });
    const title = t.subject;
    const intro = t.intro;
    const lines = [
      ...t.paragraphs,
      ...(bank ? [`Paid from our ${bank.name} account.`] : []),
      ...(withheld.gt(0) ? [`Tax of ${p.currency} ${money(withheld)} was withheld and paid to KRA on your behalf; the withholding certificate follows from iTax.`] : []),
    ];
    const table = allocations.length ? `<table style="border-collapse:collapse;font-size:14px;margin-top:8px"><thead><tr><th style="padding:4px 8px;text-align:left">Your invoice</th><th style="padding:4px 8px;text-align:left">Our reference</th><th style="padding:4px 8px;text-align:right">Settled (${p.currency})</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>This payment is held on account against future invoices.</p>';
    const mail = layout({ title, intro, paragraphs: lines, html: table, footer: t.footer });
    const text = [intro, ...lines, ...allocations.map((a) => `${ref(a.documentId) || a.documentNumber} (${a.documentNumber}): ${money(a.amount)}`)].join('\n');
    const id = await this.email.enqueue({ organisationId: user.organisationId, to: [to], subject: title, html: mail.html, text, category: 'procurement', related: { type: 'Payment', id: p._id } });
    if (!id) {
      if (opts.auto) return null;
      throw new BadRequestException('That email address is not valid');
    }
    await this.db.payments.updateOne({ _id: p._id }, { $set: { remittanceSentAt: new Date(), remittanceSentTo: to } });
    await this.audit.log(user, { action: 'payment.remittance', recordType: 'Payment', recordId: p._id, summary: `Sent remittance advice for ${p.number} to ${to}` });
    return { sentTo: to, number: p.number };
  }
}
