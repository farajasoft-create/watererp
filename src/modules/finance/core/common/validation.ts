import { Types } from 'mongoose';
import { z, ZodType, ZodTypeDef } from 'zod';
import { BadRequestException } from './errors';
import { Decimal } from './money';

/** Validates input against a schema, turning failures into a 400 with per-field messages. */
export function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new BadRequestException(
    'Validation failed',
    result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

export const zId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Invalid id')
  .transform((v) => new Types.ObjectId(v));

/** ISO calendar date (YYYY-MM-DD), stored as UTC midnight. */
export const zDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), 'Invalid date');

/** Monetary or rate value. Accepts strings to avoid floating-point loss; numbers are tolerated. */
export const zDecimal = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'Expected a decimal number')
  .transform((v) => new Decimal(v));

export const zCurrency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'Expected an ISO 4217 currency code')
  .transform((v) => v.toUpperCase());

export const zBool = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

export function parseId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value) || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Invalid id');
  return new Types.ObjectId(value);
}

export function formatDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** A same-origin path to send the user to after signing in; anything else (//host, /\\host, URLs) becomes "/". */
export function safeNext(next: string | null | undefined): string {
  return next && /^\/(?![\/\\])[^\s]*$/.test(next) && !/[\\]/.test(next) ? next : '/';
}

/** Batches or serial numbers on a stock line. */
export const zLots = z
  .array(z.object({ number: z.string().trim().min(1).max(60), expiryDate: zDate.nullable().optional(), quantity: zDecimal }))
  .max(1000)
  .nullable()
  .optional();
