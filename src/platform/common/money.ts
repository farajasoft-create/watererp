import Decimal from 'decimal.js';
import { Types } from 'mongoose';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export type DecimalInput = Decimal | Types.Decimal128 | string | number | null | undefined;

/** Converts any stored or user-supplied amount into an exact Decimal. Missing values are zero. */
export function dec(value: DecimalInput): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  if (Decimal.isDecimal(value)) return value as Decimal;
  return new Decimal(value.toString());
}

/** Rounds half-up to the given number of decimal places (the currency's minor-unit precision). */
export function round(value: DecimalInput, places: number): Decimal {
  return dec(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}

export function toD128(value: DecimalInput): Types.Decimal128 {
  return Types.Decimal128.fromString(dec(value).toFixed());
}

export function sum(values: DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}
