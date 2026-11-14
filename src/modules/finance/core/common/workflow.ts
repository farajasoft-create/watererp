import { BadRequestException, ForbiddenException } from './errors';
import { ClientSession, Model, Types } from 'mongoose';
import { AuthUser } from './auth';
import { Decimal, dec } from './money';

interface Prepared {
  createdBy: Types.ObjectId;
  submittedBy?: Types.ObjectId | null;
}

/** Maker-checker: whoever prepared or submitted a record may not approve it. */
export function assertSegregation(user: AuthUser, record: Prepared, what: string) {
  if (record.createdBy.equals(user.id) || record.submittedBy?.equals(user.id)) {
    throw new ForbiddenException(`Segregation of duties: you cannot approve ${what} you prepared or submitted`);
  }
}

/** Delegated authority: the value (functional currency) must not exceed the user's approval limit. */
export function assertApprovalLimit(user: AuthUser, value: Decimal, currency: string, what: string) {
  if (user.approvalLimit !== null && value.gt(dec(user.approvalLimit))) {
    throw new ForbiddenException(
      `${what} value ${value.toFixed()} ${currency} exceeds your approval limit of ${user.approvalLimit}`,
    );
  }
}

/** The plain (lean) document type of a model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeanOf<M> = M extends Model<infer T, any, any, any, any, any> ? T : never;

/**
 * Moves a record between statuses only if nobody changed it first (optimistic concurrency), so two
 * approvers acting at once can never both succeed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any model; the lean document type is inferred below
export async function transition<M extends Model<any>>(
  model: M,
  id: Types.ObjectId,
  from: string[],
  update: Record<string, unknown>,
  session?: ClientSession,
): Promise<LeanOf<M>> {
  const after = await model.findOneAndUpdate({ _id: id, status: { $in: from } }, update, { new: true, session }).lean();
  if (!after) throw new BadRequestException('The record was changed by someone else; reload and try again');
  return after as LeanOf<M>;
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
