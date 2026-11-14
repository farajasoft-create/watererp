import { Types } from 'mongoose';
import { AuthUser } from '../auth';
import { Db } from '../db';
import { EmailService } from './email.service';

/** In-app notifications (the bell), optionally copied by email. */
export class NotificationsService {
  constructor(
    private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async notify(organisationId: Types.ObjectId, userIds: Types.ObjectId[], n: { title: string; body?: string; link?: string; module?: string; email?: boolean }) {
    const unique = [...new Map(userIds.filter(Boolean).map((id) => [id.toHexString(), id])).values()];
    if (!unique.length) return 0;
    await this.db.notifications.insertMany(unique.map((userId) => ({ organisationId, userId, title: n.title, body: n.body, link: n.link, module: n.module })));
    if (n.email) {
      const users = await this.db.users.find({ _id: { $in: unique }, active: true }, { email: 1 }).lean();
      for (const u of users) await this.email.queue(organisationId, u.email, n.title, `${n.body ?? ''}${n.link ? `\n\nOpen: ${n.link}` : ''}`.trim(), 'core:notification');
      await this.email.deliverDue(organisationId);
    }
    return unique.length;
  }

  async list(user: AuthUser, unreadOnly = false) {
    const [items, unread] = await Promise.all([
      this.db.notifications
        .find({ userId: user.id, ...(unreadOnly && { readAt: null }) })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      this.db.notifications.countDocuments({ userId: user.id, readAt: null }),
    ]);
    return { items, unread };
  }

  async markRead(user: AuthUser, ids?: Types.ObjectId[]) {
    await this.db.notifications.updateMany({ userId: user.id, readAt: null, ...(ids?.length && { _id: { $in: ids } }) }, { readAt: new Date() });
    return { ok: true };
  }
}
