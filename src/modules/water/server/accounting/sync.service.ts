import { Types } from 'mongoose';
import { formatDate } from '@/platform/common/validation';
import { LedgerService } from '@/platform/ledger/ledger.service';
import { WaterDb as Db, waterSettings } from '@/modules/water/server/db';
import { adjustmentJournalLines, AccountMapping, billRunJournalLines, chargeAccount, channelAccount, feeJournalLines, JournalLine, missingAccounts, PaymentChannel, paymentJournalLines } from './journals';

type Kind = 'billRun' | 'payment' | 'reversal' | 'adjustment' | 'fee';

interface Prepared {
  date: string;
  description: string;
  reference: string;
  lines: JournalLine[];
  uses: (keyof AccountMapping)[];
}

/**
 * Mirrors water transactions into the platform ledger as journals. Failures are kept on the record
 * (accounting.status FAILED with the error) and retried from Water settings; nothing in water billing
 * ever waits on the ledger.
 */
export class AccountingSyncService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  private model(kind: Kind) {
    if (kind === 'billRun') return this.db.billRuns;
    if (kind === 'adjustment') return this.db.adjustments;
    if (kind === 'fee') return this.db.disconnections;
    return this.db.payments;
  }

  private async prepare(kind: Kind, id: Types.ObjectId, mapping: AccountMapping): Promise<Prepared | null> {
    if (kind === 'billRun') {
      const run = await this.db.billRuns.findById(id).lean();
      if (!run || run.status !== 'APPROVED') return null;
      const totals = Object.fromEntries(Object.entries(run.totals ?? {}).map(([k, v]) => [k, v.toString()]));
      const uses: (keyof AccountMapping)[] = ['receivable'];
      for (const code of Object.keys(totals)) {
        const slot = chargeAccount(code);
        if (slot && !uses.includes(slot)) uses.push(slot);
      }
      const supplementary = run.kind === 'SUPPLEMENTARY';
      const ref = supplementary ? `WATER-SUPP-${run._id.toHexString().slice(-8)}` : `WATER-BILLS-${run.period}`;
      const description = supplementary ? `Supplementary water bill ${run.period}: ${run.reason ?? ''}`.trim() : `Water billing ${run.period} (${run.billCount} bills)`;
      return { date: formatDate(run.billDate)!, description, reference: ref, lines: billRunJournalLines(totals, mapping, run.period), uses };
    }
    if (kind === 'fee') {
      const d = await this.db.disconnections.findById(id).lean();
      const fee = d?.reconnectionFee?.toString();
      if (!d || !fee || Number(fee) <= 0) return null;
      const narrative = `Reconnection fee ${d.accountNo ?? ''}`.trim();
      return { date: formatDate(d.reconnectedAt ?? new Date())!, description: narrative, reference: `WATER-RECON-${d._id.toHexString().slice(-8)}`, lines: feeJournalLines(fee, mapping, narrative), uses: ['receivable', 'reconnection'] };
    }
    if (kind === 'adjustment') {
      const adj = await this.db.adjustments.findById(id).lean();
      if (!adj || adj.status !== 'APPROVED') return null;
      const c = await this.db.customers.findById(adj.customerId, { accountNo: 1 }).lean();
      const narrative = `Water adjustment ${c?.accountNo ?? ''}: ${adj.reason}`.slice(0, 500);
      return { date: formatDate(adj.reviewedAt ?? new Date())!, description: narrative, reference: `WATER-ADJ-${adj._id.toHexString().slice(-8)}`, lines: adjustmentJournalLines(adj.amount?.toString() ?? 0, mapping, narrative), uses: ['receivable', 'adjustments'] };
    }
    const p = await this.db.payments.findById(id, { raw: 0 }).lean();
    if (!p) return null;
    const channel = p.channel as PaymentChannel;
    const account = channelAccount(channel);
    const narrative = `Water payment ${p.receiptNo} ${p.accountNo ?? ''} ${p.reference}`.trim();
    const lines = paymentJournalLines(p.amount?.toString() ?? 0, channel, mapping, narrative);
    if (kind === 'reversal') {
      if (p.status !== 'REVERSED') return null;
      const swapped = lines.map((l) => ({ ...l, description: `Reversal: ${l.description}`, debit: l.credit, credit: l.debit }));
      return { date: formatDate(new Date())!, description: `Reversal of water payment ${p.receiptNo}`, reference: `WATER-REV-${p.receiptNo}`, lines: swapped, uses: ['receivable', account] };
    }
    if (p.status === 'UNMATCHED') return null;
    return { date: formatDate(p.paidAt)!, description: narrative, reference: `WATER-${p.receiptNo}`, lines, uses: ['receivable', account] };
  }

  /** Sends one record's journal; returns the sync state stored on it. */
  async sync(organisationId: Types.ObjectId, kind: Kind, id: Types.ObjectId) {
    const field = kind === 'reversal' ? 'reversalAccounting' : kind === 'fee' ? 'feeAccounting' : 'accounting';
    const model = this.model(kind) as unknown as typeof this.db.payments;
    if (!(await this.ledger.isConnected(organisationId))) {
      await model.updateOne({ _id: id }, { [`${field}.status`]: 'SKIPPED', [`${field}.error`]: 'The ledger is not connected' });
      return { status: 'SKIPPED' as const };
    }
    const accounts = ((await waterSettings(this.db, organisationId)).accounts ?? {}) as AccountMapping;
    const prepared = await this.prepare(kind, id, accounts);
    if (!prepared || !prepared.lines.length) return { status: 'SKIPPED' as const };
    const missing = missingAccounts(accounts, prepared.uses);
    if (missing.length) {
      const error = `Map these accounts in Water settings → Ledger accounts: ${missing.join(', ')}`;
      await model.updateOne({ _id: id }, { [`${field}.status`]: 'FAILED', [`${field}.error`]: error, [`${field}.lastAttemptAt`]: new Date(), $inc: { [`${field}.attempts`]: 1 } });
      return { status: 'FAILED' as const, error };
    }
    await model.updateOne({ _id: id }, { [`${field}.status`]: 'PENDING', [`${field}.lastAttemptAt`]: new Date(), $inc: { [`${field}.attempts`]: 1 } });
    try {
      const journal = { date: prepared.date, description: prepared.description, reference: prepared.reference, lines: prepared.lines };
      const journalId = await this.ledger.post(organisationId, journal, `farajasoft-water:${kind}:${id.toHexString()}`);
      await model.updateOne({ _id: id }, { [`${field}.status`]: 'SENT', [`${field}.journalId`]: journalId, $unset: { [`${field}.error`]: 1 } });
      return { status: 'SENT' as const, journalId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await model.updateOne({ _id: id }, { [`${field}.status`]: 'FAILED', [`${field}.error`]: error });
      return { status: 'FAILED' as const, error };
    }
  }

  /** Never throws: used straight after billing and payments, where the ledger must not block the office. */
  async trySync(organisationId: Types.ObjectId, kind: Kind, id: Types.ObjectId) {
    try {
      return await this.sync(organisationId, kind, id);
    } catch (err) {
      console.error(`Accounting sync of ${kind} ${id.toHexString()} failed`, err);
      return { status: 'FAILED' as const };
    }
  }

  /** Re-sends everything not yet in the ledger (failed, skipped while the integration was off, or never sent). */
  async retryPending(organisationId: Types.ObjectId, limit = 200) {
    const unsent = { $in: ['NOT_SENT', 'FAILED', 'SKIPPED', 'PENDING'] };
    const [runs, payments, reversals, adjustments, fees] = await Promise.all([
      this.db.billRuns.find({ organisationId, status: 'APPROVED', 'accounting.status': unsent }, { _id: 1 }).limit(limit).lean(),
      this.db.payments.find({ organisationId, status: 'POSTED', 'accounting.status': unsent }, { _id: 1 }).limit(limit).lean(),
      this.db.payments.find({ organisationId, status: 'REVERSED', 'accounting.status': 'SENT', 'reversalAccounting.status': { $ne: 'SENT' } }, { _id: 1 }).limit(limit).lean(),
      this.db.adjustments.find({ organisationId, status: 'APPROVED', 'accounting.status': unsent }, { _id: 1 }).limit(limit).lean(),
      this.db.disconnections.find({ organisationId, reconnectionFee: { $gt: 0 }, 'feeAccounting.status': unsent }, { _id: 1 }).limit(limit).lean(),
    ]);
    const results = { sent: 0, failed: 0, skipped: 0 };
    const tally = (r: { status: string }) => {
      if (r.status === 'SENT') results.sent++;
      else if (r.status === 'FAILED') results.failed++;
      else results.skipped++;
    };
    for (const r of runs) tally(await this.trySync(organisationId, 'billRun', r._id));
    for (const p of payments) tally(await this.trySync(organisationId, 'payment', p._id));
    for (const p of reversals) tally(await this.trySync(organisationId, 'reversal', p._id));
    for (const a of adjustments) tally(await this.trySync(organisationId, 'adjustment', a._id));
    for (const f of fees) tally(await this.trySync(organisationId, 'fee', f._id));
    return results;
  }

  /** Counts by sync state, for the settings screen. */
  async status(organisationId: Types.ObjectId) {
    const count = async (model: typeof this.db.payments | typeof this.db.billRuns | typeof this.db.adjustments, extra: Record<string, unknown>) => {
      const rows = await (model as typeof this.db.payments).aggregate<{ _id: string; n: number }>([{ $match: { organisationId, ...extra } }, { $group: { _id: '$accounting.status', n: { $sum: 1 } } }]);
      return Object.fromEntries(rows.map((r) => [r._id ?? 'NOT_SENT', r.n]));
    };
    const [billRuns, payments, adjustments, lastErrors] = await Promise.all([
      count(this.db.billRuns, { status: 'APPROVED' }),
      count(this.db.payments, { status: { $in: ['POSTED', 'REVERSED'] } }),
      count(this.db.adjustments, { status: 'APPROVED' }),
      this.db.payments.find({ organisationId, 'accounting.status': 'FAILED' }, { receiptNo: 1, 'accounting.error': 1 }).sort({ updatedAt: -1 }).limit(5).lean(),
    ]);
    return { billRuns, payments, adjustments, lastErrors: lastErrors.map((p) => ({ receiptNo: p.receiptNo, error: p.accounting?.error })) };
  }
}
