import { Schema, Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { csvResponse } from '@/platform/common/csv';
import { BadRequestException } from '@/platform/common/errors';
import { AuditService } from '@/platform/services/audit.service';
import { hrSettings, type HrDb as Db } from '../db';

const { ObjectId } = Schema.Types;
const EAT = 3 * 3_600_000; // Kenya is UTC+3 all year.
const DAY = 86_400_000;

/** One clock-in or clock-out from a biometric (fingerprint/face) terminal or card reader. */
export const punchSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    employeeId: { type: ObjectId, required: true },
    at: { type: Date, required: true },
    device: { type: String, default: '' },
    method: { type: String, enum: ['FINGERPRINT', 'FACE', 'CARD', 'PIN', 'MANUAL'], default: 'FINGERPRINT' },
  },
  { versionKey: false },
);
punchSchema.index({ organisationId: 1, employeeId: 1, at: 1 }, { unique: true });
punchSchema.index({ organisationId: 1, at: 1 });

/** The working day the register checks against. */
export const attendanceSettingsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true, unique: true },
    start: { type: String, default: '08:00' },
    end: { type: String, default: '17:00' },
    graceMinutes: { type: Number, default: 15 },
    workSaturday: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const localDay = (d: Date) => new Date(d.getTime() + EAT).toISOString().slice(0, 10);
const localMinutes = (d: Date) => {
  const t = new Date(d.getTime() + EAT);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
};

/**
 * Biometric attendance: terminals (fingerprint, face, card) send clock events by employee number; each
 * working day every active employee is present, late, absent, on leave, off (weekend or public holiday),
 * with first in, last out and hours. Periods summarise days present, late arrivals, absences and hours.
 */
