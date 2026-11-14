import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { csvResponse } from '@/platform/common/csv';
import { NotFoundException } from '@/platform/common/errors';
import { Decimal, dec } from '@/platform/common/money';
import { scopeFilter } from '../access';
import { fullName, HrDb as Db } from '../db';

type Id = Types.ObjectId;
const ZERO = new Decimal(0);
const amount = (v: unknown) => dec((v as { toString(): string } | null | undefined)?.toString() ?? '0');
const m = (d: Decimal) => d.toFixed(2);

/** Audit actions that change what someone is paid, or the payroll itself. */
export const PAY_ACTIONS = [
  'hr.employee.pay',
  'hr.employee.update',
  'hr.employee.terminate',
  'hr.employee.reinstate',
  'hr.employee.suspend',
  'hr.payItem.create',
  'hr.payItem.update',
  'hr.career.approve',
  'hr.self.change_approve',
  'hr.payroll.create',
  'hr.payroll.recalculate',
  'hr.payroll.units',
  'hr.payroll.entries.add',
  'hr.payroll.entries.many',
  'hr.payroll.entries.remove',
  'hr.payroll.approve',
  'hr.payroll.paid',
  'hr.payroll.cancel',
  'hr.rates.create',
  'hr.rates.update',
  'hr.rates.delete',
];

const ACTION_LABELS: Record<string, string> = {
  'hr.employee.pay': 'Pay details changed',
  'hr.employee.update': 'Employee record changed',
  'hr.employee.terminate': 'Employment ended',
  'hr.employee.reinstate': 'Reinstated',
  'hr.employee.suspend': 'Suspended',
  'hr.payItem.create': 'Pay item added',
  'hr.payItem.update': 'Pay item changed',
  'hr.career.approve': 'Career change approved',
  'hr.self.change_approve': 'Self-service change approved',
  'hr.payroll.create': 'Payroll created',
  'hr.payroll.recalculate': 'Payroll recalculated',
  'hr.payroll.units': 'Days or hours entered',
  'hr.payroll.entries.add': 'Payments added',
  'hr.payroll.entries.many': 'Payment added for many',
  'hr.payroll.entries.remove': 'Payment removed',
  'hr.payroll.approve': 'Payroll approved',
  'hr.payroll.paid': 'Payroll paid',
  'hr.payroll.cancel': 'Payroll cancelled',
  'hr.rates.create': 'Statutory rates added',
  'hr.rates.update': 'Statutory rates changed',
  'hr.rates.delete': 'Statutory rates deleted',
};

type AuditRow = { at: Date; action: string; label: string; by: string; employee: string; payroll: string; detail: Record<string, unknown> };
type ChangeLine = { code: string; name: string; was: Decimal; now: Decimal; change: Decimal };
type AdviceRow = { employeeId: string; employeeNo: string; name: string; department: string; status: 'JOINED' | 'LEFT' | 'CHANGED'; netWas: Decimal; netNow: Decimal; netChange: Decimal; changes: ChangeLine[] };
type PensionRow = { scheme: string; memberNo: string; employeeNo: string; name: string; nationalId: string; kraPin: string; basic: Decimal; employee: Decimal; employer: Decimal; total: Decimal };

/**
 * Payroll reports beyond the statutory returns: the payroll audit trail, pay change advice between one
 * payroll and the previous, gratuity owed to contract staff, and the pension remittance schedule.
 */
export class PayrollExtrasService {
  constructor(private readonly db: Db) {}

