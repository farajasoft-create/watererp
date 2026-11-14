/**
 * HR starter data for a new organisation: Kenyan statutory rates (February 2025 and February 2026),
 * departments, leave types under the Employment Act and public holidays; with --demo also HR users,
 * employees with pay items, and last month's payroll prepared by one user and approved by another.
 *
 * Check the statutory rates against KRA, NSSF and SHA notices before the first real payroll.
 */
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { dec, toD128 } from '@/platform/common/money';
import { resolvePermissions } from '@/platform/manifest';
import { SeedContext } from '@/platform/module';
import { hrManifest } from '../manifest';
import type { HrServices } from './container';
import { KENYA_RATES_2025, KENYA_RATES_2026, StatutoryRates } from './payroll/engine';

const RATE_SETS: [string, string, StatutoryRates][] = [
  ['2025-02-01', 'NSSF Act 2013 year 3; Tax Laws (Amendment) Act 2024 (SHIF and AHL deductible)', KENYA_RATES_2025],
  ['2026-02-01', 'NSSF Act 2013 year 4 (LEL 9,000, UEL 108,000)', KENYA_RATES_2026],
];

const DEPARTMENTS = [
  ['ADM', 'Administration'],
  ['FIN', 'Finance'],
  ['COM', 'Commercial'],
  ['TEC', 'Technical'],
  ['HRM', 'Human resources'],
];

/** Employment Act 2007: 21 days annual leave, sick leave, 3 months' maternity, 2 weeks' paternity. */
const LEAVE_TYPES = [
  { code: 'AL', name: 'Annual leave', paid: true, daysPerYear: 21, accrual: 'MONTHLY', carryForwardMax: 10 },
  { code: 'SL', name: 'Sick leave', paid: true, daysPerYear: 14, accrual: 'ANNUAL', carryForwardMax: 0 },
  { code: 'ML', name: 'Maternity leave', paid: true, daysPerYear: 90, accrual: 'ANNUAL', carryForwardMax: 0, gender: 'FEMALE' },
  { code: 'PL', name: 'Paternity leave', paid: true, daysPerYear: 14, accrual: 'ANNUAL', carryForwardMax: 0, gender: 'MALE' },
  { code: 'CL', name: 'Compassionate leave', paid: true, daysPerYear: 5, accrual: 'ANNUAL', carryForwardMax: 0 },
  { code: 'UL', name: 'Unpaid leave', paid: false, daysPerYear: 0, accrual: 'ANNUAL', carryForwardMax: 0, unlimited: true },
];

/** Fixed and Easter holidays; Idd-ul-Fitr is gazetted each year, so add it when announced. */
const HOLIDAYS = [
  ['2026-01-01', "New Year's Day"],
  ['2026-04-03', 'Good Friday'],
  ['2026-04-06', 'Easter Monday'],
  ['2026-05-01', 'Labour Day'],
  ['2026-06-01', 'Madaraka Day'],
  ['2026-10-10', 'Mazingira Day'],
  ['2026-10-20', 'Mashujaa Day'],
  ['2026-12-12', 'Jamhuri Day'],
  ['2026-12-25', 'Christmas Day'],
  ['2026-12-26', 'Boxing Day'],
  ['2027-01-01', "New Year's Day"],
  ['2027-03-26', 'Good Friday'],
  ['2027-03-29', 'Easter Monday'],
  ['2027-05-01', 'Labour Day'],
  ['2027-06-01', 'Madaraka Day'],
  ['2027-10-11', 'Mazingira Day (observed)'],
  ['2027-10-20', 'Mashujaa Day'],
  ['2027-12-13', 'Jamhuri Day (observed)'],
  ['2027-12-25', 'Christmas Day'],
  ['2027-12-27', 'Boxing Day (observed)'],
];

