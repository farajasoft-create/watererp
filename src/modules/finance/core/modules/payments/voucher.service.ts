import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException } from '../../common/errors';
import { Decimal, dec, DecimalInput, sum } from '../../common/money';
import { userNames } from '../../common/names';
import { Db } from '../../database/db.service';
import { WorkflowDocumentType } from '../../database/platform.schemas';
import { ExpensesService } from '../expenses/expenses.service';
import { ImprestService } from '../expenses/imprest.service';
import { PaymentsService } from './payments.service';
import { renderChequePdf } from './cheque-pdf';
import { renderVoucherPdf, VoucherView } from './voucher-pdf';

const fmt = (v: DecimalInput) => {
  const d = dec(v);
  const [i, f] = d.abs().toFixed(2).split('.');
  return `${d.isNeg() ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
};

const CURRENCY_WORDS: Record<string, [string, string]> = {
  KES: ['Kenya Shillings', 'cents'],
  UGX: ['Uganda Shillings', 'cents'],
  TZS: ['Tanzania Shillings', 'cents'],
  RWF: ['Rwanda Francs', 'centimes'],
  USD: ['US Dollars', 'cents'],
  EUR: ['Euros', 'cents'],
  GBP: ['Pounds Sterling', 'pence'],
};
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function under1000(n: number) {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
  const r = n % 100;
  if (r) {
    const t = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
    parts.push(n >= 100 ? `and ${t}` : t);
  }
  return parts.join(' ');
}

/** A whole number in English words, British style ("one thousand two hundred and five"). */
export function numberInWords(n: bigint): string {
  if (n === BigInt(0)) return 'zero';
  const groups: number[] = [];
  for (let x = n; x > BigInt(0); x /= BigInt(1000)) groups.push(Number(x % BigInt(1000)));
  if (groups.length > SCALES.length) throw new BadRequestException('Amount too large to write in words');
  const words = groups
    .map((g, i) => (g ? `${under1000(g)}${SCALES[i] ? ` ${SCALES[i]}` : ''}` : ''))
    .reverse()
    .filter(Boolean);
  // "one thousand and five": the last group gets "and" when it is below a hundred.
  const last = groups[0];
  if (groups.length > 1 && last > 0 && last < 100) words[words.length - 1] = `and ${words[words.length - 1]}`;
  return words.join(' ');
}

/** "Kenya Shillings twelve thousand five hundred and cents fifty only". */
export function amountInWords(value: DecimalInput, currency: string): string {
  const d = dec(value).abs().toDecimalPlaces(2);
  const whole = BigInt(d.floor().toFixed(0));
  const minor = Number(d.minus(d.floor()).times(100).toFixed(0));
  const [major, cents] = CURRENCY_WORDS[currency] ?? [currency, 'cents'];
  const text = `${major} ${numberInWords(whole)}${minor ? ` and ${cents} ${numberInWords(BigInt(minor))}` : ''} only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const STAMP: Record<string, string | null> = { DRAFT: 'DRAFT', SUBMITTED: 'NOT APPROVED', REJECTED: 'REJECTED', VOID: 'VOID', APPROVED: 'NOT PAID', CANCELLED: 'CANCELLED' };

/**
 * Printable payment vouchers for money going out: supplier payments, imprest advances and expense claim
 * reimbursements. Access goes through each module's own get(), so branch scoping and "only the holder or
 * finance" rules apply unchanged.
 */
export class VoucherService {
  constructor(
    private readonly db: Db,
    private readonly payments: PaymentsService,
    private readonly imprest: ImprestService,
    private readonly expenses: ExpensesService,
  ) {}

  private async issuer(entityId: Types.ObjectId, branchId: Types.ObjectId) {
    const [entity, branch] = await Promise.all([this.db.entities.findById(entityId).lean(), this.db.branches.findById(branchId).lean()]);
    return {
      name: entity?.legalName || entity?.name || '',
      address: entity?.address ?? '',
      contact: [entity?.phone || branch?.phone, entity?.email || branch?.email].filter(Boolean).join(' · '),
      taxId: branch?.taxRegistrationNumber || entity?.taxId || '',
      branch: branch?.name ?? '',
    };
  }

  /** The posted journal as account coding, with dimensions spelled out. */
  private async coding(journalIds: (Types.ObjectId | null | undefined)[]) {
    const ids = journalIds.filter(Boolean) as Types.ObjectId[];
    if (!ids.length) return { coding: [], codingTotals: null };
    const journals = await this.db.journals.find({ _id: { $in: ids } }, { lines: 1 }).lean();
    const lines = journals.flatMap((j) => j.lines);
    const dimIds = lines.flatMap((l) => [l.departmentId, l.costCentreId, l.projectId, l.fundId]).filter(Boolean);
    const [accounts, dims] = await Promise.all([
      this.db.accounts.find({ _id: { $in: lines.map((l) => l.accountId) } }, { code: 1, name: 1 }).lean(),
      dimIds.length ? this.db.dimensions.find({ _id: { $in: dimIds } }, { code: 1, name: 1 }).lean() : [],
    ]);
    const dim = (id: Types.ObjectId | null | undefined) => (id ? dims.find((d) => d._id.equals(id))?.code : undefined);
    const coding = lines.map((l) => {
      const a = accounts.find((x) => x._id.equals(l.accountId));
      return {
        code: a?.code ?? '',
        name: l.description ? `${a?.name ?? ''} - ${l.description}` : (a?.name ?? ''),
        dimension: [l.departmentId, l.costCentreId, l.projectId, l.fundId].map(dim).filter(Boolean).join(' / '),
        debit: dec(l.debitTx).isZero() ? '' : fmt(l.debitTx),
        credit: dec(l.creditTx).isZero() ? '' : fmt(l.creditTx),
      };
    });
    return { coding, codingTotals: { debit: fmt(sum(lines.map((l) => l.debitTx))), credit: fmt(sum(lines.map((l) => l.creditTx))) } };
  }

  /**
   * Signature blocks: the preparer, each approval recorded by the workflow (so a two-step chain prints two
   * names), and whoever released the money.
   */
  private async signatures(organisationId: Types.ObjectId, types: WorkflowDocumentType[], documentId: Types.ObjectId, base: { prepared: [Types.ObjectId | null | undefined, Date | null | undefined]; approved?: [Types.ObjectId | null | undefined, Date | null | undefined]; released?: [Types.ObjectId | null | undefined, Date | null | undefined, string] }) {
    const requests = await this.db.approvalRequests.find({ organisationId, documentType: { $in: types }, documentId, status: { $in: ['PENDING', 'APPROVED'] } }).sort({ submittedAt: 1 }).lean();
    const name = await userNames(this.db, [base.prepared[0], base.approved?.[0], base.released?.[0]]);
    const out: VoucherView['signatures'] = [{ role: 'Prepared by', name: name(base.prepared[0]) ?? '', date: base.prepared[1] ?? null }];
    const approvals = requests.flatMap((r) => r.steps.flatMap((s) => s.approvals.map((a) => ({ role: s.name || 'Approved by', name: a.onBehalfOfName ? `${a.userName} for ${a.onBehalfOfName}` : a.userName, date: a.at, note: a.comment || undefined }))));
    if (approvals.length) out.push(...approvals);
    else out.push({ role: 'Approved by', name: base.approved?.[0] ? (name(base.approved[0]) ?? '') : '', date: base.approved?.[1] ?? null });
    if (base.released) out.push({ role: base.released[2], name: base.released[0] ? (name(base.released[0]) ?? '') : '', date: base.released[1] ?? null });
    return out;
  }

  private async bank(id: Types.ObjectId | null | undefined) {
    return id ? this.db.bankAccounts.findById(id, { name: 1, accountNumber: 1 }).lean() : null;
  }

  async paymentView(user: AuthUser, id: Types.ObjectId): Promise<VoucherView> {
    const p = await this.payments.get(user, id);
    if (p.kind !== 'PAYMENT') throw new BadRequestException('Vouchers are printed for supplier payments; print the receipt instead');
    const supplier = await this.db.suppliers.findById(p.partyId).lean();
    const allocations = p.status === 'POSTED' || p.status === 'VOID' ? p.allocations.filter((a) => a.sourceId.equals(p._id) && a.status === 'ACTIVE') : [];
    const docs = await this.db.invoices.find({ _id: { $in: [...allocations.map((a) => a.documentId), ...p.plannedAllocations.map((a) => a.documentId)] } }, { number: 1, supplierInvoiceNumber: 1, date: 1, reference: 1 }).lean();
    const describe = (docId: Types.ObjectId) => {
      const d = docs.find((x) => x._id.equals(docId));
      return [d?.supplierInvoiceNumber && `Supplier invoice ${d.supplierInvoiceNumber}`, d?.date && `dated ${d.date.toISOString().slice(0, 10)}`].filter(Boolean).join(', ');
    };
    const particulars = (allocations.length ? allocations : p.plannedAllocations).map((a) => ({
      reference: docs.find((x) => x._id.equals(a.documentId))?.number ?? '',
      description: describe(a.documentId),
      amount: fmt(a.amount),
    }));
    const wht = dec(p.withholdingAmount);
    const onAccount = dec(p.amount).plus(wht).minus(sum(particulars.map((x) => x.amount.replace(/,/g, ''))));
    if (onAccount.gt(0)) particulars.push({ reference: 'On account', description: 'Advance held against future bills', amount: fmt(onAccount) });
    const mpesa = supplier?.mpesaPayee;
    const view: VoucherView = {
      title: 'Payment voucher',
      number: p.number,
      date: p.date,
      status: p.status,
      stamp: STAMP[p.status] ?? null,
      issuer: await this.issuer(p.entityId, p.branchId),
      payee: {
        name: supplier?.legalName || p.partyName,
        code: supplier?.code ?? '',
        taxId: supplier?.taxId ?? '',
        lines: [
          supplier?.address ?? '',
          supplier?.bankAccountNumber ? `${[supplier.bankName, supplier.bankBranch].filter(Boolean).join(', ')} a/c ${supplier.bankAccountNumber}${supplier.bankAccountName ? ` (${supplier.bankAccountName})` : ''}` : '',
          mpesa ? `M-Pesa ${mpesa.type.toLowerCase()} ${mpesa.number}${mpesa.accountReference ? ` acc ${mpesa.accountReference}` : ''}` : '',
        ].filter(Boolean),
      },
      currency: p.currency,
      amount: fmt(p.amount),
      amountInWords: amountInWords(p.amount, p.currency),
      facts: [
        ['Paid from', p.bankAccount ? `${p.bankAccount.name}${p.bankAccount.accountNumber ? ` ${p.bankAccount.accountNumber}` : ''}` : ''],
        ['Method', p.method.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())],
        ['Cheque / ref.', p.reference],
        ['Journal', p.journalNumber ?? 'Not posted'],
        ...(p.currency !== p.functionalCurrency ? ([['Rate', dec(p.exchangeRate).toFixed()]] as [string, string][]) : []),
      ],
      narration: p.description || (particulars.length ? `Settlement of ${particulars.map((x) => x.reference).join(', ')}` : ''),
      particulars,
      particularsTotal: fmt(sum(particulars.map((x) => x.amount.replace(/,/g, '')))),
      deductions: wht.gt(0) ? [{ label: `Less withholding tax${p.withholdingTaxCode ? ` (${p.withholdingTaxCode.code})` : ''}`, amount: fmt(wht.neg()) }] : [],
      ...(await this.coding([p.journalId])),
      signatures: await this.signatures(user.organisationId, ['SUPPLIER_PAYMENT'], p._id, { prepared: [p.createdBy, p.createdAt], approved: [p.approvedBy, p.approvedAt] }),
    };
    return view;
  }

  async payment(user: AuthUser, id: Types.ObjectId) {
    const view = await this.paymentView(user, id);
    return { data: await renderVoucherPdf(view), filename: `Payment voucher ${view.number}.pdf` };
  }

  /** The cheque for a posted payment made by cheque, printed onto the bank's leaf; each print is counted. */
  async cheque(user: AuthUser, id: Types.ObjectId) {
    const p = await this.payments.get(user, id);
    if (p.kind !== 'PAYMENT' || p.method !== 'CHEQUE') throw new BadRequestException('Only payments made by cheque print a cheque');
    if (p.status !== 'POSTED') throw new BadRequestException('Print the cheque once the payment is approved and posted');
    // Accounts with cheque signatories print only once enough of them have signed electronically.
    const bank = await this.db.bankAccounts.findById(p.bankAccountId, { chequeSignaturesRequired: 1 }).lean();
    const signed = (await this.db.payments.findById(p._id, { chequeSignatures: 1 }).lean())?.chequeSignatures ?? [];
    if (bank?.chequeSignaturesRequired && signed.length < bank.chequeSignaturesRequired) throw new BadRequestException(`The cheque needs ${bank.chequeSignaturesRequired} signatures; it has ${signed.length}`);
    await this.db.payments.updateOne({ _id: p._id }, { $inc: { chequePrints: 1 } });
    const data = await renderChequePdf({ number: p.number, date: p.date, payee: p.partyName, amount: fmt(p.amount), amountInWords: amountInWords(p.amount, p.currency), crossed: true, signedBy: signed.map((x) => `${x.name} ${x.at?.toISOString().slice(0, 16).replace('T', ' ') ?? ''}`) });
    return { data, filename: `Cheque ${p.reference || p.number}.pdf` };
  }

  async imprestView(user: AuthUser, id: Types.ObjectId): Promise<VoucherView> {
    const m = await this.imprest.get(user, id);
    const issued = !!m.issue?.journalId;
    const bank = await this.bank(m.issue?.bankAccountId);
    const view: VoucherView = {
      title: 'Imprest payment voucher',
      number: m.number,
      date: m.issue?.date ?? m.createdAt,
      status: m.status,
      stamp: issued ? (m.status === 'CANCELLED' ? 'CANCELLED' : null) : (STAMP[m.status] ?? 'NOT PAID'),
      issuer: await this.issuer(m.entityId, m.branchId),
      payee: { name: m.applicantName, code: '', taxId: '', lines: [`${m.typeName} imprest`, m.destination && `Destination: ${m.destination}`].filter(Boolean) as string[] },
      currency: m.currency,
      amount: fmt(m.amount),
      amountInWords: amountInWords(m.amount, m.currency),
      facts: [
        ['Activity', `${m.startDate.toISOString().slice(0, 10)} to ${m.endDate.toISOString().slice(0, 10)}`],
        ['Surrender by', m.surrenderDue ? m.surrenderDue.toISOString().slice(0, 10) : 'Set on issue'],
        ['Paid from', bank ? `${bank.name}${bank.accountNumber ? ` ${bank.accountNumber}` : ''}` : ''],
        ['Cheque / ref.', m.issue?.reference ?? ''],
      ],
      narration: m.purpose,
      particulars: m.lines.map((l, i) => ({ reference: `Item ${i + 1}`, description: l.description, amount: fmt(l.amount) })),
      particularsTotal: fmt(m.amount),
      deductions: [],
      ...(await this.coding([m.issue?.journalId])),
      signatures: await this.signatures(user.organisationId, ['IMPREST'], m._id, { prepared: [m.applicantId, m.submittedAt ?? m.createdAt], approved: [m.approvedBy, m.approvedAt], released: [m.issue?.issuedBy, m.issue?.date, 'Issued by'] }),
    };
    return view;
  }

  async imprestIssue(user: AuthUser, id: Types.ObjectId) {
    const view = await this.imprestView(user, id);
    return { data: await renderVoucherPdf(view), filename: `Imprest voucher ${view.number}.pdf` };
  }

  async claimView(user: AuthUser, id: Types.ObjectId): Promise<VoucherView> {
    const c = await this.expenses.get(user, id);
    const paid = c.status === 'PAID';
    const bank = await this.bank(c.payment?.bankAccountId);
    const categories = await this.db.expenseCategories.find({ _id: { $in: c.lines.map((l) => l.categoryId) } }, { name: 1 }).lean();
    const payCurrency = paid && c.payment?.currency && c.payment.amount ? c.payment.currency : c.currency;
    const payAmount: Decimal = paid && c.payment?.currency && c.payment.amount ? dec(c.payment.amount) : dec(c.total);
    const view: VoucherView = {
      title: 'Payment voucher',
      number: c.number,
      date: c.payment?.date ?? c.createdAt,
      status: c.status,
      stamp: paid ? null : (STAMP[c.status] ?? 'NOT PAID'),
      issuer: await this.issuer(c.entityId, c.branchId),
      payee: { name: c.claimantName, code: '', taxId: '', lines: ['Staff expense claim'] },
      currency: payCurrency,
      amount: fmt(payAmount),
      amountInWords: amountInWords(payAmount, payCurrency),
      facts: [
        ['Paid from', bank ? `${bank.name}${bank.accountNumber ? ` ${bank.accountNumber}` : ''}` : ''],
        ['Cheque / ref.', c.payment?.reference ?? ''],
        ...(payCurrency !== c.currency ? ([['Claim total', `${c.currency} ${fmt(c.total)}`]] as [string, string][]) : []),
      ],
      narration: c.title,
      particulars: c.lines.map((l) => ({
        reference: l.receiptReference || `Line ${l.lineNo}`,
        description: [l.date.toISOString().slice(0, 10), categories.find((x) => x._id.equals(l.categoryId))?.name, l.description, l.merchant].filter(Boolean).join(' · '),
        amount: fmt(l.amount),
      })),
      particularsTotal: fmt(c.total),
      deductions: [],
      ...(await this.coding([c.payment?.journalId])),
      signatures: await this.signatures(user.organisationId, ['EXPENSE_CLAIM'], c._id, { prepared: [c.claimantId, c.submittedAt ?? c.createdAt], approved: [c.approvedBy, c.approvedAt], released: [c.payment?.paidBy, c.payment?.date, 'Paid by'] }),
    };
    return view;
  }

  async claimPayment(user: AuthUser, id: Types.ObjectId) {
    const view = await this.claimView(user, id);
    return { data: await renderVoucherPdf(view), filename: `Payment voucher ${view.number}.pdf` };
  }
}
