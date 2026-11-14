import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { NotFoundException } from '../../common/errors';
import { Decimal, dec } from '../../common/money';
import { Db } from '../../database/db.service';

const DAY = 86_400_000;
const STOP = new Set(['the', 'and', 'for', 'of', 'to', 'a', 'an', 'in', 'on', 'at', 'by', 'from', 'with', 'ltd', 'limited', 'plc', 'inc', 'llc', 'co', 'kes', 'usd', 'ugx', 'eur', 'ref', 'no', 'payment', 'invoice', 'bill']);

/** Lower-case word tokens worth comparing (numbers kept: references are often numbers). */
export function tokens(text: string | null | undefined): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

const signed = (e: { debit: unknown; credit: unknown }) => dec(e.debit as never).minus(dec(e.credit as never));

interface MatchSuggestion {
  statementLineIds: Types.ObjectId[];
  ledgerEntryIds: Types.ObjectId[];
  kind: 'one-to-one' | 'one-to-many' | 'many-to-one';
  confidence: number;
  reasons: string[];
}

/**
 * Decision support from the organisation's own history: likely bank-statement matches with a
 * confidence and the evidence behind it, and likely accounts for bill lines and bank-only items.
 * Suggestions are never applied silently; the user accepts them and the normal controls apply.
 */
export class SuggestionsService {
  constructor(private readonly db: Db) {}

  // ----- Bank reconciliation ---------------------------------------------------------------------

