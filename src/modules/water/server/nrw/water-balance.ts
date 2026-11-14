import { Decimal, dec, DecimalInput, round } from '@/platform/common/money';

export interface WaterBalanceInput {
  /** Volume put into the zone (bulk / production meters), m³. */
  systemInput: DecimalInput;
  /** Billed from actual customer meter readings, m³. */
  billedMetered: DecimalInput;
  /** Billed on estimates or flat rates, m³. */
  billedUnmetered: DecimalInput;
  /** Authorised but not billed (fire fighting, flushing, utility use), m³. */
  unbilledAuthorised?: DecimalInput;
}

export interface WaterBalance {
  systemInput: Decimal;
  revenueWater: Decimal;
  authorisedConsumption: Decimal;
  nonRevenueWater: Decimal;
  /** NRW as a share of system input, %; null when nothing was put in. */
  nrwPercent: Decimal | null;
  /** Losses (physical + commercial): system input less all authorised consumption. */
  waterLosses: Decimal;
}

/** The IWA / WASREB water balance for one zone and period. */
export function waterBalance(input: WaterBalanceInput): WaterBalance {
  const systemInput = dec(input.systemInput);
  const revenueWater = dec(input.billedMetered).plus(dec(input.billedUnmetered));
  const authorisedConsumption = revenueWater.plus(dec(input.unbilledAuthorised));
  const nonRevenueWater = systemInput.minus(revenueWater);
  return {
    systemInput,
    revenueWater,
    authorisedConsumption,
    nonRevenueWater,
    nrwPercent: systemInput.gt(0) ? round(nonRevenueWater.div(systemInput).times(100), 1) : null,
    waterLosses: systemInput.minus(authorisedConsumption),
  };
}

/** WASREB benchmark bands for NRW (%): good below 20, acceptable to 25, unacceptable above. */
export function nrwRating(percent: DecimalInput | null): 'GOOD' | 'ACCEPTABLE' | 'UNACCEPTABLE' | null {
  if (percent === null || percent === undefined) return null;
  const p = dec(percent);
  if (p.lt(20)) return 'GOOD';
  if (p.lte(25)) return 'ACCEPTABLE';
  return 'UNACCEPTABLE';
}
