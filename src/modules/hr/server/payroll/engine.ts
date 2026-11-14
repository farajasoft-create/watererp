import { Decimal, dec, DecimalInput, round } from '@/platform/common/money';

/**
 * Kenyan statutory payroll for one employee and one month: NSSF (Act 2013 tiers), SHIF, the
 * Affordable Housing Levy, PAYE with personal relief, and the employer's NSSF, AHL and NITA.
 *
 * Since 27 December 2024 SHIF and AHL are allowable deductions, so like NSSF and registered pension
 * contributions they come off pay before PAYE. All rates come from a dated rate set the organisation
 * can edit when the law changes; nothing here is hard-coded except the order of the calculation.
 */

export interface PayeBand {
  /** Upper limit of the band in monthly taxable pay; null for the top band. */
  upTo: DecimalInput | null;
  /** Percent, e.g. 10 for 10%. */
  rate: DecimalInput;
}

export interface StatutoryRates {
  paye: { bands: PayeBand[]; personalRelief: DecimalInput };
  /** NSSF: Tier I on pay up to the lower limit, Tier II from there to the upper limit; employer matches. */
  nssf: { rate: DecimalInput; lowerLimit: DecimalInput; upperLimit: DecimalInput };
  shif: { rate: DecimalInput; minimum: DecimalInput };
  ahl: { employeeRate: DecimalInput; employerRate: DecimalInput };
  /** Industrial training levy per employee per month, paid by the employer. */
  nitaPerEmployee: DecimalInput;
  /** Most that NSSF plus registered pension contributions may reduce taxable pay by each month. */
  pensionReliefCap: DecimalInput;
  /** Insurance relief: a share of life, health and education premiums, up to a monthly cap (15%, 5,000). */
  insuranceRelief?: { rate: DecimalInput; cap: DecimalInput };
}

export interface PayElement {
  code: string;
  name: string;
  amount: DecimalInput;
}

export interface PayInput {
  /** Basic pay for the month, already pro-rated for joiners, leavers and unpaid leave. */
  basic: DecimalInput;
  /** How the basic line reads on the payslip, e.g. "12 days at 900.00". */
  basicLabel?: string;
  /** Allowances, overtime, bonuses. `taxable: false` is for reimbursements, which are not pay. */
  earnings?: (PayElement & { taxable?: boolean })[];
  /** Loans, SACCO, union dues… `pension: true` for registered pension schemes (tax relief). */
  deductions?: (PayElement & { pension?: boolean; insurance?: boolean })[];
  /** What the employer pays on top (pension contributions, gratuity accrued); not the employee's pay. */
  employerContributions?: PayElement[];
  rates: StatutoryRates;
  /** Statutory items the employee does not pay (e.g. PAYE exemption certificate for a disability). */
  exempt?: { paye?: boolean; nssf?: boolean; shif?: boolean; ahl?: boolean };
  /**
   * What earlier payrolls in the same month already paid and deducted (a bonus run, final dues).
   * PAYE, NSSF, SHIF and the levy are monthly, so they are worked on the month's total pay and only
   * what is still owed is taken now; personal relief and NITA are not given twice.
   */
  prior?: PriorPay;
}

export type PriorPay = Record<'grossPay' | 'nssfEmployee' | 'shif' | 'ahlEmployee' | 'ahlEmployer' | 'pensionRelief' | 'taxablePay' | 'taxCharged' | 'personalRelief' | 'nita', DecimalInput>;

export type PayLineType = 'BASIC' | 'EARNING' | 'REIMBURSEMENT' | 'STATUTORY' | 'DEDUCTION' | 'EMPLOYER';

export interface PayLine {
  type: PayLineType;
  code: string;
  name: string;
  amount: Decimal;
}

export interface PayResult {
  /** Everything paid, reimbursements included. */
  gross: Decimal;
  /** Pay that statutory deductions and PAYE are worked on (gross less reimbursements). */
  grossPay: Decimal;
  nssfEmployee: Decimal;
  nssfEmployer: Decimal;
  shif: Decimal;
  ahlEmployee: Decimal;
  ahlEmployer: Decimal;
  pensionRelief: Decimal;
  taxablePay: Decimal;
  taxCharged: Decimal;
  personalRelief: Decimal;
  insuranceRelief: Decimal;
  paye: Decimal;
  otherDeductions: Decimal;
  totalDeductions: Decimal;
  netPay: Decimal;
  nita: Decimal;
  /** Employer pension contributions and gratuity accrued this month. */
  employerPension: Decimal;
  gratuity: Decimal;
  /** Gratuity paid out (earning code GRATUITY_PAY): clears the gratuity liability, not an expense. */
  gratuityPaid: Decimal;
  /** Gross plus the employer's statutory contributions, pension and gratuity. */
  employerCost: Decimal;
  lines: PayLine[];
  /** Things a payroll officer should look at before approving. */
  warnings: string[];
}

