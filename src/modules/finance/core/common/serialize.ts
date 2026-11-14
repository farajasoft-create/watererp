import { Types } from 'mongoose';
import { Decimal } from './money';

const SECRET_KEYS = new Set(['passwordHash', 'tokenVersion']);

/**
 * Normalises every API response: `_id` becomes `id`, ObjectIds become strings, Decimal128/Decimal
 * become exact decimal strings (never floats), and secrets are stripped.
 */
export function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Types.Decimal128) return value.toString();
  // isDecimal also recognises instances from a second copy of decimal.js (bundlers can load it twice).
  if (Decimal.isDecimal(value)) return (value as Decimal).toFixed();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown> & { toObject?: () => Record<string, unknown> };
    const source = typeof obj.toObject === 'function' ? obj.toObject() : obj;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(source)) {
      if (SECRET_KEYS.has(key)) continue;
      out[key === '_id' ? 'id' : key] = serialize(v);
    }
    return out;
  }
  return value;
}
