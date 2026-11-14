import { z } from 'zod';

/** The body Safaricom posts to the C2B validation and confirmation URLs (Daraja v2). */
export const C2BPayload = z.object({
  TransactionType: z.string().optional(),
  TransID: z.string().min(1),
  TransTime: z.string().regex(/^\d{14}$/),
  TransAmount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  BusinessShortCode: z.union([z.string(), z.number()]).transform((v) => String(v)),
  BillRefNumber: z.string().optional().default(''),
  InvoiceNumber: z.string().optional(),
  OrgAccountBalance: z.union([z.string(), z.number()]).optional(),
  ThirdPartyTransID: z.string().optional(),
  MSISDN: z.union([z.string(), z.number()]).optional().transform((v) => (v === undefined ? undefined : String(v))),
  FirstName: z.string().optional(),
  MiddleName: z.string().optional(),
  LastName: z.string().optional(),
});
export type C2BPayload = z.infer<typeof C2BPayload>;

/** TransTime is East Africa Time (UTC+3), formatted yyyyMMddHHmmss. */
export function parseTransTime(value: string): Date {
  const [y, mo, d, h, mi, s] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8), value.slice(8, 10), value.slice(10, 12), value.slice(12, 14)];
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+03:00`);
}

/**
 * Customers type account numbers loosely at the paybill prompt ("kam 42", "KAM00042", "kam-042").
 * Returns the forms to look up, the exact account number first.
 */
export function accountCandidates(ref: string): string[] {
  const clean = ref.trim().toUpperCase().replace(/\s+/g, '');
  const out = new Set<string>();
  if (clean) out.add(clean);
  const m = /^([A-Z]+)-?0*(\d+)$/.exec(clean);
  if (m) out.add(`${m[1]}-${m[2].padStart(5, '0')}`);
  return [...out];
}

export function payerName(p: Pick<C2BPayload, 'FirstName' | 'MiddleName' | 'LastName'>): string | undefined {
  const name = [p.FirstName, p.MiddleName, p.LastName].filter(Boolean).join(' ').trim();
  return name || undefined;
}

export const C2B_ACCEPT = { ResultCode: '0', ResultDesc: 'Accepted' };
/** Safaricom's code for an invalid account number; the customer is told and the money is not taken. */
export const C2B_REJECT_ACCOUNT = { ResultCode: 'C2B00012', ResultDesc: 'Rejected: unknown account number' };
