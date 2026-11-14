/**
 * Exact decimal helpers for display. Amounts arrive from the API as strings and are never
 * converted to floating point. Values are scaled to 10^SCALE as BigInt for client-side totals.
 */
const SCALE = 6;
const FACTOR = BigInt(10) ** BigInt(SCALE);

export function toUnits(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return BigInt(0);
  const s = String(value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '-' || s === '.') return BigInt(0);
  const neg = s.startsWith('-');
  const [int = '0', frac = ''] = s.replace('-', '').split('.');
  const units = BigInt(int || '0') * FACTOR + BigInt((frac + '0'.repeat(SCALE)).slice(0, SCALE) || '0');
  return neg ? -units : units;
}

export function fromUnits(units: bigint): string {
  const neg = units < BigInt(0);
  const abs = neg ? -units : units;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export function addAll(values: (string | null | undefined)[]): string {
  return fromUnits(values.reduce((acc, v) => acc + toUnits(v), BigInt(0)));
}

export function isZero(value: string | null | undefined): boolean {
  return toUnits(value) === BigInt(0);
}

export function compare(a: string, b: string): number {
  const d = toUnits(a) - toUnits(b);
  return d === BigInt(0) ? 0 : d > BigInt(0) ? 1 : -1;
}

/** Formats a decimal string with grouping and fixed places, rounding half-up. */
export function formatAmount(
  value: string | null | undefined,
  places = 2,
  opts: { parens?: boolean; blankZero?: boolean } = {},
): string {
  let units = toUnits(value);
  if (opts.blankZero && units === BigInt(0)) return '';
  const neg = units < BigInt(0);
  if (neg) units = -units;
  const step = BigInt(10) ** BigInt(SCALE - places);
  const rounded = (units + step / BigInt(2)) / step;
  const div = BigInt(10) ** BigInt(places);
  const int = (rounded / div).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = places > 0 ? `.${(rounded % div).toString().padStart(places, '0')}` : '';
  const body = `${int}${frac}`;
  if (!neg || rounded === BigInt(0)) return body;
  return opts.parens ? `(${body})` : `-${body}`;
}

/** Compact form for KPI tiles, e.g. 57.1M. */
export function formatCompact(value: string | null | undefined): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => isoDate(new Date());

export function startOfMonth(date = new Date()): string {
  return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

export function startOfYear(date = new Date()): string {
  return `${date.getUTCFullYear()}-01-01`;
}

/** Exact product of two decimal strings (truncated to 6 places), for client-side previews. */
export function multiply(a: string | null | undefined, b: string | null | undefined): string {
  return fromUnits((toUnits(a) * toUnits(b)) / FACTOR);
}

/** Exact quotient of two decimal strings, truncated to 6 places (client-side previews only). */
export function divide(a: string | null | undefined, b: string | null | undefined): string {
  const d = toUnits(b);
  if (d === BigInt(0)) return '0';
  return fromUnits((toUnits(a) * FACTOR) / d);
}

/** Days from today until an ISO date (negative when in the past). */
export function daysUntil(iso: string): number {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((new Date(iso).getTime() - today) / 86_400_000);
}

/** Rounds half-up to the given places and returns a plain decimal string. */
export function roundTo(value: string, places: number): string {
  const units = toUnits(value);
  const step = BigInt(10) ** BigInt(SCALE - places);
  const half = step / BigInt(2);
  const rounded = units < BigInt(0) ? -((-units + half) / step) : (units + half) / step;
  return fromUnits(rounded * step);
}
