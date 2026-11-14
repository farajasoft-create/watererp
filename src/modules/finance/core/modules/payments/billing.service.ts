import { Types } from 'mongoose';
import QRCode from 'qrcode';
import { renderInvoicePdf } from './invoice-pdf';
import { assertBranchAccess } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, DecimalInput } from '../../common/money';
import { PERMISSIONS as P } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { escapeHtml } from '../communication/email.service';

export interface InvoiceView {
  id: Types.ObjectId;
  kind: 'SALES_INVOICE' | 'SALES_CREDIT';
  title: string;
  number: string;
  status: string;
  date: Date;
  dueDate: Date;
  reference: string;
  currency: string;
  priceIncludesTax: boolean;
  notes: string;
  appliesTo: string | null;
  seller: { name: string; legalName: string; address: string; phone: string; email: string; website: string; taxId: string; registrationNumber: string; branch: string };
  customer: { id: Types.ObjectId; code: string; name: string; legalName: string; address: string; city: string; country: string; email: string; phone: string; taxId: string };
  lines: { description: string; quantity: string; unitPrice: string; discountPercent: string | null; taxRate: string; netAmount: string; taxAmount: string; total: string }[];
  taxSummary: { rate: string; net: string; tax: string }[];
  subtotal: string;
  taxTotal: string;
  total: string;
  paid: string;
  amountDue: string;
  paymentStatus: string;
  paymentInstructions: string;
  mpesa: { shortCode: string; type: 'PAYBILL' | 'TILL'; accountNumber: string } | null;
  /** KRA eTIMS registration, when the branch reports to KRA. */
  etims: { status: string; cuInvoiceNumber: string | null; receiptNumber: string | null; internalData: string | null; signature: string | null; dateTime: string | null; qrSvg: string | null; qrUrl: string | null } | null;
}

