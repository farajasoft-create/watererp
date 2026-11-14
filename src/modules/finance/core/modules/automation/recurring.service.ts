import { Types } from 'mongoose';
import { actorFor, AuthUser, hasPermission } from '../../common/auth';
import { assertBranchAccess } from '../../common/access';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, sum, toD128 } from '../../common/money';
import { PERMISSIONS } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { RecurrenceFrequency, RecurringJournal } from '../../database/automation.schemas';
import { AuditService } from '../audit/audit.service';
import { JournalsService } from '../journals/journals.service';
import { WorkflowService } from '../workflow/workflow.service';

const MONTHS_PER: Record<RecurrenceFrequency, number> = { WEEKLY: 0, MONTHLY: 1, QUARTERLY: 3, ANNUALLY: 12 };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** At most this many missed occurrences are caught up in one run, so a long outage cannot flood the books. */
const CATCH_UP_LIMIT = 12;

const DAY = 86_400_000;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const onDay = (y: number, m: number, day: number) => {
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  return new Date(Date.UTC(year, month, Math.min(day === 31 ? 31 : day, lastDay(year, month))));
};

interface Schedule {
  frequency: RecurrenceFrequency;
  interval: number;
  dayOfMonth: number;
  startDate: Date;
}

/** The first occurrence on or after the start date. */
export function firstOccurrence(s: Schedule): Date {
  if (s.frequency === 'WEEKLY') return s.startDate;
  const candidate = onDay(s.startDate.getUTCFullYear(), s.startDate.getUTCMonth(), s.dayOfMonth);
  return candidate >= s.startDate ? candidate : nextOccurrence(s, candidate);
}

export function nextOccurrence(s: Schedule, after: Date): Date {
  if (s.frequency === 'WEEKLY') return new Date(after.getTime() + 7 * s.interval * DAY);
  return onDay(after.getUTCFullYear(), after.getUTCMonth() + MONTHS_PER[s.frequency] * s.interval, s.dayOfMonth);
}

export function fillTokens(text: string, date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return text
    .replace(/\{monthName\}/g, MONTH_NAMES[m])
    .replace(/\{month\}/g, String(m + 1).padStart(2, '0'))
    .replace(/\{year\}/g, String(y))
    .replace(/\{period\}/g, `${MONTH_NAMES[m]} ${y}`)
    .replace(/\{date\}/g, date.toISOString().slice(0, 10));
}

export interface RecurringInput {
  entityId: Types.ObjectId;
  branchId: Types.ObjectId;
  name: string;
  description: string;
  reference?: string;
  type: 'STANDARD' | 'ACCRUAL';
  autoReverse: boolean;
  lines: { accountId: Types.ObjectId; branchId?: Types.ObjectId | null; departmentId?: Types.ObjectId | null; costCentreId?: Types.ObjectId | null; projectId?: Types.ObjectId | null; fundId?: Types.ObjectId | null; description?: string; currency?: string | null; debit?: Decimal | null; credit?: Decimal | null }[];
  frequency: RecurrenceFrequency;
  interval: number;
  dayOfMonth: number;
  startDate: Date;
  endDate?: Date | null;
  maxOccurrences?: number | null;
  action: 'DRAFT' | 'SUBMIT';
  isActive?: boolean;
}

/**
 * Recurring journals: templates that create journals on a schedule (rent, insurance amortisation,
 * management fees, monthly accruals). Each occurrence is an ordinary journal prepared in the owner's
 * name, so validation, period locks and approval all apply. Failures are recorded and the owner is
 * told; the occurrence is retried until it succeeds or is skipped, never silently lost.
 */
