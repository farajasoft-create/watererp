import { Types } from 'mongoose';
import { AuthUser } from '../auth';
import { BadRequestException } from '../common/errors';
import { Db } from '../db';
import { AuditService } from './audit.service';

/** Where personal data lives: each collection, what it is, which fields identify the person and what to show. */
const REGISTRY: { collection: string; label: string; email?: string; phone?: string; id?: string; pin?: string; show: string[] }[] = [
  { collection: 'users', label: 'System user account', email: 'email', phone: 'phone', show: ['name', 'email'] },
  { collection: 'water_customers', label: 'Water customer', email: 'email', phone: 'phone', id: 'idNumber', pin: 'kraPin', show: ['accountNo', 'name'] },
  { collection: 'hr_employees', label: 'Employee record', email: 'email', phone: 'phone', id: 'nationalId', pin: 'kraPin', show: ['employeeNo', 'firstName', 'lastName'] },
  { collection: 'hr_applicants', label: 'Job applicant account', email: 'email', phone: 'phone', id: 'nationalId', show: ['name', 'email'] },
  { collection: 'hr_applications', label: 'Job application', email: 'email', phone: 'phone', id: 'nationalId', show: ['reference', 'name'] },
  { collection: 'estates_tenants', label: 'Tenant', email: 'email', phone: 'phone', id: 'idNumber', pin: 'kraPin', show: ['name'] },
  { collection: 'portals_msmes', label: 'MSME listing', email: 'email', phone: 'phone', pin: 'kraPin', show: ['reference', 'businessName', 'ownerName'] },
  { collection: 'tenders_bids', label: 'Tender bid', email: 'bidder.email', phone: 'bidder.phone', pin: 'bidder.kraPin', show: ['number', 'bidder.name'] },
  { collection: 'finance_customers', label: 'Finance customer', email: 'email', phone: 'phone', pin: 'taxId', show: ['code', 'name'] },
  { collection: 'finance_suppliers', label: 'Supplier', email: 'email', phone: 'phone', pin: 'taxId', show: ['code', 'name'] },
];

const get = (doc: Record<string, unknown>, path: string) => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), doc);
/** The ways a Kenyan number is written: 0722…, 722…, +254722…, 254722…. */
function phoneForms(raw: string) {
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('254') ? digits.slice(3) : digits.replace(/^0/, '');
  return local.length >= 9 ? [`0${local}`, local, `+254${local}`, `254${local}`] : [raw];
}

/**
 * Data subject requests under the Data Protection Act, 2019 (s.26): finds every record the organisation
 * holds about a person, by email, phone, ID number or KRA PIN, across all modules, and exports it.
 * Each search is written to the audit trail with who searched and why.
 */
export class PrivacyService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async search(user: AuthUser, q: { email?: string; phone?: string; idNumber?: string; kraPin?: string; reason: string }) {
    if (!q.email && !q.phone && !q.idNumber && !q.kraPin) throw new BadRequestException('Give an email, phone, ID number or KRA PIN');
    const conn = this.db.connection;
    const existing = new Set((await conn.db!.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    const results: { collection: string; label: string; id: Types.ObjectId; summary: string; matchedOn: string[]; record: Record<string, unknown> }[] = [];
    for (const r of REGISTRY) {
      if (!existing.has(r.collection)) continue;
      const or: Record<string, unknown>[] = [];
      if (q.email && r.email) or.push({ [r.email]: new RegExp(`^${q.email.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      if (q.phone && r.phone) or.push({ [r.phone]: { $in: phoneForms(q.phone) } });
      if (q.idNumber && r.id) or.push({ [r.id]: q.idNumber.trim() });
      if (q.kraPin && r.pin) or.push({ [r.pin]: q.kraPin.trim().toUpperCase() });
      if (!or.length) continue;
      const docs = await conn.collection(r.collection).find({ organisationId: user.organisationId, $or: or }, { projection: { passwordHash: 0, tokenHash: 0, portalTokenHash: 0, twoFactor: 0, apiKeys: 0 } }).limit(200).toArray();
      for (const d of docs) {
        const matchedOn = [
          q.email && r.email && String(get(d, r.email) ?? '').toLowerCase() === q.email.trim().toLowerCase() ? 'email' : null,
          q.phone && r.phone && phoneForms(q.phone).includes(String(get(d, r.phone) ?? '')) ? 'phone' : null,
          q.idNumber && r.id && get(d, r.id) === q.idNumber.trim() ? 'ID number' : null,
          q.kraPin && r.pin && get(d, r.pin) === q.kraPin.trim().toUpperCase() ? 'KRA PIN' : null,
        ].filter(Boolean) as string[];
        results.push({ collection: r.collection, label: r.label, id: d._id as Types.ObjectId, summary: r.show.map((f) => get(d, f)).filter(Boolean).join(' · '), matchedOn, record: d });
      }
    }
    await this.audit.record(user, 'privacy.subject-search', 'organisation', user.organisationId, { email: q.email, phone: q.phone, idNumber: q.idNumber, kraPin: q.kraPin, reason: q.reason, found: results.length });
    return { searchedAt: new Date(), reason: q.reason, collections: REGISTRY.filter((r) => existing.has(r.collection)).map((r) => r.label), results };
  }
}
