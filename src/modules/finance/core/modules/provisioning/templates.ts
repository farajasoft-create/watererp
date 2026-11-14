import { AccountClass } from '../../database/schemas';

export const CURRENCIES: { code: string; name: string; symbol: string; precision: number }[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', precision: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', precision: 2 },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', precision: 2 },
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', precision: 2 },
  { code: 'UGX', name: 'Ugandan Shilling', symbol: 'USh', precision: 0 },
  { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TSh', precision: 2 },
  { code: 'RWF', name: 'Rwandan Franc', symbol: 'FRw', precision: 0 },
  { code: 'BIF', name: 'Burundian Franc', symbol: 'FBu', precision: 0 },
  { code: 'SSP', name: 'South Sudanese Pound', symbol: 'SSP', precision: 2 },
  { code: 'ETB', name: 'Ethiopian Birr', symbol: 'Br', precision: 2 },
  { code: 'CDF', name: 'Congolese Franc', symbol: 'FC', precision: 2 },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', precision: 2 },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', precision: 2 },
  { code: 'GHS', name: 'Ghanaian Cedi', symbol: 'GH₵', precision: 2 },
  { code: 'ZMW', name: 'Zambian Kwacha', symbol: 'ZK', precision: 2 },
  { code: 'MWK', name: 'Malawian Kwacha', symbol: 'MK', precision: 2 },
  { code: 'MZN', name: 'Mozambican Metical', symbol: 'MT', precision: 2 },
  { code: 'BWP', name: 'Botswana Pula', symbol: 'P', precision: 2 },
  { code: 'NAD', name: 'Namibian Dollar', symbol: 'N$', precision: 2 },
  { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', precision: 2 },
  { code: 'MAD', name: 'Moroccan Dirham', symbol: 'DH', precision: 2 },
  { code: 'XOF', name: 'West African CFA Franc', symbol: 'CFA', precision: 0 },
  { code: 'XAF', name: 'Central African CFA Franc', symbol: 'FCFA', precision: 0 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'AED', precision: 2 },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', precision: 2 },
  { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'KD', precision: 3 },
  { code: 'BHD', name: 'Bahraini Dinar', symbol: 'BD', precision: 3 },
  { code: 'OMR', name: 'Omani Rial', symbol: 'OMR', precision: 3 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', precision: 2 },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', precision: 2 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', precision: 0 },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', precision: 2 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', precision: 2 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', precision: 2 },
];

export interface AccountTemplate {
  code: string;
  name: string;
  accountClass: AccountClass;
  accountType: string;
  parent?: string;
  header?: boolean;
  control?: boolean;
  requiresDepartment?: boolean;
  /** 'USD' pins a bank account to a foreign currency; skipped when USD is the functional currency. */
  currency?: string;
}

