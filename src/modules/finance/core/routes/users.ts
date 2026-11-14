import bcrypt from 'bcryptjs';
import { ClientSession, Types } from 'mongoose';
import { z } from 'zod';
import { AuthUser } from '../common/auth';
import { BadRequestException, NotFoundException } from '../common/errors';
import { toD128 } from '../common/money';
import { ALL_PERMISSIONS, Permission, PERMISSION_DESCRIPTIONS, PERMISSIONS } from '../common/permissions';
import { parseId, zDecimal, zId } from '../common/validation';
import { Db } from '../database/db.service';
import { normalisePhone } from '../modules/payments/daraja';
import { route } from '../http/router';
import { PASSWORD_ROUNDS } from '../modules/provisioning/provisioning.service';
import { PasswordSchema } from './auth';

const UserBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  /** Leave out to send an invitation: the user chooses their own password from the email. */
  password: PasswordSchema.optional(),
  roleIds: z.array(zId).default([]),
  allBranches: z.boolean().default(true),
  branchIds: z.array(zId).default([]),
  approvalLimit: zDecimal.refine((d) => d.gte(0), 'Must not be negative').nullable().optional(),
  /** For expense reimbursements by M-Pesa. */
  phone: z
    .string()
    .trim()
    .max(20)
    .transform((v, ctx) => {
      if (!v) return '';
      const phone = normalisePhone(v);
      if (!phone) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a Safaricom number such as 0712 345 678' });
      return phone ?? '';
    })
    .optional(),
  isActive: z.boolean().optional(),
});
const UserUpdate = UserBody.omit({ email: true }).partial();

const RoleBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])),
});

const permissions = [PERMISSIONS.USERS_MANAGE];

async function assertRefs(db: Db, user: AuthUser, roleIds: Types.ObjectId[], branchIds: Types.ObjectId[]) {
  const [roles, branches] = await Promise.all([
    db.roles.countDocuments({ organisationId: user.organisationId, _id: { $in: roleIds } }),
    db.branches.countDocuments({ organisationId: user.organisationId, _id: { $in: branchIds } }),
  ]);
  if (roles !== new Set(roleIds.map(String)).size) throw new BadRequestException('Unknown role');
  if (branches !== new Set(branchIds.map(String)).size) throw new BadRequestException('Unknown branch');
}

/** Prevents the organisation from locking itself out of user administration. */
async function assertAdminRemains(db: Db, organisationId: Types.ObjectId, session: ClientSession) {
  const adminRoles = await db.roles.find({ organisationId, permissions: PERMISSIONS.USERS_MANAGE }, { _id: 1 }).session(session).lean();
  const admins = await db.users.countDocuments({ organisationId, isActive: true, roleIds: { $in: adminRoles.map((r) => r._id) } }).session(session);
  if (admins === 0) throw new BadRequestException('At least one active user must be able to manage users');
}

/** Inside the platform, people, sign-in and passwords belong to the platform. */
const platformMode = process.env.FINANCE_STANDALONE !== 'true';

