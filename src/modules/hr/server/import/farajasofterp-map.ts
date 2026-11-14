/**
 * How farajasofterp records become HR module records. Pure functions: nothing here reads or writes a
 * database, so the rules can be tested and the import can be tried (dry run) before anything is saved.
 */
import { createDecipheriv } from 'node:crypto';
import { Types } from 'mongoose';
import { Decimal, dec, round } from '@/platform/common/money';
import { normalisePhone } from '@/platform/common/validation';

// --- farajasofterp shapes (only the fields the import reads) ---------------------------------------

export interface SrcEmployee {
  _id: Types.ObjectId;
  employeeId: string;
  password?: string;
  status?: string;
  firstName: string;
  lastName: string;
  email?: string;
  manager?: string;
  phone?: string;
  address?: string;
  dateOfBirth?: string;
  gender?: string;
  nationalId?: string;
  position?: string;
  jobRole?: string;
  department?: string;
  contractType?: string;
  contractEndDate?: string;
  dateOfJoining?: string;
  probationEndDate?: string;
  dateOfLeaving?: string;
  salary?: Record<string, unknown>;
  bankInfo?: { bankCode?: string; accountNumber?: string; branchCode?: string; accountName?: string } | null;
  mpesaAccount?: { phoneNumber?: string } | null;
  preferredPaymentMethod?: string;
  customFields?: Record<string, unknown>;
  terminationDetails?: { reason?: string; notes?: string; terminatedAt?: Date } | null;
  paySettings?: { payType?: string; rate?: number } | null;
}

export interface SrcPayrun {
  _id: Types.ObjectId;
  period: string;
  status: string;
  paymentStatus?: string;
  dueDate?: Date;
  compData?: Record<string, unknown>[];
}

export interface SrcLeaveType {
  _id: Types.ObjectId;
  name: string;
  code?: string;
  category?: string;
  isActive?: boolean;
}

export interface SrcLeaveRequest {
  _id: Types.ObjectId;
  employee: Types.ObjectId;
  leaveType: Types.ObjectId;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  reason?: string;
  status: string;
}

export interface SrcLeaveBalance {
  employee: Types.ObjectId;
  leaveType: Types.ObjectId;
  fiscalYear: string;
  available?: number;
}

// --- helpers ---------------------------------------------------------------------------------------

