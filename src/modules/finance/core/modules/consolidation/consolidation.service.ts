import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { withTrail } from '../../common/names';
import { assertSegregation, transition } from '../../common/workflow';
import { Db } from '../../database/db.service';
import { AccountClass, DEBIT_NORMAL, INCOME_STATEMENT_CLASSES, RateType } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { ledgerSums } from '../reports/ledger-sums';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

const IS = INCOME_STATEMENT_CLASSES as string[];
const ym = (d: Date) => d.toISOString().slice(0, 7);
const monthEnd = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0));
};

export interface AdjustmentInput {
  date: Date;
  description: string;
  entityId?: Types.ObjectId | null;
  lines: { accountId: Types.ObjectId; description?: string; debit?: Decimal | null; credit?: Decimal | null }[];
}

export interface InvestmentInput {
  parentEntityId: Types.ObjectId;
  subsidiaryEntityId: Types.ObjectId;
  acquisitionDate: Date;
  investmentAccountId: Types.ObjectId;
  cost: Decimal;
  ownershipPercent: Decimal;
  goodwillAccountId: Types.ObjectId;
  notes?: string;
}

/** Synthetic rows produced by the acquisition entries. */
const SYNTHETIC: Record<string, string> = { nci: 'Non-controlling interest at acquisition', 'acq-fx': 'Translation of investments eliminated' };

type Column = Map<string, Decimal>; // accountId (or synthetic key) → signed debit amount in reporting currency

/**
 * Group consolidation. Each entity keeps its own books; the group view is produced by translating
 * entity balances into the reporting currency, eliminating intercompany balances and applying
 * approved group adjustments:
 *   - assets and liabilities at the CLOSING rate on the reporting date;
 *   - income and expenses at each month's AVERAGE rate;
 *   - equity and prior-year results at historical (monthly) rates;
 *   - the difference is the foreign currency translation reserve (CTA).
 * Missing CLOSING or AVERAGE rates fall back to SPOT.
 */