  async bankMatches(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.db.bankAccounts.findOne({ _id: bankId, organisationId: user.organisationId }).lean();
    if (!bank) throw new NotFoundException('Bank account not found');
    const restricted = allowedBranches(user);
    if (restricted && !restricted.some((b) => b.equals(bank.branchId))) throw new NotFoundException('Bank account not found');
    const lines = await this.db.bankStatementLines.find({ organisationId: user.organisationId, bankAccountId: bank._id, status: 'UNMATCHED' }).sort({ date: 1 }).limit(1000).lean();
    const entryFilter: Record<string, unknown> = { organisationId: user.organisationId, entityId: bank.entityId, accountId: bank.glAccountId };
    if (bank.reconcileFrom) entryFilter.date = { $gte: bank.reconcileFrom };
    const all = await this.db.ledger.find(entryFilter).sort({ date: 1 }).limit(5000).lean();
    const matched = new Set((await this.db.bankMatches.find({ ledgerEntryIds: { $in: all.map((e) => e._id) } }, { ledgerEntryIds: 1 }).lean()).flatMap((m) => m.ledgerEntryIds.map(String)));
    const entries = all.filter((e) => !matched.has(e._id.toHexString()));

    // Names of the customers and suppliers behind each entry, to recognise them on the statement.
    const partyIds = entries.map((e) => e.partyId).filter((p): p is Types.ObjectId => !!p);
    const [customers, suppliers, payments] = await Promise.all([
      this.db.customers.find({ _id: { $in: partyIds } }, { name: 1, code: 1 }).lean(),
      this.db.suppliers.find({ _id: { $in: partyIds } }, { name: 1, code: 1 }).lean(),
      this.db.payments.find({ organisationId: user.organisationId, journalId: { $in: entries.map((e) => e.journalId) } }, { journalId: 1, number: 1, reference: 1 }).lean(),
    ]);
    const parties = new Map([...customers, ...suppliers].map((p) => [p._id.toHexString(), p]));
    const paymentByJournal = new Map(payments.map((p) => [p.journalId!.toHexString(), p]));
    const entryText = (e: (typeof entries)[number]) => {
      const party = e.partyId ? parties.get(e.partyId.toHexString()) : undefined;
      const pay = paymentByJournal.get(e.journalId.toHexString());
      return { tokens: tokens(`${e.description} ${e.journalNumber} ${party?.name ?? ''} ${party?.code ?? ''} ${pay?.number ?? ''} ${pay?.reference ?? ''}`), party: party?.name ?? null, refs: [e.journalNumber, pay?.number, pay?.reference].filter(Boolean) as string[] };
    };
    const texts = new Map(entries.map((e) => [e._id.toHexString(), entryText(e)]));

    const evidence = (line: (typeof lines)[number], es: typeof entries) => {
      const reasons: string[] = [];
      let score = 40; // amounts agree exactly
      const days = Math.max(...es.map((e) => Math.abs(e.date.getTime() - line.date.getTime()) / DAY));
      score += days <= 1 ? 25 : days <= 3 ? 15 : days <= 7 ? 5 : -10;
      reasons.push(days < 1 ? 'same day' : `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} apart`);
      const lineText = `${line.reference} ${line.description}`.toLowerCase();
      const lineTokens = tokens(lineText);
      const ref = es.flatMap((e) => texts.get(e._id.toHexString())!.refs).find((r) => r.length >= 4 && lineText.includes(r.toLowerCase()));
      if (ref) {
        score += 30;
        reasons.push(`reference ${ref} on the statement`);
      } else {
        const best = Math.max(...es.map((e) => similarity(lineTokens, texts.get(e._id.toHexString())!.tokens)));
        const party = es.map((e) => texts.get(e._id.toHexString())!.party).find((p) => p && similarity(tokens(p), lineTokens) >= 0.5);
        if (party) {
          score += 20;
          reasons.push(`${party} named on the statement`);
        } else if (best >= 0.3) {
          score += 10;
          reasons.push('similar description');
        }
      }
      return { confidence: Math.max(5, Math.min(99, score)), reasons };
    };

    const used = new Set<string>();
    const out: MatchSuggestion[] = [];
    // One-to-one first: the strongest evidence wins each entry.
    const pairs: { line: (typeof lines)[number]; e: (typeof entries)[number]; confidence: number; reasons: string[] }[] = [];
    for (const line of lines) {
      const amount = dec(line.amount);
      for (const e of entries) {
        if (!signed(e).eq(amount) || Math.abs(e.date.getTime() - line.date.getTime()) > 14 * DAY) continue;
        pairs.push({ line, e, ...evidence(line, [e]) });
      }
    }
    pairs.sort((a, b) => b.confidence - a.confidence);
    for (const p of pairs) {
      const lk = p.line._id.toHexString();
      const ek = p.e._id.toHexString();
      if (used.has(lk) || used.has(ek)) continue;
      used.add(lk);
      used.add(ek);
      out.push({ statementLineIds: [p.line._id], ledgerEntryIds: [p.e._id], kind: 'one-to-one', confidence: p.confidence, reasons: ['amount agrees', ...p.reasons] });
    }
    // One statement line for several book entries (a deposit of several receipts), up to four.
    for (const line of lines) {
      if (used.has(line._id.toHexString())) continue;
      const amount = dec(line.amount);
      const pool = entries
        .filter((e) => !used.has(e._id.toHexString()) && Math.abs(e.date.getTime() - line.date.getTime()) <= 5 * DAY && signed(e).isPos() === amount.isPos())
        .sort((a, b) => Math.abs(a.date.getTime() - line.date.getTime()) - Math.abs(b.date.getTime() - line.date.getTime()))
        .slice(0, 14);
      const combo = subsetSum(pool.map((e) => signed(e)), amount, 4);
      if (combo) {
        const es = combo.map((i) => pool[i]);
        es.forEach((e) => used.add(e._id.toHexString()));
        used.add(line._id.toHexString());
        const ev = evidence(line, es);
        out.push({ statementLineIds: [line._id], ledgerEntryIds: es.map((e) => e._id), kind: 'one-to-many', confidence: Math.max(5, ev.confidence - 15), reasons: [`${es.length} book entries add up to the statement line`, ...ev.reasons] });
      }
    }
    // Several statement lines for one book entry (a payment split by the bank), up to three.
    for (const e of entries) {
      if (used.has(e._id.toHexString())) continue;
      const amount = signed(e);
      const pool = lines.filter((l) => !used.has(l._id.toHexString()) && Math.abs(l.date.getTime() - e.date.getTime()) <= 5 * DAY && dec(l.amount).isPos() === amount.isPos()).slice(0, 12);
      const combo = subsetSum(pool.map((l) => dec(l.amount)), amount, 3);
      if (combo && combo.length > 1) {
        const ls = combo.map((i) => pool[i]);
        ls.forEach((l) => used.add(l._id.toHexString()));
        used.add(e._id.toHexString());
        out.push({ statementLineIds: ls.map((l) => l._id), ledgerEntryIds: [e._id], kind: 'many-to-one', confidence: 45, reasons: [`${ls.length} statement lines add up to ${e.journalNumber}`] });
      }
    }

    // Statement-only items (charges, interest): the account used for similar items before.
    const adjustments = await this.adjustmentHistory(user, bank.glAccountId);
    const unexplained = lines
      .filter((l) => !used.has(l._id.toHexString()))
      .map((l) => {
        const t = tokens(`${l.reference} ${l.description}`);
        const ranked = rankAccounts(adjustments.map((h) => ({ accountId: h.accountId, weight: similarity(t, h.tokens) })));
        return ranked[0] && ranked[0].score >= 0.5 ? { statementLineId: l._id, accountId: ranked[0].accountId, confidence: Math.round(Math.min(95, ranked[0].score * 60 + ranked[0].count * 5)), reason: `like ${ranked[0].count} earlier item${ranked[0].count === 1 ? '' : 's'}` } : null;
      })
      .filter((x) => x !== null);
    const accounts = await this.db.accounts.find({ _id: { $in: unexplained.map((u) => u.accountId) } }, { code: 1, name: 1 }).lean();
    return {
      matches: out.sort((a, b) => b.confidence - a.confidence),
      adjustments: unexplained.map((u) => ({ ...u, account: accounts.find((a) => a._id.equals(u.accountId)) ?? null })),
    };
  }

