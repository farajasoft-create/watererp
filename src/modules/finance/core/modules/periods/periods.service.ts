import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { ClientSession, Types } from 'mongoose';
import { AuthUser, hasPermission } from '../../common/auth';
import { PERMISSIONS } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { Period, PeriodStatus } from '../../database/schemas';
import { AuditService } from '../audit/audit.service';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monthly periods for a 12-month fiscal year starting on the first day of startDate's month. */
export function buildMonthlyPeriods(startDate: Date) {
  const y = startDate.getUTCFullYear();
  const m = startDate.getUTCMonth();
  return Array.from({ length: 12 }, (_, i) => {
    const start = new Date(Date.UTC(y, m + i, 1));
    const end = new Date(Date.UTC(y, m + i + 1, 0));
    return { number: i + 1, name: `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`, startDate: start, endDate: end };
  });
}

export function fiscalYearName(startDate: Date): string {
  const y = startDate.getUTCFullYear();
  return startDate.getUTCMonth() === 0 ? `FY${y}` : `FY${y}/${String(y + 1).slice(-2)}`;
}

export class PeriodsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async createFiscalYear(
    actor: AuthUser | { organisationId: Types.ObjectId; name: string },
    entityId: Types.ObjectId,
    startDate: Date,
    session?: ClientSession,
  ) {
    if (startDate.getUTCDate() !== 1) throw new BadRequestException('A fiscal year must start on the first day of a month');
    const organisationId = actor.organisationId;
    const entity = await this.db.entities.findOne({ _id: entityId, organisationId }).session(session ?? null).lean();
    if (!entity) throw new NotFoundException('Entity not found');

    const periods = buildMonthlyPeriods(startDate);
    const endDate = periods[11].endDate;
    const overlap = await this.db.fiscalYears
      .exists({ organisationId, entityId, startDate: { $lte: endDate }, endDate: { $gte: startDate } })
      .session(session ?? null);
    if (overlap) throw new BadRequestException('The fiscal year overlaps an existing fiscal year for this entity');

    const [fy] = await this.db.fiscalYears.create(
      [{ organisationId, entityId, name: fiscalYearName(startDate), startDate, endDate }],
      { session },
    );
    await this.db.periods.insertMany(
      periods.map((p) => ({ ...p, organisationId, entityId, fiscalYearId: fy._id })),
      { session },
    );
    await this.audit.log(
      actor,
      { action: 'fiscal_year.create', recordType: 'FiscalYear', recordId: fy._id, summary: `Created ${fy.name} for ${entity.code}`, after: fy },
      session,
    );
    return fy;
  }

  /** Finds the accounting period that contains `date` for the entity. */
  async periodFor(organisationId: Types.ObjectId, entityId: Types.ObjectId, date: Date, session?: ClientSession) {
    return this.db.periods
      .findOne({ organisationId, entityId, startDate: { $lte: date }, endDate: { $gte: date } })
      .session(session ?? null)
      .lean();
  }

  /** Throws unless the user may post into the period containing `date`. */
  async assertPostable(user: AuthUser, entityId: Types.ObjectId, date: Date, session?: ClientSession): Promise<Period> {
    const period = await this.periodFor(user.organisationId, entityId, date, session);
    if (!period) throw new BadRequestException(`No accounting period covers ${date.toISOString().slice(0, 10)} for this entity`);
    if (period.status === 'HARD_CLOSED') throw new BadRequestException(`Period ${period.name} is closed`);
    if (period.status === 'SOFT_CLOSED' && !hasPermission(user, PERMISSIONS.PERIOD_POST_SOFT_CLOSED)) {
      throw new ForbiddenException(`Period ${period.name} is soft-closed; only authorised users may post into it`);
    }
    return period;
  }

  /**
   * Period status transitions:
   *   OPEN ⇄ SOFT_CLOSED       period.manage
   *   * → HARD_CLOSED           period.close (prior periods must already be closed)
   *   HARD_CLOSED → OPEN/SOFT   period.reopen, with a mandatory reason
   */
  async changeStatus(user: AuthUser, periodId: Types.ObjectId, status: PeriodStatus, reason?: string) {
    const before = await this.db.periods.findOne({ _id: periodId, organisationId: user.organisationId }).lean();
    if (!before) throw new NotFoundException('Period not found');
    if (before.status === status) throw new BadRequestException(`Period is already ${status}`);

    if (before.status === 'HARD_CLOSED') {
      if (!hasPermission(user, PERMISSIONS.PERIOD_REOPEN)) throw new ForbiddenException('Reopening a closed period requires period.reopen');
      if (!reason?.trim()) throw new BadRequestException('A reason is required to reopen a closed period');
      const laterClosed = await this.db.periods.exists({
        organisationId: user.organisationId,
        entityId: before.entityId,
        startDate: { $gt: before.startDate },
        status: 'HARD_CLOSED',
      });
      if (laterClosed) throw new BadRequestException('Reopen later closed periods first');
    } else if (status === 'HARD_CLOSED') {
      if (!hasPermission(user, PERMISSIONS.PERIOD_CLOSE)) throw new ForbiddenException('Closing a period requires period.close');
      const earlierOpen = await this.db.periods.exists({
        organisationId: user.organisationId,
        entityId: before.entityId,
        startDate: { $lt: before.startDate },
        status: { $ne: 'HARD_CLOSED' },
      });
      if (earlierOpen) throw new BadRequestException('Earlier periods must be closed first');
      const pending = await this.db.journals.countDocuments({
        organisationId: user.organisationId,
        periodId: before._id,
        status: { $in: ['SUBMITTED', 'APPROVED'] },
      });
      if (pending) throw new BadRequestException(`${pending} journal(s) in this period are awaiting approval or posting`);
    } else if (!hasPermission(user, PERMISSIONS.PERIOD_MANAGE)) {
      throw new ForbiddenException('Changing period status requires period.manage');
    }

    const after = await this.db.periods
      .findByIdAndUpdate(
        before._id,
        { status, statusChangedBy: user.id, statusChangedAt: new Date(), statusReason: reason?.trim() ?? '' },
        { new: true },
      )
      .lean();
    await this.audit.log(user, {
      action: before.status === 'HARD_CLOSED' ? 'period.reopen' : `period.${status.toLowerCase()}`,
      recordType: 'Period',
      recordId: before._id,
      summary: `${before.name}: ${before.status} → ${status}${reason ? ` (${reason.trim()})` : ''}`,
      before,
      after,
    });
    return after;
  }
}