const fmt = (v: DecimalInput, places = 2) => {
  const d = dec(v);
  const [i, f] = d.abs().toFixed(places).split('.');
  return `${d.isNeg() ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
};
async function etimsBlock(e: { status?: string | null; invcNo?: number | null; curRcptNo?: number | null; totRcptNo?: number | null; intrlData?: string | null; rcptSign?: string | null; sdcId?: string | null; sdcDateTime?: string | null; qrUrl?: string | null }) {
  const t = e.sdcDateTime ?? '';
  return {
    status: e.status ?? 'PENDING',
    cuInvoiceNumber: e.invcNo != null ? `${e.sdcId ? `${e.sdcId}/` : ''}${e.invcNo}` : null,
    receiptNumber: e.curRcptNo != null ? `${e.curRcptNo}/${e.totRcptNo ?? ''}` : null,
    internalData: e.intrlData ?? null,
    signature: e.rcptSign ?? null,
    dateTime: /^\d{14}$/.test(t) ? `${t.slice(6, 8)}/${t.slice(4, 6)}/${t.slice(0, 4)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}` : t || null,
    qrSvg: e.qrUrl ? await QRCode.toString(e.qrUrl, { type: 'svg', margin: 0, width: 96, errorCorrectionLevel: 'M' }) : null,
    qrUrl: e.qrUrl ?? null,
  };
}

const day = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Customer-facing invoices and credit notes: one model, rendered for print, email and the customer portal. */
export class BillingService {
  constructor(private readonly db: Db) {}

  /** Loads a sales document the user may see. */
  async authorise(user: AuthUser, id: Types.ObjectId) {
    if (!hasPermission(user, P.AR_VIEW)) throw new ForbiddenException('Missing permission: ar.view');
    const doc = await this.db.invoices.findOne({ _id: id, organisationId: user.organisationId, kind: { $in: ['SALES_INVOICE', 'SALES_CREDIT'] } }, { branchId: 1 }).lean();
    if (!doc) throw new NotFoundException('Invoice not found');
    assertBranchAccess(user, [doc.branchId]);
    return doc;
  }

  async view(organisationId: Types.ObjectId, id: Types.ObjectId): Promise<InvoiceView> {
    const doc = await this.db.invoices.findOne({ _id: id, organisationId, kind: { $in: ['SALES_INVOICE', 'SALES_CREDIT'] } }).lean();
    if (!doc) throw new NotFoundException('Invoice not found');
    const [entity, branch, customer, appliesTo, mpesa] = await Promise.all([
      this.db.entities.findById(doc.entityId).lean(),
      this.db.branches.findById(doc.branchId).lean(),
      this.db.customers.findById(doc.partyId).lean(),
      doc.appliesToId ? this.db.invoices.findById(doc.appliesToId, { number: 1 }).lean() : null,
      doc.currency === 'KES' ? this.db.bankAccounts.findOne({ organisationId, entityId: doc.entityId, isActive: true, type: 'MOBILE_MONEY', 'mpesa.enabled': true }, { 'mpesa.shortCode': 1, 'mpesa.shortCodeType': 1 }).lean() : null,
    ]);
    const lines = doc.lines.map((l) => {
      const net = dec(l.netAmount);
      const tax = dec(l.taxAmount);
      return {
        description: l.description,
        quantity: dec(l.quantity).toFixed(),
        unitPrice: fmt(l.unitPrice as DecimalInput),
        discountPercent: l.discountPercent ? dec(l.discountPercent).toFixed() : null,
        taxRate: dec(l.taxRate).toFixed(),
        netAmount: fmt(net),
        taxAmount: fmt(tax),
        total: fmt(net.plus(tax)),
      };
    });
    const byRate = new Map<string, { net: Decimal; tax: Decimal }>();
    for (const l of doc.lines) {
      const rate = dec(l.taxRate).toFixed();
      const row = byRate.get(rate) ?? { net: new Decimal(0), tax: new Decimal(0) };
      byRate.set(rate, { net: row.net.plus(dec(l.netAmount)), tax: row.tax.plus(dec(l.taxAmount)) });
    }
    const total = dec(doc.total);
    const due = doc.status === 'POSTED' ? dec(doc.amountDue) : total;
    const credit = doc.kind === 'SALES_CREDIT';
    return {
      id: doc._id,
      kind: doc.kind as InvoiceView['kind'],
      title: credit ? 'Credit note' : dec(doc.taxTotal).gt(0) ? 'Tax invoice' : 'Invoice',
      number: doc.number,
      status: doc.status,
      date: doc.date,
      dueDate: doc.dueDate,
      reference: doc.reference,
      currency: doc.currency,
      priceIncludesTax: doc.priceIncludesTax,
      notes: doc.notes,
      appliesTo: appliesTo?.number ?? null,
      seller: {
        name: entity?.name ?? '',
        legalName: entity?.legalName || entity?.name || '',
        address: entity?.address ?? '',
        phone: entity?.phone || branch?.phone || '',
        email: entity?.email || branch?.email || '',
        website: entity?.website ?? '',
        taxId: branch?.taxRegistrationNumber || entity?.taxId || '',
        registrationNumber: entity?.registrationNumber ?? '',
        branch: branch?.name ?? '',
      },
      customer: {
        id: doc.partyId,
        code: customer?.code ?? '',
        name: doc.partyName,
        legalName: customer?.legalName ?? '',
        address: customer?.address ?? '',
        city: customer?.city ?? '',
        country: customer?.country ?? '',
        email: customer?.email ?? '',
        phone: customer?.phone ?? '',
        taxId: customer?.taxId ?? '',
      },
      lines,
      taxSummary: [...byRate.entries()].filter(([, v]) => !v.net.isZero() || !v.tax.isZero()).map(([rate, v]) => ({ rate, net: fmt(v.net), tax: fmt(v.tax) })),
      subtotal: fmt(doc.subtotal as DecimalInput),
      taxTotal: fmt(doc.taxTotal as DecimalInput),
      total: fmt(total),
      paid: fmt(total.minus(due)),
      amountDue: fmt(due),
      paymentStatus: doc.paymentStatus,
      paymentInstructions: entity?.paymentInstructions ?? '',
      etims: doc.etims ? await etimsBlock(doc.etims) : null,
      mpesa: mpesa?.mpesa && !credit ? { shortCode: mpesa.mpesa.shortCode, type: mpesa.mpesa.shortCodeType as 'PAYBILL' | 'TILL', accountNumber: doc.number } : null,
    };
  }

  /** A self-contained, printable HTML page (A4, works without the app's styles or scripts). */
  render(v: InvoiceView, opts: { payUrl?: string | null; autoPrint?: boolean } = {}): string {
    const e = escapeHtml;
    const multiline = (s: string) => e(s).replace(/\n/g, '<br>');
    const credit = v.kind === 'SALES_CREDIT';
    const draft = v.status !== 'POSTED';
    const discount = v.lines.some((l) => l.discountPercent);
    const sellerLines = [v.seller.address && multiline(v.seller.address), [v.seller.phone, v.seller.email].filter(Boolean).map(e).join(' · '), v.seller.website && e(v.seller.website), v.seller.taxId && `PIN / VAT: ${e(v.seller.taxId)}`].filter(Boolean);
    const customerLines = [v.customer.legalName && v.customer.legalName !== v.customer.name && e(v.customer.legalName), v.customer.address && multiline(v.customer.address), [v.customer.city, v.customer.country].filter(Boolean).map(e).join(', '), v.customer.taxId && `PIN / VAT: ${e(v.customer.taxId)}`].filter(Boolean);
    const meta: [string, string][] = [
      [credit ? 'Credit note no.' : 'Invoice no.', v.number],
      ['Date', day(v.date)],
      ...(credit ? (v.appliesTo ? [['Against invoice', v.appliesTo] as [string, string]] : []) : [['Due date', day(v.dueDate)] as [string, string]]),
      ...(v.reference ? [['Your reference', v.reference] as [string, string]] : []),
      ['Customer account', v.customer.code],
    ];
    const pay: string[] = [];
    if (!credit && v.mpesa) {
      pay.push(`<div class="pay-box"><strong>Pay with M-Pesa</strong><br>${v.mpesa.type === 'TILL' ? `Buy Goods till <b>${e(v.mpesa.shortCode)}</b>` : `Paybill <b>${e(v.mpesa.shortCode)}</b>, account <b>${e(v.mpesa.accountNumber)}</b>`}</div>`);
    }
    if (!credit && v.paymentInstructions) pay.push(`<div class="pay-box"><strong>How to pay</strong><br>${multiline(v.paymentInstructions)}</div>`);
    if (opts.payUrl && !credit && v.status === 'POSTED' && v.amountDue !== '0.00') pay.push(`<div class="pay-box no-print"><a class="btn" href="${e(opts.payUrl)}">Pay online</a></div>`);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(v.title)} ${e(v.number)} — ${e(v.seller.name)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef1f0; color: #1b1c2b; font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .page { max-width: 210mm; margin: 24px auto; background: #fff; padding: 32px 36px; border: 1px solid #dfe5e3; border-radius: 8px; position: relative; }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #4a3cbb; padding-bottom: 16px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: .02em; color: #4a3cbb; text-transform: uppercase; }
  .seller-name { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
  .muted { color: #5e6075; }
  .parties { display: flex; justify-content: space-between; gap: 24px; margin: 20px 0; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #5e6075; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  .meta td { padding: 2px 0 2px 16px; text-align: right; white-space: nowrap; }
  .meta td:first-child { color: #5e6075; }
  .lines th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5e6075; border-bottom: 1px solid #c9d3d0; padding: 6px 6px; }
  .lines td { padding: 7px 6px; border-bottom: 1px solid #eeeef4; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bottom { display: flex; justify-content: space-between; gap: 24px; margin-top: 18px; align-items: flex-start; }
  .totals { min-width: 260px; }
  .totals td { padding: 4px 0; }
  .totals tr.grand td { border-top: 2px solid #1b1c2b; font-weight: 700; font-size: 15px; padding-top: 8px; }
  .totals tr.due td { font-weight: 700; color: #4a3cbb; }
  .tax-summary { margin-top: 18px; max-width: 360px; }
  .tax-summary td, .tax-summary th { padding: 3px 6px; font-size: 12px; }
  .pay { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 22px; }
  .pay-box { border: 1px solid #c9d3d0; border-radius: 6px; padding: 10px 14px; min-width: 220px; flex: 1; }
  .btn { display: inline-block; background: #4a3cbb; color: #fff; text-decoration: none; padding: 9px 16px; border-radius: 6px; font-weight: 600; }
  .notes { margin-top: 18px; white-space: pre-wrap; }
  .etims { display: flex; gap: 14px; align-items: center; margin-top: 18px; border: 1px solid #c9d3d0; border-radius: 6px; padding: 10px 14px; font-size: 11.5px; }
  .etims .qr svg { width: 96px; height: 96px; display: block; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  footer { margin-top: 28px; font-size: 11px; color: #5e6075; border-top: 1px solid #eeeef4; padding-top: 10px; }
  .stamp { position: absolute; top: 120px; right: 40px; transform: rotate(-12deg); border: 3px solid; border-radius: 6px; padding: 4px 12px; font-size: 20px; font-weight: 800; letter-spacing: .1em; opacity: .55; }
  .stamp.paid { color: #1d7a45; } .stamp.draft, .stamp.void { color: #b42318; }
  .toolbar { max-width: 210mm; margin: 16px auto -8px; text-align: right; }
  .toolbar button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid #c9d3d0; background: #fff; cursor: pointer; }
  @media (max-width: 640px) { .page { margin: 0; border: 0; border-radius: 0; padding: 20px 16px; } header, .parties, .bottom { flex-direction: column; } .meta td { text-align: left; padding-left: 0; } .lines .hide-sm { display: none; } }
  @media print { body { background: #fff; } .page { margin: 0; border: 0; padding: 0; max-width: none; } .no-print, .toolbar { display: none !important; } }
</style></head>
<body>
<div class="toolbar no-print"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<div class="page">
  ${draft ? `<div class="stamp ${v.status === 'VOID' ? 'void' : 'draft'}">${v.status === 'VOID' ? 'VOID' : 'DRAFT'}</div>` : !credit && v.paymentStatus === 'PAID' ? '<div class="stamp paid">PAID</div>' : ''}
  <header>
    <div>
      <div class="seller-name">${e(v.seller.legalName || v.seller.name)}</div>
      <div class="muted">${sellerLines.join('<br>')}</div>
    </div>
    <div style="text-align:right"><h1>${e(v.title)}</h1><div class="muted">${e(v.number)}</div></div>
  </header>
  <section class="parties">
    <div>
      <div class="label">${credit ? 'Credit to' : 'Bill to'}</div>
      <div style="font-weight:600">${e(v.customer.name)}</div>
      <div class="muted">${customerLines.join('<br>')}</div>
    </div>
    <table class="meta" style="width:auto">${meta.map(([k, val]) => `<tr><td>${e(k)}</td><td><b>${e(val)}</b></td></tr>`).join('')}</table>
  </section>
  <table class="lines">
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th>${discount ? '<th class="num hide-sm">Disc %</th>' : ''}<th class="num hide-sm">VAT %</th><th class="num">${v.priceIncludesTax ? 'Amount incl. VAT' : 'Amount'}</th></tr></thead>
    <tbody>${v.lines
      .map((l) => `<tr><td>${multiline(l.description)}</td><td class="num">${e(l.quantity)}</td><td class="num">${e(l.unitPrice)}</td>${discount ? `<td class="num hide-sm">${e(l.discountPercent ?? '')}</td>` : ''}<td class="num hide-sm">${e(l.taxRate)}</td><td class="num">${e(v.priceIncludesTax ? l.total : l.netAmount)}</td></tr>`)
      .join('')}</tbody>
  </table>
  <div class="bottom">
    <div>
      ${
        v.taxSummary.length && v.taxTotal !== '0.00'
          ? `<table class="tax-summary"><thead><tr><th style="text-align:left">VAT rate</th><th class="num">Net</th><th class="num">VAT</th></tr></thead><tbody>${v.taxSummary.map((t) => `<tr><td>${e(t.rate)}%</td><td class="num">${e(t.net)}</td><td class="num">${e(t.tax)}</td></tr>`).join('')}</tbody></table>`
          : ''
      }
      ${v.notes ? `<div class="notes">${e(v.notes)}</div>` : ''}
    </div>
    <table class="totals">
      <tr><td>Subtotal</td><td class="num">${e(v.subtotal)}</td></tr>
      <tr><td>VAT</td><td class="num">${e(v.taxTotal)}</td></tr>
      <tr class="grand"><td>Total ${e(v.currency)}</td><td class="num">${e(v.total)}</td></tr>
      ${!credit && v.status === 'POSTED' && v.paid !== '0.00' ? `<tr><td>Paid</td><td class="num">${e(v.paid)}</td></tr>` : ''}
      ${!credit && v.status === 'POSTED' ? `<tr class="due"><td>Amount due</td><td class="num">${e(v.currency)} ${e(v.amountDue)}</td></tr>` : ''}
    </table>
  </div>
  ${pay.length ? `<div class="pay">${pay.join('')}</div>` : ''}
  ${
    v.etims
      ? v.etims.status === 'SENT'
        ? `<div class="etims"><div class="qr">${v.etims.qrSvg ?? ''}</div><div><strong>KRA eTIMS</strong><br>CU invoice no. ${e(v.etims.cuInvoiceNumber ?? '')}<br>Receipt no. ${e(v.etims.receiptNumber ?? '')} · ${e(v.etims.dateTime ?? '')}<br>Internal data: <span class="mono">${e(v.etims.internalData ?? '')}</span><br>Signature: <span class="mono">${e(v.etims.signature ?? '')}</span></div></div>`
        : v.etims.status === 'CANCELLED'
          ? ''
          : `<div class="etims muted">Being registered with KRA eTIMS; the signed copy will show KRA's QR code.</div>`
      : ''
  }
  <footer>${[v.seller.legalName || v.seller.name, v.seller.registrationNumber && `Reg. no. ${e(v.seller.registrationNumber)}`, v.seller.branch && `Issued by ${e(v.seller.branch)}`].filter(Boolean).join(' · ')}</footer>
</div>
${opts.autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script>' : ''}
</body></html>`;
  }

  async document(user: AuthUser, id: Types.ObjectId, opts: { autoPrint?: boolean } = {}) {
    await this.authorise(user, id);
    return this.render(await this.view(user.organisationId, id), opts);
  }

  /** The document as a PDF, with a file name like "Invoice INV-KE01-000123.pdf". */
  async pdf(organisationId: Types.ObjectId, id: Types.ObjectId) {
    const view = await this.view(organisationId, id);
    return { data: await renderInvoicePdf(view), filename: `${view.title} ${view.number}.pdf` };
  }

  async pdfFor(user: AuthUser, id: Types.ObjectId) {
    await this.authorise(user, id);
    return this.pdf(user.organisationId, id);
  }
}
