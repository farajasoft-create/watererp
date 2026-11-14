import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { PASSWORD_ROUNDS } from '../provisioning/provisioning.service';
import { appUrl, EmailService, layout } from './email.service';

const RESET_MINUTES = 30;
const INVITE_DAYS = 7;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Password reset and invitations by email, with single-use tokens stored only as hashes. */
export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  private async issue(userId: Types.ObjectId, organisationId: Types.ObjectId, purpose: 'password_reset' | 'invitation', ttlMs: number, meta: { createdBy?: Types.ObjectId | null; ip?: string | null }) {
    // Only the newest link works.
    await this.db.authTokens.updateMany({ userId, purpose, usedAt: null }, { usedAt: new Date() });
    const token = randomBytes(32).toString('base64url');
    await this.db.authTokens.create([{ organisationId, userId, purpose, tokenHash: hash(token), expiresAt: new Date(Date.now() + ttlMs), createdBy: meta.createdBy ?? null, ip: meta.ip ?? null }]);
    return token;
  }

  /**
   * Starts a password reset. The response is the same whether or not the address exists, so the form
   * cannot be used to discover accounts.
   */
  async forgot(emailAddress: string, ip: string | null) {
    const user = await this.db.users.findOne({ email: emailAddress.toLowerCase() }).lean();
    if (!user || !user.isActive || user.isServiceAccount) return;
    const recent = await this.db.authTokens.countDocuments({ userId: user._id, purpose: 'password_reset', createdAt: { $gte: new Date(Date.now() - 15 * 60_000) } });
    if (recent >= 3) return;
    const token = await this.issue(user._id, user.organisationId, 'password_reset', RESET_MINUTES * 60_000, { ip });
    const url = `${appUrl()}/reset-password?token=${token}`;
    const body = layout({
      title: 'Reset your password',
      intro: `Hello ${user.name},`,
      paragraphs: [`Someone asked to reset the password for ${user.email}. The link works once and expires in ${RESET_MINUTES} minutes.`, 'If this was not you, ignore this email; your password stays the same.'],
      action: { label: 'Choose a new password', url },
    });
    await this.email.enqueue({ organisationId: user.organisationId, to: [user.email], subject: 'Reset your FarajaSoft password', ...body, category: 'account', sensitive: true, related: { type: 'User', id: user._id } });
    await this.audit.log({ organisationId: user.organisationId, name: user.name }, { action: 'auth.password_reset_requested', recordType: 'User', recordId: user._id, summary: `Password reset requested for ${user.email}${ip ? ` from ${ip}` : ''}` });
  }

  /** Sends (or re-sends) an invitation to choose a password. */
  async invite(actor: AuthUser, userId: Types.ObjectId) {
    const user = await this.db.users.findOne({ _id: userId, organisationId: actor.organisationId, isServiceAccount: { $ne: true } }).lean();
    if (!user) throw new NotFoundException('User not found');
    if (user.passwordSetAt && !user.passwordHash.startsWith('!')) throw new BadRequestException(`${user.name} has already set a password; use a password reset instead`);
    const org = await this.db.organisations.findById(actor.organisationId, { name: 1 }).lean();
    const token = await this.issue(user._id, user.organisationId, 'invitation', INVITE_DAYS * 86_400_000, { createdBy: actor.id });
    const body = layout({
      title: `Join ${org?.name ?? 'your organisation'} on FarajaSoft`,
      intro: `Hello ${user.name},`,
      paragraphs: [`${actor.name} has invited you to ${org?.name ?? 'their organisation'}'s accounting system. Choose a password to get started; the link expires in ${INVITE_DAYS} days.`, `You will sign in with ${user.email}.`],
      action: { label: 'Accept the invitation', url: `${appUrl()}/reset-password?token=${token}` },
    });
    await this.email.enqueue({ organisationId: user.organisationId, to: [user.email], replyTo: actor.email, subject: `${actor.name} invited you to FarajaSoft`, ...body, category: 'account', sensitive: true, related: { type: 'User', id: user._id } });
    await this.db.users.updateOne({ _id: user._id }, { invitedAt: new Date() });
    await this.audit.log(actor, { action: 'user.invite', recordType: 'User', recordId: user._id, summary: `Sent an invitation to ${user.email}` });
    return { invited: true };
  }

  private async valid(token: string) {
    const t = await this.db.authTokens.findOne({ tokenHash: hash(token) }).lean();
    if (!t || t.usedAt || t.expiresAt < new Date()) throw new BadRequestException('This link has expired or was already used. Ask for a new one.');
    const user = await this.db.users.findOne({ _id: t.userId, organisationId: t.organisationId }).lean();
    if (!user || !user.isActive) throw new BadRequestException('This account is no longer active');
    return { t, user };
  }

  /** What the reset / invitation page shows before the user chooses a password. */
  async tokenInfo(token: string) {
    const { t, user } = await this.valid(token);
    const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
    return { purpose: t.purpose, name: user.name, email: user.email, organisation: org?.name ?? '', expiresAt: t.expiresAt };
  }

  /** Sets the password from a link: every other session is signed out and any lockout cleared. */
  async complete(token: string, password: string, ip: string | null) {
    const { t, user } = await this.valid(token);
    const claimed = await this.db.authTokens.updateOne({ _id: t._id, usedAt: null }, { usedAt: new Date() });
    if (!claimed.modifiedCount) throw new BadRequestException('This link was already used');
    const now = new Date();
    await this.db.users.updateOne(
      { _id: user._id },
      { passwordHash: await bcrypt.hash(password, PASSWORD_ROUNDS), passwordSetAt: now, failedLogins: 0, lockedUntil: null, $inc: { tokenVersion: 1 } },
    );
    await this.db.sessions.updateMany({ userId: user._id, revokedAt: null }, { revokedAt: now, revokedReason: t.purpose === 'invitation' ? 'Invitation accepted' : 'Password reset' });
    await this.audit.log(
      { organisationId: user.organisationId, name: user.name },
      { action: t.purpose === 'invitation' ? 'user.invitation_accepted' : 'auth.password_reset', recordType: 'User', recordId: user._id, summary: `${user.email} ${t.purpose === 'invitation' ? 'accepted the invitation' : 'reset their password'}${ip ? ` from ${ip}` : ''}` },
    );
    if (t.purpose === 'password_reset') {
      const body = layout({ title: 'Your password was changed', intro: `Hello ${user.name},`, paragraphs: ['The password for your FarajaSoft account was just changed, and all other sessions were signed out.', 'If this was not you, contact your administrator at once.'] });
      await this.email.enqueue({ organisationId: user.organisationId, to: [user.email], subject: 'Your FarajaSoft password was changed', ...body, category: 'account' });
    }
    return { email: user.email };
  }
}
