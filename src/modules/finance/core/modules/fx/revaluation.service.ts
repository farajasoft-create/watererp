import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { addDays } from '../../common/workflow';
import { Db } from '../../database/db.service';
import { PartyType, RateType } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { SettlementService, SIDES } from '../settlement/settlement.service';

/** Balance-sheet account types holding monetary items that are revalued at period end. */
export const MONETARY_TYPES = ['BANK', 'CASH', 'RECEIVABLE', 'CURRENT_ASSET', 'PAYABLE', 'ACCRUAL', 'CURRENT_LIABILITY', 'TAX_PAYABLE', 'LOAN', 'NON_CURRENT_LIABILITY'];

export interface RevaluationLine {
  kind: 'ACCOUNT' | 'OPEN_ITEM';
  accountId: Types.ObjectId;
  accountCode: string;
  branchId: Types.ObjectId;
  currency: string;
  partyType: PartyType | null;
  partyId: Types.ObjectId | null;
  partyName: string;
  documentId: Types.ObjectId | null;
  documentNumber: string;
  balanceTx: Decimal;
  carrying: Decimal;
  revalued: Decimal;
  difference: Decimal;
}

/**
 * Period-end revaluation of foreign-currency monetary balances at closing rates. Open receivables and
 * payables are revalued item by item at carrying value; other monetary accounts (foreign bank accounts,
 * loans) by balance. The result posts as an auto-reversing journal, so carrying values used for
 * realised FX on settlement are never disturbed.
 */
