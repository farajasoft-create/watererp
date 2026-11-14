import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { allowedBranches, assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { Decimal, dec, round, sum, toD128 } from '../../common/money';
import { Db } from '../../database/db.service';
import { Account, DimensionType, Journal, JOURNAL_STATUSES, JournalLine, JournalStatus, PartyType } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { PeriodsService } from '../periods/periods.service';
import { MANUAL_SOURCES, WarehouseService } from '../analytics/warehouse.service';
import { subjectOf, WorkflowService } from '../workflow/workflow.service';

export interface LineInput {
  accountId: Types.ObjectId;
  branchId?: Types.ObjectId | null;
  departmentId?: Types.ObjectId | null;
  costCentreId?: Types.ObjectId | null;
  projectId?: Types.ObjectId | null;
  fundId?: Types.ObjectId | null;
  /** Intercompany: the other group entity this line is with (eliminated on consolidation). */
  intercompanyEntityId?: Types.ObjectId | null;
  description?: string;
  currency?: string;
  exchangeRate?: Decimal | null;
  debit?: Decimal | null;
  credit?: Decimal | null;
  partyType?: PartyType | null;
  partyId?: Types.ObjectId | null;
  /**
   * SYSTEM journals only: exact functional-currency amounts computed by a subledger (carrying values,
   * realised FX). When present the transaction amount may be zero (pure functional adjustments).
   */
  functionalDebit?: Decimal | null;
  functionalCredit?: Decimal | null;
}

export interface JournalInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  journalDate: Date;
  description: string;
  reference?: string;
  type?: 'STANDARD' | 'ACCRUAL' | 'OPENING';
  autoReverseDate?: Date | null;
  lines: LineInput[];
}

export interface SourceLink {
  sourceType: string;
  sourceId: Types.ObjectId;
  sourceNumber: string;
}

export type JournalSource = 'MANUAL' | 'API' | 'IMPORT' | 'SYSTEM';

export interface JournalListQuery {
  entityId?: Types.ObjectId;
  branchId?: Types.ObjectId;
  accountId?: Types.ObjectId;
  status?: JournalStatus;
  from?: Date;
  to?: Date;
  search?: string;
  page: number;
  pageSize: number;
}

const DIMENSION_FIELDS: [keyof LineInput, DimensionType, string][] = [
  ['departmentId', 'DEPARTMENT', 'department'],
  ['costCentreId', 'COST_CENTRE', 'cost centre'],
  ['projectId', 'PROJECT', 'project'],
  ['fundId', 'FUND', 'fund'],
];

