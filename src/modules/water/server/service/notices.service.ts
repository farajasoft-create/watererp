import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException } from '@/platform/common/errors';
import { AuditService } from '@/platform/services/audit.service';
import { SmsService } from '@/platform/services/sms.service';
import { WaterDb as Db } from '../db';
import { NOTICE_TYPES } from '../service-schemas';

/** Planned interruptions, rationing timetables and other notices, texted to the customers of the zones affected. */
export class NoticesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
  ) {}

  list(user: AuthUser) {
    return this.db.notices.find({ organisationId: user.organisationId }).sort({ createdAt: -1 }).limit(100).lean();
  }

  /** Published notices still running (or with no end), newest first, for the portal and USSD. */
  current(organisationId: Types.ObjectId, zoneId?: Types.ObjectId | null) {
    const now = new Date();
    return this.db.notices
      .find({
        organisationId,
        publish: true,
        $and: [{ $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }, zoneId ? { $or: [{ zoneIds: { $size: 0 } }, { zoneIds: zoneId }] } : {}],
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
  }

  async create(user: AuthUser, input: { type: (typeof NOTICE_TYPES)[number]; title: string; message: string; zoneIds: Types.ObjectId[]; startsAt?: Date | null; endsAt?: Date | null; sendSms: boolean; publish: boolean }) {
    if (input.endsAt && input.startsAt && input.endsAt < input.startsAt) throw new BadRequestException('The notice ends before it starts');
    const [notice] = await this.db.notices.create([{ ...input, organisationId: user.organisationId, createdBy: user.id }]);
    let sent = 0;
    if (input.sendSms) {
      const org = await this.db.organisations.findById(user.organisationId, { name: 1 }).lean();
      const customers = await this.db.customers.find({ organisationId: user.organisationId, status: 'ACTIVE', phone: { $nin: [null, ''] }, ...(input.zoneIds.length && { zoneId: { $in: input.zoneIds } }) }, { phone: 1 }).lean();
      const phones = [...new Set(customers.map((c) => c.phone!))];
      for (const phone of phones) if (await this.sms.queue(user.organisationId, phone, `${org?.name ?? 'Water'}: ${input.message}`, `water:notice-${input.type.toLowerCase()}`, notice._id)) sent++;
      await this.db.notices.updateOne({ _id: notice._id }, { sentCount: sent });
      await this.sms.deliverDue(user.organisationId, 1000);
    }
    await this.audit.record(user, 'water.notice.create', 'notice', notice._id, { type: input.type, zones: input.zoneIds.length, sent });
    return { ...notice.toObject(), sentCount: sent };
  }
}
