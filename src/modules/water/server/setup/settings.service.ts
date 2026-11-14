import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException } from '@/platform/common/errors';
import { Decimal, toD128 } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { WaterDb as Db, waterSettings } from '@/modules/water/server/db';
import { AccountMapping, MAPPING_LABELS } from '../accounting/journals';
import { DEFAULT_SLA_HOURS } from '../service-schemas';

export interface BillingInput {
  licenceArea?: string;
  billing: {
    dueDays: number;
    penaltyPercent: Decimal;
    reconnectionFee: Decimal;
    disconnectionMinArrears: Decimal;
    disconnectionGraceDays: number;
    highFactor: number;
    lowFactor: number;
    paybill?: string;
    billFooter?: string;
    sendBillSms: boolean;
    emailBills: boolean;
    sendReceipts: boolean;
  };
}

/** Water settings: billing rules, the M-Pesa paybill and which ledger accounts water posts to. */
export class WaterSettingsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async get(user: AuthUser) {
    const org = await this.db.organisations.findById(user.organisationId, { code: 1 }).lean();
    return { ...(await waterSettings(this.db, user.organisationId)), mappingLabels: MAPPING_LABELS, defaultSlaHours: DEFAULT_SLA_HOURS, organisationCode: org?.code };
  }

  async updateBilling(user: AuthUser, input: BillingInput) {
    const b = input.billing;
    await this.db.waterSettings.updateOne(
      { organisationId: user.organisationId },
      {
        licenceArea: input.licenceArea,
        billing: { ...b, penaltyPercent: toD128(b.penaltyPercent), reconnectionFee: toD128(b.reconnectionFee), disconnectionMinArrears: toD128(b.disconnectionMinArrears) },
      },
      { upsert: true },
    );
    await this.audit.record(user, 'water.settings.billing', 'organisation', user.organisationId);
    return this.get(user);
  }

  /** Issues the secret that goes into the C2B URLs registered with Safaricom. */
  async updateMpesa(user: AuthUser, input: { shortcode?: string; rotateToken?: boolean }) {
    const current = await waterSettings(this.db, user.organisationId);
    const callbackToken = input.rotateToken || !current.mpesa?.callbackToken ? randomBytes(24).toString('base64url') : current.mpesa.callbackToken;
    await this.db.waterSettings.updateOne({ organisationId: user.organisationId }, { mpesa: { shortcode: input.shortcode, callbackToken } });
    await this.audit.record(user, 'water.settings.mpesa', 'organisation', user.organisationId, { shortcode: input.shortcode, rotated: Boolean(input.rotateToken) });
    return this.get(user);
  }

  async updateAccounts(user: AuthUser, accounts: Partial<AccountMapping>) {
    const clean = Object.fromEntries(Object.entries(accounts).filter(([k, v]) => k in MAPPING_LABELS && typeof v === 'string' && /^[a-f\d]{24}$/i.test(v)));
    // Upsert: the mapping may be saved before anything else has created the settings document.
    await this.db.waterSettings.updateOne({ organisationId: user.organisationId }, { accounts: clean }, { upsert: true });
    await this.audit.record(user, 'water.settings.accounts', 'organisation', user.organisationId, clean);
    return this.get(user);
  }

  async updateService(user: AuthUser, input: { slaHours: Record<string, number>; portalEnabled: boolean; autoCloseDays: number; reminderAfterDays: number; routing?: { category: string | null; zoneId: Types.ObjectId | null; assignTo: Types.ObjectId }[] }) {
    if (input.routing?.some((r) => !r.category && !r.zoneId)) throw new BadRequestException('A routing rule needs a category, a zone or both');
    if (input.routing?.length && (await this.db.users.countDocuments({ organisationId: user.organisationId, _id: { $in: input.routing.map((r) => r.assignTo) }, active: true })) !== new Set(input.routing.map((r) => r.assignTo.toHexString())).size) throw new BadRequestException('Routing goes to active users only');
    await waterSettings(this.db, user.organisationId);
    await this.db.waterSettings.updateOne(
      { organisationId: user.organisationId },
      { 'service.slaHours': input.slaHours, 'service.portalEnabled': input.portalEnabled, 'service.autoCloseDays': input.autoCloseDays, 'service.reminderAfterDays': input.reminderAfterDays, ...(input.routing && { 'service.routing': input.routing }) },
    );
    await this.audit.record(user, 'water.settings.service', 'organisation', user.organisationId, input);
    return this.get(user);
  }

  async updateRegulatory(user: AuthUser, input: { populationInArea?: number | null; peoplePerConnection?: number; peoplePerKiosk?: number; staffCount?: number | null }) {
    await waterSettings(this.db, user.organisationId);
    await this.db.waterSettings.updateOne({ organisationId: user.organisationId }, { regulatory: input });
    await this.audit.record(user, 'water.settings.regulatory', 'organisation', user.organisationId, input);
    return this.get(user);
  }
}
