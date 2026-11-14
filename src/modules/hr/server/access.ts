import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { ForbiddenException } from '@/platform/common/errors';
import { PERMISSIONS as P } from '../manifest';

/** Departments the user is limited to in HR; empty means every department. */
export const departmentScope = (user: AuthUser): Types.ObjectId[] => user.access.hr?.scope ?? [];

/** A filter limiting employees (or their leave) to the user's departments. */
export function scopeFilter(user: AuthUser): Record<string, unknown> {
  const scope = departmentScope(user);
  return scope.length ? { departmentId: { $in: scope } } : {};
}

export function assertInScope(user: AuthUser, departmentId: Types.ObjectId | null | undefined) {
  const scope = departmentScope(user);
  if (scope.length && !(departmentId && scope.some((d) => d.equals(departmentId)))) throw new ForbiddenException('That employee is outside your departments');
}

export const canSeePay = (user: AuthUser) => hasPermission(user, P.SALARY_VIEW);

/** Drops pay details from an employee for users without salary access. */
export function redact<T extends Record<string, unknown>>(user: AuthUser, employee: T): T {
  if (canSeePay(user)) return employee;
  const copy: Record<string, unknown> = { ...employee };
  for (const field of PAY_FIELDS) delete copy[field];
  return copy as T;
}

const PAY_FIELDS = ['basicSalary', 'rate', 'bank', 'mpesaPhone', 'exempt', 'gratuityRate'];
