import { NotFoundException } from '../../common/errors';
import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { Decimal, dec, sum } from '../../common/money';
import { Db } from '../../database/db.service';
import { PartyType } from '../../database/schemas';
import { partyModel, requirePermission } from '../documents/documents.service';
import { SettlementService, SIDES } from '../settlement/settlement.service';

const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
type Bucket = (typeof BUCKETS)[number];
const DAY = 86_400_000;

function bucketOf(dueDate: Date, asOf: Date): Bucket {
  const days = Math.floor((asOf.getTime() - dueDate.getTime()) / DAY);
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'over90';
}

const zeroBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b, new Decimal(0)])) as Record<Bucket, Decimal>;

export class SubledgerReportsService {
  constructor(
    private readonly db: Db,
    private readonly settlement: SettlementService,
  ) {}

  private async entity(user: AuthUser, entityId: Types.ObjectId) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    return entity;
  }

  private scope(user: AuthUser, entityId: Types.ObjectId): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, entityId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  /** Allocated amounts per document/source up to a date, from active allocations. */
  private async allocatedTo(user: AuthUser, ids: Types.ObjectId[], asOf: Date, field: 'documentId' | 'sourceId') {
    const rows = await this.db.allocations.aggregate<{ _id: Types.ObjectId; amount: unknown; documentFunctional: unknown; sourceFunctional: unknown }>([
      { $match: { organisationId: user.organisationId, status: 'ACTIVE', date: { $lte: asOf }, [field]: { $in: ids } } },
      { $group: { _id: `$${field}`, amount: { $sum: '$amount' }, documentFunctional: { $sum: '$documentFunctional' }, sourceFunctional: { $sum: '$sourceFunctional' } } },
    ]);
    return new Map(rows.map((r) => [r._id.toHexString(), r]));
  }

  /**
   * Aged receivables or payables as at a date, by days past due. Each party is shown in its own
   * currency with functional-currency equivalents at carrying value; unapplied credits are separate.
   */
  async aging(user: AuthUser, partyType: PartyType, entityId: Types.ObjectId, asOf: Date) {
    requirePermission(user, partyType, 'view');
    const entity = await this.entity(user, entityId);
    const side = SIDES[partyType];
    const base = { ...this.scope(user, entityId), status: 'POSTED', date: { $lte: asOf } };
    // Only items that could be open at the date: open now, or settled by something dated after it.
    // A fully settled item whose settlements are all on or before the date is zero then too.
    const later = await this.db.allocations.find({ organisationId: user.organisationId, entityId, partyType, status: 'ACTIVE', date: { $gt: asOf } }, { documentId: 1, sourceId: 1 }).lean();
    const laterDocs = later.map((a) => a.documentId);
    const laterSources = later.map((a) => a.sourceId);
    const zero = Types.Decimal128.fromString('0');
    const [docs, creditNotes, payments] = await Promise.all([
      this.db.invoices.find({ ...base, kind: side.document, $or: [{ amountDue: { $ne: zero } }, { _id: { $in: laterDocs } }] }, { lines: 0 }).lean(),
      this.db.invoices.find({ ...base, kind: side.credit, $or: [{ amountDue: { $ne: zero } }, { _id: { $in: laterSources } }] }, { lines: 0 }).lean(),
      this.db.payments.find({ ...base, partyType, $or: [{ unallocated: { $ne: zero } }, { _id: { $in: laterSources } }] }).lean(),
    ]);
    const [docAlloc, cnAlloc, payAlloc] = await Promise.all([
      this.allocatedTo(user, docs.map((d) => d._id), asOf, 'documentId'),
      this.allocatedTo(user, creditNotes.map((d) => d._id), asOf, 'sourceId'),
      this.allocatedTo(user, payments.map((d) => d._id), asOf, 'sourceId'),
    ]);

    interface Row {
      partyId: string;
      partyName: string;
      currency: string;
      buckets: Record<Bucket, Decimal>;
      bucketsFunctional: Record<Bucket, Decimal>;
      credits: Decimal;
      creditsFunctional: Decimal;
      documents: { id: Types.ObjectId; number: string; date: Date; dueDate: Date; daysOverdue: number; open: Decimal; openFunctional: Decimal; reference: string }[];
    }
    const rows = new Map<string, Row>();
    const row = (partyId: Types.ObjectId, partyName: string, currency: string) => {
      const key = partyId.toHexString();
      let r = rows.get(key);
      if (!r) {
        r = { partyId: key, partyName, currency, buckets: zeroBuckets(), bucketsFunctional: zeroBuckets(), credits: new Decimal(0), creditsFunctional: new Decimal(0), documents: [] };
        rows.set(key, r);
      }
      return r;
    };
    for (const d of docs) {
      const a = docAlloc.get(d._id.toHexString());
      const open = dec(d.total).minus(dec(a?.amount as never));
      if (open.lte(0)) continue;
      const openF = dec(d.totalFunctional).minus(dec(a?.documentFunctional as never));
      const r = row(d.partyId, d.partyName, d.currency);
      const b = bucketOf(d.dueDate, asOf);
      r.buckets[b] = r.buckets[b].plus(open);
      r.bucketsFunctional[b] = r.bucketsFunctional[b].plus(openF);
      r.documents.push({
        id: d._id,
        number: d.number,
        date: d.date,
        dueDate: d.dueDate,
        daysOverdue: Math.max(0, Math.floor((asOf.getTime() - d.dueDate.getTime()) / DAY)),
        open,
        openFunctional: openF,
        reference: d.supplierInvoiceNumber || d.reference,
      });
    }
    for (const c of creditNotes) {
      const a = cnAlloc.get(c._id.toHexString());
      const open = dec(c.total).minus(dec(a?.amount as never));
      if (open.lte(0)) continue;
      const r = row(c.partyId, c.partyName, c.currency);
      r.credits = r.credits.plus(open);
      r.creditsFunctional = r.creditsFunctional.plus(dec(c.totalFunctional).minus(dec(a?.sourceFunctional as never)));
    }
    for (const p of payments) {
      const a = payAlloc.get(p._id.toHexString());
      const value = dec(p.amount).plus(dec(p.withholdingAmount));
      const open = value.minus(dec(a?.amount as never));
      if (open.lte(0)) continue;
      const r = row(p.partyId, p.partyName, p.currency);
      r.credits = r.credits.plus(open);
      r.creditsFunctional = r.creditsFunctional.plus(dec(p.amountFunctional).plus(dec(p.withholdingAmountFunctional)).minus(dec(a?.sourceFunctional as never)));
    }

    const result = [...rows.values()]
      .map((r) => ({
        ...r,
        total: sum(Object.values(r.buckets)).minus(r.credits),
        totalFunctional: sum(Object.values(r.bucketsFunctional)).minus(r.creditsFunctional),
        documents: r.documents.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime()),
      }))
      .sort((a, b) => a.partyName.localeCompare(b.partyName));
    const totals = Object.fromEntries(BUCKETS.map((b) => [b, sum(result.map((r) => r.bucketsFunctional[b]))])) as Record<Bucket, Decimal>;
    const credits = sum(result.map((r) => r.creditsFunctional));
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: entity.functionalCurrency,
      partyType,
      asOf,
      rows: result,
      totals: { ...totals, credits, total: sum(Object.values(totals)).minus(credits) },
    };
  }

  /** A customer or supplier statement in the party's currency, with a running balance. */
  async statement(user: AuthUser, partyType: PartyType, partyId: Types.ObjectId, entityId: Types.ObjectId, from: Date, to: Date) {
    requirePermission(user, partyType, 'view');
    const entity = await this.entity(user, entityId);
    const party = await partyModel(this.db, partyType).findOne({ _id: partyId, organisationId: user.organisationId }).lean();
    if (!party) throw new NotFoundException('Not found');
    const side = SIDES[partyType];
    const base = { ...this.scope(user, entityId), partyId, status: { $in: ['POSTED', 'VOID'] }, date: { $lte: to } };
    const [docs, payments] = await Promise.all([
      this.db.invoices.find({ ...base, kind: { $in: [side.document, side.credit] } }, { lines: 0 }).lean(),
      this.db.payments.find({ ...base, partyType }).lean(),
    ]);
    const label: Record<string, string> = {
      SALES_INVOICE: 'Invoice',
      SALES_CREDIT: 'Credit note',
      PURCHASE_BILL: 'Bill',
      PURCHASE_CREDIT: 'Supplier credit',
      RECEIPT: 'Receipt',
      PAYMENT: 'Payment',
    };
    type Entry = { date: Date; type: string; number: string; id: Types.ObjectId; reference: string; dueDate?: Date; charge: Decimal; credit: Decimal; link: 'invoices' | 'payments' };
    const entries: Entry[] = [];
    for (const d of docs) {
      const amount = dec(d.total);
      const increases = d.kind === side.document;
      entries.push({ date: d.date, type: label[d.kind], number: d.number, id: d._id, reference: d.supplierInvoiceNumber || d.reference, dueDate: d.dueDate, charge: increases ? amount : new Decimal(0), credit: increases ? new Decimal(0) : amount, link: 'invoices' });
      if (d.status === 'VOID' && d.voidedAt) {
        const voidDate = (await this.db.journals.findById(d.voidJournalId, { journalDate: 1 }).lean())?.journalDate ?? d.voidedAt;
        if (voidDate <= to) {
          entries.push({ date: voidDate, type: `Void of ${label[d.kind].toLowerCase()}`, number: d.number, id: d._id, reference: d.voidReason, charge: increases ? new Decimal(0) : amount, credit: increases ? amount : new Decimal(0), link: 'invoices' });
        }
      }
    }
    for (const p of payments) {
      const value = dec(p.amount).plus(dec(p.withholdingAmount));
      const ref = [p.reference, dec(p.withholdingAmount).gt(0) ? `incl. ${dec(p.withholdingAmount).toFixed()} withholding tax` : ''].filter(Boolean).join(' · ');
      entries.push({ date: p.date, type: label[p.kind], number: p.number, id: p._id, reference: ref, charge: new Decimal(0), credit: value, link: 'payments' });
      if (p.status === 'VOID' && p.voidJournalId) {
        const voidDate = (await this.db.journals.findById(p.voidJournalId, { journalDate: 1 }).lean())?.journalDate ?? p.voidedAt!;
        if (voidDate <= to) entries.push({ date: voidDate, type: `Void of ${label[p.kind].toLowerCase()}`, number: p.number, id: p._id, reference: p.voidReason, charge: value, credit: new Decimal(0), link: 'payments' });
      }
    }
    entries.sort((a, b) => a.date.getTime() - b.date.getTime() || a.number.localeCompare(b.number));
    let opening = new Decimal(0);
    const lines: (Entry & { balance: Decimal })[] = [];
    let balance = new Decimal(0);
    for (const e of entries) {
      if (e.date < from) {
        opening = opening.plus(e.charge).minus(e.credit);
        balance = opening;
        continue;
      }
      balance = balance.plus(e.charge).minus(e.credit);
      lines.push({ ...e, balance });
    }
    const aging = await this.aging(user, partyType, entityId, to);
    const agingRow = aging.rows.find((r) => r.partyId === partyId.toHexString());
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name, legalName: entity.legalName, taxId: entity.taxId },
      party: { id: party._id, code: party.code, name: party.name, address: party.address, city: party.city, country: party.country, email: party.email, taxId: party.taxId },
      partyType,
      currency: party.currency,
      from,
      to,
      openingBalance: opening,
      closingBalance: balance,
      lines,
      aging: agingRow ? { ...agingRow.buckets, credits: agingRow.credits } : null,
    };
  }

  /**
   * Month-end control: the AR and AP subledgers (open items at carrying value) must agree with the
   * control accounts in the general ledger, in total and per customer or supplier.
   */
  async controlCheck(user: AuthUser, entityId: Types.ObjectId) {
    const entity = await this.entity(user, entityId);
    const accounts = await this.settlement.accounts(user.organisationId);
    const out = [];
    // Unrealised FX revaluation adjusts the control accounts but not the open items' carrying values;
    // it is shown as a reconciling item and reverses on the following day.
    const revaluationJournals = await this.db.journals.find({ organisationId: user.organisationId, entityId, sourceType: 'FxRevaluation' }, { _id: 1 }).lean();
    const revaluationIds = new Set(revaluationJournals.map((j) => j._id.toHexString()));
    for (const partyType of ['CUSTOMER', 'SUPPLIER'] as PartyType[]) {
      const control = partyType === 'CUSTOMER' ? accounts.receivables : accounts.payables;
      if (!control) continue;
      const sign = partyType === 'CUSTOMER' ? 1 : -1;
      const subledger = await this.settlement.balances(user.organisationId, partyType, undefined, entityId);
      const gl = await this.db.ledger.aggregate<{ _id: { party: Types.ObjectId | null; journal: Types.ObjectId }; debit: unknown; credit: unknown }>([
        { $match: { organisationId: user.organisationId, entityId, accountId: control } },
        { $group: { _id: { party: '$partyId', journal: '$journalId' }, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ]);
      const glBy = new Map<string, Decimal>();
      let revaluation = new Decimal(0);
      for (const g of gl) {
        const amount = dec(g.debit as never).minus(dec(g.credit as never)).times(sign);
        if (revaluationIds.has(g._id.journal.toHexString())) {
          revaluation = revaluation.plus(amount);
          continue;
        }
        const key = g._id.party?.toHexString() ?? 'none';
        glBy.set(key, (glBy.get(key) ?? new Decimal(0)).plus(amount));
      }
      const keys = new Set([...subledger.keys(), ...glBy.keys()]);
      const parties = await partyModel(this.db, partyType)
        .find({ _id: { $in: [...keys].filter((k) => k !== 'none') } }, { name: 1, code: 1 })
        .lean();
      const differences = [...keys]
        .map((k) => {
          const sub = subledger.get(k)?.outstandingFunctional ?? new Decimal(0);
          const g = glBy.get(k) ?? new Decimal(0);
          const p = parties.find((x) => x._id.toHexString() === k);
          return { partyId: k === 'none' ? null : k, name: k === 'none' ? 'Entries without a customer or supplier' : (p?.name ?? 'Unknown'), subledger: sub, ledger: g, difference: g.minus(sub) };
        })
        .filter((d) => !d.difference.isZero());
      const subTotal = sum([...subledger.values()].map((v) => v.outstandingFunctional));
      const glTotal = sum([...glBy.values()]);
      const account = await this.db.accounts.findById(control, { code: 1, name: 1 }).lean();
      out.push({
        partyType,
        account: account && { id: account._id, code: account.code, name: account.name },
        subledger: subTotal,
        ledger: glTotal.plus(revaluation),
        revaluation,
        difference: glTotal.minus(subTotal),
        reconciled: glTotal.eq(subTotal),
        differences,
      });
    }
    return { entity: { id: entity._id, code: entity.code, name: entity.name }, currency: entity.functionalCurrency, checks: out };
  }
}
