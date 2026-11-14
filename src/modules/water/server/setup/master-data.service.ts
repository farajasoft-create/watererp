import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { Decimal, toD128 } from '@/platform/common/money';
import { WaterDb as Db } from '@/modules/water/server/db';
import { CUSTOMER_CATEGORIES } from '@/modules/water/server/schemas';
import { AuditService } from '@/platform/services/audit.service';
import { tariffProblems } from '../billing/tariff';

export interface ZoneInput {
  code: string;
  name: string;
  type: 'ZONE' | 'DMA';
  parentId?: Types.ObjectId | null;
  active?: boolean;
}

export interface TariffInput {
  code: string;
  name: string;
  category: (typeof CUSTOMER_CATEGORIES)[number];
  effectiveFrom: Date;
  approvalReference?: string;
  blocks: { upTo: Decimal | null; rate: Decimal; fixedAmount?: Decimal | null }[];
  meterRent: Decimal;
  sewerPercent: Decimal;
  minimumCharge: Decimal;
  defaultEstimate: Decimal;
  active?: boolean;
}

/** Zones / DMAs and tariffs. */
export class MasterDataService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listZones(user: AuthUser) {
    return this.db.zones.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean();
  }

  async saveZone(user: AuthUser, id: Types.ObjectId | null, input: ZoneInput) {
    if (input.parentId) {
      if (id && input.parentId.equals(id)) throw new BadRequestException('A zone cannot be its own parent');
      if (!(await this.db.zones.exists({ _id: input.parentId, organisationId: user.organisationId }))) throw new BadRequestException('Unknown parent zone');
    }
    const data = { ...input, code: input.code.toUpperCase() };
    const zone = id
      ? await this.db.zones.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, data, { new: true })
      : (await this.db.zones.create([{ ...data, organisationId: user.organisationId }]))[0];
    if (!zone) throw new NotFoundException('Zone not found');
    await this.audit.record(user, id ? 'zone.update' : 'zone.create', 'zone', zone._id, data);
    return zone;
  }

  listTariffs(user: AuthUser) {
    return this.db.tariffs.find({ organisationId: user.organisationId }).sort({ category: 1, code: 1 }).lean();
  }

  async getTariff(user: AuthUser, id: Types.ObjectId) {
    const tariff = await this.db.tariffs.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!tariff) throw new NotFoundException('Tariff not found');
    return tariff;
  }

  async saveTariff(user: AuthUser, id: Types.ObjectId | null, input: TariffInput) {
    const problems = tariffProblems(input);
    if (problems.length) throw new BadRequestException('The tariff is not valid', problems.map((message) => ({ path: 'blocks', message })));
    const data = {
      ...input,
      code: input.code.toUpperCase(),
      blocks: input.blocks.map((b) => ({ upTo: b.upTo === null ? null : toD128(b.upTo), rate: toD128(b.rate), fixedAmount: b.fixedAmount ? toD128(b.fixedAmount) : null })),
      meterRent: toD128(input.meterRent),
      sewerPercent: toD128(input.sewerPercent),
      minimumCharge: toD128(input.minimumCharge),
      defaultEstimate: toD128(input.defaultEstimate),
    };
    const tariff = id
      ? await this.db.tariffs.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, data, { new: true })
      : (await this.db.tariffs.create([{ ...data, organisationId: user.organisationId }]))[0];
    if (!tariff) throw new NotFoundException('Tariff not found');
    await this.audit.record(user, id ? 'tariff.update' : 'tariff.create', 'tariff', tariff._id, { code: data.code });
    return tariff;
  }
}