  /** Who changed pay, pay items, career and payrolls, when, and what changed. */
  async auditTrail(user: AuthUser, q: { from: Date; to: Date; employeeId?: Id }): Promise<AuditRow[]> {
    const org = user.organisationId;
    const filter: Record<string, unknown> = { organisationId: org, action: { $in: PAY_ACTIONS }, createdAt: { $gte: q.from, $lt: new Date(q.to.getTime() + 86_400_000) } };
    if (q.employeeId) {
      const [items, events, requests] = await Promise.all([
        this.db.payItems.find({ organisationId: org, employeeId: q.employeeId }, { _id: 1 }).lean(),
        this.db.careerEvents.find({ organisationId: org, employeeId: q.employeeId }, { _id: 1 }).lean(),
        this.db.changeRequests.find({ organisationId: org, employeeId: q.employeeId }, { _id: 1 }).lean(),
      ]);
      filter.entityId = { $in: [q.employeeId, ...items.map((i) => i._id), ...events.map((e) => e._id), ...requests.map((r) => r._id)] };
    }
    const rows = await this.db.audit.find(filter).sort({ createdAt: -1 }).limit(2000).lean();
    const idsOf = (entity: string) => rows.filter((r) => r.entity === entity && r.entityId).map((r) => r.entityId!);
    const [users, items, events, requests, runs] = await Promise.all([
      this.db.users.find({ _id: { $in: rows.map((r) => r.userId).filter(Boolean) } }, { name: 1 }).lean(),
      this.db.payItems.find({ _id: { $in: idsOf('hrPayItem') } }, { employeeId: 1 }).lean(),
      this.db.careerEvents.find({ _id: { $in: idsOf('hrCareerEvent') } }, { employeeId: 1 }).lean(),
      this.db.changeRequests.find({ _id: { $in: idsOf('hrChangeRequest') } }, { employeeId: 1 }).lean(),
      this.db.payRuns.find({ _id: { $in: idsOf('hrPayRun') } }, { period: 1, kind: 1, title: 1 }).lean(),
    ]);
    const owners: { _id: Id; employeeId: Id }[] = [...items, ...events, ...requests];
    const employeeOf = (r: (typeof rows)[number]): Id | null => {
      if (!r.entityId) return null;
      if (r.entity === 'hrEmployee') return r.entityId;
      return owners.find((o) => o._id.equals(r.entityId!))?.employeeId ?? null;
    };
    const people = await this.db.employees.find({ organisationId: org, _id: { $in: rows.map(employeeOf).filter((x): x is Id => !!x) }, ...scopeFilter(user) }, { employeeNo: 1, firstName: 1, lastName: 1, otherNames: 1 }).lean();
    const out: AuditRow[] = [];
    for (const r of rows) {
      const eid = employeeOf(r);
      const p = eid ? people.find((x) => x._id.equals(eid)) : null;
      // Outside the user's departments (or a person no longer on record): not shown.
      if (eid && !p) continue;
      const run = r.entity === 'hrPayRun' && r.entityId ? runs.find((x) => x._id.equals(r.entityId!)) : null;
      out.push({
        at: r.createdAt as Date,
        action: r.action,
        label: ACTION_LABELS[r.action] ?? r.action,
        by: users.find((u) => r.userId && u._id.equals(r.userId))?.name ?? 'System',
        employee: p ? `${p.employeeNo} · ${fullName(p)}` : '',
        payroll: run ? (run.kind === 'REGULAR' ? run.period : `${run.title ?? run.kind} (${run.period})`) : '',
        detail: (r.data ?? {}) as Record<string, unknown>,
      });
    }
    return out;
  }

  async auditTrailCsv(user: AuthUser, q: { from: Date; to: Date; employeeId?: Id }) {
    const rows = await this.auditTrail(user, q);
    return csvResponse(`payroll-audit-${q.from.toISOString().slice(0, 10)}-${q.to.toISOString().slice(0, 10)}.csv`, [
      ['When', 'Change', 'By', 'Employee', 'Payroll', 'Detail'],
      ...rows.map((r) => [r.at.toISOString().replace('T', ' ').slice(0, 19), r.label, r.by, r.employee, r.payroll, JSON.stringify(r.detail)]),
    ]);
  }

