import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '@/platform/auth';
import { ForbiddenException, NotFoundException } from '@/platform/common/errors';
import { PERMISSIONS as P } from '../manifest';

export const can = (user: AuthUser, permission: string) => hasPermission(user, permission);
export const isManager = (user: AuthUser) => can(user, P.MANAGE) || can(user, P.REPORT_APPROVE);

type EngagementAccess = { leadId: Types.ObjectId; team?: Types.ObjectId[] | null; restricted?: boolean | null };

export const onTeam = (user: AuthUser, e: EngagementAccess) => e.leadId.equals(user.id) || (e.team ?? []).some((t) => t.equals(user.id));

/**
 * Who sees an engagement: audit managers and the head always; its team; other audit staff only when it
 * is not restricted (investigations are).
 */
export function assertCanSee(user: AuthUser, e: EngagementAccess) {
  if (isManager(user) || onTeam(user, e)) return;
  if (!e.restricted && can(user, P.VIEW)) return;
  throw new NotFoundException('Engagement not found');
}

/** Working papers, findings and time are for the team and managers only. */
export function assertCanWork(user: AuthUser, e: EngagementAccess) {
  if (isManager(user)) return;
  if (can(user, P.WORK) && onTeam(user, e)) return;
  throw new ForbiddenException('Only the engagement team and audit managers can do that');
}

/** A filter for the engagements the user may list. */
export function engagementFilter(user: AuthUser): Record<string, unknown> {
  if (isManager(user)) return {};
  return { $or: [{ restricted: { $ne: true } }, { leadId: user.id }, { team: user.id }] };
}
