import { Connection, Types } from 'mongoose';
import { Decimal, dec, toD128 } from '@/platform/common/money';
import { fullName, HrDb as Db } from '../db';
import { LeaveService } from '../leave/leave.service';
import { periodEnd } from '../payroll/calendar';
import { PayrollService } from '../payroll/payroll.service';
import {
  decryptor,
  departmentCode,
  leaveStatus,
  mapEmployee,
  MappedEmployee,
  mapPayslip,
  parsePeriod,
  payrunStatus,
  SrcEmployee,
  SrcLeaveBalance,
  SrcLeaveRequest,
  SrcLeaveType,
  SrcPayrun,
  sumOf,
} from './farajasofterp-map';

export type SourceDb = NonNullable<Connection['db']>;

export interface ImportOptions {
  /** The farajasofterp company to bring across; needed when the database holds more than one. */
  companyId?: Types.ObjectId;
  /** Without it nothing is written: the report says what would happen. */
  commit: boolean;
  /** Give active employees a self-service login with their farajasofterp password. */
  withLogins: boolean;
  /** farajasofterp's FIELD_ENCRYPTION_KEY, for encrypted ID, bank and M-Pesa numbers. */
  encryptionKey?: string;
  now?: Date;
}

export interface ImportReport {
  committed: boolean;
  company: { id: string; name: string };
  employees: { found: number; created: number; updated: number; skipped: number };
  departments: number;
  allowances: number;
  leaveTypes: { matched: number; created: number };
  leaveRequests: number;
  openingBalances: number;
  payrolls: { periods: string[]; payslips: number; skipped: string[] };
  logins: { created: number; linked: number };
  warnings: string[];
  /** The last imported month worked again with this system's engine, employee by employee. */
  comparison?: { period: string; oldNet: string; newNet: string; differences: { employeeNo: string; name: string; oldNet: string; newNet: string; difference: string }[] } | { period: string; error: string };
}

const TOTALS = ['gross', 'paye', 'nssfEmployee', 'nssfEmployer', 'shif', 'ahlEmployee', 'ahlEmployer', 'nita', 'otherDeductions', 'netPay', 'employerCost'] as const;
const IMPORT_NOTE = 'Balance brought from farajasofterp';
const nextMonth = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};

/**
 * Brings a farajasofterp company into the HR module: departments, employees with their pay and
 * statutory numbers, recurring allowances, approved payroll history (as payslips), leave types,
 * leave applications and this year's balances, and optionally self-service logins.
 *
 * Everything is matched on farajasofterp's ids, so it can run again (during a parallel run, say) and
 * updates instead of duplicating. Payroll history is marked imported and never sent to the ledger.
 */
export class FarajasofterpImporter {
  constructor(
    private readonly db: Db,
    private readonly payroll: PayrollService,
    private readonly leave: LeaveService,
  ) {}