export async function seedHr({ services, organisationId, demo, demoPassword }: SeedContext<HrServices>) {
  const db = services.db;
  await db.hrSettings.updateOne(
    { organisationId },
    { $setOnInsert: { organisationId, employeeNoPrefix: 'EMP', holidays: HOLIDAYS.map(([date, name]) => ({ date, name })) } },
    { upsert: true },
  );
  for (const [from, reference, r] of RATE_SETS) {
    await db.rateSets.updateOne(
      { organisationId, effectiveFrom: new Date(`${from}T00:00:00Z`) },
      {
        $setOnInsert: {
          organisationId,
          reference,
          paye: { bands: r.paye.bands.map((b) => ({ upTo: b.upTo === null ? null : toD128(b.upTo), rate: toD128(b.rate) })), personalRelief: toD128(r.paye.personalRelief) },
          nssf: { rate: toD128(r.nssf.rate), lowerLimit: toD128(r.nssf.lowerLimit), upperLimit: toD128(r.nssf.upperLimit) },
          shif: { rate: toD128(r.shif.rate), minimum: toD128(r.shif.minimum) },
          ahl: { employeeRate: toD128(r.ahl.employeeRate), employerRate: toD128(r.ahl.employerRate) },
          nitaPerEmployee: toD128(r.nitaPerEmployee),
          pensionReliefCap: toD128(r.pensionReliefCap),
        },
      },
      { upsert: true },
    );
  }
  for (const [code, name] of DEPARTMENTS) await db.departments.updateOne({ organisationId, code }, { $setOnInsert: { organisationId, code, name, active: true } }, { upsert: true });
  for (const t of LEAVE_TYPES) await db.leaveTypes.updateOne({ organisationId, code: t.code }, { $setOnInsert: { organisationId, gender: null, unlimited: false, active: true, ...t } }, { upsert: true });
  console.log(`HR: statutory rates (${RATE_SETS.length} sets), ${DEPARTMENTS.length} departments, ${LEAVE_TYPES.length} leave types and public holidays ready`);
  if (demo) await seedDemo(services, organisationId, demoPassword);
}

const STAFF: [string, string, 'MALE' | 'FEMALE', string, string, string][] = [
  ['Kiprotich', 'Langat', 'MALE', 'ADM', 'Managing director', '380000'],
  ['Faith', 'Jeptoo', 'FEMALE', 'FIN', 'Finance manager', '210000'],
  ['Brian', 'Kiprono', 'MALE', 'FIN', 'Accountant', '95000'],
  ['Mercy', 'Chepkoech', 'FEMALE', 'HRM', 'HR officer', '78000'],
  ['Wesley', 'Kibet', 'MALE', 'COM', 'Commercial manager', '165000'],
  ['Ruth', 'Jelagat', 'FEMALE', 'COM', 'Billing clerk', '48000'],
  ['Collins', 'Kipkemoi', 'MALE', 'COM', 'Cashier', '42000'],
  ['Gladys', 'Chebet', 'FEMALE', 'COM', 'Customer care', '38000'],
  ['Dennis', 'Rotich', 'MALE', 'TEC', 'Technical manager', '170000'],
  ['Emmanuel', 'Koech', 'MALE', 'TEC', 'Plumber', '32000'],
  ['Purity', 'Jerop', 'FEMALE', 'TEC', 'Water quality technician', '55000'],
  ['Hillary', 'Kirui', 'MALE', 'TEC', 'Pump operator', '28000'],
  ['Victor', 'Sang', 'MALE', 'TEC', 'Plumber', '30000'],
  ['Caroline', 'Cherono', 'FEMALE', 'ADM', 'Office assistant', '24000'],
  ['Joseph', 'Bett', 'MALE', 'ADM', 'Driver', '27000'],
  ['Demo', 'reader', 'MALE', 'COM', 'Meter reader', '30000'],
  ['Kevin', 'Kiptoo', 'MALE', 'TEC', 'Casual labourer (daily)', 'DAILY:850'],
];

function actingAs(id: Types.ObjectId, organisationId: Types.ObjectId, role: string): AuthUser {
  const access = [{ module: 'hr', role }];
  return { id, organisationId, email: '', name: role, isAdmin: false, access: { hr: { role, scope: [] } }, modules: ['hr'], permissions: resolvePermissions([hrManifest], { isAdmin: false, access }, ['hr']), ip: null };
}

