import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { assertApprovalLimit } from '../../common/workflow';
import { ASSET_ACQUISITION_TYPES, ASSET_CONDITIONS, FixedAsset } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { JournalsService, LineInput } from '../journals/journals.service';

export interface AssetInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  categoryId: Types.ObjectId;
  name: string;
  description?: string;
  serialNumber?: string;
  location?: string;
  departmentId?: Types.ObjectId | null;
  projectId?: Types.ObjectId | null;
  acquisitionDate: Date;
  tagNumber?: string;
  details?: AssetDetails;
  depreciationStart?: Date | null;
  cost: Decimal;
  residualValue?: Decimal | null;
  usefulLifeMonths?: number | null;
  annualRatePercent?: Decimal | null;
  openingAccumulated?: Decimal | null;
  /** 'POST' capitalises now (Dr asset, Cr contra account); 'EXISTING' registers an asset already in the ledger. */
  capitalisation: { mode: 'POST'; contraAccountId: Types.ObjectId } | { mode: 'EXISTING'; sourceInvoiceId?: Types.ObjectId | null };
}

/** Descriptive fields that carry no ledger effect: tag, custody, condition, source, warranty and insurance. */
export interface AssetDetails {
  custodian?: string;
  condition?: (typeof ASSET_CONDITIONS)[number];
  acquisitionType?: (typeof ASSET_ACQUISITION_TYPES)[number];
  donor?: string;
  supplierName?: string;
  makeModel?: string;
  pvNumber?: string;
  deliveryDate?: Date | null;
  warranty?: { provider?: string; expiresOn?: Date | null; terms?: string };
  insurance?: { insurer?: string; policyNumber?: string; sumInsured?: Decimal | null; premium?: Decimal | null; startsOn?: Date | null; expiresOn?: Date | null };
}

export type AssetPatch = AssetDetails & { name?: string; description?: string; serialNumber?: string; location?: string; departmentId?: Types.ObjectId | null; projectId?: Types.ObjectId | null; tagNumber?: string };

/** Flattens details into a $set so a partial warranty or insurance update keeps the other fields. */
function detailsSet(d: AssetDetails) {
  const set: Record<string, unknown> = {};
  for (const k of ['custodian', 'condition', 'acquisitionType', 'donor', 'supplierName', 'makeModel', 'pvNumber', 'deliveryDate'] as const) if (d[k] !== undefined) set[k] = d[k];
  if (d.acquisitionType && d.acquisitionType !== 'DONATED' && d.donor === undefined) set.donor = '';
  for (const [k, v] of Object.entries(d.warranty ?? {})) if (v !== undefined) set[`warranty.${k}`] = v;
  for (const [k, v] of Object.entries(d.insurance ?? {})) if (v !== undefined) set[`insurance.${k}`] = v instanceof Decimal ? toD128(v) : v;
  return set;
}

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

/**
 * Fixed asset register with monthly depreciation (straight-line or reducing balance), disposals with
 * gain or loss, and transfers between branches. Every value change posts a journal linked to the asset.
 */
