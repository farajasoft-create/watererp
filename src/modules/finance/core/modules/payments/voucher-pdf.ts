import PDFDocument from 'pdfkit';

const INK = '#1b1c2b';
const MUTED = '#5e6075';
const LINE = '#c9cad6';
const SHADE = '#f4f4f8';
const day = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

export interface VoucherView {
  /** e.g. "Payment voucher", "Imprest voucher". */
  title: string;
  number: string;
  date: Date;
  /** DRAFT, SUBMITTED, VOID… anything but a paid status is stamped across the page. */
  status: string;
  stamp: string | null;
  issuer: { name: string; address: string; contact: string; taxId: string; branch: string };
  payee: { name: string; code: string; taxId: string; lines: string[] };
  currency: string;
  /** Cash actually paid out, formatted. */
  amount: string;
  amountInWords: string;
  facts: [string, string][];
  narration: string;
  particulars: { reference: string; description: string; amount: string }[];
  particularsTotal: string;
  deductions: { label: string; amount: string }[];
  coding: { code: string; name: string; dimension: string; debit: string; credit: string }[];
  codingTotals: { debit: string; credit: string } | null;
  /** Who did what: prepared, checked/approved (each workflow step), released. */
  signatures: { role: string; name: string; date: Date | null; note?: string }[];
}

/**
 * A payment voucher on A4 in the layout public bodies use: the payee and the amount in words, what is
 * being paid, the ledger coding, then authorisations with names and dates taken from the approval trail,
 * and a space for the payee to sign for receipt. Built with PDFKit's built-in fonts.
 */