export const usersRoutes = [
  route({ method: 'POST', path: '/users/:id/invite', status: 200, permissions, handler: ({ s, user, params }) => s.account.invite(user, parseId(params.id)) }),
  /** Clears a user's two-step verification (lost phone); they set it up again at next sign-in. */
  route({
    method: 'POST',
    path: '/users/:id/mfa/reset',
    status: 200,
    permissions,
    handler: async ({ s, user, params }) => {
      const target = await s.db.users.findOne({ _id: parseId(params.id), organisationId: user.organisationId, isServiceAccount: { $ne: true } }).lean();
      if (!target) throw new NotFoundException('User not found');
      await s.db.users.updateOne({ _id: target._id }, { mfa: { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null, lastUsedStep: null }, $inc: { tokenVersion: 1 } });
      await s.db.sessions.updateMany({ userId: target._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'Two-step verification reset by an administrator' });
      await s.audit.log(user, { action: 'user.mfa_reset', recordType: 'User', recordId: target._id, summary: `Reset two-step verification for ${target.email} and signed them out` });
      return { ok: true };
    },
  }),
  route({
    method: 'POST',
    path: '/users/:id/sessions/revoke',
    status: 200,
    permissions,
    handler: async ({ s, user, params }) => {
      const target = await s.db.users.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!target) throw new NotFoundException('User not found');
      await s.db.users.updateOne({ _id: target._id }, { $inc: { tokenVersion: 1 } });
      const res = await s.db.sessions.updateMany({ userId: target._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'Signed out by an administrator' });
      await s.audit.log(user, { action: 'user.sessions_revoke', recordType: 'User', recordId: target._id, summary: `Signed ${target.email} out of ${res.modifiedCount} session(s)` });
      return { revoked: res.modifiedCount };
    },
  }),

  route({
    method: 'GET',
    path: '/users',
    permissions,
    handler: async ({ s, user }) => {
      if (platformMode) {
        const { getPlatform } = await import('@/platform/container');
        const { syncFinanceUsers } = await import('../bridge');
        await syncFinanceUsers(await getPlatform(), s, user.organisationId);
      }
      return s.db.users.find({ organisationId: user.organisationId, isServiceAccount: { $ne: true } }, { passwordHash: 0, 'mfa.secret': 0, 'mfa.pendingSecret': 0, 'mfa.recoveryCodes': 0 }).sort({ name: 1 }).lean();
    },
  }),

  route({
    method: 'POST',
    path: '/users',
    permissions,
    body: UserBody,
    handler: async ({ s, user, body }) => {
      if (platformMode) throw new BadRequestException('Add people under Settings → Users & roles and give them a Finance role; they then appear here');
      await assertRefs(s.db, user, body.roleIds, body.branchIds);
      const { password, approvalLimit, ...rest } = body;
      const [created] = await s.db.users.create([
        {
          ...rest,
          organisationId: user.organisationId,
          passwordHash: password ? await bcrypt.hash(password, PASSWORD_ROUNDS) : '!invited',
          passwordSetAt: password ? new Date() : null,
          approvalLimit: approvalLimit ? toD128(approvalLimit) : null,
        },
      ]);
      const safe = { ...created.toObject(), passwordHash: undefined, mfa: undefined };
      await s.audit.log(user, { action: 'user.create', recordType: 'User', recordId: created._id, summary: `Created user ${created.email}${password ? '' : ' and sent an invitation'}`, after: safe });
      if (!password) await s.account.invite(user, created._id);
      return safe;
    },
  }),

  route({
    method: 'PATCH',
    path: '/users/:id',
    permissions,
    body: UserUpdate,
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.users.findOne({ _id: parseId(params.id), organisationId: user.organisationId }, { passwordHash: 0, 'mfa.secret': 0, 'mfa.pendingSecret': 0, 'mfa.recoveryCodes': 0 }).lean();
      if (!before) throw new NotFoundException('User not found');
      if (body.roleIds || body.branchIds) await assertRefs(s.db, user, body.roleIds ?? [], body.branchIds ?? []);
      if (before._id.equals(user.id) && body.isActive === false) throw new BadRequestException('You cannot deactivate yourself');
      if (platformMode && (body.password || body.name)) throw new BadRequestException('Names, emails and passwords are managed under Settings → Users & roles');
      const { password, approvalLimit, ...rest } = body;
      const update: Record<string, unknown> = { ...rest };
      if (approvalLimit !== undefined) update.approvalLimit = approvalLimit ? toD128(approvalLimit) : null;
      if (password) {
        update.passwordHash = await bcrypt.hash(password, PASSWORD_ROUNDS);
        update.$inc = { tokenVersion: 1 };
      }
      return s.db.transaction(async (session) => {
        const after = await s.db.users.findByIdAndUpdate(before._id, update, { new: true, session, projection: { passwordHash: 0, 'mfa.secret': 0, 'mfa.pendingSecret': 0, 'mfa.recoveryCodes': 0 } }).lean();
        await assertAdminRemains(s.db, user.organisationId, session);
        await s.audit.log(
          user,
          { action: 'user.update', recordType: 'User', recordId: before._id, summary: `Updated user ${before.email}${password ? ' (password reset)' : ''}`, before, after },
          session,
        );
        return after;
      });
    },
  }),

  route({
    method: 'GET',
    path: '/roles',
    permissions,
    handler: async ({ s, user }) => {
      const [roles, counts] = await Promise.all([
        s.db.roles.find({ organisationId: user.organisationId }).sort({ isSystem: -1, name: 1 }).lean(),
        s.db.users.aggregate<{ _id: Types.ObjectId; n: number }>([
          { $match: { organisationId: user.organisationId } },
          { $unwind: '$roleIds' },
          { $group: { _id: '$roleIds', n: { $sum: 1 } } },
        ]),
      ]);
      return roles.map((r) => ({ ...r, userCount: counts.find((c) => c._id.equals(r._id))?.n ?? 0 }));
    },
  }),

  route({
    method: 'GET',
    path: '/roles/permissions',
    permissions,
    handler: () => Object.entries(PERMISSION_DESCRIPTIONS).map(([key, description]) => ({ key, description })),
  }),

  route({
    method: 'POST',
    path: '/roles',
    permissions,
    body: RoleBody,
    handler: async ({ s, user, body }) => {
      const [role] = await s.db.roles.create([{ ...body, organisationId: user.organisationId }]);
      await s.audit.log(user, { action: 'role.create', recordType: 'Role', recordId: role._id, summary: `Created role ${role.name}`, after: role });
      return role;
    },
  }),

  route({
    method: 'PATCH',
    path: '/roles/:id',
    permissions,
    body: RoleBody.partial(),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.roles.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Role not found');
      if (before.isSystem && body.name && body.name !== before.name) throw new BadRequestException('System roles cannot be renamed');
      return s.db.transaction(async (session) => {
        const after = await s.db.roles.findByIdAndUpdate(before._id, body, { new: true, session }).lean();
        await assertAdminRemains(s.db, user.organisationId, session);
        await s.audit.log(user, { action: 'role.update', recordType: 'Role', recordId: before._id, summary: `Updated role ${before.name}`, before, after }, session);
        return after;
      });
    },
  }),

  route({
    method: 'DELETE',
    path: '/roles/:id',
    permissions,
    handler: async ({ s, user, params }) => {
      const role = await s.db.roles.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!role) throw new NotFoundException('Role not found');
      if (role.isSystem) throw new BadRequestException('System roles cannot be deleted');
      if (await s.db.users.exists({ organisationId: user.organisationId, roleIds: role._id })) {
        throw new BadRequestException('Remove the role from all users before deleting it');
      }
      await s.db.roles.deleteOne({ _id: role._id });
      await s.audit.log(user, { action: 'role.delete', recordType: 'Role', recordId: role._id, summary: `Deleted role ${role.name}`, before: role });
      return { id: role._id, deleted: true };
    },
  }),
];