export class RevaluationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
    private readonly settlement: SettlementService,
  ) {}

  private async fxAccounts(organisationId: Types.ObjectId) {
    const org = await this.db.organisations.findById(organisationId).lean();
    const s = org?.settings;
    const gain = s?.unrealisedFxGainAccountId ?? s?.fxGainAccountId ?? null;
    const loss = s?.unrealisedFxLossAccountId ?? s?.fxLossAccountId ?? null;
    if (!gain || !loss) throw new BadRequestException('Set the unrealised FX gain and loss accounts in organisation settings first');
    return { gain, loss };
  }

  /** Calculates (without posting) the revaluation of an entity's foreign-currency balances at a date. */
  async compute(user: AuthUser, entityId: Types.ObjectId, date: Date, rateType: RateType = 'CLOSING') {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: org }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const functional = entity.functionalCurrency;
    const fp = await this.currencies.precision(functional);

    // Rates: the requested type (normally CLOSING), falling back to SPOT on or before the date.
    const rateCache = new Map<string, { rate: Decimal; rateType: string; effectiveDate: Date }>();
    const rateFor = async (currency: string) => {
      const cached = rateCache.get(currency);
      if (cached) return cached.rate;
      const preferred = await this.currencies.findRate(org, currency, functional, date, rateType);
      const found = preferred ?? (rateType !== 'SPOT' ? await this.currencies.findRate(org, currency, functional, date, 'SPOT') : null);
      if (!found) throw new BadRequestException(`No approved ${rateType} or SPOT ${currency}/${functional} rate on or before ${date.toISOString().slice(0, 10)}`);
      rateCache.set(currency, { rate: found.rate, rateType: preferred ? rateType : 'SPOT', effectiveDate: found.effectiveDate });
      return found.rate;
    };

    const lines: RevaluationLine[] = [];
    const accounts = await this.db.accounts.find({ organisationId: org }).lean();
    const accountById = new Map(accounts.map((a) => [a._id.toHexString(), a]));
    const controls = await this.settlement.accounts(org);
    const controlIds = [controls.receivables, controls.payables].filter(Boolean).map(String);

    // 1. Monetary accounts other than the AR/AP control accounts, by account, branch and currency.
    const monetary = accounts.filter((a) => a.isPostable && MONETARY_TYPES.includes(a.accountType) && !controlIds.includes(a._id.toHexString()));
    const balances = await this.db.ledger.aggregate<{ _id: { account: Types.ObjectId; branch: Types.ObjectId; currency: string }; tx: unknown; fn: unknown }>([
      { $match: { organisationId: org, entityId, date: { $lte: date }, accountId: { $in: monetary.map((a) => a._id) }, currency: { $ne: functional } } },
      {
        $group: {
          _id: { account: '$accountId', branch: '$branchId', currency: '$currency' },
          tx: { $sum: { $subtract: ['$debitTx', '$creditTx'] } },
          fn: { $sum: { $subtract: ['$debit', '$credit'] } },
        },
      },
    ]);
    for (const b of balances) {
      const tx = dec(b.tx as never);
      const carrying = dec(b.fn as never);
      if (tx.isZero() && carrying.isZero()) continue;
      const revalued = round(tx.times(await rateFor(b._id.currency)), fp);
      const account = accountById.get(b._id.account.toHexString())!;
      lines.push({
        kind: 'ACCOUNT',
        accountId: b._id.account,
        accountCode: account.code,
        branchId: b._id.branch,
        currency: b._id.currency,
        partyType: null,
        partyId: null,
        partyName: account.name,
        documentId: null,
        documentNumber: '',
        balanceTx: tx,
        carrying,
        revalued,
        difference: revalued.minus(carrying),
      });
    }

    // 2. Open receivables and payables in foreign currency, item by item at carrying value — plus any
    //    revaluation still in effect at the date (posted on or before it and not yet reversed).
    const activeRuns = await this.db.fxRevaluations.find({ organisationId: org, entityId, status: 'POSTED', date: { $lte: date }, reverseOn: { $gt: date } }, { lines: 1 }).lean();
    const priorRevaluation = new Map<string, Decimal>();
    for (const run of activeRuns) {
      for (const l of run.lines) {
        if (!l.documentId) continue;
        const key = l.documentId.toHexString();
        priorRevaluation.set(key, (priorRevaluation.get(key) ?? new Decimal(0)).plus(dec(l.difference)));
      }
    }
    const base = { organisationId: org, entityId, status: { $in: ['POSTED', 'VOID'] }, date: { $lte: date }, currency: { $ne: functional } };
    for (const partyType of ['CUSTOMER', 'SUPPLIER'] as PartyType[]) {
      const control = partyType === 'CUSTOMER' ? controls.receivables : controls.payables;
      if (!control) continue;
      const side = SIDES[partyType];
      const [docs, payments] = await Promise.all([
        this.db.invoices.find({ ...base, kind: { $in: [side.document, side.credit] } }, { lines: 0 }).lean(),
        this.db.payments.find({ ...base, partyType }).lean(),
      ]);
      const ids = [...docs.map((d) => d._id), ...payments.map((p) => p._id)];
      const allocations = await this.db.allocations
        .find({ organisationId: org, date: { $lte: date }, $or: [{ documentId: { $in: ids } }, { sourceId: { $in: ids } }] })
        .lean();
      const settled = (id: Types.ObjectId, field: 'documentId' | 'sourceId', fnField: 'documentFunctional' | 'sourceFunctional') =>
        allocations
          // An allocation counts if it was active at the date (reversed later still counts).
          .filter((a) => a[field].equals(id) && (a.status === 'ACTIVE' || (a.reversedAt && a.reversedAt > date)))
          .reduce((acc, a) => ({ tx: acc.tx.plus(dec(a.amount)), fn: acc.fn.plus(dec(a[fnField])) }), { tx: new Decimal(0), fn: new Decimal(0) });

      const items: { id: Types.ObjectId; number: string; branchId: Types.ObjectId; partyId: Types.ObjectId; partyName: string; currency: string; open: Decimal; carrying: Decimal; debitNatured: boolean }[] = [];
      for (const d of docs) {
        if (d.status === 'VOID' && d.voidedAt && d.voidedAt <= date) continue;
        const isDocument = d.kind === side.document;
        const s = settled(d._id, isDocument ? 'documentId' : 'sourceId', isDocument ? 'documentFunctional' : 'sourceFunctional');
        items.push({
          id: d._id,
          number: d.number,
          branchId: d.branchId,
          partyId: d.partyId,
          partyName: d.partyName,
          currency: d.currency,
          open: dec(d.total).minus(s.tx),
          carrying: dec(d.totalFunctional).minus(s.fn),
          // On the control account: sales invoices and supplier credits are debits.
          debitNatured: (partyType === 'CUSTOMER') === isDocument,
        });
      }
      for (const p of payments) {
        if (p.status === 'VOID' && p.voidedAt && p.voidedAt <= date) continue;
        const s = settled(p._id, 'sourceId', 'sourceFunctional');
        items.push({
          id: p._id,
          number: p.number,
          branchId: p.branchId,
          partyId: p.partyId,
          partyName: p.partyName,
          currency: p.currency,
          open: dec(p.amount).plus(dec(p.withholdingAmount)).minus(s.tx),
          carrying: dec(p.amountFunctional).plus(dec(p.withholdingAmountFunctional)).minus(s.fn),
          debitNatured: partyType === 'SUPPLIER',
        });
      }
      for (const it of items) {
        if (it.open.isZero()) continue;
        const sign = it.debitNatured ? 1 : -1;
        const carrying = it.carrying.times(sign).plus(priorRevaluation.get(it.id.toHexString()) ?? 0);
        const revalued = round(it.open.times(await rateFor(it.currency)), fp).times(sign);
        lines.push({
          kind: 'OPEN_ITEM',
          accountId: control,
          accountCode: accountById.get(control.toHexString())?.code ?? '',
          branchId: it.branchId,
          currency: it.currency,
          partyType,
          partyId: it.partyId,
          partyName: it.partyName,
          documentId: it.id,
          documentNumber: it.number,
          balanceTx: it.open.times(sign),
          carrying,
          revalued,
          difference: revalued.minus(carrying),
        });
      }
    }

    const restricted = allowedBranches(user);
    const visible = restricted ? lines.filter((l) => restricted.some((r) => r.equals(l.branchId))) : lines;
    const changed = visible.filter((l) => !l.difference.isZero());
    return {
      entity: { id: entity._id, code: entity.code, name: entity.name },
      currency: functional,
      date,
      rateType,
      rates: [...rateCache.entries()].map(([currency, r]) => ({ currency, ...r })),
      lines: changed,
      /** Every foreign-currency balance considered, including those already at the rate (for exposure reporting). */
      all: visible,
      unchanged: visible.length - changed.length,
      totalGain: sum(changed.filter((l) => l.difference.gt(0)).map((l) => l.difference)),
      totalLoss: sum(changed.filter((l) => l.difference.lt(0)).map((l) => l.difference.neg())),
    };
  }

  /** Posts a revaluation as a journal that reverses on the following day. */
  async post(user: AuthUser, entityId: Types.ObjectId, date: Date, rateType: RateType = 'CLOSING') {
    if (!user.allBranches) throw new BadRequestException('Revaluation covers every branch; it needs a user with access to all branches');
    const existing = await this.db.fxRevaluations.exists({ organisationId: user.organisationId, entityId, date, status: 'POSTED' });
    if (existing) throw new BadRequestException(`A revaluation is already posted for ${date.toISOString().slice(0, 10)}`);
    const result = await this.compute(user, entityId, date, rateType);
    if (!result.lines.length) throw new BadRequestException('Nothing to revalue: foreign-currency balances already reflect the rates');
    const fx = await this.fxAccounts(user.organisationId);
    const fp = await this.currencies.precision(result.currency);
    const reverseOn = addDays(date, 1);
    const rates = new Map(result.rates.map((r) => [r.currency, r.rate]));

    const journalLines: LineInput[] = [];
    const contra = new Map<string, Decimal>(); // per branch, signed (gain positive)
    for (const l of result.lines) {
      const gain = l.difference.gt(0);
      journalLines.push({
        accountId: l.accountId,
        branchId: l.branchId,
        partyType: l.partyType,
        partyId: l.partyId,
        currency: l.currency,
        exchangeRate: rates.get(l.currency),
        description: `FX revaluation ${l.documentNumber || l.accountCode} (${l.currency})`,
        functionalDebit: gain ? l.difference : new Decimal(0),
        functionalCredit: gain ? new Decimal(0) : l.difference.neg(),
      });
      const key = l.branchId.toHexString();
      contra.set(key, (contra.get(key) ?? new Decimal(0)).plus(l.difference));
    }
    for (const [branch, net] of contra) {
      if (net.isZero()) continue;
      const amount = round(net.abs(), fp);
      journalLines.push({
        accountId: net.gt(0) ? fx.gain : fx.loss,
        branchId: new Types.ObjectId(branch),
        currency: result.currency,
        description: `Unrealised FX ${net.gt(0) ? 'gain' : 'loss'} at ${date.toISOString().slice(0, 10)}`,
        debit: net.gt(0) ? null : amount,
        credit: net.gt(0) ? amount : null,
        functionalDebit: net.gt(0) ? new Decimal(0) : amount,
        functionalCredit: net.gt(0) ? amount : new Decimal(0),
      });
    }

    return this.db.transaction(async (session) => {
      const entity = (await this.db.entities.findById(entityId).session(session).lean())!;
      const number = await this.db.nextNumber(user.organisationId, entity, 'FXR', session);
      const id = new Types.ObjectId();
      const journal = await this.journals.postSystemJournal(
        user,
        {
          entityId,
          branchId: result.lines[0].branchId,
          journalDate: date,
          description: `Unrealised FX revaluation at ${date.toISOString().slice(0, 10)} (${rateType} rates)`,
          reference: number,
          type: 'ACCRUAL',
          autoReverseDate: reverseOn,
          lines: journalLines,
        },
        { sourceType: 'FxRevaluation', sourceId: id, sourceNumber: number },
        session,
      );
      const [run] = await this.db.fxRevaluations.create(
        [
          {
            _id: id,
            organisationId: user.organisationId,
            entityId,
            date,
            reverseOn,
            rateType,
            rates: result.rates.map((r) => ({ currency: r.currency, rate: toD128(r.rate), rateType: r.rateType, effectiveDate: r.effectiveDate })),
            lines: result.lines.map((l) => ({
              kind: l.kind,
              accountId: l.accountId,
              branchId: l.branchId,
              currency: l.currency,
              partyType: l.partyType,
              partyId: l.partyId,
              documentId: l.documentId,
              documentNumber: l.documentNumber,
              balanceTx: toD128(l.balanceTx),
              carrying: toD128(l.carrying),
              revalued: toD128(l.revalued),
              difference: toD128(l.difference),
            })),
            totalGain: toD128(result.totalGain),
            totalLoss: toD128(result.totalLoss),
            journalId: journal._id,
            createdBy: user.id,
          },
        ],
        { session },
      );
      await this.audit.log(
        user,
        {
          action: 'fx.revaluation.post',
          recordType: 'FxRevaluation',
          recordId: id,
          summary: `${number}: revalued ${result.lines.length} balance(s) at ${date.toISOString().slice(0, 10)} — gain ${result.totalGain.toFixed()} / loss ${result.totalLoss.toFixed()} ${result.currency}, reversing ${reverseOn.toISOString().slice(0, 10)}`,
        },
        session,
      );
      return { ...run.toObject(), number, journalNumber: journal.number };
    });
  }

  async list(user: AuthUser, entityId: Types.ObjectId) {
    const runs = await this.db.fxRevaluations.find({ organisationId: user.organisationId, entityId }, { lines: 0 }).sort({ date: -1 }).limit(100).lean();
    const journals = await this.db.journals.find({ _id: { $in: runs.map((r) => r.journalId) } }, { number: 1, reference: 1, reversedById: 1 }).lean();
    return Promise.all(
      runs.map(async (r) => {
        const j = journals.find((x) => x._id.equals(r.journalId ?? undefined));
        return { ...(await withTrail(this.db, { ...r, createdBy: r.createdBy })), number: j?.reference ?? '', journalNumber: j?.number ?? '', reversed: !!j?.reversedById };
      }),
    );
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const run = await this.db.fxRevaluations.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!run) throw new NotFoundException('Revaluation not found');
    const [accounts, journal] = await Promise.all([
      this.db.accounts.find({ _id: { $in: [...new Set(run.lines.map((l) => l.accountId.toHexString()))] } }, { code: 1, name: 1 }).lean(),
      this.db.journals.findById(run.journalId, { number: 1, reference: 1, reversedById: 1 }).lean(),
    ]);
    return { ...run, number: journal?.reference ?? '', journalNumber: journal?.number ?? '', reversedById: journal?.reversedById ?? null, accounts };
  }
}
