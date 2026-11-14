import PDFDocument from 'pdfkit';

const MM = 72 / 25.4;

export interface ChequeView {
  number: string;
  date: Date;
  payee: string;
  /** Amount in figures, formatted. */
  amount: string;
  amountInWords: string;
  /** Crossed "A/C payee only" (the default for supplier payments). */
  crossed: boolean;
  /** Signatories who signed electronically, printed on the counterfoil. */
  signedBy?: string[];
}

/**
 * Prints the variable fields of a cheque onto the bank's pre-printed leaf: the Kenya Bankers Association
 * standard size (175 × 80 mm) with the date as DDMMYYYY in the boxes at the top right, the payee, the
 * amount in words over two lines, the figures box and the "A/C payee only" crossing. A second page
 * carries the counterfoil details for the cheque register.
 */
export async function renderChequePdf(c: ChequeView): Promise<Buffer> {
  const doc = new PDFDocument({ size: [175 * MM, 80 * MM], margin: 0, info: { Title: `Cheque for ${c.number}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const d = c.date;
  const digits = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${d.getUTCFullYear()}`;
  doc.font('Courier-Bold').fontSize(11);
  digits.split('').forEach((ch, i) => doc.text(ch, (128 + i * 5.2) * MM, 9 * MM, { lineBreak: false }));
  doc.font('Helvetica-Bold').fontSize(10).text(c.payee.toUpperCase(), 22 * MM, 25 * MM, { width: 140 * MM, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(9).text(`${c.amountInWords} only`.toUpperCase(), 22 * MM, 34 * MM, { width: 100 * MM, lineGap: 4 });
  doc.font('Courier-Bold').fontSize(12).text(`**${c.amount}**`, 130 * MM, 37 * MM, { width: 40 * MM, align: 'right', lineBreak: false });
  if (c.crossed) {
    doc.save().rotate(-30, { origin: [20 * MM, 20 * MM] });
    doc.moveTo(8 * MM, 14 * MM).lineTo(48 * MM, 14 * MM).moveTo(8 * MM, 22 * MM).lineTo(48 * MM, 22 * MM).lineWidth(0.8).stroke();
    doc.font('Helvetica-Bold').fontSize(7).text('A/C PAYEE ONLY', 10 * MM, 16.5 * MM, { lineBreak: false });
    doc.restore();
  }
  doc.addPage({ size: [175 * MM, 80 * MM], margin: 0 });
  doc.font('Helvetica-Bold').fontSize(10).text('Counterfoil', 10 * MM, 10 * MM);
  doc.font('Helvetica').fontSize(9);
  [['Payment', c.number], ['Date', d.toISOString().slice(0, 10)], ['Payee', c.payee], ['Amount', c.amount], ['In words', c.amountInWords], ...(c.signedBy?.length ? [['Signed', c.signedBy.join('; ')]] : [])].forEach(([k, v], i) => {
    doc.font('Helvetica-Bold').text(k, 10 * MM, (20 + i * 8) * MM, { lineBreak: false });
    doc.font('Helvetica').text(v, 35 * MM, (20 + i * 8) * MM, { width: 130 * MM, lineBreak: false, ellipsis: true });
  });
  doc.end();
  return done;
}