export class AssetsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly journals: JournalsService,
  ) {}

  private scope(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.branchId = { $in: restricted };
    return filter;
  }

  async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession): Promise<FixedAsset> {
    const a = await this.db.fixedAssets.findOne({ ...this.scope(user), _id: id }).session(session ?? null).lean();
    if (!a) throw new NotFoundException('Asset not found');
    return a;
  }

  /** Depreciation for one month: straight-line on the depreciable amount, or a rate on net book value. */
  private monthly(asset: Pick<FixedAsset, 'method' | 'cost' | 'residualValue' | 'usefulLifeMonths' | 'annualRatePercent'>, accumulated: Decimal, fp: number): Decimal {
    const cost = dec(asset.cost);
    const depreciable = cost.minus(dec(asset.residualValue));
    const remaining = depreciable.minus(accumulated);
    if (remaining.lte(0)) return new Decimal(0);
    const charge =
      asset.method === 'REDUCING_BALANCE'
        ? round(cost.minus(accumulated).times(dec(asset.annualRatePercent)).div(1200), fp)
        : round(depreciable.div(asset.usefulLifeMonths), fp);
    return Decimal.min(charge, remaining);
  }

  /** Depreciation due from the month after `depreciatedTo` (or the start month) up to `to`, month by month. */
  schedule(asset: FixedAsset, to: Date, fp: number) {
    const start = asset.depreciatedTo ? addMonths(asset.depreciatedTo, 1) : monthStart(asset.depreciationStart);
    const months: { month: Date; amount: Decimal }[] = [];
    let accumulated = dec(asset.accumulatedDepreciation);
    for (let m = start; m <= to; m = addMonths(m, 1)) {
      const amount = this.monthly(asset, accumulated, fp);
      if (amount.isZero()) break;
      accumulated = accumulated.plus(amount);
      months.push({ month: m, amount });
    }
    return { months, total: sum(months.map((m) => m.amount)), accumulated };
  }

  async register(user: AuthUser, entityId: Types.ObjectId, asOf: Date) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const assets = await this.db.fixedAssets.find({ ...this.scope(user), entityId, acquisitionDate: { $lte: asOf } }).sort({ number: 1 }).lean();
    const categories = await this.db.assetCategories.find({ organisationId: user.organisationId }).lean();
    const rows = assets.map((a) => {
      const disposed = a.status === 'DISPOSED' && a.disposal?.date && a.disposal.date <= asOf;
      const cost = disposed ? new Decimal(0) : dec(a.cost);
      const accumulated = disposed ? new Decimal(0) : dec(a.accumulatedDepreciation);
      return { ...a, categoryName: categories.find((c) => c._id.equals(a.categoryId))?.name ?? '', costAtDate: cost, accumulatedAtDate: accumulated, netBookValue: cost.minus(accumulated) };
    });
    // Reconcile cost and accumulated depreciation to the ledger accounts of the categories in use.
    const assetAccounts = [...new Set(categories.map((c) => c.assetAccountId.toHexString()))].map((x) => new Types.ObjectId(x));
    const accAccounts = [...new Set(categories.map((c) => c.accumulatedDepreciationAccountId.toHexString()))].map((x) => new Types.ObjectId(x));
    const gl = async (ids: Types.ObjectId[]) => {
      const [r] = await this.db.ledger.aggregate<{ debit: unknown; credit: unknown }>([
        { $match: { organisationId: user.organisationId, entityId, accountId: { $in: ids }, date: { $lte: asOf } } },
        { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ]);
      return r ? dec(r.debit as never).minus(dec(r.credit as never)) : new Decimal(0);
    };
    const totals = { cost: sum(rows.map((r) => r.costAtDate)), accumulated: sum(rows.map((r) => r.accumulatedAtDate)), netBookValue: sum(rows.map((r) => r.netBookValue)) };
    const ledger = { cost: await gl(assetAccounts), accumulated: (await gl(accAccounts)).neg() };
    return { entity: { id: entity._id, code: entity.code, name: entity.name }, currency: entity.functionalCurrency, asOf, rows, totals, ledger };
  }

  async create(user: AuthUser, input: AssetInput) {
    const org = user.organisationId;
    return this.db.transaction(async (session) => {
      const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(session).lean();
      if (!entity) throw new BadRequestException('Entity not found');
      const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: org, entityId: entity._id }).session(session).lean();
      if (!branch) throw new BadRequestException('Branch not found in this entity');
      assertBranchAccess(user, [branch._id]);
      const category = await this.db.assetCategories.findOne({ _id: input.categoryId, organisationId: org }).session(session).lean();
      if (!category?.isActive) throw new BadRequestException('Asset category not found or inactive');
      const fp = await this.currencies.precision(entity.functionalCurrency);
      if (input.cost.lte(0) || input.cost.decimalPlaces() > fp) throw new BadRequestException('Enter a positive cost');
      const residual = input.residualValue ?? round(input.cost.times(dec(category.residualPercent)).div(100), fp);
      if (residual.isNeg() || residual.gte(input.cost)) throw new BadRequestException('The residual value must be less than the cost');
      const opening = input.openingAccumulated ?? new Decimal(0);
      if (opening.isNeg() || opening.gt(input.cost.minus(residual))) throw new BadRequestException('Opening depreciation cannot exceed the depreciable amount');
      const method = category.method;
      const life = input.usefulLifeMonths ?? category.usefulLifeMonths;
      const ratePct = input.annualRatePercent ?? (category.annualRatePercent ? dec(category.annualRatePercent) : null);
      if (method === 'STRAIGHT_LINE' && (!life || life <= 0)) throw new BadRequestException('Enter a useful life in months');
      if (method === 'REDUCING_BALANCE' && (!ratePct || ratePct.lte(0))) throw new BadRequestException('Enter an annual depreciation rate');
      const start = input.depreciationStart ?? input.acquisitionDate;
      const number = await this.db.nextNumber(org, entity, 'FA', session);
      const tagNumber = (input.tagNumber || number).toUpperCase();
      await this.assertTagFree(org, tagNumber, null, session);
      if (input.details?.acquisitionType === 'DONATED' && !input.details.donor) throw new BadRequestException('Name the donor of a donated asset');
      const id = new Types.ObjectId();
      let capitalisationJournalId: Types.ObjectId | null = null;

      if (input.capitalisation.mode === 'POST') {
        const contra = await this.db.accounts.findOne({ _id: input.capitalisation.contraAccountId, organisationId: org }).session(session).lean();
        if (!contra?.isPostable) throw new BadRequestException('Choose a postable account to credit (bank, payables clearing, opening balance equity...)');
        if (!contra.allowManualPosting) throw new BadRequestException(`${contra.code} is a control account; capitalise from a supplier bill instead`);
        assertApprovalLimit(user, input.cost, entity.functionalCurrency, 'The capitalisation');
        const lines: LineInput[] = [
          { accountId: category.assetAccountId, currency: entity.functionalCurrency, debit: input.cost, departmentId: input.departmentId, projectId: input.projectId, description: `${number} ${input.name}` },
          { accountId: contra._id, currency: entity.functionalCurrency, credit: input.cost, description: `${number} ${input.name}` },
        ];
        if (opening.gt(0)) {
          lines.push(
            { accountId: contra._id, currency: entity.functionalCurrency, debit: opening, description: `${number} accumulated depreciation brought forward` },
            { accountId: category.accumulatedDepreciationAccountId, currency: entity.functionalCurrency, credit: opening, description: `${number} accumulated depreciation brought forward` },
          );
        }
        const journal = await this.journals.postSystemJournal(
          user,
          { entityId: entity._id, branchId: branch._id, journalDate: input.acquisitionDate, description: `Capitalise ${number} ${input.name}`, lines },
          { sourceType: 'FixedAsset', sourceId: id, sourceNumber: number },
          session,
        );
        capitalisationJournalId = journal._id;
      }
      const [asset] = await this.db.fixedAssets.create(
        [
          {
            _id: id,
            organisationId: org,
            entityId: entity._id,
            branchId: branch._id,
            categoryId: category._id,
            number,
            name: input.name,
            description: input.description ?? '',
            serialNumber: input.serialNumber ?? '',
            location: input.location ?? '',
            originalLocation: input.location ?? '',
            tagNumber,
            departmentId: input.departmentId ?? null,
            projectId: input.projectId ?? null,
            acquisitionDate: input.acquisitionDate,
            depreciationStart: start,
            cost: toD128(input.cost),
            residualValue: toD128(residual),
            method,
            usefulLifeMonths: life,
            annualRatePercent: ratePct ? toD128(ratePct) : null,
            openingAccumulated: toD128(opening),
            accumulatedDepreciation: toD128(opening),
            depreciatedTo: null,
            capitalisationJournalId,
            sourceInvoiceId: input.capitalisation.mode === 'EXISTING' ? (input.capitalisation.sourceInvoiceId ?? null) : null,
            createdBy: user.id,
          },
        ],
        { session },
      );
      if (input.details) await this.db.fixedAssets.updateOne({ _id: id }, { $set: detailsSet(input.details) }, { session });
      await this.audit.log(user, { action: 'asset.create', recordType: 'FixedAsset', recordId: id, summary: `Registered ${number} ${input.name} (cost ${input.cost.toFixed()} ${entity.functionalCurrency})`, after: asset }, session);
      return asset.toObject();
    });
  }

  /** Tags are unique across the organisation so a scanned label always finds one asset. */
  private async assertTagFree(organisationId: Types.ObjectId, tag: string, except: Types.ObjectId | null, session?: ClientSession) {
    const clash = await this.db.fixedAssets.findOne({ organisationId, $or: [{ tagNumber: tag }, { number: tag }], ...(except && { _id: { $ne: except } }) }, { number: 1 }).session(session ?? null).lean();
    if (clash) throw new BadRequestException(`Tag ${tag} is already used by ${clash.number}`);
  }

  async update(user: AuthUser, id: Types.ObjectId, patch: AssetPatch) {
    const before = await this.load(user, id);
    const { custodian, condition, acquisitionType, donor, supplierName, makeModel, pvNumber, deliveryDate, warranty, insurance, tagNumber, ...plain } = patch;
    const set: Record<string, unknown> = { ...plain, ...detailsSet({ custodian, condition, acquisitionType, donor, supplierName, makeModel, pvNumber, deliveryDate, warranty, insurance }) };
    if (tagNumber !== undefined) {
      set.tagNumber = (tagNumber || before.number).toUpperCase();
      if (set.tagNumber !== before.tagNumber) await this.assertTagFree(user.organisationId, set.tagNumber as string, before._id);
    }
    if ((acquisitionType ?? before.acquisitionType) === 'DONATED' && !(donor ?? before.donor)) throw new BadRequestException('Name the donor of a donated asset');
    const after = await this.db.fixedAssets.findByIdAndUpdate(before._id, { $set: set }, { new: true }).lean();
    await this.audit.log(user, { action: 'asset.update', recordType: 'FixedAsset', recordId: id, summary: `Updated ${before.number}`, before, after });
    return after;
  }

  /** Calculates the depreciation due for every active asset of an entity up to a month end. */
  async preview(user: AuthUser, entityId: Types.ObjectId, periodEnd: Date) {
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new NotFoundException('Entity not found');
    const end = monthEnd(periodEnd);
    const fp = await this.currencies.precision(entity.functionalCurrency);
    const assets = await this.db.fixedAssets.find({ organisationId: user.organisationId, entityId, status: 'ACTIVE', depreciationStart: { $lte: end } }).sort({ number: 1 }).lean();
    const lines = assets
      .map((a) => {
        const s = this.schedule(a, end, fp);
        return { asset: a, ...s };
      })
      .filter((l) => l.total.gt(0));
    return {
      entity: { id: entity._id, code: entity.code },
      currency: entity.functionalCurrency,
      periodEnd: end,
      lines: lines.map((l) => ({
        assetId: l.asset._id,
        assetNumber: l.asset.number,
        name: l.asset.name,
        branchId: l.asset.branchId,
        from: l.months[0].month,
        to: monthEnd(l.months[l.months.length - 1].month),
        months: l.months.length,
        amount: l.total,
        accumulatedAfter: l.accumulated,
        netBookValueAfter: dec(l.asset.cost).minus(l.accumulated),
      })),
      total: sum(lines.map((l) => l.total)),
    };
  }

  /** Posts depreciation for all assets up to a month end; each period can be run once per entity. */
  async run(user: AuthUser, entityId: Types.ObjectId, periodEnd: Date) {
    if (!user.allBranches) throw new BadRequestException('Depreciation runs cover every branch; they need a user with access to all branches');
    const end = monthEnd(periodEnd);
    const preview = await this.preview(user, entityId, end);
    if (!preview.lines.length) throw new BadRequestException('No depreciation is due up to this date');
    return this.db.transaction(async (session) => {
      if (await this.db.depreciationRuns.exists({ organisationId: user.organisationId, entityId, periodEnd: end }).session(session)) {
        throw new BadRequestException(`Depreciation has already been run to ${end.toISOString().slice(0, 10)}`);
      }
      const categories = await this.db.assetCategories.find({ organisationId: user.organisationId }).session(session).lean();
      const lines: LineInput[] = [];
      const currency = preview.currency;
      for (const l of preview.lines) {
        const asset = (await this.db.fixedAssets.findById(l.assetId).session(session).lean())!;
        const category = categories.find((c) => c._id.equals(asset.categoryId))!;
        lines.push(
          { accountId: category.depreciationExpenseAccountId, branchId: asset.branchId, departmentId: asset.departmentId, projectId: asset.projectId, currency, debit: l.amount, description: `Depreciation ${asset.number} ${asset.name}` },
          { accountId: category.accumulatedDepreciationAccountId, branchId: asset.branchId, currency, credit: l.amount, description: `Depreciation ${asset.number}` },
        );
        const fullyDepreciated = dec(asset.cost).minus(dec(asset.residualValue)).minus(l.accumulatedAfter).lte(0);
        const updated = await this.db.fixedAssets.updateOne(
          { _id: asset._id, accumulatedDepreciation: asset.accumulatedDepreciation },
          { accumulatedDepreciation: toD128(l.accumulatedAfter), depreciatedTo: l.to, status: fullyDepreciated ? 'FULLY_DEPRECIATED' : 'ACTIVE' },
          { session },
        );
        if (updated.modifiedCount !== 1) throw new BadRequestException(`${asset.number} was changed by someone else; run again`);
      }
      const entity = (await this.db.entities.findById(entityId).session(session).lean())!;
      const id = new Types.ObjectId();
      const number = `DEP-${entity.code}-${end.toISOString().slice(0, 7)}`;
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId, branchId: preview.lines[0].branchId, journalDate: end, description: `Depreciation to ${end.toISOString().slice(0, 10)}`, reference: number, lines },
        { sourceType: 'DepreciationRun', sourceId: id, sourceNumber: number },
        session,
      );
      const [run] = await this.db.depreciationRuns.create(
        [
          {
            _id: id,
            organisationId: user.organisationId,
            entityId,
            periodEnd: end,
            lines: preview.lines.map((l) => ({ assetId: l.assetId, assetNumber: l.assetNumber, branchId: l.branchId, from: l.from, to: l.to, months: l.months, amount: toD128(l.amount) })),
            total: toD128(preview.total),
            journalId: journal._id,
            createdBy: user.id,
          },
        ],
        { session },
      );
      await this.audit.log(user, { action: 'asset.depreciate', recordType: 'DepreciationRun', recordId: id, summary: `${number}: depreciation ${preview.total.toFixed()} ${currency} on ${preview.lines.length} asset(s) (${journal.number})` }, session);
      return { ...run.toObject(), journalNumber: journal.number };
    });
  }

  runs(user: AuthUser, entityId: Types.ObjectId) {
    return this.db.depreciationRuns.find({ organisationId: user.organisationId, entityId }, { lines: 0 }).sort({ periodEnd: -1 }).limit(60).lean();
  }

  /** Disposes of an asset: removes cost and accumulated depreciation and books the gain or loss. */
  async dispose(user: AuthUser, id: Types.ObjectId, input: { date: Date; proceeds: Decimal; proceedsAccountId?: Types.ObjectId | null; reason: string }) {
    return this.db.transaction(async (session) => {
      const asset = await this.load(user, id, session);
      if (asset.status === 'DISPOSED') throw new BadRequestException('The asset has already been disposed of');
      if (input.date < asset.acquisitionDate) throw new BadRequestException('The disposal date is before the acquisition date');
      const entity = (await this.db.entities.findById(asset.entityId).session(session).lean())!;
      const fp = await this.currencies.precision(entity.functionalCurrency);
      // Depreciation must be up to date to the month before disposal.
      const due = this.schedule(asset, monthEnd(addMonths(input.date, -1)), fp);
      if (due.total.gt(0)) throw new BadRequestException(`Run depreciation to ${monthEnd(addMonths(input.date, -1)).toISOString().slice(0, 10)} before disposing of ${asset.number}`);
      const category = (await this.db.assetCategories.findById(asset.categoryId).session(session).lean())!;
      const cost = dec(asset.cost);
      const accumulated = dec(asset.accumulatedDepreciation);
      const proceeds = input.proceeds;
      if (proceeds.isNeg()) throw new BadRequestException('Proceeds cannot be negative');
      if (proceeds.gt(0) && !input.proceedsAccountId) throw new BadRequestException('Choose the account that received the proceeds');
      const gainLoss = proceeds.minus(cost.minus(accumulated));
      const currency = entity.functionalCurrency;
      const lines: LineInput[] = [{ accountId: category.assetAccountId, currency, credit: cost, description: `Dispose ${asset.number} – cost` }];
      if (accumulated.gt(0)) lines.push({ accountId: category.accumulatedDepreciationAccountId, currency, debit: accumulated, description: `Dispose ${asset.number} – accumulated depreciation` });
      if (proceeds.gt(0)) lines.push({ accountId: input.proceedsAccountId!, currency, debit: proceeds, description: `Proceeds from ${asset.number}` });
      if (!gainLoss.isZero()) {
        lines.push({ accountId: category.disposalAccountId, currency, debit: gainLoss.lt(0) ? gainLoss.abs() : null, credit: gainLoss.gt(0) ? gainLoss : null, description: `${gainLoss.gt(0) ? 'Gain' : 'Loss'} on disposal of ${asset.number}` });
      }
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: asset.entityId, branchId: asset.branchId, journalDate: input.date, description: `Disposal of ${asset.number} ${asset.name}: ${input.reason}`, lines },
        { sourceType: 'FixedAsset', sourceId: asset._id, sourceNumber: asset.number },
        session,
      );
      const after = await this.db.fixedAssets
        .findOneAndUpdate(
          { _id: asset._id, status: { $ne: 'DISPOSED' } },
          { status: 'DISPOSED', disposal: { date: input.date, proceeds: toD128(proceeds), gainLoss: toD128(round(gainLoss, fp)), journalId: journal._id, reason: input.reason } },
          { new: true, session },
        )
        .lean();
      if (!after) throw new BadRequestException('The asset was changed by someone else');
      await this.audit.log(user, { action: 'asset.dispose', recordType: 'FixedAsset', recordId: asset._id, summary: `Disposed of ${asset.number}: proceeds ${proceeds.toFixed()}, ${gainLoss.gte(0) ? 'gain' : 'loss'} ${gainLoss.abs().toFixed()} ${currency} (${journal.number})` }, session);
      return after;
    });
  }

  /** Moves an asset to another branch of the entity, carrying its cost and depreciation with it. */
  async transfer(user: AuthUser, id: Types.ObjectId, input: { date: Date; branchId: Types.ObjectId; location?: string }) {
    return this.db.transaction(async (session) => {
      const asset = await this.load(user, id, session);
      if (asset.status === 'DISPOSED') throw new BadRequestException('A disposed asset cannot be transferred');
      if (asset.branchId.equals(input.branchId)) throw new BadRequestException('The asset is already in that branch');
      const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: user.organisationId, entityId: asset.entityId }).session(session).lean();
      if (!branch) throw new BadRequestException('Branch not found in this entity');
      assertBranchAccess(user, [branch._id]);
      const category = (await this.db.assetCategories.findById(asset.categoryId).session(session).lean())!;
      const entity = (await this.db.entities.findById(asset.entityId).session(session).lean())!;
      const currency = entity.functionalCurrency;
      const cost = dec(asset.cost);
      const accumulated = dec(asset.accumulatedDepreciation);
      const lines: LineInput[] = [
        { accountId: category.assetAccountId, branchId: branch._id, currency, debit: cost, description: `${asset.number} transferred in` },
        { accountId: category.assetAccountId, branchId: asset.branchId, currency, credit: cost, description: `${asset.number} transferred out` },
      ];
      if (accumulated.gt(0)) {
        lines.push(
          { accountId: category.accumulatedDepreciationAccountId, branchId: asset.branchId, currency, debit: accumulated, description: `${asset.number} transferred out` },
          { accountId: category.accumulatedDepreciationAccountId, branchId: branch._id, currency, credit: accumulated, description: `${asset.number} transferred in` },
        );
      }
      const journal = await this.journals.postSystemJournal(
        user,
        { entityId: asset.entityId, branchId: asset.branchId, journalDate: input.date, description: `Transfer of ${asset.number} to ${branch.code}`, lines },
        { sourceType: 'FixedAsset', sourceId: asset._id, sourceNumber: asset.number },
        session,
      );
      const after = await this.db.fixedAssets.findByIdAndUpdate(asset._id, { branchId: branch._id, ...(input.location !== undefined && { location: input.location }) }, { new: true, session }).lean();
      await this.audit.log(user, { action: 'asset.transfer', recordType: 'FixedAsset', recordId: asset._id, summary: `Transferred ${asset.number} to ${branch.code} (${journal.number})`, before: asset, after }, session);
      return after;
    });
  }

  async history(user: AuthUser, id: Types.ObjectId) {
    const asset = await this.load(user, id);
    const journals = await this.db.journals
      .find({ organisationId: user.organisationId, $or: [{ sourceId: asset._id }, { _id: { $in: (await this.db.depreciationRuns.find({ 'lines.assetId': asset._id }, { journalId: 1 }).lean()).map((r) => r.journalId) } }] }, { number: 1, journalDate: 1, description: 1, totalDebit: 1 })
      .sort({ journalDate: 1 })
      .lean();
    const runs = await this.db.depreciationRuns.find({ organisationId: user.organisationId, 'lines.assetId': asset._id }).sort({ periodEnd: 1 }).lean();
    const fp = await this.currencies.precision((await this.db.entities.findById(asset.entityId).lean())!.functionalCurrency);
    const forecast = this.schedule(asset, addMonths(new Date(), 24), fp).months.slice(0, 24).map((m) => ({ month: m.month, amount: m.amount }));
    return {
      asset,
      journals,
      depreciation: runs.map((r) => ({ periodEnd: r.periodEnd, journalId: r.journalId, ...r.lines.find((l) => l.assetId?.equals(asset._id)) })),
      forecast,
    };
  }
}