  private async adjustmentHistory(user: AuthUser, bankGl: Types.ObjectId) {
    const journals = await this.db.journals.find({ organisationId: user.organisationId, sourceType: 'BankStatementLine', status: 'POSTED' }, { lines: 1, description: 1 }).sort({ createdAt: -1 }).limit(500).lean();
    return journals.flatMap((j) => {
      const contra = j.lines.find((l) => !l.accountId.equals(bankGl));
      return contra ? [{ accountId: contra.accountId, tokens: tokens(`${contra.description} ${j.description}`) }] : [];
    });
  }

  // ----- Account coding --------------------------------------------------------------------------

  /**
   * Likely accounts for a bill (or sales) line: what this party's earlier lines used, and what lines
   * with similar descriptions used across all parties.
   */
  async coding(user: AuthUser, q: { side: 'purchase' | 'sales'; partyId?: Types.ObjectId; description?: string }) {
    const kinds = q.side === 'purchase' ? ['PURCHASE_BILL', 'PURCHASE_CREDIT'] : ['SALES_INVOICE', 'SALES_CREDIT'];
    const docs = await this.db.invoices.find({ organisationId: user.organisationId, kind: { $in: kinds }, status: 'POSTED' }, { partyId: 1, lines: 1 }).sort({ date: -1 }).limit(1500).lean();
    const t = tokens(q.description);
    const votes: { accountId: Types.ObjectId; weight: number; party: boolean; text: boolean }[] = [];
    for (const d of docs) {
      const sameParty = !!q.partyId && d.partyId.equals(q.partyId);
      for (const l of d.lines) {
        const sim = similarity(t, tokens(l.description));
        if (!sameParty && sim < 0.5) continue;
        votes.push({ accountId: l.accountId, weight: (sameParty ? 1 : 0) + sim * 2, party: sameParty, text: sim >= 0.5 });
      }
    }
    const ranked = rankAccounts(votes).slice(0, 3);
    const accounts = await this.db.accounts.find({ _id: { $in: ranked.map((r) => r.accountId) }, isActive: true, isPostable: true }, { code: 1, name: 1, allowManualPosting: 1 }).lean();
    const total = ranked.reduce((s, r) => s + r.score, 0) || 1;
    return ranked
      .map((r) => {
        const a = accounts.find((x) => x._id.equals(r.accountId));
        if (!a || !a.allowManualPosting) return null;
        const v = votes.filter((x) => x.accountId.equals(r.accountId));
        const fromParty = v.filter((x) => x.party).length;
        const fromText = v.filter((x) => x.text).length;
        return {
          accountId: a._id,
          code: a.code,
          name: a.name,
          confidence: Math.round(Math.min(97, (r.score / total) * 100 * Math.min(1, r.count / 3))),
          reason: [fromParty ? `${fromParty} earlier line${fromParty === 1 ? '' : 's'} from this ${q.side === 'purchase' ? 'supplier' : 'customer'}` : '', fromText ? `${fromText} similar description${fromText === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '),
        };
      })
      .filter((x) => x !== null);
  }
}

function rankAccounts(votes: { accountId: Types.ObjectId; weight: number }[]) {
  const by = new Map<string, { accountId: Types.ObjectId; score: number; count: number }>();
  for (const v of votes) {
    if (v.weight <= 0) continue;
    const k = v.accountId.toHexString();
    const cur = by.get(k) ?? { accountId: v.accountId, score: 0, count: 0 };
    cur.score += v.weight;
    cur.count++;
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => b.score - a.score);
}

/** Indexes of up to `max` values (of at least two) that add up exactly to the target, preferring fewer. */
function subsetSum(values: Decimal[], target: Decimal, max: number): number[] | null {
  for (let size = 2; size <= Math.min(max, values.length); size++) {
    const pick: number[] = [];
    const walk = (start: number, total: Decimal): number[] | null => {
      if (pick.length === size) return total.eq(target) ? [...pick] : null;
      for (let i = start; i < values.length; i++) {
        pick.push(i);
        const found = walk(i + 1, total.plus(values[i]));
        if (found) return found;
        pick.pop();
      }
      return null;
    };
    const found = walk(0, new Decimal(0));
    if (found) return found;
  }
  return null;
}