const ZERO = new Decimal(0);
const money = (v: DecimalInput) => round(v, 2);
const pct = (base: Decimal, rate: DecimalInput) => money(base.times(dec(rate)).dividedBy(100));
const min = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);
const max = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b);

export function nssf(pay: Decimal, r: StatutoryRates['nssf']): Decimal {
  const pensionable = min(max(pay, ZERO), dec(r.upperLimit));
  return pct(pensionable, r.rate);
}

/** The employee's NSSF split into Tier I and Tier II, as the NSSF return lists it. */
export function nssfTiers(pay: Decimal, r: StatutoryRates['nssf']): { tier1: Decimal; tier2: Decimal } {
  const total = nssf(pay, r);
  const tier1 = min(total, pct(min(max(pay, ZERO), dec(r.lowerLimit)), r.rate));
  return { tier1, tier2: total.minus(tier1) };
}

export function shif(pay: Decimal, r: StatutoryRates['shif']): Decimal {
  if (pay.lte(0)) return ZERO;
  return max(pct(pay, r.rate), dec(r.minimum));
}

/** Tax on monthly taxable pay before relief, band by band. */
export function taxOnBands(taxable: Decimal, bands: PayeBand[]): Decimal {
  let tax = ZERO;
  let lower = ZERO;
  for (const band of bands) {
    if (taxable.lte(lower)) break;
    const upper = band.upTo === null || band.upTo === undefined ? taxable : min(taxable, dec(band.upTo));
    tax = tax.plus(upper.minus(lower).times(dec(band.rate)).dividedBy(100));
    if (band.upTo === null || band.upTo === undefined) break;
    lower = dec(band.upTo);
  }
  return money(tax);
}