/** farajasofterp's AES-256-GCM field encryption (enc:<iv>:<tag>:<data>); plain values pass through. */
export function decryptor(keyHex?: string) {
  const key = keyHex && keyHex.length === 64 ? Buffer.from(keyHex, 'hex') : null;
  return (value?: string | null): string | undefined => {
    if (!value) return undefined;
    if (!value.startsWith('enc:')) return value;
    if (!key) throw new Error('Values are encrypted: set SOURCE_FIELD_ENCRYPTION_KEY to farajasofterp’s FIELD_ENCRYPTION_KEY');
    const [iv, tag, data] = value.slice(4).split(':');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return d.update(Buffer.from(data, 'hex')).toString('utf8') + d.final('utf8');
  };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "October 2026" (farajasofterp) or "2026-10" → "2026-10". */
export function parsePeriod(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return v;
  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(v);
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  return month < 0 ? null : `${m[2]}-${String(month + 1).padStart(2, '0')}`;
}

/** Date strings as farajasofterp keeps them ("2024-01-15", ISO) → UTC midnight. */
export function toDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const s = value instanceof Date ? value.toISOString() : String(value);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  const d = m ? new Date(`${m[1]}T00:00:00.000Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const words = (key: string) =>
  key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** "houseAllowance" → "House allowance". */
export function humanise(key: string): string {
  const w = words(key).map((x) => x.toLowerCase());
  return w.length ? w[0][0].toUpperCase() + w.join(' ').slice(1) : key;
}

/** "houseAllowance" → "HOUSE_ALW" (pay item codes are at most 12 characters). */
export function itemCode(key: string): string {
  const short: Record<string, string> = { ALLOWANCE: 'ALW', TRANSPORT: 'TRANS', DEDUCTION: 'DED', CONTRIBUTION: 'CONT', MEDICAL: 'MED', COMMUTER: 'COMM' };
  const code = words(key)
    .map((w) => w.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .map((w) => short[w] ?? w)
    .join('_');
  return (code || 'ITEM').slice(0, 12).replace(/_$/, '');
}

const firstOf = (bag: Record<string, unknown> | undefined, keys: string[]) => {
  for (const k of keys) {
    const v = bag?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
};

const BASIC_KEYS = ['basicSalary', 'basic_salary', 'basic', 'Basic Salary'];
const NOT_PAY = new Set(['grossSalary', 'gross', 'grossPay', 'netSalary', 'netPay', 'totalEarnings', 'totalDeductions']);

// --- employees -------------------------------------------------------------------------------------

export interface MappedEmployee {
  legacyId: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  gender: 'MALE' | 'FEMALE' | null;
  dateOfBirth: Date | null;
  nationalId?: string;
  kraPin?: string;
  nssfNo?: string;
  shaNo?: string;
  phone?: string;
  email?: string;
  address?: string;
  department?: string;
  jobTitle?: string;
  employmentType: 'PERMANENT' | 'CONTRACT' | 'CASUAL' | 'INTERN';
  hireDate: Date;
  probationEndDate: Date | null;
  contractEndDate: Date | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  terminationDate: Date | null;
  terminationReason: 'OTHER' | null;
  terminationNote?: string;
  basicSalary: Decimal;
  payType: 'MONTHLY' | 'DAILY' | 'HOURLY';
  rate: Decimal;
  payMethod: 'BANK' | 'MPESA';
  bank: { name?: string; branch?: string; accountNo?: string; accountName?: string };
  mpesaPhone?: string;
  /** Other fixed monthly pay in farajasofterp's salary, as recurring allowances. */
  allowances: { code: string; name: string; amount: Decimal }[];
  managerRef?: string;
  passwordHash?: string;
  warnings: string[];
}

export function mapEmployee(e: SrcEmployee, decrypt: (v?: string | null) => string | undefined): MappedEmployee {
  const warnings: string[] = [];
  const who = `${e.employeeId} ${e.firstName} ${e.lastName}`;
  const cf = e.customFields ?? {};
  const salary = Object.fromEntries(Object.entries(e.salary ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
  const basicKey = BASIC_KEYS.find((k) => k in salary);
  const allowances = Object.entries(salary)
    .filter(([k, v]) => k !== basicKey && !NOT_PAY.has(k) && v > 0)
    .map(([k, v]) => ({ code: itemCode(k), name: humanise(k), amount: round(String(v), 2) }));

  let kraPin = firstOf(cf, ['kraPin', 'kra_pin', 'kraPIN', 'KRA PIN']) ?? firstOf(e as unknown as Record<string, unknown>, ['kraPin']);
  if (kraPin && !/^[AP]\d{9}[A-Z]$/i.test(kraPin)) {
    warnings.push(`${who}: KRA PIN "${kraPin}" is not valid; left blank`);
    kraPin = undefined;
  }
  const rawPhone = e.phone ? normalisePhone(e.phone) : null;
  if (e.phone && !rawPhone) warnings.push(`${who}: phone "${e.phone}" is not a Kenyan mobile number; left blank`);
  const mpesaRaw = decrypt(e.mpesaAccount?.phoneNumber);
  const mpesaPhone = mpesaRaw ? (normalisePhone(mpesaRaw) ?? undefined) : undefined;
  const hireDate = toDate(e.dateOfJoining);
  if (!hireDate) warnings.push(`${who}: no joining date; used 1 January 2000`);
  const payType = e.paySettings?.payType;
  const rated = payType === 'hourly_rate' || payType === 'daily_rate';
  if (rated && !e.paySettings?.rate) warnings.push(`${who}: paid by the ${payType === 'daily_rate' ? 'day' : 'hour'} but has no rate`);
  const basic = basicKey ? salary[basicKey] : 0;
  if (!basic && !rated) warnings.push(`${who}: no basic salary`);

  const status = (e.status ?? 'active').toLowerCase();
  const ct = (e.contractType ?? '').toLowerCase();
  const gender = (e.gender ?? '').toLowerCase();
  const terminated = status === 'terminated';
  return {
    legacyId: e._id.toHexString(),
    employeeNo: e.employeeId,
    firstName: e.firstName?.trim() || '—',
    lastName: e.lastName?.trim() || '—',
    gender: gender === 'male' ? 'MALE' : gender === 'female' ? 'FEMALE' : null,
    dateOfBirth: toDate(e.dateOfBirth),
    nationalId: decrypt(e.nationalId)?.trim() || undefined,
    kraPin: kraPin?.toUpperCase(),
    nssfNo: firstOf(cf, ['nssfNumber', 'nssf_number', 'nssfNo', 'NSSF Number']),
    shaNo: firstOf(cf, ['shaNumber', 'sha_number', 'shifNumber', 'shif_number', 'nhifNumber', 'nhif_number']),
    phone: rawPhone ?? undefined,
    email: e.email?.toLowerCase().trim() || undefined,
    address: e.address,
    department: e.department?.trim() || undefined,
    jobTitle: e.position ?? e.jobRole,
    employmentType: ct.includes('contract') || ct.includes('fixed') ? 'CONTRACT' : ct.includes('casual') ? 'CASUAL' : ct.includes('intern') || ct.includes('attach') ? 'INTERN' : 'PERMANENT',
    hireDate: hireDate ?? new Date('2000-01-01T00:00:00Z'),
    probationEndDate: toDate(e.probationEndDate),
    contractEndDate: toDate(e.contractEndDate),
    status: terminated ? 'TERMINATED' : status === 'inactive' ? 'SUSPENDED' : 'ACTIVE',
    terminationDate: terminated ? (toDate(e.dateOfLeaving) ?? toDate(e.terminationDetails?.terminatedAt) ?? new Date()) : null,
    terminationReason: terminated ? 'OTHER' : null,
    terminationNote: terminated ? [e.terminationDetails?.reason, e.terminationDetails?.notes].filter(Boolean).join(' – ') || undefined : undefined,
    basicSalary: round(String(rated ? 0 : basic), 2),
    payType: payType === 'daily_rate' ? 'DAILY' : payType === 'hourly_rate' ? 'HOURLY' : 'MONTHLY',
    rate: round(String(rated ? (e.paySettings?.rate ?? 0) : 0), 2),
    payMethod: e.preferredPaymentMethod === 'MPESA' ? 'MPESA' : 'BANK',
    bank: { name: e.bankInfo?.bankCode || undefined, branch: e.bankInfo?.branchCode || undefined, accountNo: decrypt(e.bankInfo?.accountNumber), accountName: decrypt(e.bankInfo?.accountName) },
    mpesaPhone,
    allowances,
    managerRef: e.manager?.trim() || undefined,
    passwordHash: e.password && /^\$2[aby]\$/.test(e.password) ? e.password : undefined,
    warnings,
  };
}

// --- payslips --------------------------------------------------------------------------------------

export interface MappedLine {
  type: 'BASIC' | 'EARNING' | 'STATUTORY' | 'DEDUCTION' | 'EMPLOYER';
  code: string;
  name: string;
  amount: Decimal;
}

export interface MappedPayslip {
  employeeRef: { id?: string; employeeId?: string };
  lines: MappedLine[];
  gross: Decimal;
  paye: Decimal;
  nssfEmployee: Decimal;
  nssfTier1: Decimal;
  nssfTier2: Decimal;
  nssfEmployer: Decimal;
  shif: Decimal;
  ahlEmployee: Decimal;
  ahlEmployer: Decimal;
  nita: Decimal;
  otherDeductions: Decimal;
  totalDeductions: Decimal;
  netPay: Decimal;
  taxablePay: Decimal;
  taxCharged: Decimal;
  personalRelief: Decimal;
  employerCost: Decimal;
}

/** Fields of a pay run's employee entry that are bookkeeping, not pay. */
const META = new Set(['totalEarnings', 'totalDeductions', 'fixedSalary', 'netSalary', 'rate', 'hoursWorked', 'daysWorked', 'rateBasedBasicSalary', 'totalEmployerCost', 'basicSalary', 'housingAllowance', 'overtime', 'incomeTax']);

type Statutory = 'PAYE' | 'NSSF' | 'SHIF' | 'AHL' | 'NITA' | null;

function statutoryOf(name: string): Statutory {
  const n = name.toUpperCase().replace(/[^A-Z]/g, '');
  if (n.includes('PAYE') || n.includes('INCOMETAX')) return 'PAYE';
  if (n.includes('NSSF')) return 'NSSF';
  if (n.includes('SHIF') || n.includes('NHIF') || n.includes('SHA')) return 'SHIF';
  if (n.includes('AHL') || n.includes('HOUSING')) return 'AHL';
  if (n.includes('NITA')) return 'NITA';
  return null;
}

/**
 * One employee's entry in a farajasofterp pay run. Amounts are kept as paid. farajasofterp does not
 * store taxable pay or tax charged, so they are derived: taxable = gross less NSSF, SHIF and housing
 * levy; tax charged = PAYE plus the personal relief.
 */
export function mapPayslip(c: Record<string, unknown>, personalRelief: Decimal = new Decimal(2400)): MappedPayslip {
  const num = (k: string) => (typeof c[k] === 'number' && Number.isFinite(c[k] as number) ? round(String(c[k]), 2) : new Decimal(0));
  const lines: MappedLine[] = [];
  const stat: Record<Exclude<Statutory, null>, Decimal> = { PAYE: new Decimal(0), NSSF: new Decimal(0), SHIF: new Decimal(0), AHL: new Decimal(0), NITA: new Decimal(0) };
  const employer: Record<string, Decimal> = {};
  let tier1 = new Decimal(0);
  let tier2 = new Decimal(0);

  for (const [key, value] of Object.entries(c)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0 || META.has(key) || key.endsWith('Percentage')) continue;
    const amount = round(String(Math.abs(value)), 2);
    if (key.startsWith('nssfTier')) {
      if (/^nssfTierIEmployee$/.test(key)) tier1 = amount;
      else if (/^nssfTierIIEmployee$/.test(key)) tier2 = amount;
      continue;
    }
    if (key.startsWith('employer_')) {
      const kind = statutoryOf(key.slice(9)) ?? 'OTHER';
      employer[kind] = (employer[kind] ?? new Decimal(0)).plus(amount);
      continue;
    }
    if (key.endsWith('Tax')) {
      const kind = statutoryOf(key.slice(0, -3));
      if (kind) {
        stat[kind] = stat[kind].plus(amount);
        continue;
      }
    }
    if (value > 0) lines.push({ type: /basic/i.test(key) ? 'BASIC' : 'EARNING', code: /basic/i.test(key) ? 'BASIC' : itemCode(key), name: /basic/i.test(key) ? 'Basic salary' : humanise(key), amount });
    else lines.push({ type: 'DEDUCTION', code: itemCode(key), name: humanise(key), amount });
  }

  const earnings = lines.filter((l) => l.type === 'BASIC' || l.type === 'EARNING').reduce((s, l) => s.plus(l.amount), new Decimal(0));
  const fixed = num('fixedSalary');
  const gross = fixed.gt(0) || num('totalEarnings').gt(0) ? fixed.plus(num('totalEarnings')) : earnings;
  const statutoryTotal = stat.PAYE.plus(stat.NSSF).plus(stat.SHIF).plus(stat.AHL);
  const listed = lines.filter((l) => l.type === 'DEDUCTION').reduce((s, l) => s.plus(l.amount), new Decimal(0));
  const totalDeductions = typeof c.totalDeductions === 'number' ? num('totalDeductions').abs() : statutoryTotal.plus(listed);
  const netPay = typeof c.netSalary === 'number' ? num('netSalary') : gross.minus(totalDeductions);

  for (const [code, name, amount] of [['PAYE', 'PAYE', stat.PAYE], ['NSSF', 'NSSF', stat.NSSF], ['SHIF', 'SHIF', stat.SHIF], ['AHL', 'Housing levy', stat.AHL]] as const) {
    if (amount.gt(0)) lines.push({ type: 'STATUTORY', code, name, amount });
  }
  const nssfEmployer = employer.NSSF ?? new Decimal(0);
  const ahlEmployer = employer.AHL ?? new Decimal(0);
  const nita = (employer.NITA ?? new Decimal(0)).plus(stat.NITA);
  for (const [code, name, amount] of [['NSSF_ER', 'NSSF (employer)', nssfEmployer], ['AHL_ER', 'Housing levy (employer)', ahlEmployer], ['NITA', 'NITA levy', nita], ['OTHER_ER', 'Other employer contributions', employer.OTHER ?? new Decimal(0)]] as const) {
    if (amount.gt(0)) lines.push({ type: 'EMPLOYER', code, name, amount });
  }
  const relief = stat.PAYE.gt(0) ? personalRelief : new Decimal(0);
  const employerTotal = Object.values(employer).reduce((s, v) => s.plus(v), new Decimal(0)).plus(stat.NITA);
  return {
    employeeRef: { id: typeof c.id === 'string' ? c.id : undefined, employeeId: typeof c.employeeId === 'string' ? c.employeeId : undefined },
    lines,
    gross,
    paye: stat.PAYE,
    nssfEmployee: stat.NSSF,
    nssfTier1: tier1,
    nssfTier2: tier2,
    nssfEmployer,
    shif: stat.SHIF,
    ahlEmployee: stat.AHL,
    ahlEmployer,
    nita,
    otherDeductions: Decimal.max(totalDeductions.minus(statutoryTotal), 0),
    totalDeductions,
    netPay,
    taxablePay: Decimal.max(gross.minus(stat.NSSF).minus(stat.SHIF).minus(stat.AHL), 0),
    taxCharged: stat.PAYE.plus(relief),
    personalRelief: relief,
    employerCost: gross.plus(employerTotal),
  };
}

/** Pay runs that were approved in farajasofterp; drafts and rejected runs are not history. */
export function payrunStatus(p: Pick<SrcPayrun, 'status' | 'paymentStatus'>): 'APPROVED' | 'PAID' | null {
  if (p.status === 'Complete' || p.paymentStatus === 'COMPLETE') return 'PAID';
  if (['Approved', 'Ready', 'In Progress'].includes(p.status)) return 'APPROVED';
  return null;
}

export function leaveStatus(s: string): 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' {
  const v = s.toLowerCase();
  return v === 'approved' ? 'APPROVED' : v === 'rejected' ? 'REJECTED' : v === 'pending' ? 'PENDING' : 'CANCELLED';
}

/** A department code from its name: "Human Resources" → "HR", made unique against those taken. */
export function departmentCode(name: string, taken: Set<string>): string {
  const w = words(name.replace(/&/g, ' ')).filter((x) => !/^(and|of|the)$/i.test(x));
  const base = (w.length > 1 ? w.map((x) => x[0]).join('') : (w[0] ?? 'DEPT').slice(0, 4)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DEPT';
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base.slice(0, 7)}${i}`;
  taken.add(code);
  return code;
}

export const sumOf = (values: Decimal[]) => values.reduce((s, v) => s.plus(v), dec(0));