export class AttendanceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async settings(user: AuthUser) {
    return (await this.db.attendanceSettings.findOneAndUpdate({ organisationId: user.organisationId }, { $setOnInsert: { organisationId: user.organisationId } }, { upsert: true, new: true }).lean())!;
  }

  async saveSettings(user: AuthUser, input: { start: string; end: string; graceMinutes: number; workSaturday: boolean }) {
    if (minutesOf(input.end) <= minutesOf(input.start)) throw new BadRequestException('The day must end after it starts');
    await this.db.attendanceSettings.updateOne({ organisationId: user.organisationId }, input, { upsert: true });
    await this.audit.record(user, 'hr.attendance.settings', 'organisation', user.organisationId, input);
    return this.settings(user);
  }

  /** Clock events from a terminal; resending the same events records nothing twice. */
  async punches(user: AuthUser, input: { device: string; punches: { employeeNo: string; at: Date; method?: 'FINGERPRINT' | 'FACE' | 'CARD' | 'PIN' }[] }) {
    const numbers = [...new Set(input.punches.map((p) => p.employeeNo.trim().toUpperCase()))];
    const staff = await this.db.employees.find({ organisationId: user.organisationId, employeeNo: { $in: numbers } }, { employeeNo: 1 }).lean();
    const byNo = new Map(staff.map((e) => [e.employeeNo.toUpperCase(), e._id]));
    const unknown = numbers.filter((n) => !byNo.has(n));
    const docs = input.punches.filter((p) => byNo.has(p.employeeNo.trim().toUpperCase())).map((p) => ({ organisationId: user.organisationId, employeeId: byNo.get(p.employeeNo.trim().toUpperCase())!, at: p.at, device: input.device, method: p.method ?? 'FINGERPRINT' }));
    let stored = 0;
    if (docs.length) {
      const res = await this.db.punches.insertMany(docs, { ordered: false }).catch((err: { insertedDocs?: unknown[] }) => err.insertedDocs ?? []);
      stored = Array.isArray(res) ? res.length : 0;
    }
    return { received: input.punches.length, stored, duplicates: docs.length - stored, unknownEmployees: unknown };
  }

  /** The register for each day from `from` to `to`, per active employee. */
  private async build(user: AuthUser, from: string, to: string, filter: { departmentId?: Types.ObjectId; employeeId?: Types.ObjectId } = {}) {
    const s = await this.settings(user);
    const start = new Date(`${from}T00:00:00Z`).getTime() - EAT;
    const end = new Date(`${to}T00:00:00Z`).getTime() - EAT + DAY;
    if (end - start > 92 * DAY) throw new BadRequestException('Ask for at most three months at a time');
    const staff = await this.db.employees.find({ organisationId: user.organisationId, status: { $in: ['ACTIVE', 'PROBATION'] }, ...(filter.departmentId && { departmentId: filter.departmentId }), ...(filter.employeeId && { _id: filter.employeeId }) }, { employeeNo: 1, firstName: 1, lastName: 1, departmentId: 1, hireDate: 1 }).sort({ employeeNo: 1 }).lean();
    const ids = staff.map((e) => e._id);
    const [punches, leave, holidayDoc] = await Promise.all([
      this.db.punches.find({ organisationId: user.organisationId, employeeId: { $in: ids }, at: { $gte: new Date(start), $lt: new Date(end) } }, { employeeId: 1, at: 1 }).sort({ at: 1 }).lean(),
      this.db.leaveRequests.find({ organisationId: user.organisationId, employeeId: { $in: ids }, status: 'APPROVED', startDate: { $lt: new Date(end) }, endDate: { $gte: new Date(start - DAY) } }, { employeeId: 1, startDate: 1, endDate: 1 }).lean(),
      hrSettings(this.db, user.organisationId),
    ]);
    const holidays = new Set((holidayDoc.holidays ?? []).map((h) => h.date).filter(Boolean));
    const late = minutesOf(s.start) + s.graceMinutes;
    const days: string[] = [];
    for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= new Date(`${to}T00:00:00Z`).getTime(); t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
    const rows = [];
    for (const e of staff) {
      const mine = punches.filter((p) => p.employeeId.equals(e._id));
      for (const d of days) {
        const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
        const today = mine.filter((p) => localDay(p.at) === d);
        const first = today[0]?.at ?? null;
        const last = today.length > 1 ? today[today.length - 1].at : null;
        const onLeave = leave.some((l) => l.employeeId.equals(e._id) && localDay(l.startDate) <= d && localDay(l.endDate) >= d);
        const off = weekday === 0 || (weekday === 6 && !s.workSaturday) || holidays.has(d);
        const notYet = e.hireDate && localDay(e.hireDate) > d;
        const status = notYet ? 'NOT_EMPLOYED' : first ? (localMinutes(first) > late && !off ? 'LATE' : 'PRESENT') : onLeave ? 'ON_LEAVE' : off ? 'OFF' : 'ABSENT';
        rows.push({
          date: d,
          employeeId: e._id,
          employeeNo: e.employeeNo,
          name: `${e.firstName} ${e.lastName}`,
          departmentId: e.departmentId,
          status,
          firstIn: first,
          lastOut: last,
          hours: first && last ? Math.round(((last.getTime() - first.getTime()) / 3_600_000) * 100) / 100 : null,
          lateMinutes: first && status === 'LATE' ? localMinutes(first) - minutesOf(s.start) : 0,
          punches: today.length,
        });
      }
    }
    return rows;
  }

  async day(user: AuthUser, date: string, departmentId?: Types.ObjectId) {
    const rows = await this.build(user, date, date, { departmentId });
    const count = (st: string) => rows.filter((r) => r.status === st).length;
    return { date, totals: { present: count('PRESENT'), late: count('LATE'), absent: count('ABSENT'), onLeave: count('ON_LEAVE'), off: count('OFF') }, rows };
  }

  async summary(user: AuthUser, q: { from: string; to: string; departmentId?: Types.ObjectId; employeeId?: Types.ObjectId }) {
    const rows = await this.build(user, q.from, q.to, q);
    const by = new Map<string, { employeeId: Types.ObjectId; employeeNo: string; name: string; workingDays: number; present: number; late: number; lateMinutes: number; absent: number; onLeave: number; hours: number }>();
    for (const r of rows) {
      const k = String(r.employeeId);
      const t = by.get(k) ?? { employeeId: r.employeeId, employeeNo: r.employeeNo, name: r.name, workingDays: 0, present: 0, late: 0, lateMinutes: 0, absent: 0, onLeave: 0, hours: 0 };
      if (!['OFF', 'NOT_EMPLOYED'].includes(r.status)) t.workingDays++;
      if (r.status === 'PRESENT' || r.status === 'LATE') t.present++;
      if (r.status === 'LATE') t.late++;
      t.lateMinutes += r.lateMinutes;
      if (r.status === 'ABSENT') t.absent++;
      if (r.status === 'ON_LEAVE') t.onLeave++;
      t.hours = Math.round((t.hours + (r.hours ?? 0)) * 100) / 100;
      by.set(k, t);
    }
    return { from: q.from, to: q.to, rows: [...by.values()] };
  }

  async summaryCsv(user: AuthUser, q: { from: string; to: string; departmentId?: Types.ObjectId }) {
    const r = await this.summary(user, q);
    return csvResponse(`attendance-${q.from}-${q.to}.csv`, [['Number', 'Name', 'Working days', 'Present', 'Late', 'Minutes late', 'Absent', 'On leave', 'Hours'], ...r.rows.map((x) => [x.employeeNo, x.name, x.workingDays, x.present, x.late, x.lateMinutes, x.absent, x.onLeave, x.hours])]);
  }
}