export function calculatePay(input: PayInput): PayResult {
  const { rates } = input;
  const exempt = input.exempt ?? {};
  const lines: PayLine[] = [];
  const warnings: string[] = [];

  const basic = money(input.basic);
  if (basic.gt(0)) lines.push({ type: 'BASIC', code: 'BASIC', name: input.basicLabel ?? 'Basic salary', amount: basic });
  let grossPay = basic;
  let reimbursements = ZERO;
  let gratuityPaid = ZERO;
  for (const e of input.earnings ?? []) {
    const amount = money(e.amount);
    if (amount.isZero()) continue;
    if (e.code === 'GRATUITY_PAY') gratuityPaid = gratuityPaid.plus(amount);
    if (e.taxable === false) {
      reimbursements = reimbursements.plus(amount);
      lines.push({ type: 'REIMBURSEMENT', code: e.code, name: e.name, amount });
    } else {
      grossPay = grossPay.plus(amount);
      lines.push({ type: 'EARNING', code: e.code, name: e.name, amount });
    }
  }

  const prior = input.prior;
  // Each amount is worked on the month's pay, less what earlier payrolls this month already took.
  const already = (k: keyof PriorPay) => (prior ? dec(prior[k]) : ZERO);
  const owed = (forMonth: Decimal, k: keyof PriorPay) => max(forMonth.minus(already(k)), ZERO);
  const monthPay = grossPay.plus(already('grossPay'));
  const nssfEmployee = exempt.nssf ? ZERO : owed(nssf(monthPay, rates.nssf), 'nssfEmployee');
  const nssfEmployer = exempt.nssf ? ZERO : nssfEmployee;
  const shifAmount = exempt.shif ? ZERO : owed(shif(monthPay, rates.shif), 'shif');
  const ahlEmployee = exempt.ahl ? ZERO : owed(pct(max(monthPay, ZERO), rates.ahl.employeeRate), 'ahlEmployee');
  const ahlEmployer = exempt.ahl ? ZERO : owed(pct(max(monthPay, ZERO), rates.ahl.employerRate), 'ahlEmployer');

  let pensionContributions = ZERO;
  let insurancePremiums = ZERO;
  let otherDeductions = ZERO;
  const deductionLines: PayLine[] = [];
  for (const d of input.deductions ?? []) {
    const amount = money(d.amount);
    if (amount.isZero()) continue;
    if (d.pension) pensionContributions = pensionContributions.plus(amount);
    if (d.insurance) insurancePremiums = insurancePremiums.plus(amount);
    otherDeductions = otherDeductions.plus(amount);
    deductionLines.push({ type: 'DEDUCTION', code: d.code, name: d.name, amount });
  }
  const monthNssf = nssfEmployee.plus(already('nssfEmployee'));
  const pensionRelief = owed(min(pensionContributions.plus(already('pensionRelief')), max(dec(rates.pensionReliefCap).minus(monthNssf), ZERO)), 'pensionRelief');

  const taxablePay = max(grossPay.minus(nssfEmployee).minus(pensionRelief).minus(shifAmount).minus(ahlEmployee), ZERO);
  const monthTax = taxOnBands(taxablePay.plus(already('taxablePay')), rates.paye.bands);
  const taxCharged = exempt.paye ? ZERO : owed(monthTax, 'taxCharged');
  const personalRelief = exempt.paye ? ZERO : owed(min(money(rates.paye.personalRelief), monthTax), 'personalRelief');
  const ir = rates.insuranceRelief ?? { rate: '15', cap: '5000' };
  const insuranceRelief = exempt.paye ? ZERO : min(min(pct(insurancePremiums, ir.rate), money(ir.cap)), max(taxCharged.minus(personalRelief), ZERO));
  const paye = max(taxCharged.minus(personalRelief).minus(insuranceRelief), ZERO);

  const statutory: [string, string, Decimal][] = [
    ['PAYE', 'PAYE', paye],
    ['NSSF', 'NSSF', nssfEmployee],
    ['SHIF', 'SHIF', shifAmount],
    ['AHL', 'Housing levy', ahlEmployee],
  ];
  for (const [code, name, amount] of statutory) if (amount.gt(0)) lines.push({ type: 'STATUTORY', code, name, amount });
  lines.push(...deductionLines);

  const statutoryTotal = paye.plus(nssfEmployee).plus(shifAmount).plus(ahlEmployee);
  const totalDeductions = statutoryTotal.plus(otherDeductions);
  const gross = grossPay.plus(reimbursements);
  const netPay = gross.minus(totalDeductions);

  const nita = grossPay.gt(0) && !already('nita').gt(0) ? money(rates.nitaPerEmployee) : ZERO;
  for (const [code, name, amount] of [['NSSF_ER', 'NSSF (employer)', nssfEmployer], ['AHL_ER', 'Housing levy (employer)', ahlEmployer], ['NITA', 'NITA levy', nita]] as const) {
    if (amount.gt(0)) lines.push({ type: 'EMPLOYER', code, name, amount });
  }
  let employerPension = ZERO;
  let gratuity = ZERO;
  for (const c of input.employerContributions ?? []) {
    const amount = money(c.amount);
    if (amount.lte(0)) continue;
    if (c.code === 'GRATUITY') gratuity = gratuity.plus(amount);
    else employerPension = employerPension.plus(amount);
    lines.push({ type: 'EMPLOYER', code: c.code, name: c.name, amount });
  }

  if (netPay.lt(0)) warnings.push('Deductions exceed pay: net pay is negative');
  // Employment Act s.19(3): deductions may not exceed two-thirds of wages.
  else if (grossPay.gt(0) && totalDeductions.gt(grossPay.times(2).dividedBy(3))) warnings.push('Deductions exceed two-thirds of pay (Employment Act s.19)');

  return {
    gross,
    grossPay,
    nssfEmployee,
    nssfEmployer,
    shif: shifAmount,
    ahlEmployee,
    ahlEmployer,
    pensionRelief,
    taxablePay,
    taxCharged,
    personalRelief,
    insuranceRelief,
    paye,
    otherDeductions,
    totalDeductions,
    netPay,
    nita,
    employerPension,
    gratuity,
    gratuityPaid,
    employerCost: gross.plus(nssfEmployer).plus(ahlEmployer).plus(nita).plus(employerPension).plus(gratuity),
    lines,
    warnings,
  };
}

/** The statutory rates from February 2026 (NSSF year 4). Check against KRA, NSSF and SHA before use. */
export const KENYA_RATES_2026: StatutoryRates = {
  paye: {
    bands: [
      { upTo: '24000', rate: '10' },
      { upTo: '32333', rate: '25' },
      { upTo: '500000', rate: '30' },
      { upTo: '800000', rate: '32.5' },
      { upTo: null, rate: '35' },
    ],
    personalRelief: '2400',
  },
  nssf: { rate: '6', lowerLimit: '9000', upperLimit: '108000' },
  shif: { rate: '2.75', minimum: '300' },
  ahl: { employeeRate: '1.5', employerRate: '1.5' },
  nitaPerEmployee: '50',
  pensionReliefCap: '30000',
};

/** February 2025 to January 2026 (NSSF year 3). */
export const KENYA_RATES_2025: StatutoryRates = { ...KENYA_RATES_2026, nssf: { rate: '6', lowerLimit: '8000', upperLimit: '72000' } };
