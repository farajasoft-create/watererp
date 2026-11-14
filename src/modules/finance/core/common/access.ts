import { ForbiddenException } from './errors';
import { Types } from 'mongoose';
import { AuthUser } from './auth';

/** Branch ids the user is restricted to, or null when the user may access every branch. */
export function allowedBranches(user: AuthUser): Types.ObjectId[] | null {
  return user.allBranches ? null : user.branchIds;
}

export function canAccessBranch(user: AuthUser, branchId: Types.ObjectId | string): boolean {
  if (user.allBranches) return true;
  return user.branchIds.some((b) => b.equals(branchId));
}

export function assertBranchAccess(user: AuthUser, branchIds: (Types.ObjectId | string)[]): void {
  const denied = branchIds.filter((b) => !canAccessBranch(user, b));
  if (denied.length) throw new ForbiddenException('You do not have access to one or more branches on this transaction');
}