const lineLabel = (i: number) => `Line ${i + 1}`;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class JournalsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly periods: PeriodsService,
    private readonly workflow: WorkflowService,
    private readonly warehouse: WarehouseService,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Validation & translation
  // ------------------------------------------------------------------------------------------

  /**
   * Validates a journal against master data, translates every line into the entity's functional
   * currency and checks that it balances. Returns the fields to persist.
   */
  async build(user: AuthUser, input: JournalInput, source: JournalSource | 'REVERSAL', session?: ClientSession) {
    const org = user.organisationId;
    const s = session ?? null;

    if (input.lines.length < 2) throw new BadRequestException('A journal needs at least two lines');
    if (input.lines.length > 1000) throw new BadRequestException('A journal may have at most 1000 lines');

    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).session(s).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    if (!entity.isActive) throw new BadRequestException(`Entity ${entity.code} is inactive`);
    const functional = entity.functionalCurrency;
    const functionalPrecision = await this.currencies.precision(functional);

    const period = await this.periods.periodFor(org, entity._id, input.journalDate, session);
    if (!period) {
      throw new BadRequestException(`No accounting period covers ${input.journalDate.toISOString().slice(0, 10)} for ${entity.code}`);
    }
    if (period.status === 'HARD_CLOSED') throw new BadRequestException(`Period ${period.name} is closed`);
    if (input.autoReverseDate && input.autoReverseDate <= input.journalDate) {
      throw new BadRequestException('The auto-reverse date must be after the journal date');
    }

    // Branches: every line carries a branch, defaulting to the header branch.
    const branchIds = [input.branchId, ...input.lines.map((l) => l.branchId ?? input.branchId)];
    assertBranchAccess(user, branchIds);
    const branches = await this.db.branches
      .find({ organisationId: org, _id: { $in: branchIds } })
      .session(s)
      .lean();
    const branchById = new Map(branches.map((b) => [b._id.toHexString(), b]));
    for (const id of new Set(branchIds.map(String))) {
      const branch = branchById.get(id);
      if (!branch) throw new BadRequestException(`Branch ${id} not found`);
      if (!branch.entityId.equals(entity._id)) throw new BadRequestException(`Branch ${branch.code} does not belong to ${entity.code}`);
      if (!branch.isActive) throw new BadRequestException(`Branch ${branch.code} is inactive`);
    }

    const accounts = await this.db.accounts
      .find({ organisationId: org, _id: { $in: input.lines.map((l) => l.accountId) } })
      .session(s)
      .lean();
    const accountById = new Map(accounts.map((a) => [a._id.toHexString(), a]));

    const dimensionIds = input.lines.flatMap((l) => DIMENSION_FIELDS.map(([f]) => l[f] as Types.ObjectId | null | undefined)).filter(Boolean);
    const dimensions = dimensionIds.length
      ? await this.db.dimensions.find({ organisationId: org, _id: { $in: dimensionIds } }).session(s).lean()
      : [];
    const dimensionById = new Map(dimensions.map((d) => [d._id.toHexString(), d]));

    const orgDoc = await this.db.organisations.findById(org).session(s).lean();
    const activeCurrencies = new Set(orgDoc?.activeCurrencies ?? []);

    const lines: JournalLine[] = [];
    for (const [i, line] of input.lines.entries()) {
      const label = lineLabel(i);
      const account = accountById.get(line.accountId.toHexString());
      if (!account) throw new BadRequestException(`${label}: account not found`);
      this.assertAccountUsable(account, entity._id, source, label);

      for (const [field, type, name] of DIMENSION_FIELDS) {
        const id = line[field] as Types.ObjectId | null | undefined;
        if (id) {
          const dim = dimensionById.get(id.toHexString());
          if (!dim || dim.type !== type) throw new BadRequestException(`${label}: ${name} not found`);
          if (!dim.isActive) throw new BadRequestException(`${label}: ${name} ${dim.code} is inactive`);
          if (dim.entityId && !dim.entityId.equals(entity._id)) {
            throw new BadRequestException(`${label}: ${name} ${dim.code} is not available in ${entity.code}`);
          }
        }
      }
      if (line.intercompanyEntityId) {
        if (line.intercompanyEntityId.equals(entity._id)) throw new BadRequestException(`${label}: an intercompany line is with another entity of the group`);
        const other = await this.db.entities.findOne({ _id: line.intercompanyEntityId, organisationId: org }, { _id: 1 }).session(session ?? null).lean();
        if (!other) throw new BadRequestException(`${label}: intercompany entity not found`);
        if (line.partyId) throw new BadRequestException(`${label}: a line is either with a customer/supplier or with a group entity, not both`);
      }
      if (account.requiresDepartment && !line.departmentId) throw new BadRequestException(`${label}: account ${account.code} requires a department`);
      if (account.requiresCostCentre && !line.costCentreId) throw new BadRequestException(`${label}: account ${account.code} requires a cost centre`);
      if (account.requiresProject && !line.projectId) throw new BadRequestException(`${label}: account ${account.code} requires a project`);

      const currency = line.currency ?? account.currency ?? functional;
      if (!activeCurrencies.has(currency)) throw new BadRequestException(`${label}: currency ${currency} is not active`);
      if (account.currency && account.currency !== currency) {
        throw new BadRequestException(`${label}: account ${account.code} only accepts ${account.currency}`);
      }
      const txPrecision = await this.currencies.precision(currency);

      const debitTx = dec(line.debit);
      const creditTx = dec(line.credit);
      const explicit = line.functionalDebit != null || line.functionalCredit != null;
      if (explicit && source !== 'SYSTEM') throw new BadRequestException(`${label}: functional amounts can only be set by the system`);
      if (debitTx.isNeg() || creditTx.isNeg()) throw new BadRequestException(`${label}: amounts cannot be negative`);
      if (!explicit && debitTx.isZero() === creditTx.isZero()) throw new BadRequestException(`${label}: enter either a debit or a credit`);
      for (const amount of [debitTx, creditTx]) {
        if (amount.decimalPlaces() > txPrecision) {
          throw new BadRequestException(`${label}: ${currency} allows at most ${txPrecision} decimal places`);
        }
      }

      let rate: Decimal;
      if (currency === functional) {
        if (line.exchangeRate && !dec(line.exchangeRate).eq(1)) {
          throw new BadRequestException(`${label}: the exchange rate for the functional currency must be 1`);
        }
        rate = new Decimal(1);
      } else if (line.exchangeRate) {
        rate = dec(line.exchangeRate);
        if (rate.lte(0)) throw new BadRequestException(`${label}: exchange rate must be positive`);
      } else {
        const found = await this.currencies.findRate(org, currency, functional, input.journalDate, 'SPOT', session);
        if (!found) {
          throw new BadRequestException(
            `${label}: no approved ${currency}/${functional} rate on or before ${input.journalDate.toISOString().slice(0, 10)}`,
          );
        }
        rate = found.rate;
      }

      let debit = round(debitTx.times(rate), functionalPrecision);
      let credit = round(creditTx.times(rate), functionalPrecision);
      if (explicit) {
        debit = dec(line.functionalDebit);
        credit = dec(line.functionalCredit);
        const debitSide = debitTx.gt(0) || debit.gt(0);
        const creditSide = creditTx.gt(0) || credit.gt(0);
        if (debit.isNeg() || credit.isNeg() || debitSide === creditSide) throw new BadRequestException(`${label}: invalid system amounts`);
        if (debit.decimalPlaces() > functionalPrecision || credit.decimalPlaces() > functionalPrecision) {
          throw new BadRequestException(`${label}: functional amounts exceed ${functional} precision`);
        }
      }

      lines.push({
        lineNo: i + 1,
        accountId: account._id,
        branchId: line.branchId ?? input.branchId,
        departmentId: line.departmentId ?? null,
        costCentreId: line.costCentreId ?? null,
        projectId: line.projectId ?? null,
        fundId: line.fundId ?? null,
        partyType: line.partyType ?? null,
        partyId: line.partyId ?? null,
        intercompanyEntityId: line.intercompanyEntityId ?? null,
        autoInterBranch: false,
        description: line.description ?? '',
        currency,
        exchangeRate: toD128(rate),
        debitTx: toD128(debitTx),
        creditTx: toD128(creditTx),
        debit: toD128(debit),
        credit: toD128(credit),
      });
    }

    const totalDebit = sum(lines.map((l) => l.debit));
    const totalCredit = sum(lines.map((l) => l.credit));
    if (!totalDebit.eq(totalCredit)) {
      throw new BadRequestException(
        `Journal does not balance in ${functional}: debits ${totalDebit.toFixed(functionalPrecision)} ≠ credits ${totalCredit.toFixed(functionalPrecision)} (difference ${totalDebit.minus(totalCredit).abs().toFixed(functionalPrecision)})`,
      );
    }

    // Totals stay at the transaction's value; clearing lines are added after so approval limits are not inflated.
    lines.push(...this.interBranchLines(lines, orgDoc?.settings?.interBranchAccountId ?? null, functional));

    return {
      entity,
      period,
      fields: {
        entityId: entity._id,
        branchId: input.branchId,
        journalDate: input.journalDate,
        periodId: period._id,
        description: input.description,
        reference: input.reference ?? '',
        type: input.type ?? 'STANDARD',
        autoReverseDate: input.autoReverseDate ?? null,
        functionalCurrency: functional,
        totalDebit: toD128(totalDebit),
        totalCredit: toD128(totalCredit),
        lines,
      },
    };
  }

  /**
   * When a journal spans branches, each branch must balance on its own so branch balance sheets hold.
   * Any branch left with a net debit or credit is balanced against the inter-branch clearing account
   * (due to / due from), so the clearing balances across the entity always sum to zero.
   */
  private interBranchLines(lines: JournalLine[], clearingAccountId: Types.ObjectId | null, functional: string): JournalLine[] {
    const net = new Map<string, Decimal>();
    for (const l of lines) {
      const key = l.branchId.toHexString();
      net.set(key, (net.get(key) ?? new Decimal(0)).plus(dec(l.debit)).minus(dec(l.credit)));
    }
    const unbalanced = [...net.entries()].filter(([, v]) => !v.isZero());
    if (!unbalanced.length) return [];
    if (!clearingAccountId) {
      throw new BadRequestException('This journal leaves branches unbalanced; set the inter-branch clearing account in organisation settings');
    }
    return unbalanced.map(([branch, v], i) => ({
      lineNo: lines.length + i + 1,
      accountId: clearingAccountId,
      branchId: new Types.ObjectId(branch),
      departmentId: null,
      costCentreId: null,
      projectId: null,
      fundId: null,
      partyType: null,
      partyId: null,
      autoInterBranch: true,
      description: v.gt(0) ? 'Inter-branch: due to other branches' : 'Inter-branch: due from other branches',
      currency: functional,
      exchangeRate: toD128(1),
      debitTx: toD128(v.lt(0) ? v.neg() : 0),
      creditTx: toD128(v.gt(0) ? v : 0),
      debit: toD128(v.lt(0) ? v.neg() : 0),
      credit: toD128(v.gt(0) ? v : 0),
    }));
  }

  private assertAccountUsable(account: Account, entityId: Types.ObjectId, source: string, label: string) {
    if (!account.isActive) throw new BadRequestException(`${label}: account ${account.code} is inactive`);
    if (!account.isPostable) throw new BadRequestException(`${label}: ${account.code} is a header account and cannot be posted to`);
    if (account.entityIds.length && !account.entityIds.some((e) => e.equals(entityId))) {
      throw new BadRequestException(`${label}: account ${account.code} is not available in this entity`);
    }
    if (!account.allowManualPosting && source !== 'SYSTEM' && source !== 'REVERSAL') {
      throw new BadRequestException(`${label}: ${account.code} is a control account and only accepts postings from its subledger`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------------------------

  private scopeFilter(user: AuthUser): Record<string, unknown> {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    const restricted = allowedBranches(user);
    if (restricted) filter.$or = [{ branchId: { $in: restricted } }, { 'lines.branchId': { $in: restricted } }];
    return filter;
  }

  async list(user: AuthUser, q: JournalListQuery) {
    const filter = this.scopeFilter(user);
    if (q.entityId) filter.entityId = q.entityId;
    if (q.status) filter.status = q.status;
    if (q.branchId) filter['lines.branchId'] = q.branchId;
    if (q.accountId) filter['lines.accountId'] = q.accountId;
    if (q.from || q.to) filter.journalDate = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$and = [{ $or: [{ number: rx }, { description: rx }, { reference: rx }] }];
    }
    const [items, total, counts] = await Promise.all([
      this.db.journals
        .find(filter, { lines: 0 })
        .sort({ journalDate: -1, number: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      this.db.journals.countDocuments(filter),
      this.db.journals.aggregate<{ _id: string; n: number }>([
        { $match: { ...filter, status: { $exists: true } } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);
    const names = await this.userNames(items.map((j) => j.createdBy));
    return {
      items: items.map((j) => ({ ...j, createdByName: names.get(j.createdBy.toHexString()) ?? '' })),
      total,
      page: q.page,
      pageSize: q.pageSize,
      statusCounts: Object.fromEntries(JOURNAL_STATUSES.map((st) => [st, counts.find((c) => c._id === st)?.n ?? 0])),
    };
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const journal = await this.db.journals.findOne({ ...this.scopeFilter(user), _id: id }).lean();
    if (!journal) throw new NotFoundException('Journal not found');
    const related = await this.db.journals
      .find({ _id: { $in: [journal.reversalOfId, journal.reversedById].filter(Boolean) } }, { number: 1 })
      .lean();
    const names = await this.userNames([
      journal.createdBy,
      journal.submittedBy,
      journal.approvedBy,
      journal.postedBy,
      journal.rejectedBy,
    ]);
    const nameOf = (uid: Types.ObjectId | null | undefined) => (uid ? (names.get(uid.toHexString()) ?? '') : null);
    return {
      ...journal,
      createdByName: nameOf(journal.createdBy),
      submittedByName: nameOf(journal.submittedBy),
      approvedByName: nameOf(journal.approvedBy),
      postedByName: nameOf(journal.postedBy),
      rejectedByName: nameOf(journal.rejectedBy),
      reversalOfNumber: related.find((r) => r._id.equals(journal.reversalOfId ?? undefined))?.number ?? null,
      reversedByNumber: related.find((r) => r._id.equals(journal.reversedById ?? undefined))?.number ?? null,
    };
  }

  private async userNames(ids: (Types.ObjectId | null | undefined)[]) {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    const users = await this.db.users.find({ _id: { $in: unique } }, { name: 1 }).lean();
    return new Map(users.map((u) => [u._id.toHexString(), u.name]));
  }

  private async load(user: AuthUser, id: Types.ObjectId, session?: ClientSession): Promise<Journal> {
    const journal = await this.db.journals
      .findOne({ ...this.scopeFilter(user), _id: id })
      .session(session ?? null)
      .lean();
    if (!journal) throw new NotFoundException('Journal not found');
    assertBranchAccess(user, [journal.branchId, ...journal.lines.map((l) => l.branchId)]);
    return journal;
  }

  /** Moves a journal between statuses only if nobody else changed it first (optimistic concurrency). */
  private async transition(
    journal: Journal,
    from: JournalStatus[],
    update: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<Journal> {
    const after = await this.db.journals
      .findOneAndUpdate({ _id: journal._id, status: { $in: from } }, update, { new: true, session })
      .lean();
    if (!after) throw new BadRequestException('The journal was changed by someone else; reload and try again');
    return after;
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle: draft → submitted → approved → posted (or rejected), with reversal after posting
  // ------------------------------------------------------------------------------------------

  async create(user: AuthUser, input: JournalInput, opts: { source?: JournalSource; idempotencyKey?: string } = {}) {
    const source = opts.source ?? 'MANUAL';
    if (opts.idempotencyKey) {
      const existing = await this.db.journals
        .findOne({ organisationId: user.organisationId, idempotencyKey: opts.idempotencyKey })
        .lean();
      if (existing) return existing;
    }
    return this.db.transaction(async (session) => {
      const { entity, fields } = await this.build(user, input, source, session);
      const seq = await this.db.nextSequence(user.organisationId, entity._id, 'journal', session);
      const [journal] = await this.db.journals.create(
        [
          {
            ...fields,
            organisationId: user.organisationId,
            number: `JV-${entity.code}-${String(seq).padStart(6, '0')}`,
            source,
            status: 'DRAFT',
            idempotencyKey: opts.idempotencyKey,
            createdBy: user.id,
          },
        ],
        { session },
      );
      await this.audit.log(
        user,
        { action: 'journal.create', recordType: 'Journal', recordId: journal._id, summary: `Created ${journal.number}`, after: journal },
        session,
      );
      return journal.toObject();
    });
  }

  async update(user: AuthUser, id: Types.ObjectId, input: JournalInput) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') {
        throw new BadRequestException(`A ${before.status.toLowerCase()} journal cannot be edited`);
      }
      if (!before.entityId.equals(input.entityId)) throw new BadRequestException('The entity of a journal cannot change');
      const { fields } = await this.build(user, input, before.source as JournalSource, session);
      const after = await this.transition(
        before,
        ['DRAFT', 'REJECTED'],
        { ...fields, status: 'DRAFT', rejectedBy: null, rejectedAt: null, rejectionReason: '' },
        session,
      );
      await this.audit.log(
        user,
        { action: 'journal.update', recordType: 'Journal', recordId: id, summary: `Edited ${before.number}`, before, after },
        session,
      );
      return after;
    });
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') {
        throw new BadRequestException('Only draft or rejected journals can be deleted');
      }
      await this.db.journals.deleteOne({ _id: id, status: before.status }, { session });
      await this.workflow.close(user, 'JOURNAL', id, 'CANCELLED', 'Deleted', session);
      await this.audit.log(
        user,
        { action: 'journal.delete', recordType: 'Journal', recordId: id, summary: `Deleted ${before.number}`, before },
        session,
      );
      return { id, deleted: true };
    });
  }

  async submit(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'DRAFT' && before.status !== 'REJECTED') {
        throw new BadRequestException(`A ${before.status.toLowerCase()} journal cannot be submitted`);
      }
      await this.revalidate(user, before, session);
      const after = await this.transition(
        before,
        ['DRAFT', 'REJECTED'],
        { status: 'SUBMITTED', submittedBy: user.id, submittedAt: new Date() },
        session,
      );
      await this.audit.log(
        user,
        { action: 'journal.submit', recordType: 'Journal', recordId: id, summary: `Submitted ${before.number} for approval` },
        session,
      );
      await this.workflow.open(user, subjectOf('JOURNAL', after), session);
      return after;
    });
  }

  async approve(user: AuthUser, id: Types.ObjectId, opts: { post?: boolean; comment?: string } = {}) {
    let final = true;
    const approved = await this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'SUBMITTED') throw new BadRequestException('Only submitted journals can be approved');
      if (before.createdBy.equals(user.id) || before.submittedBy?.equals(user.id)) {
        throw new ForbiddenException('Segregation of duties: you cannot approve a journal you prepared or submitted');
      }
      // Multi-step approval: until the last step is approved the journal stays submitted.
      const gate = await this.workflow.gate(user, subjectOf('JOURNAL', before), opts.comment, session);
      final = gate.final;
      if (!gate.final) return { ...before, approval: this.workflow.view(gate.request) };
      if (user.approvalLimit !== null && dec(before.totalDebit).gt(dec(user.approvalLimit))) {
        throw new ForbiddenException(
          `Journal value ${dec(before.totalDebit).toFixed()} ${before.functionalCurrency} exceeds your approval limit of ${user.approvalLimit}`,
        );
      }
      const after = await this.transition(before, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: new Date() }, session);
      await this.audit.log(
        user,
        {
          action: 'journal.approve',
          recordType: 'Journal',
          recordId: id,
          summary: `Approved ${before.number}${opts.comment ? `: ${opts.comment}` : ''}`,
        },
        session,
      );
      return after;
    });
    return opts.post && final ? this.post(user, id) : approved;
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      if (before.status !== 'SUBMITTED' && before.status !== 'APPROVED') {
        throw new BadRequestException('Only submitted or approved journals can be rejected');
      }
      const after = await this.transition(
        before,
        ['SUBMITTED', 'APPROVED'],
        { status: 'REJECTED', rejectedBy: user.id, rejectedAt: new Date(), rejectionReason: reason, approvedBy: null, approvedAt: null },
        session,
      );
      await this.audit.log(
        user,
        { action: 'journal.reject', recordType: 'Journal', recordId: id, summary: `Rejected ${before.number}: ${reason}` },
        session,
      );
      await this.workflow.close(user, 'JOURNAL', id, 'REJECTED', reason, session);
      return after;
    });
  }

  /**
   * Posts a journal to the general ledger. Everything (status change, ledger rows, audit, and an
   * automatic reversal for accruals) commits atomically or not at all.
   */
  async post(user: AuthUser, id: Types.ObjectId) {
    return this.db.transaction(async (session) => {
      const before = await this.load(user, id, session);
      const org = await this.db.organisations.findById(user.organisationId).session(session).lean();
      const allowed: JournalStatus[] = org?.settings?.requireJournalApproval === false ? ['DRAFT', 'SUBMITTED', 'APPROVED'] : ['APPROVED'];
      if (!allowed.includes(before.status as JournalStatus)) {
        throw new BadRequestException(
          before.status === 'POSTED' ? 'Journal is already posted' : 'Journal must be approved before it can be posted',
        );
      }
      await this.periods.assertPostable(user, before.entityId, before.journalDate, session);
      await this.revalidate(user, before, session);

      const now = new Date();
      const after = await this.transition(before, allowed, { status: 'POSTED', postedBy: user.id, postedAt: now }, session);
      await this.writeLedger(after, now, session);
      await this.audit.log(
        user,
        { action: 'journal.post', recordType: 'Journal', recordId: id, summary: `Posted ${before.number} to the ledger` },
        session,
      );

      if (after.autoReverseDate) {
        await this.createReversal(user, after, after.autoReverseDate, `Auto-reversal of ${after.number}`, session);
      }
      return this.db.journals.findById(id).session(session).lean();
    });
  }

  async reverse(user: AuthUser, id: Types.ObjectId, date: Date, reason: string) {
    return this.db.transaction(async (session) => {
      const original = await this.load(user, id, session);
      if (original.status !== 'POSTED') throw new BadRequestException('Only posted journals can be reversed');
      if (original.reversedById) throw new BadRequestException('Journal has already been reversed');
      if (original.reversalOfId) throw new BadRequestException('A reversal cannot itself be reversed; post a new journal instead');
      if (original.sourceType) {
        throw new BadRequestException(`This journal was generated by ${original.sourceNumber}; void or reverse it from the source document`);
      }
      if (date < original.journalDate) throw new BadRequestException('The reversal date cannot be before the original journal date');
      return this.createReversal(user, original, date, reason, session);
    });
  }

  /** Reverses a subledger journal as part of the caller's transaction (voids and cancellations). */
  async reverseSystemJournal(user: AuthUser, journalId: Types.ObjectId, date: Date, reason: string, session: ClientSession) {
    const original = await this.db.journals.findOne({ _id: journalId, organisationId: user.organisationId }).session(session).lean();
    if (!original) throw new NotFoundException('Journal not found');
    if (original.reversedById) throw new BadRequestException(`${original.number} has already been reversed`);
    return this.createReversal(user, original, date < original.journalDate ? original.journalDate : date, reason, session);
  }

  private async createReversal(user: AuthUser, original: Journal, date: Date, reason: string, session: ClientSession) {
    const period = await this.periods.assertPostable(user, original.entityId, date, session);
    const entity = await this.db.entities.findById(original.entityId).session(session).lean();
    const seq = await this.db.nextSequence(user.organisationId, original.entityId, 'journal', session);
    const now = new Date();
    const [reversal] = await this.db.journals.create(
      [
        {
          organisationId: user.organisationId,
          entityId: original.entityId,
          branchId: original.branchId,
          number: `JV-${entity!.code}-${String(seq).padStart(6, '0')}`,
          journalDate: date,
          periodId: period._id,
          description: `Reversal of ${original.number}: ${reason}`,
          reference: original.number,
          type: 'REVERSAL',
          source: 'REVERSAL',
          status: 'POSTED',
          functionalCurrency: original.functionalCurrency,
          totalDebit: original.totalCredit,
          totalCredit: original.totalDebit,
          reversalOfId: original._id,
          sourceType: original.sourceType,
          sourceId: original.sourceId,
          sourceNumber: original.sourceNumber,
          lines: original.lines.map((l) => ({
            ...l,
            debitTx: l.creditTx,
            creditTx: l.debitTx,
            debit: l.credit,
            credit: l.debit,
            description: l.description ? `Reversal: ${l.description}` : 'Reversal',
          })),
          createdBy: user.id,
          approvedBy: user.id,
          approvedAt: now,
          postedBy: user.id,
          postedAt: now,
        },
      ],
      { session },
    );
    const marked = await this.db.journals.updateOne(
      { _id: original._id, reversedById: null },
      { reversedById: reversal._id },
      { session },
    );
    if (marked.modifiedCount !== 1) throw new BadRequestException('Journal has already been reversed');
    await this.writeLedger(reversal.toObject(), now, session);
    await this.audit.log(
      user,
      {
        action: 'journal.reverse',
        recordType: 'Journal',
        recordId: original._id,
        summary: `Reversed ${original.number} with ${reversal.number} dated ${date.toISOString().slice(0, 10)}`,
      },
      session,
    );
    return reversal.toObject();
  }

  /**
   * Creates and posts a SYSTEM journal for a subledger document inside the caller's transaction.
   * Approval happened on the source document, so the journal goes straight to the ledger.
   */
  async postSystemJournal(user: AuthUser, input: JournalInput, link: SourceLink, session: ClientSession) {
    const { entity, fields } = await this.build(user, input, 'SYSTEM', session);
    await this.periods.assertPostable(user, entity._id, input.journalDate, session);
    const seq = await this.db.nextSequence(user.organisationId, entity._id, 'journal', session);
    const now = new Date();
    const [journal] = await this.db.journals.create(
      [
        {
          ...fields,
          ...link,
          organisationId: user.organisationId,
          number: `JV-${entity.code}-${String(seq).padStart(6, '0')}`,
          source: 'SYSTEM',
          status: 'POSTED',
          createdBy: user.id,
          approvedBy: user.id,
          approvedAt: now,
          postedBy: user.id,
          postedAt: now,
        },
      ],
      { session },
    );
    const posted = journal.toObject();
    await this.writeLedger(posted, now, session);
    await this.audit.log(
      user,
      { action: 'journal.post', recordType: 'Journal', recordId: posted._id, summary: `Posted ${posted.number} for ${link.sourceNumber}` },
      session,
    );
    if (posted.autoReverseDate) {
      await this.createReversal(user, posted, posted.autoReverseDate, `Auto-reversal of ${posted.number}`, session);
      return (await this.db.journals.findById(posted._id).session(session).lean())!;
    }
    return posted;
  }

  /** Re-runs validation against current master data so nothing stale reaches the ledger. */
  private async revalidate(user: AuthUser, journal: Journal, session: ClientSession) {
    const { fields } = await this.build(
      user,
      {
        entityId: journal.entityId,
        branchId: journal.branchId,
        journalDate: journal.journalDate,
        description: journal.description,
        reference: journal.reference,
        type: journal.type as JournalInput['type'],
        autoReverseDate: journal.autoReverseDate,
        lines: journal.lines.filter((l) => !l.autoInterBranch).map((l) => ({
          ...l,
          partyType: l.partyType as PartyType | null,
          debit: dec(l.debitTx),
          credit: dec(l.creditTx),
          exchangeRate: dec(l.exchangeRate),
        })),
      },
      journal.source as JournalSource,
      session,
    );
    if (!dec(fields.totalDebit).eq(dec(journal.totalDebit))) {
      throw new BadRequestException('Journal totals changed on revalidation; edit and resubmit it');
    }
  }

  private async writeLedger(journal: Journal, postedAt: Date, session: ClientSession) {
    const accounts = await this.db.accounts
      .find({ _id: { $in: journal.lines.map((l) => l.accountId) } }, { accountClass: 1, accountType: 1 })
      .session(session)
      .lean();
    const classOf = new Map(accounts.map((a) => [a._id.toHexString(), a.accountClass]));
    const typeOf = new Map(accounts.map((a) => [a._id.toHexString(), a.accountType]));
    // Monthly totals move with the ledger, in the same transaction, so reports can rely on them.
    await this.warehouse.apply(
      journal.lines.map((l) => ({
        organisationId: journal.organisationId,
        entityId: journal.entityId,
        date: journal.journalDate,
        branchId: l.branchId,
        accountId: l.accountId,
        accountClass: classOf.get(l.accountId.toHexString())!,
        accountType: typeOf.get(l.accountId.toHexString()) ?? null,
        departmentId: l.departmentId,
        costCentreId: l.costCentreId,
        projectId: l.projectId,
        debit: l.debit,
        credit: l.credit,
        manual: MANUAL_SOURCES.includes(journal.source),
      })),
      session,
    );
    await this.db.ledger.insertMany(
      journal.lines.map((l) => ({
        organisationId: journal.organisationId,
        entityId: journal.entityId,
        journalId: journal._id,
        journalNumber: journal.number,
        lineNo: l.lineNo,
        date: journal.journalDate,
        periodId: journal.periodId,
        accountId: l.accountId,
        accountClass: classOf.get(l.accountId.toHexString()),
        branchId: l.branchId,
        departmentId: l.departmentId,
        costCentreId: l.costCentreId,
        projectId: l.projectId,
        fundId: l.fundId,
        partyType: l.partyType ?? null,
        partyId: l.partyId ?? null,
        intercompanyEntityId: l.intercompanyEntityId ?? null,
        description: l.description || journal.description,
        currency: l.currency,
        exchangeRate: l.exchangeRate,
        debitTx: l.debitTx,
        creditTx: l.creditTx,
        debit: l.debit,
        credit: l.credit,
        source: journal.source,
        postedAt,
      })),
      { session },
    );
  }
}
