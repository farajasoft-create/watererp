import { Decimal, dec, DecimalInput, round } from '@/platform/common/money';

/**
 * A band of an increasing-block tariff (the WASREB structure). Bands run from the previous band's
 * upper bound to `upTo` cubic metres; the last band is open-ended (`upTo: null`).
 * A band with `fixedAmount` charges that flat sum whenever consumption reaches it, whatever the
 * units used inside it (the usual "0–6 m³ minimum charge").
 */
export interface TariffBlock {
  upTo: DecimalInput | null;
  rate: DecimalInput;
  fixedAmount?: DecimalInput | null;
}

export interface TariffRules {
  blocks: TariffBlock[];
  /** Monthly meter rent, charged once per month billed. */
  meterRent?: DecimalInput;
  /** Sewerage charge as a percentage of the water charge, for sewered connections. */
  sewerPercent?: DecimalInput;
  /** The water charge is never below this. */
  minimumCharge?: DecimalInput;
}

export type ChargeCode = 'WATER' | 'SEWER' | 'METER_RENT';

export interface ChargeLine {
  code: ChargeCode;
  description: string;
  quantity: Decimal;
  rate: Decimal | null;
  amount: Decimal;
}

export interface Band {
  from: Decimal;
  to: Decimal | null;
  units: Decimal;
  rate: Decimal;
  fixed: boolean;
  amount: Decimal;
}

/** Problems that make a tariff unusable; empty when it is valid. */
export function tariffProblems(rules: TariffRules): string[] {
  const problems: string[] = [];
  const { blocks } = rules;
  if (!blocks.length) return ['A tariff needs at least one band'];
  let previous = new Decimal(0);
  blocks.forEach((b, i) => {
    const last = i === blocks.length - 1;
    if (b.upTo === null || b.upTo === undefined) {
      if (!last) problems.push(`Band ${i + 1}: only the last band can be open-ended`);
    } else {
      const upTo = dec(b.upTo);
      if (upTo.lte(previous)) problems.push(`Band ${i + 1}: the upper limit must be above ${previous.toFixed()} m³`);
      previous = upTo;
      if (last) problems.push('The last band must be open-ended so every consumption is priced');
    }
    if (dec(b.rate).isNegative()) problems.push(`Band ${i + 1}: the rate cannot be negative`);
    if (b.fixedAmount !== null && b.fixedAmount !== undefined && dec(b.fixedAmount).isNegative()) problems.push(`Band ${i + 1}: the fixed amount cannot be negative`);
  });
  for (const [key, label] of [
    ['meterRent', 'Meter rent'],
    ['sewerPercent', 'Sewer percentage'],
    ['minimumCharge', 'Minimum charge'],
  ] as const) {
    if (rules[key] !== undefined && dec(rules[key]).isNegative()) problems.push(`${label} cannot be negative`);
  }
  return problems;
}

/** Prices consumption band by band (incremental blocks). */
export function waterCharge(blocks: TariffBlock[], consumption: DecimalInput): { amount: Decimal; bands: Band[] } {
  const units = dec(consumption);
  if (units.isNegative()) throw new Error('Consumption cannot be negative');
  const bands: Band[] = [];
  let lower = new Decimal(0);
  for (const b of blocks) {
    const upper = b.upTo === null || b.upTo === undefined ? null : dec(b.upTo);
    const reached = lower.isZero() || units.gt(lower);
    if (!reached) break;
    const top = upper && units.gt(upper) ? upper : units;
    const inBand = Decimal.max(top.minus(lower), 0);
    const fixed = b.fixedAmount !== null && b.fixedAmount !== undefined;
    const rate = dec(b.rate);
    const amount = fixed ? dec(b.fixedAmount) : inBand.times(rate);
    bands.push({ from: lower, to: upper, units: inBand, rate, fixed, amount: round(amount, 2) });
    if (!upper || units.lte(upper)) break;
    lower = upper;
  }
  return { amount: round(bands.reduce((s, b) => s.plus(b.amount), new Decimal(0)), 2), bands };
}

/** Every charge on a bill for one connection and period. */
export function billCharges(rules: TariffRules, consumption: DecimalInput, opts: { sewered: boolean; months?: number }): ChargeLine[] {
  const months = opts.months ?? 1;
  const units = dec(consumption);
  let { amount: water } = waterCharge(rules.blocks, units);
  if (rules.minimumCharge !== undefined && water.lt(dec(rules.minimumCharge))) water = round(rules.minimumCharge, 2);

  const lines: ChargeLine[] = [{ code: 'WATER', description: `Water charge (${units.toFixed()} m³)`, quantity: units, rate: null, amount: water }];
  const sewerPercent = dec(rules.sewerPercent);
  if (opts.sewered && sewerPercent.gt(0)) {
    lines.push({ code: 'SEWER', description: `Sewerage (${sewerPercent.toFixed()}% of water)`, quantity: units, rate: sewerPercent, amount: round(water.times(sewerPercent).div(100), 2) });
  }
  const rent = dec(rules.meterRent);
  if (rent.gt(0)) {
    lines.push({ code: 'METER_RENT', description: months === 1 ? 'Meter rent' : `Meter rent (${months} months)`, quantity: new Decimal(months), rate: rent, amount: round(rent.times(months), 2) });
  }
  return lines;
}