  /**
   * Pay change advice: for each employee, what changed on this payroll against the previous payroll of
   * the same kind — joiners, leavers, and each pay line that was added, removed or changed.
   */
  async changeAdvice(user: AuthUser, runId: Id) {
    const org = user.organisationId;
    const run = await this.db.payRuns.findOne({ _id: runId, organisationId: org }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    const previous = await this.db.payRuns
      .findOne({ organisationId: org, _id: { $ne: run._id }, kind: run.kind, ...(run.kind === 'GROUP' && { payGroup: run.payGroup }), period: { $lt: run.period }, status: { $in: ['APPROVED', 'PAID'] } })
      .sort({ period: -1 })
      .lean();
    const scope = scopeFilter(user).departmentId ? { 'employee.departmentId': scopeFilter(user).departmentId } : {};
    const [now, before] = await Promise.all([
      this.db.payslips.find({ organisationId: org, payRunId: run._id, status: { $ne: 'CANCELLED' }, ...scope }).lean(),
      previous ? this.db.payslips.find({ organisationId: org, payRunId: previous._id, status: { $ne: 'CANCELLED' }, ...scope }).lean() : Promise.resolve([]),
    ]);
    const ids = new Set([...now, ...before].map((s) => s.employeeId.toHexString()));
    const rows: AdviceRow[] = [];
    for (const id of ids) {
      const a = before.find((s) => s.employeeId.toHexString() === id);
      const b = now.find((s) => s.employeeId.toHexString() === id);
      const lines = new Map<string, { code: string; name: string; was: Decimal; now: Decimal }>();
      for (const l of a?.lines ?? []) lines.set(`${l.type}:${l.code}`, { code: l.code ?? '', name: l.name ?? '', was: amount(l.amount), now: ZERO });
      for (const l of b?.lines ?? []) {
        const k = `${l.type}:${l.code}`;
        const cur = lines.get(k) ?? { code: l.code ?? '', name: l.name ?? '', was: ZERO, now: ZERO };
        cur.now = amount(l.amount);
        cur.name = l.name ?? cur.name;
        lines.set(k, cur);
      }
      const changes = [...lines.values()].filter((l) => !l.was.eq(l.now)).map((l) => ({ ...l, change: l.now.minus(l.was) }));
      const netWas = a ? amount(a.netPay) : ZERO;
      const netNow = b ? amount(b.netPay) : ZERO;
      if (!changes.length && netWas.eq(netNow)) continue;
      const emp = (b ?? a)!.employee;
      rows.push({ employeeId: id, employeeNo: emp?.employeeNo ?? '', name: emp?.name ?? '', department: emp?.department ?? '', status: !a ? 'JOINED' : !b ? 'LEFT' : 'CHANGED', netWas, netNow, netChange: netNow.minus(netWas), changes });
    }
    rows.sort((x, y) => x.employeeNo.localeCompare(y.employeeNo));
    const total = (k: 'netWas' | 'netNow') => rows.reduce((t, r) => t.plus(r[k]), ZERO);
    return {
      run: { id: run._id, period: run.period, kind: run.kind, title: run.title ?? null, status: run.status },
      previous: previous ? { id: previous._id, period: previous.period, title: previous.title ?? null } : null,
      rows,
      totals: { joined: rows.filter((r) => r.status === 'JOINED').length, left: rows.filter((r) => r.status === 'LEFT').length, changed: rows.filter((r) => r.status === 'CHANGED').length, netWas: total('netWas'), netNow: total('netNow'), netChange: total('netNow').minus(total('netWas')) },
    };
  }

  async changeAdviceCsv(user: AuthUser, runId: Id) {
    const a = await this.changeAdvice(user, runId);
    const out: unknown[][] = [['Employee no', 'Name', 'Department', 'Status', 'Item', 'Was', 'Now', 'Change']];
    for (const r of a.rows) {
      for (const c of r.changes) out.push([r.employeeNo, r.name, r.department, r.status, c.name, m(c.was), m(c.now), m(c.change)]);
      out.push([r.employeeNo, r.name, r.department, r.status, 'Net pay', m(r.netWas), m(r.netNow), m(r.netChange)]);
    }
    return csvResponse(`pay-change-advice-${a.run.period}.csv`, out);
  }

  /** Gratuity accrued to contract staff on approved payrolls, less gratuity paid out. */
  async gratuity(user: AuthUser) {
    const slips = await this.db.payslips
      .find({ organisationId: user.organisationId, status: { $in: ['APPROVED', 'PAID'] }, 'lines.code': { $in: ['GRATUITY', 'GRATUITY_PAY'] }, ...(scopeFilter(user).departmentId ? { 'employee.departmentId': scopeFilter(user).departmentId } : {}) }, { employeeId: 1, employee: 1, lines: 1 })
      .lean();
    const by = new Map<string, { employeeId: Id; employeeNo: string; name: string; department: string; accrued: Decimal; paid: Decimal }>();
    for (const s of slips) {
      const k = s.employeeId.toHexString();
      const cur = by.get(k) ?? { employeeId: s.employeeId, employeeNo: s.employee?.employeeNo ?? '', name: s.employee?.name ?? '', department: s.employee?.department ?? '', accrued: ZERO, paid: ZERO };
      for (const l of s.lines) {
        if (l.code === 'GRATUITY' && l.type === 'EMPLOYER') cur.accrued = cur.accrued.plus(amount(l.amount));
        if (l.code === 'GRATUITY_PAY' && l.type === 'EARNING') cur.paid = cur.paid.plus(amount(l.amount));
      }
      by.set(k, cur);
    }
    const people = await this.db.employees.find({ _id: { $in: [...by.values()].map((r) => r.employeeId) } }, { contractEndDate: 1, gratuityRate: 1, status: 1 }).lean();
    const rows = [...by.values()]
      .map((r) => {
        const p = people.find((x) => x._id.equals(r.employeeId));
        return { ...r, balance: r.accrued.minus(r.paid), gratuityRate: p?.gratuityRate ?? 0, contractEndDate: p?.contractEndDate ?? null, status: p?.status ?? '' };
      })
      .sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
    const total = (k: 'accrued' | 'paid' | 'balance') => rows.reduce((t, r) => t.plus(r[k]), ZERO);
    return { rows, totals: { accrued: total('accrued'), paid: total('paid'), balance: total('balance') } };
  }

  async gratuityCsv(user: AuthUser) {
    const g = await this.gratuity(user);
    return csvResponse('gratuity.csv', [
      ['Employee no', 'Name', 'Department', 'Rate %', 'Contract ends', 'Accrued', 'Paid', 'Balance'],
      ...g.rows.map((r) => [r.employeeNo, r.name, r.department, r.gratuityRate, r.contractEndDate ? r.contractEndDate.toISOString().slice(0, 10) : '', m(r.accrued), m(r.paid), m(r.balance)]),
    ]);
  }

  /**
   * Pension remittance schedule for a payroll: each member's contribution and the employer's for every
   * registered scheme, in the layout scheme administrators (e.g. the KIE scheme) take for upload.
   */
  async pensionSchedule(user: AuthUser, runId: Id) {
    const org = user.organisationId;
    const run = await this.db.payRuns.findOne({ _id: runId, organisationId: org }).lean();
    if (!run) throw new NotFoundException('Payroll not found');
    const scope = scopeFilter(user).departmentId ? { 'employee.departmentId': scopeFilter(user).departmentId } : {};
    const slips = await this.db.payslips.find({ organisationId: org, payRunId: run._id, status: { $ne: 'CANCELLED' }, ...scope }).sort({ 'employee.employeeNo': 1 }).lean();
    const items = await this.db.payItems.find({ organisationId: org, employeeId: { $in: slips.map((s) => s.employeeId) }, pension: true, kind: 'DEDUCTION' }, { employeeId: 1, code: 1, name: 1, memberNo: 1 }).lean();
    const people = await this.db.employees.find({ _id: { $in: slips.map((s) => s.employeeId) } }, { nationalId: 1, kraPin: 1 }).lean();
    const rows: PensionRow[] = [];
    for (const s of slips) {
      const own = items.filter((i) => i.employeeId.equals(s.employeeId));
      const p = people.find((x) => x._id.equals(s.employeeId));
      for (const l of s.lines.filter((x) => x.type === 'DEDUCTION' && own.some((i) => i.code === x.code))) {
        const item = own.find((i) => i.code === l.code)!;
        const er = s.lines.find((x) => x.type === 'EMPLOYER' && x.code === `${l.code}_ER`.slice(0, 16));
        const employee = amount(l.amount);
        const employer = er ? amount(er.amount) : ZERO;
        rows.push({ scheme: item.name, memberNo: item.memberNo ?? '', employeeNo: s.employee?.employeeNo ?? '', name: s.employee?.name ?? '', nationalId: p?.nationalId ?? '', kraPin: p?.kraPin ?? '', basic: amount(s.lines.find((x) => x.type === 'BASIC')?.amount), employee, employer, total: employee.plus(employer) });
      }
    }
    const total = (k: 'employee' | 'employer' | 'total') => rows.reduce((a, r) => a.plus(r[k]), ZERO);
    const schemes = [...new Set(rows.map((r) => r.scheme))].map((scheme) => {
      const of = rows.filter((r) => r.scheme === scheme);
      return { scheme, members: of.length, employee: of.reduce((a, r) => a.plus(r.employee), ZERO), employer: of.reduce((a, r) => a.plus(r.employer), ZERO) };
    });
    return { run: { id: run._id, period: run.period, title: run.title ?? null, status: run.status }, rows, schemes, totals: { employee: total('employee'), employer: total('employer'), total: total('total') } };
  }

  async pensionScheduleCsv(user: AuthUser, runId: Id, scheme?: string) {
    const p = await this.pensionSchedule(user, runId);
    const rows = scheme ? p.rows.filter((r) => r.scheme === scheme) : p.rows;
    return csvResponse(`pension-${scheme ? `${scheme}-` : ''}${p.run.period}.csv`, [
      ['Scheme', 'Member no', 'Payroll no', 'Name', 'ID number', 'KRA PIN', 'Period', 'Pensionable pay', 'Member contribution', 'Employer contribution', 'Total'],
      ...rows.map((r) => [r.scheme, r.memberNo, r.employeeNo, r.name, r.nationalId, r.kraPin, p.run.period, m(r.basic), m(r.employee), m(r.employer), m(r.total)]),
    ]);
  }
}