export class RecurringService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly workflow: WorkflowService,
  ) {}

  private async validate(user: AuthUser, input: RecurringInput) {
    const org = user.organisationId;
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: org }).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: org, entityId: entity._id }).lean();
    if (!branch) throw new BadRequestException('The branch must belong to the entity');
    assertBranchAccess(user, [branch._id, ...input.lines.map((l) => l.branchId).filter((b): b is Types.ObjectId => !!b)]);
    if (input.lines.length < 2) throw new BadRequestException('A journal needs at least two lines');
    const accounts = await this.db.accounts.find({ organisationId: org, _id: { $in: input.lines.map((l) => l.accountId) } }).lean();
    for (const [i, l] of input.lines.entries()) {
      const a = accounts.find((x) => x._id.equals(l.accountId));
      if (!a?.isPostable || !a.isActive) throw new BadRequestException(`Line ${i + 1}: choose an active postable account`);
      if (!a.allowManualPosting) throw new BadRequestException(`Line ${i + 1}: ${a.code} is a control account and only takes postings from its subledger`);
      const debit = l.debit ?? new Decimal(0);
      const credit = l.credit ?? new Decimal(0);
      if (debit.isNeg() || credit.isNeg() || debit.isZero() === credit.isZero()) throw new BadRequestException(`Line ${i + 1}: enter either a debit or a credit`);
    }
    const byCurrency = new Map<string, Decimal>();
    for (const l of input.lines) {
      const c = l.currency ?? entity.functionalCurrency;
      byCurrency.set(c, (byCurrency.get(c) ?? new Decimal(0)).plus(l.debit ?? 0).minus(l.credit ?? 0));
    }
    for (const [c, v] of byCurrency) if (!v.isZero()) throw new BadRequestException(`The ${c} lines do not balance (difference ${v.toFixed()})`);
    if (input.endDate && input.endDate < input.startDate) throw new BadRequestException('The end date is before the start date');
    if (input.frequency !== 'WEEKLY' && !(input.dayOfMonth === 31 || (input.dayOfMonth >= 1 && input.dayOfMonth <= 28))) throw new BadRequestException('Choose a day from 1 to 28, or the last day of the month');
    return entity;
  }

  private doc(input: RecurringInput) {
    const first = firstOccurrence(input);
    return {
      ...input,
      reference: input.reference ?? '',
      endDate: input.endDate ?? null,
      maxOccurrences: input.maxOccurrences ?? null,
      lines: input.lines.map((l) => ({ ...l, debit: l.debit ? toD128(l.debit) : null, credit: l.credit ? toD128(l.credit) : null, currency: l.currency ?? null })),
      nextRunDate: input.endDate && first > input.endDate ? null : first,
    };
  }

  async list(user: AuthUser, entityId?: Types.ObjectId) {
    const rows = await this.db.recurringJournals.find({ organisationId: user.organisationId, ...(entityId && { entityId }) }, { runs: { $slice: -5 } }).sort({ isActive: -1, nextRunDate: 1 }).lean();
    return rows.map((r) => ({ ...r, total: sum(r.lines.map((l) => l.debit ?? 0)) }));
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const r = await this.db.recurringJournals.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r) throw new NotFoundException('Recurring journal not found');
    return { ...r, schedule: this.preview(r, 6) };
  }

  /** The next few dates the template will run on. */
  preview(r: Pick<RecurringJournal, 'frequency' | 'interval' | 'dayOfMonth' | 'startDate' | 'endDate' | 'maxOccurrences' | 'occurrences' | 'nextRunDate'>, n: number) {
    const out: Date[] = [];
    let date = r.nextRunDate;
    let count = r.occurrences;
    while (date && out.length < n) {
      if (r.endDate && date > r.endDate) break;
      if (r.maxOccurrences && count >= r.maxOccurrences) break;
      out.push(date);
      count++;
      date = nextOccurrence(r as Schedule, date);
    }
    return out;
  }

  async create(user: AuthUser, input: RecurringInput) {
    await this.validate(user, input);
    const [r] = await this.db.recurringJournals.create([{ ...this.doc(input), organisationId: user.organisationId, ownerId: user.id, createdBy: user.id }]);
    await this.audit.log(user, { action: 'recurring_journal.create', recordType: 'RecurringJournal', recordId: r._id, summary: `Created recurring journal ${input.name} (${input.frequency.toLowerCase()}, first on ${r.nextRunDate?.toISOString().slice(0, 10) ?? '—'})` });
    return r.toObject();
  }

  async update(user: AuthUser, id: Types.ObjectId, input: RecurringInput) {
    const before = await this.db.recurringJournals.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!before) throw new NotFoundException('Recurring journal not found');
    await this.validate(user, input);
    const doc = this.doc(input);
    // Changing the schedule restarts it from the later of the next due date and the new start date.
    const scheduleChanged = ['frequency', 'interval', 'dayOfMonth', 'startDate'].some((k) => String(before[k as keyof typeof before]) !== String(input[k as keyof RecurringInput]));
    const nextRunDate = scheduleChanged || !before.nextRunDate ? (before.occurrences ? this.firstAfter(input, before.runs.at(-1)?.date ?? input.startDate) : doc.nextRunDate) : before.nextRunDate;
    const after = await this.db.recurringJournals.findByIdAndUpdate(id, { ...doc, nextRunDate, lastError: '' }, { new: true }).lean();
    await this.audit.log(user, { action: 'recurring_journal.update', recordType: 'RecurringJournal', recordId: id, summary: `Updated recurring journal ${input.name}` });
    return after;
  }

  private firstAfter(s: Schedule, last: Date) {
    let d = firstOccurrence(s);
    while (d <= last) d = nextOccurrence(s, d);
    return d;
  }

  async setActive(user: AuthUser, id: Types.ObjectId, isActive: boolean) {
    const r = await this.db.recurringJournals.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, { isActive, ...(isActive && { lastError: '' }) }, { new: true }).lean();
    if (!r) throw new NotFoundException('Recurring journal not found');
    await this.audit.log(user, { action: `recurring_journal.${isActive ? 'resume' : 'pause'}`, recordType: 'RecurringJournal', recordId: id, summary: `${isActive ? 'Resumed' : 'Paused'} recurring journal ${r.name}` });
    return r;
  }

  /** Skips the next occurrence (for example a month when the rent is waived). */
  async skip(user: AuthUser, id: Types.ObjectId) {
    const r = await this.db.recurringJournals.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r || !r.nextRunDate) throw new NotFoundException('Nothing to skip');
    const next = nextOccurrence(r as Schedule, r.nextRunDate);
    const done = (r.endDate && next > r.endDate) || (r.maxOccurrences && r.occurrences >= r.maxOccurrences);
    await this.db.recurringJournals.updateOne(
      { _id: r._id },
      { nextRunDate: done ? null : next, lastError: '', $push: { runs: { $each: [{ date: r.nextRunDate, status: 'SKIPPED', at: new Date(), error: `Skipped by ${user.name}` }], $slice: -50 } } },
    );
    await this.audit.log(user, { action: 'recurring_journal.skip', recordType: 'RecurringJournal', recordId: r._id, summary: `Skipped ${r.name} for ${r.nextRunDate.toISOString().slice(0, 10)}` });
    return this.get(user, id);
  }

  /** Creates the next occurrence now (for example to post this month's accrual early). */
  async runNow(user: AuthUser, id: Types.ObjectId) {
    const r = await this.db.recurringJournals.findOne({ _id: id, organisationId: user.organisationId, isActive: true }).lean();
    if (!r?.nextRunDate) throw new BadRequestException('This template has no occurrence left to create');
    if (!r.ownerId.equals(user.id) && !hasPermission(user, PERMISSIONS.JOURNAL_APPROVE)) throw new ForbiddenException('Only the owner or an approver can run it early');
    const result = await this.occur(r, r.nextRunDate);
    if (result.error) throw new BadRequestException(result.error);
    return result;
  }

  /** Creates every occurrence that is due (cron). */
  async processDue(today = new Date()) {
    const due = await this.db.recurringJournals.find({ isActive: true, nextRunDate: { $ne: null, $lte: today } }).limit(500).lean();
    let created = 0;
    let failed = 0;
    for (const r of due) {
      let current: RecurringJournal | null = r;
      for (let i = 0; i < CATCH_UP_LIMIT && current?.nextRunDate && current.nextRunDate <= today; i++) {
        const result = await this.occur(current, current.nextRunDate);
        if (result.error) {
          failed++;
          break;
        }
        created++;
        current = await this.db.recurringJournals.findById(r._id).lean();
      }
    }
    return { created, failed };
  }

  private async occur(r: RecurringJournal, date: Date): Promise<{ journalId?: Types.ObjectId; number?: string; error?: string }> {
    const owner = await actorFor(this.db, r.ownerId);
    const fail = async (error: string) => {
      // Only the first failure of a run notifies, so a template stuck on a closed period does not spam.
      const repeat = r.lastError === error;
      await this.db.recurringJournals.updateOne({ _id: r._id }, { lastError: error, $push: { runs: { $each: [{ date, status: 'FAILED', error, at: new Date() }], $slice: -50 } } });
      if (!repeat) {
        await this.workflow.notify(r.organisationId, [r.ownerId], { kind: 'recurring', title: `Recurring journal "${r.name}" could not be created`, body: `${date.toISOString().slice(0, 10)}: ${error}`, link: '/finance/journals/recurring' });
      }
      return { error };
    };
    if (!owner) return fail('The owner of this template is inactive; give it a new owner');
    try {
      const journal = await this.journals.create(owner, {
        entityId: r.entityId,
        branchId: r.branchId,
        journalDate: date,
        description: fillTokens(r.description, date),
        reference: fillTokens(r.reference || `Recurring: ${r.name}`, date).slice(0, 100),
        type: r.type as 'STANDARD' | 'ACCRUAL',
        autoReverseDate: r.autoReverse ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)) : null,
        lines: r.lines.map((l) => ({
          accountId: l.accountId,
          branchId: l.branchId,
          departmentId: l.departmentId,
          costCentreId: l.costCentreId,
          projectId: l.projectId,
          fundId: l.fundId,
          description: fillTokens(l.description, date),
          currency: l.currency ?? undefined,
          debit: l.debit ? dec(l.debit) : null,
          credit: l.credit ? dec(l.credit) : null,
        })),
      });
      let status: 'CREATED' | 'SUBMITTED' = 'CREATED';
      if (r.action === 'SUBMIT') {
        await this.journals.submit(owner, journal._id);
        status = 'SUBMITTED';
      }
      const occurrences = r.occurrences + 1;
      const next = nextOccurrence(r as Schedule, date);
      const finished = (r.endDate && next > r.endDate) || (r.maxOccurrences && occurrences >= r.maxOccurrences);
      await this.db.recurringJournals.updateOne(
        { _id: r._id },
        { occurrences, nextRunDate: finished ? null : next, lastError: '', $push: { runs: { $each: [{ date, journalId: journal._id, journalNumber: journal.number, status, at: new Date() }], $slice: -50 } } },
      );
      await this.audit.log(owner, { action: 'recurring_journal.run', recordType: 'RecurringJournal', recordId: r._id, summary: `${r.name}: created ${journal.number} for ${date.toISOString().slice(0, 10)}${status === 'SUBMITTED' ? ' and submitted it' : ''}` });
      return { journalId: journal._id, number: journal.number };
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Unexpected error');
    }
  }
}
