import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import type { InvoiceView } from './billing.service';

const INK = '#1b1c2b';
const MUTED = '#5e6075';
const LINE = '#e4e4ec';
const BRAND = '#4a3cbb';
const day = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The invoice or credit note as a PDF (A4), from the same model as the HTML document: letterhead, the
 * customer, lines, tax summary and totals, how to pay, and the KRA eTIMS block with its QR code.
 * Uses PDFKit's built-in fonts, so nothing is downloaded and it runs in a serverless function.
 */
export async function renderInvoicePdf(view: InvoiceView & { etims: (InvoiceView['etims'] & { qrUrl?: string | null }) | null }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `${view.title} ${view.number}`, Author: view.seller.name, Subject: `${view.title} ${view.number} for ${view.customer.name}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const right = left + width;

  // Letterhead and title.
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(16).text(view.seller.legalName || view.seller.name, left, 48, { width: width * 0.6 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
  const sellerLines = [view.seller.address, [view.seller.phone, view.seller.email].filter(Boolean).join(' · '), view.seller.website, view.seller.taxId && `PIN ${view.seller.taxId}`, view.seller.registrationNumber && `Reg. ${view.seller.registrationNumber}`].filter(Boolean) as string[];
  doc.text(sellerLines.join('\n'), left, doc.y + 2, { width: width * 0.6 });
  const headerBottom = doc.y;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(view.title.toUpperCase(), left, 48, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const meta: [string, string][] = [
    ['Number', view.number],
    ['Date', day(view.date)],
    ...(view.kind === 'SALES_INVOICE' ? ([['Due', day(view.dueDate)]] as [string, string][]) : []),
    ...(view.reference ? ([['Reference', view.reference]] as [string, string][]) : []),
    ...(view.appliesTo ? ([['Against', view.appliesTo]] as [string, string][]) : []),
    ['Currency', view.currency],
  ];
  let y = 76;
  for (const [k, v] of meta) {
    doc.fillColor(MUTED).text(k, right - 200, y, { width: 80 });
    doc.fillColor(INK).text(v, right - 120, y, { width: 120, align: 'right' });
    y += 13;
  }
  y = Math.max(y, headerBottom) + 16;

  // Bill to.
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('BILL TO', left, y);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(view.customer.legalName || view.customer.name, left, y + 11, { width: width * 0.6 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const customerLines = [view.customer.address, [view.customer.city, view.customer.country].filter(Boolean).join(', '), view.customer.taxId && `PIN ${view.customer.taxId}`, `Account ${view.customer.code}`].filter(Boolean) as string[];
  doc.text(customerLines.join('\n'), left, doc.y + 1, { width: width * 0.6 });
  y = doc.y + 18;

  // Lines.
  const cols = [
    { key: 'description', label: 'Description', w: width - 330, align: 'left' as const },
    { key: 'quantity', label: 'Qty', w: 50, align: 'right' as const },
    { key: 'unitPrice', label: 'Unit price', w: 75, align: 'right' as const },
    { key: 'taxRate', label: 'Tax', w: 45, align: 'right' as const },
    { key: 'netAmount', label: 'Net', w: 75, align: 'right' as const },
    { key: 'total', label: 'Total', w: 85, align: 'right' as const },
  ];
  const header = () => {
    doc.rect(left, y, width, 18).fill('#f6f6fa');
    let x = left;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8);
    for (const c of cols) {
      doc.text(c.label.toUpperCase(), x + 4, y + 5, { width: c.w - 8, align: c.align });
      x += c.w;
    }
    y += 22;
  };
  header();
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const l of view.lines) {
    const values: Record<string, string> = { description: l.description + (l.discountPercent ? ` (less ${l.discountPercent}%)` : ''), quantity: l.quantity, unitPrice: l.unitPrice, taxRate: `${l.taxRate}%`, netAmount: l.netAmount, total: l.total };
    const h = Math.max(doc.heightOfString(values.description, { width: cols[0].w - 8 }), 11) + 8;
    if (y + h > doc.page.height - 160) {
      doc.addPage();
      y = 48;
      header();
      doc.font('Helvetica').fontSize(9).fillColor(INK);
    }
    let x = left;
    for (const c of cols) {
      doc.text(values[c.key], x + 4, y, { width: c.w - 8, align: c.align });
      x += c.w;
    }
    y += h;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor(LINE).stroke();
  }

  // Totals.
  y += 6;
  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor(bold ? INK : MUTED);
    doc.text(label, right - 230, y, { width: 130 });
    doc.fillColor(INK).text(value, right - 100, y, { width: 100, align: 'right' });
    y += bold ? 16 : 13;
  };
  totalRow(view.priceIncludesTax ? 'Subtotal (excl. tax)' : 'Subtotal', view.subtotal);
  for (const t of view.taxSummary) totalRow(`Tax ${t.rate}% on ${t.net}`, t.tax);
  totalRow(`Total ${view.currency}`, view.total, true);
  if (view.kind === 'SALES_INVOICE' && view.paid !== '0.00') {
    totalRow('Paid', view.paid);
    totalRow(`Amount due ${view.currency}`, view.amountDue, true);
  }

  // Notes and how to pay.
  y += 10;
  const block = (title: string, body: string) => {
    if (!body.trim()) return;
    if (y > doc.page.height - 140) {
      doc.addPage();
      y = 48;
    }
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(title.toUpperCase(), left, y);
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(body, left, y + 11, { width: width * 0.62 });
    y = doc.y + 10;
  };
  if (view.kind === 'SALES_INVOICE') {
    const pay = [view.mpesa ? (view.mpesa.type === 'TILL' ? `M-Pesa Buy Goods till ${view.mpesa.shortCode}` : `M-Pesa paybill ${view.mpesa.shortCode}, account ${view.mpesa.accountNumber}`) : '', view.paymentInstructions].filter(Boolean).join('\n');
    block('How to pay', pay);
  }
  block('Notes', view.notes);

  // KRA eTIMS: control unit details and the verification QR code.
  if (view.etims && view.etims.status === 'SENT') {
    const top = Math.max(y, doc.page.height - 150);
    if (top + 100 > doc.page.height - 30) doc.addPage();
    const ey = top + 100 > doc.page.height - 30 ? 48 : top;
    if (view.etims.qrUrl) doc.image(await QRCode.toBuffer(view.etims.qrUrl, { margin: 0, width: 160, errorCorrectionLevel: 'M' }), right - 80, ey, { width: 80 });
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('KRA eTIMS', left, ey);
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    const rows = [
      view.etims.cuInvoiceNumber && `CU invoice number: ${view.etims.cuInvoiceNumber}`,
      view.etims.receiptNumber && `Receipt: ${view.etims.receiptNumber}`,
      view.etims.dateTime && `Date: ${view.etims.dateTime}`,
      view.etims.internalData && `Internal data: ${view.etims.internalData}`,
      view.etims.signature && `Signature: ${view.etims.signature}`,
    ].filter(Boolean) as string[];
    doc.text(rows.join('\n'), left, ey + 11, { width: width - 100 });
  }

  // Footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(`${view.title} ${view.number} · ${view.seller.name} · page ${i + 1} of ${range.count}`, left, doc.page.height - 32, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