/** A neutral IFRS-style starter chart. Organisations extend or replace it. */
export const CHART_OF_ACCOUNTS: AccountTemplate[] = [
  { code: '1000', name: 'Assets', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', header: true },
  { code: '1100', name: 'Current Assets', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', header: true, parent: '1000' },
  { code: '1110', name: 'Cash on Hand', accountClass: 'ASSET', accountType: 'CASH', parent: '1100' },
  { code: '1120', name: 'Bank - Operating Account', accountClass: 'ASSET', accountType: 'BANK', parent: '1100' },
  { code: '1130', name: 'Bank - USD Account', accountClass: 'ASSET', accountType: 'BANK', parent: '1100', currency: 'USD' },
  { code: '1200', name: 'Accounts Receivable', accountClass: 'ASSET', accountType: 'RECEIVABLE', parent: '1100', control: true },
  { code: '1250', name: 'Other Receivables', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parent: '1100' },
  { code: '1300', name: 'Inventory', accountClass: 'ASSET', accountType: 'INVENTORY', parent: '1100' },
  { code: '1400', name: 'Prepayments', accountClass: 'ASSET', accountType: 'PREPAYMENT', parent: '1100' },
  { code: '1320', name: 'Landed Costs Clearing', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parent: '1100' },
  { code: '1450', name: 'VAT Receivable (Input VAT)', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parent: '1100' },
  { code: '1460', name: 'Withholding Tax Recoverable', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parent: '1100' },
  { code: '1465', name: 'VAT Withheld by Customers', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parent: '1100' },
  { code: '1500', name: 'Inter-Branch Clearing', accountClass: 'ASSET', accountType: 'INTER_BRANCH', parent: '1100', control: true },
  { code: '1600', name: 'Non-Current Assets', accountClass: 'ASSET', accountType: 'NON_CURRENT_ASSET', header: true, parent: '1000' },
  { code: '1610', name: 'Property, Plant & Equipment', accountClass: 'ASSET', accountType: 'FIXED_ASSET', parent: '1600' },
  { code: '1630', name: 'Goodwill', accountClass: 'ASSET', accountType: 'NON_CURRENT_ASSET', parent: '1600' },
  { code: '1640', name: 'Investments in Subsidiaries', accountClass: 'ASSET', accountType: 'NON_CURRENT_ASSET', parent: '1600' },
  { code: '1620', name: 'Accumulated Depreciation', accountClass: 'ASSET', accountType: 'ACCUMULATED_DEPRECIATION', parent: '1600' },

  { code: '2000', name: 'Liabilities', accountClass: 'LIABILITY', accountType: 'CURRENT_LIABILITY', header: true },
  { code: '2100', name: 'Current Liabilities', accountClass: 'LIABILITY', accountType: 'CURRENT_LIABILITY', header: true, parent: '2000' },
  { code: '2110', name: 'Accounts Payable', accountClass: 'LIABILITY', accountType: 'PAYABLE', parent: '2100', control: true },
  { code: '2120', name: 'Accrued Expenses', accountClass: 'LIABILITY', accountType: 'ACCRUAL', parent: '2100' },
  { code: '2130', name: 'VAT Payable (Output VAT)', accountClass: 'LIABILITY', accountType: 'TAX_PAYABLE', parent: '2100' },
  { code: '2140', name: 'PAYE & Statutory Deductions', accountClass: 'LIABILITY', accountType: 'TAX_PAYABLE', parent: '2100' },
  { code: '2145', name: 'Net Salaries Payable', accountClass: 'LIABILITY', accountType: 'ACCRUAL', parent: '2100' },
  { code: '2150', name: 'Withholding Tax Payable', accountClass: 'LIABILITY', accountType: 'TAX_PAYABLE', parent: '2100' },
  { code: '2160', name: 'Customer Deposits', accountClass: 'LIABILITY', accountType: 'CURRENT_LIABILITY', parent: '2100' },
  { code: '2180', name: 'Goods Received Not Invoiced', accountClass: 'LIABILITY', accountType: 'ACCRUAL', parent: '2100', control: true },
  { code: '2170', name: 'Employee Claims Payable', accountClass: 'LIABILITY', accountType: 'CURRENT_LIABILITY', parent: '2100', control: true },
  { code: '2500', name: 'Non-Current Liabilities', accountClass: 'LIABILITY', accountType: 'NON_CURRENT_LIABILITY', header: true, parent: '2000' },
  { code: '2510', name: 'Long-term Loans', accountClass: 'LIABILITY', accountType: 'LOAN', parent: '2500' },

  { code: '3000', name: 'Equity', accountClass: 'EQUITY', accountType: 'EQUITY', header: true },
  { code: '3100', name: 'Share Capital', accountClass: 'EQUITY', accountType: 'SHARE_CAPITAL', parent: '3000' },
  { code: '3200', name: 'Retained Earnings', accountClass: 'EQUITY', accountType: 'RETAINED_EARNINGS', parent: '3000' },
  { code: '3300', name: 'Opening Balance Equity', accountClass: 'EQUITY', accountType: 'EQUITY', parent: '3000' },

  { code: '4000', name: 'Revenue', accountClass: 'REVENUE', accountType: 'REVENUE', header: true },
  { code: '4100', name: 'Sales Revenue', accountClass: 'REVENUE', accountType: 'REVENUE', parent: '4000' },
  { code: '4200', name: 'Service Revenue', accountClass: 'REVENUE', accountType: 'REVENUE', parent: '4000' },
  { code: '4800', name: 'Other Income', accountClass: 'REVENUE', accountType: 'OTHER_INCOME', parent: '4000' },
  { code: '4900', name: 'Realised FX Gain', accountClass: 'REVENUE', accountType: 'FX_GAIN', parent: '4000' },
  { code: '4910', name: 'Unrealised FX Gain', accountClass: 'REVENUE', accountType: 'FX_GAIN', parent: '4000' },

  { code: '5000', name: 'Cost of Sales', accountClass: 'COST_OF_SALES', accountType: 'COST_OF_SALES', header: true },
  { code: '5100', name: 'Cost of Goods Sold', accountClass: 'COST_OF_SALES', accountType: 'COST_OF_SALES', parent: '5000' },
  { code: '5200', name: 'Direct Labour', accountClass: 'COST_OF_SALES', accountType: 'COST_OF_SALES', parent: '5000' },

  { code: '6000', name: 'Operating Expenses', accountClass: 'EXPENSE', accountType: 'EXPENSE', header: true },
  { code: '6100', name: 'Salaries & Wages', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000', requiresDepartment: true },
  { code: '6200', name: 'Rent & Rates', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000' },
  { code: '6300', name: 'Utilities', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000' },
  { code: '6400', name: 'Marketing & Advertising', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000' },
  { code: '6500', name: 'Travel & Accommodation', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000' },
  { code: '6600', name: 'Office & Administration', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000' },
  { code: '6700', name: 'Professional Fees', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000' },
  { code: '6800', name: 'Bank Charges', accountClass: 'EXPENSE', accountType: 'EXPENSE', parent: '6000' },
  { code: '6850', name: 'Depreciation', accountClass: 'EXPENSE', accountType: 'DEPRECIATION', parent: '6000' },
  { code: '6900', name: 'Realised FX Loss', accountClass: 'EXPENSE', accountType: 'FX_LOSS', parent: '6000' },
  { code: '6910', name: 'Unrealised FX Loss', accountClass: 'EXPENSE', accountType: 'FX_LOSS', parent: '6000' },
  { code: '6950', name: 'Income Tax Expense', accountClass: 'EXPENSE', accountType: 'TAX_EXPENSE', parent: '6000' },
];

export const DEFAULT_DEPARTMENTS = [
  { code: 'ADMIN', name: 'Administration' },
  { code: 'FIN', name: 'Finance' },
  { code: 'SALES', name: 'Sales & Marketing' },
  { code: 'OPS', name: 'Operations' },
];

export interface TaxTemplate {
  code: string;
  name: string;
  kind: 'VAT' | 'WITHHOLDING';
  rate: string;
  /** Account codes from CHART_OF_ACCOUNTS. */
  output: string;
  /** VAT: recoverable input tax. Withholding: tax customers withheld from us, recoverable from the authority. */
  input?: string;
  description?: string;
  /** Kenya eTIMS tax type (A exempt, B 16%, C zero-rated, D non-VAT, E 8%). */
  etims?: 'A' | 'B' | 'C' | 'D' | 'E';
}

const VAT_OUTPUT = '2130';
const VAT_INPUT = '1450';
const WHT_PAYABLE = '2150';
const WHT_RECOVERABLE = '1460';
const VAT_WITHHELD = '1465';

/**
 * Starter tax codes by country. These are data, not logic: every rate and account can be changed,
 * and new effective-dated rates added, without code changes.
 */
const TAX_TEMPLATES: Record<string, { prefix: string; codes: TaxTemplate[] }> = {
  kenya: {
    prefix: '',
    codes: [
      { code: 'VAT16', name: 'VAT standard rate 16%', kind: 'VAT', rate: '16', output: VAT_OUTPUT, input: VAT_INPUT, etims: 'B' },
      { code: 'VAT8', name: 'VAT reduced rate 8% (fuel)', kind: 'VAT', rate: '8', output: VAT_OUTPUT, input: VAT_INPUT, etims: 'E' },
      { code: 'ZERO', name: 'Zero-rated', kind: 'VAT', rate: '0', output: VAT_OUTPUT, input: VAT_INPUT, etims: 'C' },
      { code: 'EXEMPT', name: 'Exempt', kind: 'VAT', rate: '0', output: VAT_OUTPUT, etims: 'A' },
      { code: 'WHT5', name: 'Withholding tax 5% (professional fees)', kind: 'WITHHOLDING', rate: '5', output: WHT_PAYABLE, input: WHT_RECOVERABLE },
      { code: 'WHVAT2', name: 'VAT withholding 2%', kind: 'WITHHOLDING', rate: '2', output: WHT_PAYABLE, input: VAT_WITHHELD },
    ],
  },
  uganda: {
    prefix: 'UG-',
    codes: [
      { code: 'VAT18', name: 'VAT standard rate 18%', kind: 'VAT', rate: '18', output: VAT_OUTPUT, input: VAT_INPUT },
      { code: 'ZERO', name: 'Zero-rated', kind: 'VAT', rate: '0', output: VAT_OUTPUT, input: VAT_INPUT },
      { code: 'EXEMPT', name: 'Exempt', kind: 'VAT', rate: '0', output: VAT_OUTPUT },
      { code: 'WHT6', name: 'Withholding tax 6%', kind: 'WITHHOLDING', rate: '6', output: WHT_PAYABLE, input: WHT_RECOVERABLE },
    ],
  },
  tanzania: {
    prefix: 'TZ-',
    codes: [
      { code: 'VAT18', name: 'VAT standard rate 18%', kind: 'VAT', rate: '18', output: VAT_OUTPUT, input: VAT_INPUT },
      { code: 'ZERO', name: 'Zero-rated', kind: 'VAT', rate: '0', output: VAT_OUTPUT, input: VAT_INPUT },
      { code: 'EXEMPT', name: 'Exempt', kind: 'VAT', rate: '0', output: VAT_OUTPUT },
      { code: 'WHT5', name: 'Withholding tax 5%', kind: 'WITHHOLDING', rate: '5', output: WHT_PAYABLE, input: WHT_RECOVERABLE },
    ],
  },
  rwanda: {
    prefix: 'RW-',
    codes: [
      { code: 'VAT18', name: 'VAT standard rate 18%', kind: 'VAT', rate: '18', output: VAT_OUTPUT, input: VAT_INPUT },
      { code: 'ZERO', name: 'Zero-rated', kind: 'VAT', rate: '0', output: VAT_OUTPUT, input: VAT_INPUT },
      { code: 'EXEMPT', name: 'Exempt', kind: 'VAT', rate: '0', output: VAT_OUTPUT },
      { code: 'WHT15', name: 'Withholding tax 15%', kind: 'WITHHOLDING', rate: '15', output: WHT_PAYABLE, input: WHT_RECOVERABLE },
    ],
  },
};

const GENERIC_TAX: TaxTemplate[] = [
  { code: 'STD', name: 'Standard rate (set your rate)', kind: 'VAT', rate: '15', output: VAT_OUTPUT, input: VAT_INPUT, description: 'Review this rate for your jurisdiction' },
  { code: 'ZERO', name: 'Zero-rated', kind: 'VAT', rate: '0', output: VAT_OUTPUT, input: VAT_INPUT },
  { code: 'EXEMPT', name: 'Exempt', kind: 'VAT', rate: '0', output: VAT_OUTPUT },
  { code: 'WHT', name: 'Withholding tax (set your rate)', kind: 'WITHHOLDING', rate: '5', output: WHT_PAYABLE, input: WHT_RECOVERABLE },
];

/** Tax codes for a country, with the jurisdiction recorded so they cannot be used by other countries' entities. */
export function taxTemplatesFor(country: string | undefined): { country: string; codes: TaxTemplate[] } {
  const t = TAX_TEMPLATES[(country ?? '').trim().toLowerCase()];
  if (!t) return { country: '', codes: GENERIC_TAX };
  return { country: country!.trim(), codes: t.codes.map((c) => ({ ...c, code: `${t.prefix}${c.code}` })) };
}

/** Subledger settings: control accounts and realised FX accounts, by template code. */
export const SUBLEDGER_ACCOUNTS = {
  receivables: '1200',
  payables: '2110',
  fxGain: '4900',
  fxLoss: '6900',
  unrealisedFxGain: '4910',
  unrealisedFxLoss: '6910',
  interBranch: '1500',
  employeeClaims: '2170',
  grni: '2180',
  landedCosts: '1320',
  salariesPayable: '2145',
};

/** Starter fixed-asset categories (account codes from CHART_OF_ACCOUNTS). */
export const ASSET_CATEGORIES = [
  { code: 'BUILDINGS', name: 'Buildings', method: 'STRAIGHT_LINE', usefulLifeMonths: 480, residualPercent: '10' },
  { code: 'VEHICLES', name: 'Motor vehicles', method: 'REDUCING_BALANCE', usefulLifeMonths: 60, annualRatePercent: '25', residualPercent: '0' },
  { code: 'EQUIPMENT', name: 'Office & IT equipment', method: 'STRAIGHT_LINE', usefulLifeMonths: 36, residualPercent: '0' },
  { code: 'FURNITURE', name: 'Furniture & fittings', method: 'STRAIGHT_LINE', usefulLifeMonths: 96, residualPercent: '5' },
] as const;
export const ASSET_ACCOUNTS = { asset: '1610', accumulated: '1620', expense: '6850', disposal: '4800' };

/** Starter expense-claim categories. */
export const EXPENSE_CATEGORIES = [
  { code: 'TRAVEL', name: 'Travel & transport', account: '6500', limit: null },
  { code: 'ACCOM', name: 'Accommodation', account: '6500', limit: '25000' },
  { code: 'MEALS', name: 'Meals & entertainment', account: '6500', limit: '5000' },
  { code: 'OFFICE', name: 'Office supplies', account: '6600', limit: null },
  { code: 'TRAINING', name: 'Training & professional', account: '6700', limit: null },
] as const;