export class ConsolidationService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly workflow: WorkflowService,
  ) {}

  private rateResolver(organisationId: Types.ObjectId, reporting: string) {
    const cache = new Map<string, { rate: Decimal; rateType: string; effectiveDate: Date }>();
    const missing = new Set<string>();
    const get = async (from: string, date: Date, type: RateType) => {
      const key = `${from}|${type}|${date.toISOString().slice(0, 10)}`;
      const hit = cache.get(key);
      if (hit) return hit.rate;
      if (from === reporting) return new Decimal(1);
      const preferred = await this.currencies.findRate(organisationId, from, reporting, date, type);
      const found = preferred ?? (await this.currencies.findRate(organisationId, from, reporting, date, 'SPOT'));
      if (!found) {
        missing.add(`${from}/${reporting} on ${date.toISOString().slice(0, 10)}`);
        return new Decimal(0);
      }
      cache.set(key, { rate: found.rate, rateType: preferred ? type : 'SPOT', effectiveDate: found.effectiveDate });
      return found.rate;
    };
    return { get, cache, missing };
  }

  /**
   * An entity's balances to the reporting date by account and month, with intercompany activity (lines with
   * a group customer or supplier, or tagged with another group entity) split out per counterparty. Totals
   * come from the monthly figures; only the intercompany lines are read from the ledger.
   */
  private async entityRows(organisationId: Types.ObjectId, entityId: Types.ObjectId, asOf: Date, icIds: Types.ObjectId[], scopeIds: Types.ObjectId[]) {
    type Row = { _id: { account: Types.ObjectId; cls: AccountClass; ym: string; ic: boolean; party: Types.ObjectId | null }; amount: Decimal };
    // Ledger dates are whole days, so "on or before asOf" is "before the next day"; whole months then come
    // from the monthly totals.
    const until = new Date(asOf.getTime() + 86_400_000);
    const icRows = (match: Record<string, unknown>, party: '$partyId' | '$intercompanyEntityId', hint: Record<string, number>) =>
      this.db.ledger
        .aggregate<{ _id: { account: Types.ObjectId; cls: AccountClass; ym: string; party: Types.ObjectId }; amount: unknown }>([
          { $match: { organisationId, entityId, date: { $lt: until }, ...match } },
          { $group: { _id: { account: '$accountId', cls: '$accountClass', ym: { $dateToString: { format: '%Y-%m', date: '$date' } }, party }, amount: { $sum: { $subtract: ['$debit', '$credit'] } } } },
        ])
        .hint(hint);
    // Two indexed queries rather than one $or, which would scan the entity's whole ledger.
    const [totals, byParty, tagged] = await Promise.all([
      ledgerSums(this.db, { organisationId, entityId }, null, until, ['account', 'class', 'month']),
      icIds.length ? icRows({ partyId: { $in: icIds } }, '$partyId', { organisationId: 1, partyId: 1, date: 1 }) : [],
      icRows({ intercompanyEntityId: { $in: scopeIds, $type: 'objectId' }, partyId: { $nin: icIds } }, '$intercompanyEntityId', { organisationId: 1, intercompanyEntityId: 1, date: 1 }),
    ]);
    const ic = [...byParty, ...tagged];
    const out: Row[] = [];
    const icTotals = new Map<string, Decimal>();
    for (const r of ic) {
      const amount = dec(r.amount as never);
      out.push({ _id: { ...r._id, ic: true }, amount });
      const k = `${r._id.account.toHexString()}|${r._id.ym}`;
      icTotals.set(k, (icTotals.get(k) ?? new Decimal(0)).plus(amount));
    }
    for (const t of totals) {
      const month = ym(t.month!);
      const amount = t.debit.minus(t.credit).minus(icTotals.get(`${t.account!.toHexString()}|${month}`) ?? 0);
      if (!amount.isZero()) out.push({ _id: { account: t.account!, cls: t.cls as AccountClass, ym: month, ic: false, party: null }, amount });
    }
    return out;
  }

  async report(user: AuthUser, q: { from: Date; asOf: Date; entityIds?: Types.ObjectId[] }) {
    if (q.from > q.asOf) throw new BadRequestException('"from" must be on or before the reporting date');
    const org = await this.db.organisations.findById(user.organisationId).lean();
    if (!org) throw new NotFoundException('Organisation not found');
    const reporting = org.reportingCurrency;
    const rp = await this.currencies.precision(reporting);
    const entityFilter: Record<string, unknown> = { organisationId: user.organisationId, isActive: true };
    if (q.entityIds?.length) entityFilter._id = { $in: q.entityIds };
    const entities = await this.db.entities.find(entityFilter).sort({ code: 1 }).lean();
    if (!entities.length) throw new BadRequestException('No active entities to consolidate');
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId }).lean();
    const accountById = new Map(accounts.map((a) => [a._id.toHexString(), a]));
    const reId = org.settings?.retainedEarningsAccountId?.toHexString() ?? 'retained-earnings';

    // Intercompany parties: customers and suppliers that are other entities of the group.
    const [icCustomers, icSuppliers] = await Promise.all([
      this.db.customers.find({ organisationId: user.organisationId, intercompanyEntityId: { $ne: null } }, { _id: 1, intercompanyEntityId: 1, name: 1 }).lean(),
      this.db.suppliers.find({ organisationId: user.organisationId, intercompanyEntityId: { $ne: null } }, { _id: 1, intercompanyEntityId: 1, name: 1 }).lean(),
    ]);
    const icParties = [...icCustomers, ...icSuppliers];
    const icIds = icParties.map((p) => p._id);

    const scopeIds = entities.map((e) => e._id);
    const entityNames = new Map(entities.map((e) => [e._id.toHexString(), e.name]));
    const rates = this.rateResolver(user.organisationId, reporting);
    const columns: { entity: (typeof entities)[number]; translated: Column; functional: Column; cta: Decimal; closingRate: Decimal }[] = [];
    const eliminations: Column = new Map();
    const icDetail: { entityCode: string; partyName: string; accountId: string; amount: Decimal }[] = [];

    for (const entity of entities) {
      const rows = await this.entityRows(user.organisationId, entity._id, q.asOf, icIds, scopeIds);
      const fc = entity.functionalCurrency;
      const closing = await rates.get(fc, q.asOf, 'CLOSING');
      const translated: Column = new Map();
      const functional: Column = new Map();
      const add = (col: Column, key: string, v: Decimal) => col.set(key, (col.get(key) ?? new Decimal(0)).plus(v));
      const fromKey = ym(q.from);

      for (const r of rows) {
        const amount = dec(r.amount as never);
        if (amount.isZero()) continue;
        const cls = r._id.cls;
        const isPL = IS.includes(cls);
        // Prior-period results roll into retained earnings (no closing entries are posted).
        const key = isPL && r._id.ym < fromKey ? reId : r._id.account.toHexString();
        let rate: Decimal;
        if (cls === 'ASSET' || cls === 'LIABILITY') rate = closing;
        else rate = await rates.get(fc, monthEnd(r._id.ym) > q.asOf ? q.asOf : monthEnd(r._id.ym), 'AVERAGE');
        const t = round(amount.times(rate), rp);
        add(functional, key, amount);
        add(translated, key, t);
        if (r._id.ic) {
          // Remove intercompany balances and transactions from the group view.
          add(eliminations, key, t.neg());
          const party = icParties.find((p) => p._id.equals(r._id.party ?? undefined));
          icDetail.push({ entityCode: entity.code, partyName: party?.name ?? entityNames.get(r._id.party?.toHexString() ?? '') ?? '', accountId: key, amount: t });
        }
      }
      // Translation reserve: what makes the translated trial balance balance again.
      const cta = sum([...translated.values()]).neg();
      columns.push({ entity, translated, functional, cta, closingRate: closing });
    }

    // Acquisitions: the parent's investment is eliminated against the subsidiary's equity at acquisition.
    const acquisitions: Column = new Map();
    const acquisitionDetail = [];
    // Each subsidiary's results before acquisition within the period (not the group's, nor the outside shareholders').
    const preAcquisitionProfit = new Map<string, Decimal>();
    const investments = await this.db.groupInvestments.find({ organisationId: user.organisationId, isActive: true, acquisitionDate: { $lte: q.asOf }, parentEntityId: { $in: scopeIds }, subsidiaryEntityId: { $in: scopeIds } }).lean();
    const addTo = (col: Column, key: string, v: Decimal) => col.set(key, (col.get(key) ?? new Decimal(0)).plus(v));
    for (const inv of investments) {
      const parent = entities.find((e) => e._id.equals(inv.parentEntityId))!;
      const sub = entities.find((e) => e._id.equals(inv.subsidiaryEntityId))!;
      const parentColumn = columns.find((c) => c.entity._id.equals(parent._id))!;
      const pre = (await ledgerSums(this.db, { organisationId: user.organisationId, entityId: sub._id, accountClass: { $in: ['EQUITY', ...IS] } }, null, new Date(inv.acquisitionDate.getTime() + 1), ['account', 'class', 'month'])).map((r) => ({
        _id: { account: r.account!, cls: r.cls as AccountClass, ym: ym(r.month!) },
        amount: r.debit.minus(r.credit),
      }));
      // Pre-acquisition equity, translated and keyed exactly as the subsidiary's column carries it.
      const entries: Column = new Map();
      let netAssets = new Decimal(0);
      for (const r of pre) {
        const amount = dec(r.amount as never);
        if (amount.isZero()) continue;
        const isPL = IS.includes(r._id.cls);
        const key = isPL && r._id.ym < ym(q.from) ? reId : r._id.account.toHexString();
        const rate = await rates.get(sub.functionalCurrency, monthEnd(r._id.ym) > q.asOf ? q.asOf : monthEnd(r._id.ym), 'AVERAGE');
        const t = round(amount.times(rate), rp);
        addTo(entries, key, t.neg());
        netAssets = netAssets.minus(t);
        if (isPL && key !== reId) preAcquisitionProfit.set(sub._id.toHexString(), (preAcquisitionProfit.get(sub._id.toHexString()) ?? new Decimal(0)).minus(t));
      }
      const owned = dec(inv.ownershipPercent).div(100);
      const costAtAcquisition = round(dec(inv.cost).times(await rates.get(parent.functionalCurrency, inv.acquisitionDate, 'SPOT')), rp);
      const costInColumn = round(dec(inv.cost).times(parentColumn.closingRate), rp);
      const nci = round(netAssets.times(new Decimal(1).minus(owned)), rp);
      const goodwill = costAtAcquisition.minus(round(netAssets.times(owned), rp));
      // A bargain purchase (negative goodwill) is a gain, carried in retained earnings.
      addTo(entries, goodwill.gte(0) ? inv.goodwillAccountId.toHexString() : reId, goodwill);
      addTo(entries, inv.investmentAccountId.toHexString(), costInColumn.neg());
      addTo(entries, 'nci', nci.neg());
      const fx = sum([...entries.values()]).neg();
      if (!fx.isZero()) addTo(entries, 'acq-fx', fx);
      for (const [k, v] of entries) addTo(acquisitions, k, v);
      acquisitionDetail.push({ parentCode: parent.code, subsidiaryCode: sub.code, acquisitionDate: inv.acquisitionDate, ownershipPercent: dec(inv.ownershipPercent), cost: costAtAcquisition, netAssets, goodwill, nonControllingInterest: nci });
    }

    // Approved group adjustments (reporting currency): balance-sheet effects to date, P&L within the period.
    const adjustments: Column = new Map();
    const adjDocs = await this.db.consolidationAdjustments.find({ organisationId: user.organisationId, status: 'APPROVED', date: { $lte: q.asOf } }).lean();
    for (const a of adjDocs) {
      for (const l of a.lines) {
        const account = accountById.get(l.accountId.toHexString());
        const isPL = account && IS.includes(account.accountClass);
        const key = isPL && a.date < q.from ? reId : l.accountId.toHexString();
        adjustments.set(key, (adjustments.get(key) ?? new Decimal(0)).plus(dec(l.debit)).minus(dec(l.credit)));
      }
    }
    // Eliminations that do not net to zero: on the balance sheet they are unmatched intercompany
    // balances (to investigate); on income and expense they are FX from translating each side at
    // different rates, which belongs in the translation reserve.
    const isPLKey = (key: string) => key === reId || IS.includes(accountById.get(key)?.accountClass ?? '');
    const elimBalanceSheet = sum([...eliminations.entries()].filter(([k]) => !isPLKey(k)).map(([, v]) => v));
    const elimIncome = sum([...eliminations.entries()].filter(([k]) => isPLKey(k)).map(([, v]) => v));

    // Assemble rows: every account touched by any column.
    const keys = new Set<string>([...columns.flatMap((c) => [...c.translated.keys()]), ...eliminations.keys(), ...adjustments.keys(), ...acquisitions.keys()]);
    const classOf = (key: string): AccountClass => (accountById.get(key)?.accountClass as AccountClass) ?? 'EQUITY';
    const rowsOut = [...keys]
      .map((key) => {
        const account = accountById.get(key);
        const cls = classOf(key);
        const perEntity = columns.map((c) => c.translated.get(key) ?? new Decimal(0));
        const elim = eliminations.get(key) ?? new Decimal(0);
        const adj = adjustments.get(key) ?? new Decimal(0);
        const acq = acquisitions.get(key) ?? new Decimal(0);
        const total = sum(perEntity).plus(elim).plus(adj).plus(acq);
        // Present in the account's natural direction.
        const natural = (v: Decimal) => (DEBIT_NORMAL.has(cls) ? v : v.neg());
        return {
          accountId: account ? key : null,
          code: account?.code ?? '',
          name: account?.name ?? SYNTHETIC[key] ?? 'Retained earnings',
          accountClass: cls,
          entities: perEntity.map(natural),
          eliminations: natural(elim),
          acquisitions: natural(acq),
          adjustments: natural(adj),
          consolidated: natural(total),
          raw: total,
        };
      })
      .filter((r) => !(r.entities.every((v) => v.isZero()) && r.eliminations.isZero() && r.adjustments.isZero() && r.acquisitions.isZero()))
      .sort((a, b) => a.code.localeCompare(b.code));

    const total = (cls: AccountClass[], pick: (r: (typeof rowsOut)[number]) => Decimal) => sum(rowsOut.filter((r) => cls.includes(r.accountClass)).map(pick));
    const entityTotals = columns.map((c, i) => {
      const of = (cls: AccountClass[]) => total(cls, (r) => r.entities[i]);
      const revenue = of(['REVENUE']);
      const cos = of(['COST_OF_SALES']);
      const exp = of(['EXPENSE']);
      const netProfit = revenue.minus(cos).minus(exp);
      // Non-controlling interest: the outside shareholders' share of the entity's translated results
      // and net assets (before intercompany eliminations).
      const owned = c.entity.ownershipPercent ? dec(c.entity.ownershipPercent) : new Decimal(100);
      const outside = new Decimal(100).minus(owned).div(100);
      const netAssets = of(['ASSET']).minus(of(['LIABILITY']));
      const preAcquisition = preAcquisitionProfit.get(c.entity._id.toHexString()) ?? new Decimal(0);
      return { netProfit, cta: c.cta.neg(), ownershipPercent: owned, nciProfit: round(netProfit.minus(preAcquisition).times(outside), rp), nciNetAssets: round(netAssets.times(outside), rp) };
    });
    const of = (cls: AccountClass[], pick: (r: (typeof rowsOut)[number]) => Decimal = (r) => r.consolidated) => total(cls, pick);
    const revenue = of(['REVENUE']);
    const costOfSales = of(['COST_OF_SALES']);
    const expenses = of(['EXPENSE']);
    const netProfit = revenue.minus(costOfSales).minus(expenses);
    const assets = of(['ASSET']);
    const liabilities = of(['LIABILITY']);
    const equityAccounts = of(['EQUITY']);
    const ctaTotal = sum(columns.map((c) => c.cta)).neg().plus(elimIncome); // natural (credit-positive) equity
    const equity = equityAccounts.plus(netProfit).plus(ctaTotal).plus(elimBalanceSheet);
    const nciProfit = sum(entityTotals.map((t) => t.nciProfit));
    const nciEquity = sum(entityTotals.map((t) => t.nciNetAssets));

    return {
      reportingCurrency: reporting,
      from: q.from,
      asOf: q.asOf,
      entities: columns.map((c, i) => ({
        id: c.entity._id,
        code: c.entity.code,
        name: c.entity.name,
        functionalCurrency: c.entity.functionalCurrency,
        closingRate: c.closingRate,
        netProfit: entityTotals[i].netProfit,
        translationReserve: entityTotals[i].cta,
        ownershipPercent: entityTotals[i].ownershipPercent,
        nonControllingProfit: entityTotals[i].nciProfit,
        nonControllingNetAssets: entityTotals[i].nciNetAssets,
      })),
      rows: rowsOut.map(({ raw: _raw, ...r }) => r),
      totals: {
        revenue,
        costOfSales,
        grossProfit: revenue.minus(costOfSales),
        expenses,
        netProfit,
        assets,
        liabilities,
        equityAccounts,
        translationReserve: ctaTotal,
        intercompanyDifference: elimBalanceSheet,
        intercompanyTranslation: elimIncome,
        equity,
        profitToOwners: netProfit.minus(nciProfit),
        profitToNonControlling: nciProfit,
        equityToOwners: equity.minus(nciEquity),
        nonControllingInterest: nciEquity,
        balanced: assets.eq(liabilities.plus(equity)),
      },
      intercompany: icDetail.map((d) => ({ ...d, accountCode: accountById.get(d.accountId)?.code ?? '', accountName: accountById.get(d.accountId)?.name ?? '' })),
      adjustmentsCount: adjDocs.length,
      acquisitions: acquisitionDetail,
      rates: [...rates.cache.entries()].map(([key, v]) => {
        const [from, type, date] = key.split('|');
        return { from, to: reporting, requested: type, date, rate: v.rate, rateType: v.rateType, effectiveDate: v.effectiveDate };
      }),
      missingRates: [...rates.missing],
    };
  }

  // ------------------------------------------------------------------------------------------
  // Investments in subsidiaries (acquisitions)
  // ------------------------------------------------------------------------------------------

  async investments(user: AuthUser) {
    return this.db.groupInvestments.find({ organisationId: user.organisationId }).sort({ acquisitionDate: 1 }).lean();
  }

  private async checkInvestment(user: AuthUser, input: InvestmentInput, excludeId?: Types.ObjectId) {
    const org = user.organisationId;
    if (input.parentEntityId.equals(input.subsidiaryEntityId)) throw new BadRequestException('An entity cannot own itself');
    const [parent, sub] = await Promise.all([this.db.entities.findOne({ _id: input.parentEntityId, organisationId: org }).lean(), this.db.entities.findOne({ _id: input.subsidiaryEntityId, organisationId: org }).lean()]);
    if (!parent || !sub) throw new BadRequestException('Entity not found');
    if (!input.ownershipPercent.gt(0) || input.ownershipPercent.gt(100)) throw new BadRequestException('Ownership is more than 0% and at most 100%');
    if (!input.cost.gt(0)) throw new BadRequestException('Enter the cost of the investment');
    const [investment, goodwill] = await Promise.all([this.db.accounts.findOne({ _id: input.investmentAccountId, organisationId: org }).lean(), this.db.accounts.findOne({ _id: input.goodwillAccountId, organisationId: org }).lean()]);
    if (!investment || investment.accountClass !== 'ASSET') throw new BadRequestException("The investment account is an asset account in the parent's books");
    if (!goodwill || goodwill.accountClass !== 'ASSET' || !goodwill.isPostable) throw new BadRequestException('The goodwill account is a postable asset account');
    if (await this.db.groupInvestments.exists({ organisationId: org, subsidiaryEntityId: sub._id, ...(excludeId && { _id: { $ne: excludeId } }) })) throw new BadRequestException(`${sub.code} already has a parent investment recorded`);
    // A parent that is itself owned by the subsidiary would be circular.
    if (await this.db.groupInvestments.exists({ organisationId: org, parentEntityId: sub._id, subsidiaryEntityId: parent._id })) throw new BadRequestException(`${sub.code} owns ${parent.code}; ownership cannot be circular`);
    return { parent, sub };
  }

  async createInvestment(user: AuthUser, input: InvestmentInput) {
    const { parent, sub } = await this.checkInvestment(user, input);
    return this.db.transaction(async (session) => {
      const [inv] = await this.db.groupInvestments.create([{ ...input, cost: toD128(input.cost), ownershipPercent: toD128(input.ownershipPercent), notes: input.notes ?? '', organisationId: user.organisationId, createdBy: user.id }], { session });
      // Non-controlling interest everywhere else follows the ownership recorded here.
      await this.db.entities.updateOne({ _id: sub._id }, { ownershipPercent: toD128(input.ownershipPercent) }, { session });
      await this.audit.log(user, { action: 'group_investment.create', recordType: 'GroupInvestment', recordId: inv._id, summary: `Recorded ${parent.code}'s ${input.ownershipPercent.toFixed()}% investment in ${sub.code} from ${input.acquisitionDate.toISOString().slice(0, 10)}`, after: inv }, session);
      return inv.toObject();
    });
  }

  async updateInvestment(user: AuthUser, id: Types.ObjectId, input: InvestmentInput & { isActive?: boolean }) {
    const before = await this.db.groupInvestments.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!before) throw new NotFoundException('Investment not found');
    const { sub } = await this.checkInvestment(user, input, id);
    return this.db.transaction(async (session) => {
      await this.db.groupInvestments.updateOne({ _id: id }, { ...input, cost: toD128(input.cost), ownershipPercent: toD128(input.ownershipPercent), notes: input.notes ?? '' }, { session });
      await this.db.entities.updateOne({ _id: sub._id }, { ownershipPercent: toD128(input.ownershipPercent) }, { session });
      await this.audit.log(user, { action: 'group_investment.update', recordType: 'GroupInvestment', recordId: id, summary: `Updated the investment in ${sub.code}`, before }, session);
      return this.db.groupInvestments.findById(id).session(session).lean();
    });
  }

  // ------------------------------------------------------------------------------------------
  // Group adjustments (maker-checker)
  // ------------------------------------------------------------------------------------------

  private async build(user: AuthUser, input: AdjustmentInput, session?: ClientSession) {
    const org = await this.db.organisations.findById(user.organisationId).session(session ?? null).lean();
    const currency = org!.reportingCurrency;
    const rp = await this.currencies.precision(currency);
    if (input.lines.length < 2) throw new BadRequestException('An adjustment needs at least two lines');
    if (input.entityId && !(await this.db.entities.exists({ _id: input.entityId, organisationId: user.organisationId }))) {
      throw new BadRequestException('Entity not found');
    }
    const accounts = await this.db.accounts.find({ organisationId: user.organisationId, _id: { $in: input.lines.map((l) => l.accountId) } }).session(session ?? null).lean();
    const lines = input.lines.map((l, i) => {
      const a = accounts.find((x) => x._id.equals(l.accountId));
      if (!a || !a.isPostable) throw new BadRequestException(`Line ${i + 1}: choose a postable account`);
      const debit = dec(l.debit);
      const credit = dec(l.credit);
      if (debit.isNeg() || credit.isNeg() || debit.isZero() === credit.isZero()) throw new BadRequestException(`Line ${i + 1}: enter either a debit or a credit`);
      if (debit.decimalPlaces() > rp || credit.decimalPlaces() > rp) throw new BadRequestException(`Line ${i + 1}: ${currency} allows ${rp} decimal places`);
      return { accountId: a._id, description: l.description ?? '', debit: toD128(debit), credit: toD128(credit) };
    });
    const debit = sum(lines.map((l) => l.debit));
    if (!debit.eq(sum(lines.map((l) => l.credit)))) throw new BadRequestException('The adjustment does not balance');
    return { currency, lines, total: toD128(debit) };
  }

  async list(user: AuthUser) {
    const items = await this.db.consolidationAdjustments.find({ organisationId: user.organisationId }).sort({ date: -1, number: -1 }).limit(200).lean();
    return Promise.all(items.map((a) => withTrail(this.db, a)));
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const a = await this.db.consolidationAdjustments.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!a) throw new NotFoundException('Adjustment not found');
    return withTrail(this.db, a);
  }

  async create(user: AuthUser, input: AdjustmentInput) {
    return this.db.transaction(async (session) => {
      const built = await this.build(user, input, session);
      const seq = await this.db.nextSequence(user.organisationId, null, 'consolidation', session);
      const number = `CADJ-${String(seq).padStart(5, '0')}`;
      const [doc] = await this.db.consolidationAdjustments.create(
        [{ ...built, organisationId: user.organisationId, number, date: input.date, description: input.description, entityId: input.entityId ?? null, createdBy: user.id }],
        { session },
      );
      await this.audit.log(user, { action: 'consolidation.adjustment.create', recordType: 'ConsolidationAdjustment', recordId: doc._id, summary: `Created ${number}: ${input.description}`, after: doc }, session);
      return doc.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: AdjustmentInput) {
    return this.db.transaction(async (session) => {
      const before = await this.get(user, id);
      if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException(`A ${before.status.toLowerCase()} adjustment cannot be edited`);
      const built = await this.build(user, input, session);
      const after = await transition(this.db.consolidationAdjustments, id, ['DRAFT', 'REJECTED'], { ...built, date: input.date, description: input.description, entityId: input.entityId ?? null, status: 'DRAFT' }, session);
      await this.audit.log(user, { action: 'consolidation.adjustment.update', recordType: 'ConsolidationAdjustment', recordId: id, summary: `Edited ${before.number}`, before, after }, session);
      return after;
    });
  }

  async act(user: AuthUser, id: Types.ObjectId, action: 'submit' | 'approve' | 'reject' | 'void', reason?: string) {
    return this.db.transaction(async (session) => {
      const a = await this.get(user, id);
      const now = new Date();
      let after;
      if (action === 'submit') {
        after = await transition(this.db.consolidationAdjustments, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now }, session);
        await this.workflow.open(user, subjectOf('CONSOLIDATION_ADJUSTMENT', after), session);
      } else if (action === 'approve') {
        if (a.status !== 'SUBMITTED') throw new BadRequestException('Only submitted adjustments can be approved');
        assertSegregation(user, a, 'a consolidation adjustment');
        const gate = await this.workflow.gate(user, subjectOf('CONSOLIDATION_ADJUSTMENT', a), reason, session);
        if (!gate.final) return { ...a, approval: this.workflow.view(gate.request) };
        after = await transition(this.db.consolidationAdjustments, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now }, session);
      } else if (action === 'reject') {
        after = await transition(this.db.consolidationAdjustments, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: reason ?? '' }, session);
        await this.workflow.close(user, 'CONSOLIDATION_ADJUSTMENT', id, 'REJECTED', reason ?? '', session);
      } else {
        after = await transition(this.db.consolidationAdjustments, id, ['APPROVED'], { status: 'VOID' }, session);
      }
      await this.audit.log(
        user,
        { action: `consolidation.adjustment.${action}`, recordType: 'ConsolidationAdjustment', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${a.number}${reason ? `: ${reason}` : ''}` },
        session,
      );
      return after;
    });
  }
}
