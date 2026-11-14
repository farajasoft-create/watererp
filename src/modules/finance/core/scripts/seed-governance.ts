/**
 * Demo data for Phase 6: supporting documents on bills, an expense claim and a customer. The
 * duplicated OfficePro bill carries the same PDF twice, which the exception analytics pick up.
 */
import { Types } from 'mongoose';
import { AuthUser } from '../common/auth';
import { Services } from '../container';

interface Context {
  s: Services;
  organisationId: Types.ObjectId;
  accountant: AuthUser;
  approver: AuthUser;
}

/** A one-page PDF with a few lines of text (valid xref offsets, so viewers open it without repair). */
function pdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 11 Tf', '56 780 Td', '14 TL', ...lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export async function seedGovernance(c: Context) {
  const { s, organisationId, accountant } = c;
  const { db } = s;

  const bills = await db.invoices.find({ organisationId, kind: 'PURCHASE_BILL', status: 'POSTED' }).sort({ date: 1 }).lean();
  for (const bill of bills.slice(0, 6)) {
    if (bill.supplierInvoiceNumber?.startsWith('OP-10455')) continue;
    await s.attachments.upload(
      accountant,
      { recordType: 'Invoice', recordId: bill._id, name: `${bill.supplierInvoiceNumber || bill.number}.pdf`, category: 'INVOICE', description: `Supplier invoice from ${bill.partyName}` },
      pdf([bill.partyName, `Tax invoice ${bill.supplierInvoiceNumber || bill.number}`, `Date: ${bill.date.toISOString().slice(0, 10)}`, `Total: ${bill.currency} ${bill.total.toString()}`]),
    );
  }

  // The duplicated bill: the same scanned invoice was entered twice.
  const scan = pdf(['OfficePro Supplies', 'Tax invoice OP-10455', 'Printer toner and paper - September', 'Total: KES 79,460.00']);
  for (const bill of bills.filter((b) => b.supplierInvoiceNumber?.startsWith('OP-10455'))) {
    await s.attachments.upload(accountant, { recordType: 'Invoice', recordId: bill._id, name: 'OfficePro-OP-10455.pdf', category: 'INVOICE' }, scan);
  }

  const claim = await db.expenseClaims.findOne({ organisationId, title: /Mombasa/ }).lean();
  if (claim) {
    const claimant = { ...accountant, id: claim.claimantId };
    await s.attachments.upload(claimant, { recordType: 'ExpenseClaim', recordId: claim._id, name: 'Bahari-Beach-Hotel-receipt.pdf', category: 'RECEIPT' }, pdf(['Bahari Beach Hotel', 'Receipt BBH-2231', '2 nights, 14-16 September 2026', 'Total: KES 31,000.00']));
  }

  const customer = await db.customers.findOne({ organisationId, code: 'SAVANNA' }).lean();
  if (customer) {
    await s.attachments.upload(
      accountant,
      { recordType: 'Customer', recordId: customer._id, name: 'Savanna-supply-agreement-2026.pdf', category: 'CONTRACT', description: 'Annual supply agreement and credit terms' },
      pdf(['Supply agreement', 'Faraja Kenya Ltd and Savanna Retailers Ltd', 'Term: 1 January - 31 December 2026', 'Credit limit: KES 5,000,000; payment within 30 days']),
    );
  }
}