export async function renderVoucherPdf(v: VoucherView): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${v.title} ${v.number}`, Author: v.issuer.name, Subject: `${v.title} ${v.number}: ${v.payee.name}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const right = left + width;
  const bottom = doc.page.height - 50;
  let y = 40;
  const room = (h: number) => {
    if (y + h > bottom) {
      doc.addPage();
      y = 40;
    }
  };
  const label = (text: string, x: number, at: number, w?: number) => doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(text.toUpperCase(), x, at, { width: w });

  // Letterhead.
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(v.issuer.name, left, y, { width, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  const head = [v.issuer.address, v.issuer.contact, v.issuer.taxId && `PIN ${v.issuer.taxId}`].filter(Boolean).join('  ·  ');
  if (head) doc.text(head, left, doc.y + 2, { width, align: 'center' });
  y = doc.y + 8;
  doc.rect(left, y, width, 24).fill(INK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text(v.title.toUpperCase(), left, y + 6, { width, align: 'center', characterSpacing: 1 });
  y += 32;

  // Number, date and the payee.
  const half = width / 2 - 6;
  const boxTop = y;
  label('Payee', left + 8, y + 7);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(v.payee.name, left + 8, y + 18, { width: half - 16 });
  doc.font('Helvetica').fontSize(8.5).fillColor(INK);
  const payeeLines = [v.payee.code && `Account ${v.payee.code}`, v.payee.taxId && `PIN ${v.payee.taxId}`, ...v.payee.lines].filter(Boolean) as string[];
  if (payeeLines.length) doc.text(payeeLines.join('\n'), left + 8, doc.y + 2, { width: half - 16 });
  const payeeBottom = doc.y + 8;
  let fy = y + 7;
  const facts: [string, string][] = [['Voucher no.', v.number], ['Date', day(v.date)], ...v.facts];
  for (const [k, val] of facts) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(k, left + half + 20, fy, { width: 90 });
    doc.fillColor(INK).font(k === 'Voucher no.' ? 'Helvetica-Bold' : 'Helvetica').text(val || '—', left + half + 110, fy, { width: right - (left + half + 118), align: 'right' });
    fy = doc.y + 3;
  }
  y = Math.max(payeeBottom, fy + 5);
  doc.rect(left, boxTop, width, y - boxTop).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.moveTo(left + half + 12, boxTop).lineTo(left + half + 12, y).stroke();
  y += 10;

  // Amount in figures and words.
  doc.rect(left, y, width, 40).fill(SHADE);
  label('Amount', left + 8, y + 6);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(`${v.currency} ${v.amount}`, left + 8, y + 17, { width: 170 });
  label('In words', left + 190, y + 6);
  doc.fillColor(INK).font('Helvetica-Oblique').fontSize(9).text(v.amountInWords, left + 190, y + 17, { width: width - 198 });
  y = Math.max(y + 40, doc.y + 6) + 10;

  if (v.narration) {
    label('Being payment for', left, y);
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(v.narration, left, y + 10, { width });
    y = doc.y + 10;
  }

  // A ruled table with a shaded header that repeats on new pages.
  const table = (cols: { label: string; w: number; align?: 'left' | 'right' }[], rows: string[][], foot?: string[]) => {
    const drawHead = () => {
      doc.rect(left, y, width, 16).fill(SHADE);
      let x = left;
      for (const c of cols) {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(c.label.toUpperCase(), x + 4, y + 5, { width: c.w - 8, align: c.align ?? 'left' });
        x += c.w;
      }
      y += 19;
    };
    room(40);
    drawHead();
    const line = (cells: string[], bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      const h = Math.max(...cells.map((t, i) => doc.heightOfString(t || ' ', { width: cols[i].w - 8 })), 10) + 6;
      if (y + h > bottom) {
        doc.addPage();
        y = 40;
        drawHead();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      }
      let x = left;
      cells.forEach((t, i) => {
        doc.fillColor(INK).text(t, x + 4, y, { width: cols[i].w - 8, align: cols[i].align ?? 'left' });
        x += cols[i].w;
      });
      y += h;
      doc.moveTo(left, y - 3).lineTo(right, y - 3).lineWidth(0.4).strokeColor(LINE).stroke();
    };
    for (const r of rows) line(r);
    if (foot) line(foot, true);
    y += 8;
  };

  if (v.particulars.length) {
    label('Particulars', left, y);
    y += 11;
    table(
      [
        { label: 'Reference', w: 130 },
        { label: 'Description', w: width - 240 },
        { label: `Amount ${v.currency}`, w: 110, align: 'right' },
      ],
      v.particulars.map((p) => [p.reference, p.description, p.amount]),
      v.particulars.length > 1 || v.deductions.length ? ['', 'Total', v.particularsTotal] : undefined,
    );
    if (v.deductions.length) {
      y -= 4;
      for (const d of [...v.deductions, { label: 'Net amount paid', amount: v.amount }]) {
        const last = d.label === 'Net amount paid';
        doc.fillColor(last ? INK : MUTED).font(last ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(d.label, left + 134, y, { width: width - 248, align: 'right' });
        doc.fillColor(INK).text(d.amount, right - 110 + 4, y, { width: 102, align: 'right' });
        y += 13;
      }
      y += 6;
    }
  }

  label('Account coding', left, y);
  y += 11;
  if (v.coding.length) {
    table(
      [
        { label: 'Account', w: 60 },
        { label: 'Name', w: width - 320 },
        { label: 'Analysis', w: 100 },
        { label: 'Debit', w: 80, align: 'right' },
        { label: 'Credit', w: 80, align: 'right' },
      ],
      v.coding.map((c) => [c.code, c.name, c.dimension, c.debit, c.credit]),
      v.codingTotals ? ['', 'Totals', '', v.codingTotals.debit, v.codingTotals.credit] : undefined,
    );
  } else {
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.5).text('The ledger coding is printed here once the payment has been approved and posted.', left, y, { width });
    y = doc.y + 12;
  }

  // Authorisations, then the payee's acknowledgement.
  const sigs = [...v.signatures, { role: 'Received by payee', name: '', date: null }];
  const per = 3;
  const colW = width / per;
  room(20);
  label('Authorisation', left, y);
  y += 12;
  for (let i = 0; i < sigs.length; i += per) {
    room(64);
    sigs.slice(i, i + per).forEach((s, j) => {
      const x = left + j * colW;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(s.role.toUpperCase(), x, y, { width: colW - 14 });
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(s.name ? `Name: ${s.name}` : 'Name:', x, y + 12, { width: colW - 14 });
      doc.text(`Date: ${day(s.date)}`, x, y + 24, { width: colW - 14 });
      if (s.note) doc.fillColor(MUTED).fontSize(7.5).text(s.note, x, y + 35, { width: colW - 14, height: 10, ellipsis: true });
      doc.moveTo(x, y + 58).lineTo(x + colW - 18, y + 58).lineWidth(0.6).strokeColor(INK).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(7).text('Signature', x, y + 60, { width: colW - 14 });
    });
    y += 76;
  }

  // Stamp unpaid and void vouchers so a draft is never mistaken for a release.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    if (v.stamp) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.fillColor('#c0392b').opacity(0.12).font('Helvetica-Bold').fontSize(80).text(v.stamp, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false });
      doc.restore();
      doc.opacity(1);
    }
    doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(`${v.title} ${v.number} · ${v.issuer.name}${v.issuer.branch ? ` · ${v.issuer.branch}` : ''} · printed ${day(new Date())} · page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
