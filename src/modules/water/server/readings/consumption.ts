import { Decimal, dec, DecimalInput, round } from '@/platform/common/money';

export const READING_EXCEPTIONS = ['NONE', 'ZERO', 'HIGH', 'LOW', 'NEGATIVE', 'ROLLOVER', 'NO_ACCESS', 'METER_FAULTY', 'METER_TAMPERED'] as const;
export type ReadingException = (typeof READING_EXCEPTIONS)[number];

/** Exceptions a reader reports in the field instead of a value. */
export const FIELD_EXCEPTIONS = ['NO_ACCESS', 'METER_FAULTY', 'METER_TAMPERED'] as const;

export type ConsumptionResult = { ok: true; units: Decimal; rollover: boolean } | { ok: false; reason: 'NEGATIVE' };

/**
 * Units used between two register values. A lower value on a meter whose previous reading was in the
 * top fifth of its register is a rollover (the dials went past 9999… back to zero); otherwise it is a
 * negative reading that needs checking.
 */
export function consumption(previous: DecimalInput, current: DecimalInput, dials?: number | null): ConsumptionResult {
  const prev = dec(previous);
  const curr = dec(current);
  if (curr.gte(prev)) return { ok: true, units: curr.minus(prev), rollover: false };
  if (dials && dials > 0) {
    const max = new Decimal(10).pow(dials);
    if (prev.gte(max.times(0.8)) && curr.lt(max)) return { ok: true, units: max.minus(prev).plus(curr), rollover: true };
  }
  return { ok: false, reason: 'NEGATIVE' };
}

export interface ClassifyOptions {
  /** Consumption above this multiple of the average is HIGH. */
  highFactor?: number;
  /** Consumption below this fraction of the average is LOW. */
  lowFactor?: number;
  /** Below this average (m³) the high/low checks are skipped; small users swing a lot. */
  minAverage?: number;
}

/** Flags a reading for review by comparing it with the connection's recent average. */
export function classify(result: ConsumptionResult, average: DecimalInput | null, opts: ClassifyOptions = {}): ReadingException {
  if (!result.ok) return 'NEGATIVE';
  if (result.rollover) return 'ROLLOVER';
  if (result.units.isZero()) return 'ZERO';
  if (average === null || average === undefined) return 'NONE';
  const avg = dec(average);
  if (avg.lt(opts.minAverage ?? 2)) return 'NONE';
  if (result.units.gt(avg.times(opts.highFactor ?? 2))) return 'HIGH';
  if (result.units.lt(avg.times(opts.lowFactor ?? 0.3))) return 'LOW';
  return 'NONE';
}

/** Average monthly consumption of the latest actual readings (up to `take`), or null when there are none. */
export function averageConsumption(history: DecimalInput[], take = 3): Decimal | null {
  const recent = history.slice(0, take).map(dec);
  if (!recent.length) return null;
  return round(recent.reduce((s, u) => s.plus(u), new Decimal(0)).div(recent.length), 2);
}

/** Estimated units for a connection that could not be read: its average, else the category default. */
export function estimateUnits(history: DecimalInput[], categoryDefault: DecimalInput): Decimal {
  const avg = averageConsumption(history);
  return (avg ?? dec(categoryDefault)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}
