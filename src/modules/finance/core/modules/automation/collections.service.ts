import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum, toD128 } from '../../common/money';
import { Db } from '../../database/db.service';
import { COLLECTION_ACTIVITY_TYPES } from '../../database/automation.schemas';
import { AuditService } from '../audit/audit.service';
import { SubledgerReportsService } from '../reports/subledger-reports.service';
import { EmailService, escapeHtml, layout } from '../communication/email.service';
import { SmsService } from '../communication/sms.service';

const DAY = 86_400_000;
type Priority = 'high' | 'medium' | 'low';

/**
 * Collections: a prioritised worklist of customers with overdue balances, the contact history and
 * promises to pay, and reminder letters whose tone follows how late the account is.
 */
export class CollectionsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly subledgers: SubledgerReportsService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
  ) {}

  /** A short reminder by text message to the customer's phone, and a record of the contact. */
  async smsReminder(user: AuthUser, entityId: Types.ObjectId, customerId: Types.ObjectId, asOf: Date, to?: string) {
    const letter = await this.letter(user, entityId, customerId, asOf);
    const customer = await this.db.customers.findById(customerId, { phone: 1 }).lean();
    const phone = to ?? customer?.phone ?? '';
    if (!phone) throw new BadRequestException(`${letter.to.name} has no phone number; add one or enter where to send it`);
    const fmt = (d: Decimal) => d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const paybill = await this.db.bankAccounts.findOne({ organisationId: user.organisationId, entityId, isActive: true, 'mpesa.enabled': true, currency: letter.currency }, { 'mpesa.shortCode': 1, 'mpesa.shortCodeType': 1 }).lean();
    const how = paybill?.mpesa ? (paybill.mpesa.shortCodeType === 'TILL' ? ` Pay via M-Pesa till ${paybill.mpesa.shortCode}.` : ` Pay via M-Pesa paybill ${paybill.mpesa.shortCode}, account = invoice number.`) : '';
    const oldest = letter.items[0];
    const message =
      letter.stage === 'final'
        ? `${letter.from.name}: FINAL NOTICE. ${letter.currency} ${fmt(letter.total)} is overdue on your account (oldest ${oldest.number}, ${oldest.daysOverdue} days).${how} Please pay or call us to avoid your account being put on hold.`
        : `${letter.from.name}: ${letter.currency} ${fmt(letter.total)} is overdue on your account (${letter.items.length} invoice${letter.items.length === 1 ? '' : 's'}, oldest ${oldest.number}).${how} If already paid, thank you.`;
    await this.sms.enqueue({ organisationId: user.organisationId, to: phone, message, category: 'reminder', related: { type: 'Customer', id: customerId } });
    await this.log(user, { entityId, customerId, type: 'SMS', note: `${letter.stage === 'final' ? 'Final notice' : 'Reminder'} texted to ${phone}` });
    return { sentTo: phone, stage: letter.stage };
  }

  /** Emails the reminder letter to the customer (replies go to the sender) and records the contact. */
  async sendReminder(user: AuthUser, entityId: Types.ObjectId, customerId: Types.ObjectId, asOf: Date, to?: string) {
    const letter = await this.letter(user, entityId, customerId, asOf);
    const address = to ?? letter.to.email;
    if (!address) throw new BadRequestException(`${letter.to.name} has no email address; add one or enter where to send it`);
    const fmt = (d: Decimal) => d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const table = `<table role="presentation" cellspacing="0" cellpadding="6" style="width:100%;margin:0 0 14px;font-size:13px;border-collapse:collapse">
<tr style="background:#f6f6fa;text-align:left"><th>Invoice</th><th>Due</th><th style="text-align:right">Days overdue</th><th style="text-align:right">Amount (${escapeHtml(letter.currency)})</th></tr>
${letter.items.map((i) => `<tr style="border-top:1px solid #e4e4ec"><td>${escapeHtml(i.number)}${i.reference ? ` (${escapeHtml(i.reference)})` : ''}</td><td>${i.dueDate.toISOString().slice(0, 10)}</td><td style="text-align:right">${i.daysOverdue}</td><td style="text-align:right">${fmt(i.open)}</td></tr>`).join('')}
<tr style="border-top:2px solid #1b1c2b;font-weight:700"><td colspan="3">Total overdue</td><td style="text-align:right">${fmt(letter.total)}</td></tr></table>`;
    const body = layout({
      title: letter.subject,
      intro: `Dear ${letter.to.name},`,
      paragraphs: letter.paragraphs.slice(0, 1),
      html: `${table}${letter.paragraphs
        .slice(1)
        .map((p) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#1b1c2b">${escapeHtml(p)}</p>`)
        .join('')}<p style="margin:0;font-size:14px;color:#1b1c2b">Yours sincerely,<br>${escapeHtml(letter.signedBy)}<br>${escapeHtml(letter.from.name)}</p>`,
      footer: `Sent by ${letter.from.name} through FarajaSoft. Reply to this email to reach ${letter.signedBy}.`,
    });
    await this.email.enqueue({ organisationId: user.organisationId, to: [address], replyTo: user.email, subject: `${letter.subject} — ${letter.from.name}`, ...body, category: 'reminder', related: { type: 'Customer', id: customerId } });
    await this.log(user, { entityId, customerId, type: 'EMAIL', note: `${letter.subject} emailed to ${address}` });
    return { sentTo: address, stage: letter.stage };
  }

  /** Average days customers paid after the due date, over the last year. */
  private async paymentBehaviour(user: AuthUser, entityId: Types.ObjectId, asOf: Date) {
    const allocations = await this.db.allocations.find({ organisationId: user.organisationId, entityId, partyType: 'CUSTOMER', status: 'ACTIVE', date: { $gte: new Date(asOf.getTime() - 365 * DAY), $lte: asOf } }, { partyId: 1, date: 1, documentId: 1 }).lean();
    const docs = await this.db.invoices.find({ _id: { $in: allocations.map((a) => a.documentId) } }, { dueDate: 1 }).lean();
    const due = new Map(docs.map((d) => [d._id.toHexString(), d.dueDate]));
    const late = new Map<string, number[]>();
    for (const a of allocations) {
      const d = due.get(a.documentId.toHexString());
      if (!d) continue;
      const k = a.partyId.toHexString();
      late.set(k, [...(late.get(k) ?? []), Math.round((a.date.getTime() - d.getTime()) / DAY)]);
    }
    return new Map([...late].map(([k, xs]) => [k, { averageDaysLate: Math.round(xs.reduce((s, x) => s + x, 0) / xs.length), payments: xs.length }]));
  }

  async worklist(user: AuthUser, entityId: Types.ObjectId, asOf: Date) {
    const aging = await this.subledgers.aging(user, 'CUSTOMER', entityId, asOf);
    const ids = aging.rows.map((r) => new Types.ObjectId(r.partyId));
    const [customers, activities, behaviour] = await Promise.all([
      this.db.customers.find({ _id: { $in: ids } }, { code: 1, name: 1, email: 1, phone: 1, creditLimit: 1, onHold: 1, paymentTermsDays: 1, intercompanyEntityId: 1 }).lean(),
      this.db.collectionActivities.find({ organisationId: user.organisationId, entityId, customerId: { $in: ids } }).sort({ createdAt: -1 }).lean(),
      this.paymentBehaviour(user, entityId, asOf),
    ]);
    const lastPayments = await this.db.payments
      .aggregate<{ _id: Types.ObjectId; date: Date }>([{ $match: { organisationId: user.organisationId, entityId, kind: 'RECEIPT', status: 'POSTED', partyId: { $in: ids } } }, { $group: { _id: '$partyId', date: { $max: '$date' } } }]);

    const rows = aging.rows
      .map((r) => {
        const overdueDocs = r.documents.filter((d) => d.daysOverdue > 0);
        const overdue = sum(overdueDocs.map((d) => d.openFunctional));
        if (overdue.lte(0)) return null;
        const id = r.partyId;
        const customer = customers.find((c) => c._id.toHexString() === id);
        // Group companies settle through intercompany accounts, not collections.
        if (customer?.intercompanyEntityId) return null;
        const acts = activities.filter((a) => a.customerId.toHexString() === id);
        const lastPayment = lastPayments.find((p) => p._id.toHexString() === id)?.date ?? null;
        const promise = acts.find((a) => a.type === 'PROMISE');
        // A promise is broken if its date passed without a payment since it was made.
        const promiseBroken = !!promise?.promiseDate && promise.promiseDate < asOf && !(lastPayment && lastPayment >= (promise as { createdAt?: Date }).createdAt!);
        const promiseOpen = !!promise?.promiseDate && promise.promiseDate >= asOf && !(lastPayment && lastPayment >= (promise as { createdAt?: Date }).createdAt!);
        const dispute = acts.find((a) => a.type === 'DISPUTE' && Date.now() - ((a as { createdAt?: Date }).createdAt?.getTime() ?? 0) < 60 * DAY);
        const oldest = Math.max(...overdueDocs.map((d) => d.daysOverdue));
        const history = behaviour.get(id);
        const exposure = customer?.creditLimit ? dec(r.totalFunctional).div(dec(customer.creditLimit)) : null;
        // Score: size of the debt (log scale) times how late it is, raised for broken promises and habitual lateness.
        const lateness = oldest > 90 ? 4 : oldest > 60 ? 3 : oldest > 30 ? 2 : 1;
        let score = Math.log10(Math.max(10, overdue.toNumber())) * lateness;
        if (promiseBroken) score *= 1.5;
        if (history && history.averageDaysLate > 30) score *= 1.2;
        if (promiseOpen) score *= 0.5;
        if (dispute) score *= 0.6;
        const priority: Priority = promiseBroken || oldest > 60 || score >= 12 ? 'high' : oldest > 30 || score >= 7 ? 'medium' : 'low';
        const action = dispute
          ? 'Resolve the dispute before chasing'
          : promiseBroken
            ? `Call: promised ${promise!.promiseDate!.toISOString().slice(0, 10)} and has not paid`
            : promiseOpen
              ? `Wait for the promised payment on ${promise!.promiseDate!.toISOString().slice(0, 10)}`
              : oldest > 90
                ? `Final notice${customer?.onHold ? '' : '; consider a credit hold'}`
                : oldest > 60
                  ? 'Second reminder and a call'
                  : oldest > 30
                    ? 'Call the customer'
                    : 'Send a friendly reminder';
        return {
          customerId: id,
          code: customer?.code ?? '',
          name: r.partyName,
          email: customer?.email ?? '',
          phone: customer?.phone ?? '',
          currency: aging.currency,
          overdue,
          total: r.totalFunctional,
          oldestDaysOverdue: oldest,
          overdueInvoices: overdueDocs.length,
          buckets: r.bucketsFunctional,
          creditLimitUsedPercent: exposure ? exposure.times(100).toDecimalPlaces(0).toNumber() : null,
          onHold: !!customer?.onHold,
          averageDaysLate: history?.averageDaysLate ?? null,
          lastPaymentDate: lastPayment,
          lastContact: acts[0] ? { type: acts[0].type, at: (acts[0] as { createdAt?: Date }).createdAt, by: acts[0].createdByName, note: acts[0].note } : null,
          followUpDate: acts.find((a) => a.followUpDate)?.followUpDate ?? null,
          promise: promise?.promiseDate ? { date: promise.promiseDate, amount: promise.promiseAmount ? dec(promise.promiseAmount) : null, broken: promiseBroken } : null,
          disputed: !!dispute,
          score: Math.round(score * 10) / 10,
          priority,
          action,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);
    return {
      currency: aging.currency,
      asOf,
      totals: { overdue: sum(rows.map((r) => r.overdue)), customers: rows.length, high: rows.filter((r) => r.priority === 'high').length, brokenPromises: rows.filter((r) => r.promise?.broken).length },
      rows,
    };
  }

  async activities(user: AuthUser, entityId: Types.ObjectId, customerId: Types.ObjectId) {
    return this.db.collectionActivities.find({ organisationId: user.organisationId, entityId, customerId }).sort({ createdAt: -1 }).limit(100).lean();
  }

  async log(user: AuthUser, input: { entityId: Types.ObjectId; customerId: Types.ObjectId; type: (typeof COLLECTION_ACTIVITY_TYPES)[number]; note?: string; promiseDate?: Date | null; promiseAmount?: Decimal | null; followUpDate?: Date | null }) {
    const customer = await this.db.customers.findOne({ _id: input.customerId, organisationId: user.organisationId }).lean();
    if (!customer) throw new NotFoundException('Customer not found');
    if (input.type === 'PROMISE' && !input.promiseDate) throw new BadRequestException('A promise to pay needs a date');
    const [a] = await this.db.collectionActivities.create([
      {
        organisationId: user.organisationId,
        entityId: input.entityId,
        customerId: customer._id,
        type: input.type,
        note: input.note ?? '',
        promiseDate: input.promiseDate ?? null,
        promiseAmount: input.promiseAmount ? toD128(input.promiseAmount) : null,
        followUpDate: input.followUpDate ?? null,
        createdBy: user.id,
        createdByName: user.name,
      },
    ]);
    await this.audit.log(user, { action: 'collections.activity', recordType: 'Customer', recordId: customer._id, summary: `${input.type.toLowerCase()} with ${customer.name}${input.promiseDate ? `: promised ${input.promiseDate.toISOString().slice(0, 10)}` : ''}${input.note ? ` — ${input.note}` : ''}` });
    return a.toObject();
  }

  /** A reminder letter; the tone follows the oldest overdue invoice. */
  async letter(user: AuthUser, entityId: Types.ObjectId, customerId: Types.ObjectId, asOf: Date) {
    const [aging, customer, entity, org] = await Promise.all([
      this.subledgers.aging(user, 'CUSTOMER', entityId, asOf),
      this.db.customers.findOne({ _id: customerId, organisationId: user.organisationId }).lean(),
      this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean(),
      this.db.organisations.findById(user.organisationId, { name: 1 }).lean(),
    ]);
    if (!customer || !entity) throw new NotFoundException('Customer not found');
    const row = aging.rows.find((r) => r.partyId === customerId.toHexString());
    const overdue = (row?.documents ?? []).filter((d) => d.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue);
    if (!overdue.length) throw new BadRequestException(`${customer.name} has nothing overdue`);
    const oldest = overdue[0].daysOverdue;
    const stage = oldest > 60 ? 'final' : oldest > 30 ? 'firm' : 'friendly';
    const total = sum(overdue.map((d) => d.open));
    const currency = row!.currency;
    const fmt = (d: Decimal) => d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const due = new Date(asOf.getTime() + (stage === 'final' ? 7 : 14) * DAY).toISOString().slice(0, 10);
    const paragraphs =
      stage === 'friendly'
        ? [
            `Our records show that the invoices below, totalling ${currency} ${fmt(total)}, are now past their due date. This may simply have been overlooked.`,
            `We would be grateful if you could arrange payment by ${due}. If you have already paid, please accept our thanks and send us the remittance details so we can match it.`,
          ]
        : stage === 'firm'
          ? [
              `Despite our earlier reminder, ${currency} ${fmt(total)} remains outstanding on the invoices below, the oldest now ${oldest} days overdue.`,
              `Please arrange payment by ${due}, or contact us at once if there is a query on any invoice so that we can resolve it.`,
            ]
          : [
              `${currency} ${fmt(total)} is seriously overdue, the oldest invoice by ${oldest} days, and we have not received payment or an explanation despite our reminders.`,
              `Unless payment is received by ${due}, we will place your account on hold and may take further steps to recover the debt without further notice.`,
            ];
    return {
      stage,
      date: asOf,
      from: { name: entity.legalName || entity.name, organisation: org?.name ?? '', taxId: entity.taxId, country: entity.country },
      to: { name: customer.name, legalName: customer.legalName, address: customer.address, city: customer.city, country: customer.country, email: customer.email },
      subject: stage === 'final' ? 'Final notice: overdue account' : stage === 'firm' ? 'Second reminder: overdue invoices' : 'Payment reminder',
      paragraphs,
      currency,
      items: overdue.map((d) => ({ number: d.number, date: d.date, dueDate: d.dueDate, daysOverdue: d.daysOverdue, reference: d.reference, open: d.open })),
      total,
      payBy: due,
      signedBy: user.name,
    };
  }
}