  async run(source: SourceDb, organisationId: Types.ObjectId, opts: ImportOptions): Promise<ImportReport> {
    const now = opts.now ?? new Date();
    const year = now.getUTCFullYear();
    const warnings: string[] = [];

    // Source ---------------------------------------------------------------------------------------
    const companies = await source.collection('companies').find({}, { projection: { name: 1 } }).toArray();
    const company = opts.companyId ? companies.find((c) => c._id.equals(opts.companyId!)) : companies.length === 1 ? companies[0] : undefined;
    if (!company) throw new Error(opts.companyId ? `No company ${opts.companyId} in the source` : `Choose a company with SOURCE_COMPANY_ID: ${companies.map((c) => `${c._id} (${c.name})`).join(', ')}`);
    const cid = company._id as Types.ObjectId;
    const [srcEmployees, srcPayruns, srcTypes, srcRequests] = await Promise.all([
      source.collection('employees').find({ company: cid }).toArray() as unknown as Promise<SrcEmployee[]>,
      source.collection('payruns').find({ $or: [{ company_id: cid }, { company: cid }] }).toArray() as unknown as Promise<SrcPayrun[]>,
      source.collection('leavetypes').find({ company: cid }).toArray() as unknown as Promise<SrcLeaveType[]>,
      source.collection('leaverequests').find({ company: cid }).toArray() as unknown as Promise<SrcLeaveRequest[]>,
    ]);
    const srcBalances = (await source
      .collection('leavebalances')
      .find({ employee: { $in: srcEmployees.map((e) => e._id) }, fiscalYear: { $regex: String(year) } })
      .toArray()) as unknown as SrcLeaveBalance[];

    const decrypt = decryptor(opts.encryptionKey);
    const mapped: MappedEmployee[] = srcEmployees.map((e) => mapEmployee(e, decrypt)).sort((a, b) => a.employeeNo.localeCompare(b.employeeNo));
    for (const m of mapped) warnings.push(...m.warnings);

    // Departments --------------------------------------------------------------------------------
    const departments = await this.db.departments.find({ organisationId }).lean();
    const deptByName = new Map(departments.map((d) => [d.name.toLowerCase(), d._id]));
    const codes = new Set(departments.map((d) => d.code));
    const newDepartments: { _id: Types.ObjectId; code: string; name: string }[] = [];
    for (const name of new Set(mapped.map((m) => m.department).filter((d): d is string => Boolean(d)))) {
      if (deptByName.has(name.toLowerCase())) continue;
      const d = { _id: new Types.ObjectId(), code: departmentCode(name, codes), name };
      newDepartments.push(d);
      deptByName.set(name.toLowerCase(), d._id);
    }
    const deptName = new Map([...departments.map((d) => [d._id.toHexString(), d.name] as const), ...newDepartments.map((d) => [d._id.toHexString(), d.name] as const)]);

    // Employees ----------------------------------------------------------------------------------
    const existing = await this.db.employees.find({ organisationId }, { legacyId: 1, employeeNo: 1, nationalId: 1, userId: 1 }).lean();
    const byLegacy = new Map(existing.filter((e) => e.legacyId).map((e) => [e.legacyId!, e]));
    const byNo = new Map(existing.map((e) => [e.employeeNo, e]));
    const byNationalId = new Map(existing.filter((e) => e.nationalId).map((e) => [e.nationalId!, e]));
    const idFor = new Map<string, Types.ObjectId>(); // legacy id or farajasofterp employee number → target id
    const plan: { m: MappedEmployee; _id: Types.ObjectId; isNew: boolean }[] = [];
    const seenIds = new Set<string>();
    let skipped = 0;
    for (const m of mapped) {
      const mine = byLegacy.get(m.legacyId);
      const holder = byNo.get(m.employeeNo);
      if (holder && !holder._id.equals(mine?._id ?? new Types.ObjectId())) {
        warnings.push(`${m.employeeNo} ${m.firstName} ${m.lastName}: employee number already used here by someone else; not imported`);
        skipped++;
        continue;
      }
      if (m.nationalId) {
        const other = byNationalId.get(m.nationalId);
        if (seenIds.has(m.nationalId) || (other && !other._id.equals(mine?._id ?? new Types.ObjectId()))) {
          warnings.push(`${m.employeeNo}: ID number ${m.nationalId} belongs to another employee; left blank`);
          m.nationalId = undefined;
        } else seenIds.add(m.nationalId);
      }
      const _id = mine?._id ?? new Types.ObjectId();
      plan.push({ m, _id, isNew: !mine });
      idFor.set(m.legacyId, _id);
      idFor.set(m.employeeNo, _id);
    }
    const legacyToMapped = new Map(plan.map((p) => [p.m.legacyId, p]));

    // Payroll history ----------------------------------------------------------------------------
    const runsByPeriod = new Map<string, SrcPayrun>();
    for (const r of srcPayruns) {
      const period = parsePeriod(r.period ?? '');
      if (!payrunStatus(r)) continue;
      if (!period) {
        warnings.push(`Pay run "${r.period}" has a period that cannot be read; not imported`);
        continue;
      }
      // Two approved runs for one month (a re-run): keep the later one.
      const prev = runsByPeriod.get(period);
      if (!prev || prev._id.getTimestamp() < r._id.getTimestamp()) runsByPeriod.set(period, r);
    }
    const existingRuns = await this.db.payRuns.find({ organisationId, status: { $ne: 'CANCELLED' } }, { period: 1, legacyId: 1 }).lean();
    const runPlans: { src: SrcPayrun; period: string; status: 'APPROVED' | 'PAID'; _id: Types.ObjectId }[] = [];
    const skippedPeriods: string[] = [];
    for (const [period, src] of [...runsByPeriod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const there = existingRuns.find((r) => r.period === period);
      if (there?.legacyId === src._id.toHexString()) continue; // imported before
      if (there) {
        skippedPeriods.push(period);
        warnings.push(`${period}: a payroll for this month already exists here; farajasofterp's was not imported`);
        continue;
      }
      runPlans.push({ src, period, status: payrunStatus(src)!, _id: new Types.ObjectId() });
    }
    const lastImported = [...runsByPeriod.keys()].sort().pop();
    const allowancesFrom = lastImported ? nextMonth(lastImported) : now.toISOString().slice(0, 7);

    // Leave --------------------------------------------------------------------------------------
    const types = await this.db.leaveTypes.find({ organisationId }).lean();
    const typeFor = new Map<string, Types.ObjectId>();
    const newTypes: { _id: Types.ObjectId; code: string; name: string; paid: boolean; unlimited: boolean }[] = [];
    const typeCodes = new Set(types.map((t) => t.code));
    for (const t of srcTypes) {
      const code = (t.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      const match = types.find((x) => (code && x.code === code) || x.name.toLowerCase() === t.name.toLowerCase()) ?? newTypes.find((x) => x.name.toLowerCase() === t.name.toLowerCase());
      if (match) {
        typeFor.set(t._id.toHexString(), match._id);
        continue;
      }
      const unpaid = t.category === 'unpaid';
      const created = { _id: new Types.ObjectId(), code: code && !typeCodes.has(code) ? code : departmentCode(t.name, typeCodes), name: t.name, paid: !unpaid, unlimited: unpaid };
      typeCodes.add(created.code);
      newTypes.push(created);
      typeFor.set(t._id.toHexString(), created._id);
      warnings.push(`Leave type "${t.name}" created as ${created.code} with no yearly entitlement; set its days in HR settings → Leave types`);
    }
    const requestPlans = srcRequests.flatMap((r) => {
      const employeeId = idFor.get(r.employee.toHexString());
      const leaveTypeId = typeFor.get(r.leaveType.toHexString());
      if (!employeeId || !leaveTypeId) return [];
      const emp = legacyToMapped.get(r.employee.toHexString())!;
      return [{ legacyId: r._id.toHexString(), employeeId, leaveTypeId, departmentId: emp.m.department ? deptByName.get(emp.m.department.toLowerCase()) : null, startDate: r.startDate, endDate: r.endDate, days: r.totalDays, reason: r.reason, status: leaveStatus(r.status) }];
    });
    const balancePlans = srcBalances.flatMap((b) => {
      const employeeId = idFor.get(b.employee.toHexString());
      const leaveTypeId = typeFor.get(b.leaveType.toHexString());
      return employeeId && leaveTypeId && typeof b.available === 'number' ? [{ employeeId, leaveTypeId, available: b.available }] : [];
    });

    // Logins -------------------------------------------------------------------------------------
    const loginPlans = opts.withLogins ? plan.filter((p) => p.m.status === 'ACTIVE' && p.m.email && p.m.passwordHash) : [];
    if (opts.withLogins) {
      const without = plan.filter((p) => p.m.status === 'ACTIVE' && (!p.m.email || !p.m.passwordHash)).length;
      if (without) warnings.push(`${without} active employees have no email or password in farajasofterp; give them self-service from their employee page`);
    }

    const report: ImportReport = {
      committed: opts.commit,
      company: { id: cid.toHexString(), name: String(company.name) },
      employees: { found: srcEmployees.length, created: plan.filter((p) => p.isNew).length, updated: plan.filter((p) => !p.isNew).length, skipped },
      departments: newDepartments.length,
      allowances: plan.reduce((n, p) => n + p.m.allowances.length, 0),
      leaveTypes: { matched: srcTypes.length - newTypes.length, created: newTypes.length },
      leaveRequests: requestPlans.length,
      openingBalances: balancePlans.length,
      payrolls: { periods: runPlans.map((r) => r.period), payslips: runPlans.reduce((n, r) => n + (r.src.compData?.length ?? 0), 0), skipped: skippedPeriods },
      logins: { created: 0, linked: 0 },
      warnings,
    };
    if (!opts.commit) return report;

    // Write ------------------------------------------------------------------------------------------
    if (newDepartments.length) await this.db.departments.insertMany(newDepartments.map((d) => ({ ...d, organisationId, active: true })));
    if (newTypes.length) await this.db.leaveTypes.insertMany(newTypes.map((t) => ({ ...t, organisationId, daysPerYear: 0, accrual: 'ANNUAL', carryForwardMax: 0, gender: null, active: true })));

    await this.db.employees.bulkWrite(
      plan.map(({ m, _id }) => {
        const managerId = m.managerRef ? (idFor.get(m.managerRef) ?? null) : null;
        return {
          updateOne: {
            filter: { _id },
            update: {
              $set: {
                employeeNo: m.employeeNo,
                firstName: m.firstName,
                lastName: m.lastName,
                gender: m.gender,
                dateOfBirth: m.dateOfBirth,
                nationalId: m.nationalId,
                kraPin: m.kraPin,
                nssfNo: m.nssfNo,
                shaNo: m.shaNo,
                phone: m.phone,
                email: m.email,
                address: m.address,
                departmentId: m.department ? (deptByName.get(m.department.toLowerCase()) ?? null) : null,
                jobTitle: m.jobTitle,
                employmentType: m.employmentType,
                hireDate: m.hireDate,
                probationEndDate: m.probationEndDate,
                contractEndDate: m.contractEndDate,
                managerId: managerId?.equals(_id) ? null : managerId,
                status: m.status,
                terminationDate: m.terminationDate,
                terminationReason: m.terminationReason,
                terminationNote: m.terminationNote,
                basicSalary: toD128(m.basicSalary),
                payType: m.payType,
                rate: toD128(m.rate),
                payMethod: m.payMethod,
                bank: m.bank,
                mpesaPhone: m.mpesaPhone,
              },
              $setOnInsert: { organisationId, legacyId: m.legacyId, exempt: { paye: false, nssf: false, shif: false, ahl: false } },
            },
            upsert: true,
          },
        };
      }),
    );

    const items = plan.flatMap(({ m, _id }) =>
      m.allowances.map((a) => ({
        updateOne: {
          filter: { organisationId, employeeId: _id, kind: 'EARNING', code: a.code },
          update: { $set: { name: a.name, amount: toD128(a.amount), taxable: true, pension: false, active: m.status !== 'TERMINATED' }, $setOnInsert: { fromPeriod: allowancesFrom, toPeriod: null, balance: null } },
          upsert: true,
        },
      })),
    );
    if (items.length) await this.db.payItems.bulkWrite(items);

    if (requestPlans.length) {
      await this.db.leaveRequests.bulkWrite(
        requestPlans.map(({ legacyId, ...r }) => ({ updateOne: { filter: { organisationId, legacyId }, update: { $set: r }, upsert: true } })),
      );
    }
    // Opening balances: whatever makes this year's balance here equal farajasofterp's "available".
    const employeesById = new Map((await this.db.employees.find({ _id: { $in: [...new Set(balancePlans.map((b) => b.employeeId))] } }, { hireDate: 1, gender: 1 }).lean()).map((e) => [e._id.toHexString(), e]));
    for (const b of balancePlans) {
      const e = employeesById.get(b.employeeId.toHexString());
      if (!e) continue;
      const filter = { organisationId, employeeId: b.employeeId, leaveTypeId: b.leaveTypeId, year, kind: 'OPENING' as const, reason: IMPORT_NOTE };
      const prior = (await this.db.leaveAdjustments.findOne(filter).lean())?.days ?? 0;
      const current = (await this.leave.balances(organisationId, e, year, now)).find((x) => x.leaveTypeId.equals(b.leaveTypeId));
      if (!current || current.unlimited) continue;
      const days = Math.round((b.available - (current.available - prior)) * 100) / 100;
      await this.db.leaveAdjustments.updateOne(filter, { $set: { days } }, { upsert: true });
    }

    for (const r of runPlans) {
      const slips = (r.src.compData ?? []).flatMap((c) => {
        const p = mapPayslip(c);
        const ref = (p.employeeRef.id && idFor.has(p.employeeRef.id) ? p.employeeRef.id : p.employeeRef.employeeId) ?? '';
        const employeeId = idFor.get(ref);
        const emp = employeeId ? plan.find((x) => x._id.equals(employeeId)) : undefined;
        if (!employeeId || !emp) {
          warnings.push(`${r.period}: a payslip for ${String(c.firstName ?? '')} ${String(c.lastName ?? '')} (${ref}) has no matching employee; not imported`);
          return [];
        }
        return [{ p, employeeId, emp: emp.m }];
      });
      slips.sort((a, b) => a.emp.employeeNo.localeCompare(b.emp.employeeNo));
      const totals = Object.fromEntries(TOTALS.map((k) => [k, toD128(sumOf(slips.map((s) => s.p[k])))]));
      await this.db.payRuns.create([
        {
          _id: r._id,
          organisationId,
          period: r.period,
          status: r.status,
          payDate: r.src.dueDate ?? periodEnd(r.period),
          employeeCount: slips.length,
          totals,
          approvedAt: periodEnd(r.period),
          paidAt: r.status === 'PAID' ? periodEnd(r.period) : undefined,
          paymentReference: r.status === 'PAID' ? 'farajasofterp' : undefined,
          imported: true,
          legacyId: r.src._id.toHexString(),
          accounting: { status: 'SKIPPED', error: 'Imported from farajasofterp: already in the books' },
          paymentAccounting: { status: 'SKIPPED', error: 'Imported from farajasofterp: already in the books' },
        },
      ]);
      if (slips.length) {
        await this.db.payslips.insertMany(
          slips.map(({ p, employeeId, emp }, i) => {
            const departmentId = emp.department ? deptByName.get(emp.department.toLowerCase()) : undefined;
            return {
              organisationId,
              payRunId: r._id,
              employeeId,
              period: r.period,
              payslipNo: `IMP-${r.period.replace('-', '')}-${String(i + 1).padStart(4, '0')}`,
              status: r.status,
              employee: {
                employeeNo: emp.employeeNo,
                name: fullName(emp),
                departmentId,
                department: departmentId ? deptName.get(departmentId.toHexString()) : undefined,
                jobTitle: emp.jobTitle,
                kraPin: emp.kraPin,
                nssfNo: emp.nssfNo,
                shaNo: emp.shaNo,
                nationalId: emp.nationalId,
                payMethod: emp.payMethod,
                bankName: emp.bank.name,
                bankBranch: emp.bank.branch,
                accountNo: emp.bank.accountNo,
                mpesaPhone: emp.mpesaPhone,
              },
              daysPaid: periodEnd(r.period).getUTCDate(),
              daysInPeriod: periodEnd(r.period).getUTCDate(),
              lines: p.lines.map((l) => ({ ...l, amount: toD128(l.amount) })),
              gross: toD128(p.gross),
              grossPay: toD128(p.gross),
              nssfEmployee: toD128(p.nssfEmployee),
              nssfTier1: toD128(p.nssfTier1),
              nssfTier2: toD128(p.nssfTier2),
              nssfEmployer: toD128(p.nssfEmployer),
              shif: toD128(p.shif),
              ahlEmployee: toD128(p.ahlEmployee),
              ahlEmployer: toD128(p.ahlEmployer),
              pensionRelief: toD128(0),
              taxablePay: toD128(p.taxablePay),
              taxCharged: toD128(p.taxCharged),
              personalRelief: toD128(p.personalRelief),
              paye: toD128(p.paye),
              otherDeductions: toD128(p.otherDeductions),
              totalDeductions: toD128(p.totalDeductions),
              netPay: toD128(p.netPay),
              nita: toD128(p.nita),
              employerCost: toD128(p.employerCost),
              warnings: ['Imported from farajasofterp; taxable pay and tax charged are worked back from the amounts paid'],
            };
          }),
        );
      }
    }
    report.payrolls.payslips = await this.db.payslips.countDocuments({ organisationId, payRunId: { $in: runPlans.map((r) => r._id) } });

    for (const { m, _id } of loginPlans) {
      const user = await this.db.users.findOne({ email: m.email }).lean();
      if (user && !user.organisationId.equals(organisationId)) {
        warnings.push(`${m.employeeNo}: ${m.email} signs in to another organisation; no login linked`);
        continue;
      }
      const taken = user ? await this.db.employees.exists({ organisationId, userId: user._id, _id: { $ne: _id } }) : null;
      if (taken) {
        warnings.push(`${m.employeeNo}: ${m.email} is already linked to another employee`);
        continue;
      }
      let userId = user?._id;
      if (user) {
        if (!user.isAdmin && !(user.access ?? []).some((a) => a.module === 'hr')) await this.db.users.updateOne({ _id: user._id }, { $push: { access: { module: 'hr', role: 'EMPLOYEE', scope: [] } } });
        report.logins.linked++;
      } else {
        userId = (await this.db.users.create([{ organisationId, name: fullName(m), email: m.email, phone: m.phone, access: [{ module: 'hr', role: 'EMPLOYEE', scope: [] }], passwordHash: m.passwordHash }]))[0]._id;
        report.logins.created++;
      }
      await this.db.employees.updateOne({ _id }, { userId });
    }

    if (lastImported) report.comparison = await this.compare(organisationId, lastImported);
    return report;
  }

  /** Works an imported month again with this system's engine and lists whose net pay would differ. */
  async compare(organisationId: Types.ObjectId, period: string): Promise<NonNullable<ImportReport['comparison']>> {
    const run = await this.db.payRuns.findOne({ organisationId, period, status: { $ne: 'CANCELLED' } }, { _id: 1 }).lean();
    const imported = run ? await this.db.payslips.find({ payRunId: run._id }, { employeeId: 1, employee: 1, netPay: 1 }).lean() : [];
    try {
      const { slips } = await this.payroll.calculate(organisationId, period);
      const fresh = new Map(slips.map((s) => [s.employeeId.toHexString(), s.result.netPay]));
      let oldNet = new Decimal(0);
      let newNet = new Decimal(0);
      const differences = imported.flatMap((s) => {
        const before = dec(s.netPay?.toString());
        const after = fresh.get(s.employeeId.toHexString()) ?? new Decimal(0);
        oldNet = oldNet.plus(before);
        newNet = newNet.plus(after);
        const diff = after.minus(before);
        return diff.abs().gte(1) ? [{ employeeNo: s.employee?.employeeNo ?? '', name: s.employee?.name ?? '', oldNet: before.toFixed(2), newNet: after.toFixed(2), difference: diff.toFixed(2) }] : [];
      });
      return { period, oldNet: oldNet.toFixed(2), newNet: newNet.toFixed(2), differences: differences.sort((a, b) => Math.abs(Number(b.difference)) - Math.abs(Number(a.difference))) };
    } catch (err) {
      return { period, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