async function seedDemo(services: HrServices, organisationId: Types.ObjectId, password: string) {
  const db = services.db;
  if (await db.employees.exists({ organisationId })) {
    console.log('HR demo data already present');
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const departments = new Map((await db.departments.find({ organisationId }).lean()).map((x) => [x.code, x._id]));
  const users: Record<string, Types.ObjectId> = {};
  for (const [role, label, scope] of [
    ['HR_MANAGER', 'hr', []],
    ['PAYROLL_OFFICER', 'payroll', []],
    ['FINANCE', 'finance', []],
    ['LINE_MANAGER', 'technicalhead', [departments.get('TEC')!]],
  ] as const) {
    const email = `${label}@demo.hr`;
    const existing = await db.users.findOne({ email }).lean();
    users[role] = existing?._id ?? (await db.users.create([{ organisationId, email, name: `Demo ${label}`, access: [{ module: 'hr', role, scope: [...scope] }], passwordHash: hash }]))[0]._id;
  }

  const hr = actingAs(users.HR_MANAGER, organisationId, 'HR_MANAGER');
  const today = new Date();
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  let n = 0;
  for (const [firstName, lastName, gender, dept, jobTitle, salary] of STAFF) {
    n++;
    const reader = lastName === 'reader';
    const daily = salary.startsWith('DAILY:');
    const e = await services.employees.create(
      hr,
      {
        firstName,
        lastName,
        gender,
        departmentId: departments.get(dept),
        jobTitle,
        employmentType: n % 7 === 0 ? 'CONTRACT' : 'PERMANENT',
        hireDate: new Date(Date.UTC(2018 + (n % 7), (n * 5) % 12, 1 + (n % 20))),
        contractEndDate: n % 7 === 0 ? new Date(today.getTime() + 40 * 86_400_000) : null,
        nationalId: String(20000000 + n * 1234567).slice(0, 8),
        kraPin: `A${String(100000000 + n * 7654321).slice(-9)}${String.fromCharCode(65 + (n % 26))}`,
        nssfNo: String(2000000000 + n * 13579),
        shaNo: `CR${String(10000000 + n * 2468).slice(-8)}`,
        phone: `2547${String(20000000 + n * 3571).slice(-8)}`,
        email: reader ? 'reader@demo.water' : `${firstName.toLowerCase()}.${lastName.toLowerCase()}@demo.hr`,
      },
      { basicSalary: dec(daily ? '0' : salary), payType: daily ? 'DAILY' : 'MONTHLY', rate: daily ? dec(salary.slice(6)) : undefined, payMethod: n % 4 === 0 ? 'MPESA' : 'BANK', bank: { name: 'KCB', branch: 'Nandi Hills', accountNo: String(1100000000 + n * 1111) }, mpesaPhone: `2547${String(20000000 + n * 3571).slice(-8)}`, exempt: { paye: false, nssf: false, shif: false, ahl: false } },
    );
    const id = e._id as Types.ObjectId;
    const item = (kind: 'EARNING' | 'DEDUCTION', code: string, name: string, amount: string, extra: Partial<{ taxable: boolean; pension: boolean; balance: string }> = {}) =>
      services.employees.addPayItem(hr, id, { kind, code, name, amount: dec(amount), taxable: extra.taxable ?? true, pension: extra.pension ?? false, balance: extra.balance ? dec(extra.balance) : null, fromPeriod: '2025-01' });
    if (daily) {
      await db.payInputs.create([{ organisationId, period: lastMonth, employeeId: id, units: 18 }]);
      continue;
    }
    await item('EARNING', 'HOUSE', 'House allowance', dec(salary).times('0.15').toDecimalPlaces(0).toFixed());
    if (dept === 'TEC' || reader) await item('EARNING', 'TRAVEL', 'Field travel allowance', '3000');
    if (n % 3 === 0) await item('DEDUCTION', 'SACCO', 'Tachasis Staff SACCO', '2500');
    if (n % 5 === 0) await item('DEDUCTION', 'LOAN', 'Salary advance', '5000', { balance: '15000' });
    if (Number(salary) >= 150000) await item('DEDUCTION', 'PENSION', 'Staff pension scheme', dec(salary).times('0.05').toFixed(0), { pension: true });
    // The meter reader keeps their water login and gains HR self-service on it: one login for both.
    if (reader || n === 4) await services.employees.grantPortal(hr, id, password);
  }

  const payroll = actingAs(users.PAYROLL_OFFICER, organisationId, 'PAYROLL_OFFICER');
  const finance = actingAs(users.FINANCE, organisationId, 'FINANCE');
  const run = await services.payroll.createRun(payroll, { period: lastMonth });
  await services.payroll.approveRun(finance, run!._id);
  // A bonus paid apart from the salaries, its tax worked together with them.
  const bonus = await services.payroll.createRun(payroll, { period: lastMonth, kind: 'OFF_CYCLE', title: 'Field team bonus' });
  await services.payroll.addToMany(payroll, bonus!._id, { departmentId: departments.get('TEC'), name: 'Field team bonus', percentOfBasic: 25, taxable: true });
  await services.payroll.approveRun(finance, bonus!._id);

  const annual = await db.leaveTypes.findOne({ organisationId, code: 'AL' }).lean();
  const plumber = await db.employees.findOne({ organisationId, jobTitle: 'Plumber' }).lean();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 14));
  if (annual && plumber && start.getUTCMonth() < 11) {
    await services.leave.request(hr, { employeeId: plumber._id, leaveTypeId: annual._id, startDate: start, endDate: new Date(start.getTime() + 4 * 86_400_000), reason: 'Family visit' });
  }
  console.log(
    `HR demo data ready: ${n} employees, ${lastMonth} payroll and a field team bonus approved. Demo users: hr@, payroll@, finance@, technicalhead@demo.hr; reader@demo.water and mercy.chepkoech@demo.hr also see their payslips (the demo password).`,
  );
}
