import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec } from '../../common/money';
import { PERMISSIONS } from '../../common/permissions';
import { Party, SUPPLIER_COMPLIANCE_TYPES, SUPPLIER_STATUSES } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';

type Status = (typeof SUPPLIER_STATUSES)[number];
const DAY = 86_400_000;

/**
 * What a supplier in each status may still do. New business (orders, RFQs) needs an approved, active
 * supplier; bills and payments for work already done still go through for a suspended or blacklisted
 * supplier, but never for one that was not approved.
 */
export function assertSupplierUsable(supplier: Pick<Party, 'name' | 'isActive'> & { status?: string | null; statusReason?: string | null }, purpose: 'ORDER' | 'BILL' | 'PAY') {
  if (!supplier.isActive) throw new BadRequestException(`${supplier.name} is inactive`);
  const status = (supplier.status ?? 'ACTIVE') as Status;
  if (status === 'ACTIVE') return;
  if (status === 'PENDING') throw new BadRequestException(`${supplier.name} is awaiting onboarding approval`);
  if (status === 'REJECTED') throw new BadRequestException(`${supplier.name} was not approved as a supplier`);
  if (purpose === 'ORDER') throw new BadRequestException(`${supplier.name} is ${status.toLowerCase()}${supplier.statusReason ? `: ${supplier.statusReason}` : ''}`);
}

export interface CategoryInput {
  code: string;
  name: string;
  description?: string;
  expenseAccountId?: Types.ObjectId | null;
  isActive?: boolean;
}

export interface ComplianceDoc {
  type: (typeof SUPPLIER_COMPLIANCE_TYPES)[number];
  number: string;
  issuedOn?: Date | null;
  expiresOn?: Date | null;
  note?: string;
}

export interface RatingInput {
  purchaseOrderId?: Types.ObjectId | null;
  date: Date;
  quality: number;
  delivery: number;
  price: number;
  service: number;
  comment?: string;
}

/**
 * The supplier side of procurement: categories tied to ledger accounts, onboarding approval, status
 * flags (suspension and blacklisting), compliance documents with expiry, and performance ratings with
 * on-time delivery worked out from orders and goods received.
 */
export class SupplierManagementService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async supplier(user: AuthUser, id: Types.ObjectId) {
    const s = await this.db.suppliers.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!s) throw new NotFoundException('Supplier not found');
    return s;
  }

  private requireApprover(user: AuthUser) {
    if (!hasPermission(user, PERMISSIONS.PROCUREMENT_APPROVE)) throw new ForbiddenException('Missing permission: procurement.approve');
  }

  // ----- Categories ---------------------------------------------------------------------------

  categories(user: AuthUser) {
    return this.db.supplierCategories.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean();
  }

  async saveCategory(user: AuthUser, id: Types.ObjectId | null, input: Partial<CategoryInput>) {
    if (input.expenseAccountId) {
      const a = await this.db.accounts.findOne({ _id: input.expenseAccountId, organisationId: user.organisationId }).lean();
      if (!a?.isActive || !a.isPostable || a.isControl) throw new BadRequestException('Choose an active, postable account that is not a control account');
      if (!['EXPENSE', 'ASSET'].includes(a.accountClass)) throw new BadRequestException(`${a.code} is not an expense or asset account`);
    }
    const doc = { ...input, ...(input.code && { code: input.code.toUpperCase() }) };
    if (!id) {
      if (await this.db.supplierCategories.exists({ organisationId: user.organisationId, code: doc.code })) throw new BadRequestException(`Category ${doc.code} already exists`);
      const [c] = await this.db.supplierCategories.create([{ ...doc, organisationId: user.organisationId }]);
      await this.audit.log(user, { action: 'supplier_category.create', recordType: 'SupplierCategory', recordId: c._id, summary: `Created supplier category ${c.code} · ${c.name}` });
      return c.toObject();
    }
    const before = await this.db.supplierCategories.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!before) throw new NotFoundException('Category not found');
    if (doc.code && doc.code !== before.code && (await this.db.supplierCategories.exists({ organisationId: user.organisationId, code: doc.code }))) throw new BadRequestException(`Category ${doc.code} already exists`);
    const after = await this.db.supplierCategories.findByIdAndUpdate(id, doc, { new: true }).lean();
    await this.audit.log(user, { action: 'supplier_category.update', recordType: 'SupplierCategory', recordId: id, summary: `Updated supplier category ${before.code}`, before, after });
    return after;
  }

  /** Checks category ids on a supplier and returns the account a new bill line should default to. */
  async categoryAccount(organisationId: Types.ObjectId, categoryIds: Types.ObjectId[]) {
    if (!categoryIds.length) return null;
    const found = await this.db.supplierCategories.find({ _id: { $in: categoryIds }, organisationId }).lean();
    if (found.length !== new Set(categoryIds.map(String)).size) throw new BadRequestException('Supplier category not found');
    const inactive = found.find((c) => !c.isActive);
    if (inactive) throw new BadRequestException(`Supplier category ${inactive.code} is inactive`);
    const first = categoryIds.map((id) => found.find((c) => c._id.equals(id))!).find((c) => c.expenseAccountId);
    return first?.expenseAccountId ?? null;
  }

  // ----- Onboarding and status ------------------------------------------------------------------

  /** New suppliers wait for approval when the organisation asks for it. */
  async onboardingRequired(organisationId: Types.ObjectId) {
    const org = await this.db.organisations.findById(organisationId, { 'settings.supplierOnboardingApproval': 1 }).lean();
    return !!org?.settings?.supplierOnboardingApproval;
  }

  /** Gaps that stop approval: a supplier must have a tax PIN, a way to be paid and a current tax compliance certificate. */
  private onboardingGaps(s: Party & { compliance?: ComplianceDoc[] }, now = new Date()) {
    const gaps: string[] = [];
    if (!s.taxId) gaps.push('KRA PIN');
    if (!s.bankAccountNumber && !s.mpesaPayee) gaps.push('bank or M-Pesa payment details');
    const tcc = (s.compliance ?? []).find((c) => c.type === 'TAX_COMPLIANCE');
    if (!tcc) gaps.push('tax compliance certificate');
    else if (tcc.expiresOn && tcc.expiresOn < now) gaps.push('a current tax compliance certificate (it has expired)');
    return gaps;
  }

  async approve(user: AuthUser, id: Types.ObjectId, comment?: string) {
    this.requireApprover(user);
    const s = await this.supplier(user, id);
    if (s.status !== 'PENDING') throw new BadRequestException(`${s.name} is not awaiting approval`);
    if (s.createdBy?.equals(user.id)) throw new ForbiddenException('You registered this supplier, so someone else must approve it');
    const gaps = this.onboardingGaps(s);
    if (gaps.length) throw new BadRequestException(`Before approval, record the supplier's ${gaps.join(', ')}`);
    const after = await this.db.suppliers.findOneAndUpdate({ _id: s._id, status: 'PENDING' }, { $set: { status: 'ACTIVE', statusReason: '', statusChangedAt: new Date(), statusChangedBy: user.id, 'onboarding.approvedBy': user.id, 'onboarding.approvedAt': new Date(), 'onboarding.comment': comment ?? '' } }, { new: true }).lean();
    if (!after) throw new BadRequestException('The supplier was changed by someone else');
    await this.audit.log(user, { action: 'supplier.approve', recordType: 'Supplier', recordId: s._id, summary: `Approved supplier ${s.code} · ${s.name}${comment ? `: ${comment}` : ''}` });
    return after;
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    this.requireApprover(user);
    const s = await this.supplier(user, id);
    if (s.status !== 'PENDING') throw new BadRequestException(`${s.name} is not awaiting approval`);
    const after = await this.db.suppliers.findOneAndUpdate({ _id: s._id, status: 'PENDING' }, { $set: { status: 'REJECTED', statusReason: reason, statusChangedAt: new Date(), statusChangedBy: user.id } }, { new: true }).lean();
    await this.audit.log(user, { action: 'supplier.reject', recordType: 'Supplier', recordId: s._id, summary: `Rejected supplier ${s.code} · ${s.name}: ${reason}` });
    return after;
  }

  /** Resubmits a rejected supplier once its details are fixed. */
  async resubmit(user: AuthUser, id: Types.ObjectId) {
    const s = await this.supplier(user, id);
    if (s.status !== 'REJECTED') throw new BadRequestException('Only a rejected supplier can be resubmitted');
    const after = await this.db.suppliers.findByIdAndUpdate(s._id, { $set: { status: 'PENDING', statusChangedAt: new Date(), statusChangedBy: user.id, 'onboarding.submittedAt': new Date(), 'onboarding.submittedBy': user.id } }, { new: true }).lean();
    await this.audit.log(user, { action: 'supplier.resubmit', recordType: 'Supplier', recordId: s._id, summary: `Resubmitted supplier ${s.code} for approval` });
    return after;
  }

  /** Suspends, blacklists or reinstates an approved supplier. */
  async setStatus(user: AuthUser, id: Types.ObjectId, input: { status: 'ACTIVE' | 'SUSPENDED' | 'BLACKLISTED'; reason?: string; until?: Date | null }) {
    this.requireApprover(user);
    const s = await this.supplier(user, id);
    if (s.status === 'PENDING' || s.status === 'REJECTED') throw new BadRequestException(`${s.name} has not been approved yet`);
    if (s.status === input.status) throw new BadRequestException(`${s.name} is already ${input.status.toLowerCase()}`);
    if (input.status !== 'ACTIVE' && !input.reason) throw new BadRequestException('Give the reason; it is shown to anyone who tries to order from this supplier');
    if (input.until && input.status !== 'SUSPENDED') throw new BadRequestException('Only a suspension has an end date');
    const after = await this.db.suppliers
      .findByIdAndUpdate(s._id, { $set: { status: input.status, statusReason: input.reason ?? '', statusUntil: input.until ?? null, statusChangedAt: new Date(), statusChangedBy: user.id } }, { new: true })
      .lean();
    await this.audit.log(user, {
      action: `supplier.${input.status.toLowerCase()}`,
      recordType: 'Supplier',
      recordId: s._id,
      summary: `${input.status === 'ACTIVE' ? 'Reinstated' : input.status === 'SUSPENDED' ? 'Suspended' : 'Blacklisted'} ${s.code} · ${s.name}${input.reason ? `: ${input.reason}` : ''}${input.until ? ` until ${input.until.toISOString().slice(0, 10)}` : ''}`,
    });
    return after;
  }

  /** Reinstates suppliers whose suspension has run out (from the scheduled job). */
  async liftExpiredSuspensions(now = new Date()) {
    const due = await this.db.suppliers.find({ status: 'SUSPENDED', statusUntil: { $ne: null, $lte: now } }, { _id: 1, organisationId: 1, code: 1 }).lean();
    for (const s of due) {
      await this.db.suppliers.updateOne({ _id: s._id, status: 'SUSPENDED' }, { $set: { status: 'ACTIVE', statusReason: '', statusUntil: null, statusChangedAt: now, statusChangedBy: null } });
      await this.audit.log({ organisationId: s.organisationId, name: 'system' }, { action: 'supplier.reinstate', recordType: 'Supplier', recordId: s._id, summary: `Suspension of ${s.code} ended` });
    }
    return { reinstated: due.length };
  }

  async saveCompliance(user: AuthUser, id: Types.ObjectId, docs: ComplianceDoc[]) {
    const s = await this.supplier(user, id);
    for (const d of docs) {
      if (d.issuedOn && d.expiresOn && d.expiresOn <= d.issuedOn) throw new BadRequestException(`${d.type.replace(/_/g, ' ').toLowerCase()} ${d.number}: expiry must be after issue`);
    }
    const after = await this.db.suppliers.findByIdAndUpdate(s._id, { $set: { compliance: docs.map((d) => ({ type: d.type, number: d.number, issuedOn: d.issuedOn ?? null, expiresOn: d.expiresOn ?? null, note: d.note ?? '' })) } }, { new: true }).lean();
    await this.audit.log(user, { action: 'supplier.compliance', recordType: 'Supplier', recordId: s._id, summary: `Updated compliance documents of ${s.code}: ${docs.map((d) => `${d.type} ${d.number}`).join(', ') || 'none'}` });
    return after;
  }

  /** Compliance documents that have expired or expire within `days`. */
  async expiringCompliance(user: AuthUser, days: number) {
    const now = new Date();
    const horizon = new Date(now.getTime() + days * DAY);
    const suppliers = await this.db.suppliers.find({ organisationId: user.organisationId, isActive: true, status: { $in: ['ACTIVE', 'SUSPENDED', 'PENDING'] }, 'compliance.expiresOn': { $lte: horizon } }, { code: 1, name: 1, email: 1, compliance: 1 }).sort({ name: 1 }).lean();
    return suppliers.flatMap((s) =>
      (s.compliance ?? [])
        .filter((c) => c.expiresOn && c.expiresOn <= horizon)
        .map((c) => ({ supplierId: s._id, code: s.code, name: s.name, email: s.email, type: c.type, number: c.number, expiresOn: c.expiresOn, days: Math.ceil((c.expiresOn!.getTime() - now.getTime()) / DAY) })),
    );
  }

  // ----- Performance --------------------------------------------------------------------------

  async rate(user: AuthUser, supplierId: Types.ObjectId, input: RatingInput) {
    if (!hasPermission(user, PERMISSIONS.PROCUREMENT_MANAGE) && !hasPermission(user, PERMISSIONS.PROCUREMENT_APPROVE)) throw new ForbiddenException('Missing permission: procurement.manage');
    const s = await this.supplier(user, supplierId);
    for (const k of ['quality', 'delivery', 'price', 'service'] as const) {
      if (!Number.isInteger(input[k]) || input[k] < 1 || input[k] > 5) throw new BadRequestException(`Score ${k} from 1 to 5`);
    }
    let poNumber = '';
    if (input.purchaseOrderId) {
      const po = await this.db.purchaseOrders.findOne({ _id: input.purchaseOrderId, organisationId: user.organisationId, supplierId: s._id }, { number: 1, status: 1 }).lean();
      if (!po) throw new BadRequestException(`That purchase order is not from ${s.name}`);
      if (!(await this.db.goodsReceipts.exists({ purchaseOrderId: po._id }))) throw new BadRequestException(`Nothing has been received on ${po.number} yet`);
      if (await this.db.supplierRatings.exists({ organisationId: user.organisationId, purchaseOrderId: po._id })) throw new BadRequestException(`${po.number} has already been rated`);
      poNumber = po.number;
    }
    const me = await this.db.users.findById(user.id, { name: 1 }).lean();
    const [r] = await this.db.supplierRatings.create([{ organisationId: user.organisationId, supplierId: s._id, purchaseOrderId: input.purchaseOrderId ?? null, purchaseOrderNumber: poNumber, date: input.date, quality: input.quality, delivery: input.delivery, price: input.price, service: input.service, comment: input.comment ?? '', ratedBy: user.id, ratedByName: me?.name ?? '' }]);
    const avg = (input.quality + input.delivery + input.price + input.service) / 4;
    await this.audit.log(user, { action: 'supplier.rate', recordType: 'Supplier', recordId: s._id, summary: `Rated ${s.code} ${avg.toFixed(1)}/5${poNumber ? ` on ${poNumber}` : ''}` });
    return r.toObject();
  }

  /**
   * A supplier's scorecard: average scores, on-time delivery (first goods received on or before the date
   * the order expected), spend in the last twelve months and the ratings behind it.
   */
  async performance(user: AuthUser, supplierId: Types.ObjectId) {
    const s = await this.supplier(user, supplierId);
    const [ratings, delivery, spend] = await Promise.all([
      this.db.supplierRatings.find({ organisationId: user.organisationId, supplierId: s._id }).sort({ date: -1 }).limit(200).lean(),
      this.deliveryStats(user.organisationId, [s._id]),
      this.spend(user.organisationId, [s._id]),
    ]);
    return { supplierId: s._id, status: s.status ?? 'ACTIVE', ...summarise(ratings), ...(delivery.get(s._id.toHexString()) ?? { ordersDelivered: 0, onTime: 0, onTimePercent: null }), spend12m: spend.get(s._id.toHexString()) ?? new Decimal(0), ratings };
  }

  /** Every supplier's scorecard side by side (for the vendor performance report). */
  async scorecards(user: AuthUser) {
    const suppliers = await this.db.suppliers.find({ organisationId: user.organisationId }, { code: 1, name: 1, status: 1, statusReason: 1, categoryIds: 1, isActive: 1 }).sort({ name: 1 }).limit(2000).lean();
    const ids = suppliers.map((s) => s._id);
    const [ratings, delivery, spend, categories] = await Promise.all([
      this.db.supplierRatings.find({ organisationId: user.organisationId, supplierId: { $in: ids } }, { supplierId: 1, quality: 1, delivery: 1, price: 1, service: 1 }).lean(),
      this.deliveryStats(user.organisationId, ids),
      this.spend(user.organisationId, ids),
      this.db.supplierCategories.find({ organisationId: user.organisationId }, { code: 1 }).lean(),
    ]);
    return suppliers.map((s) => ({
      id: s._id,
      code: s.code,
      name: s.name,
      status: s.isActive ? (s.status ?? 'ACTIVE') : 'INACTIVE',
      statusReason: s.statusReason ?? '',
      categories: (s.categoryIds ?? []).map((c) => categories.find((x) => x._id.equals(c))?.code).filter(Boolean),
      ...summarise(ratings.filter((r) => r.supplierId.equals(s._id))),
      ...(delivery.get(s._id.toHexString()) ?? { ordersDelivered: 0, onTime: 0, onTimePercent: null }),
      spend12m: spend.get(s._id.toHexString()) ?? new Decimal(0),
    }));
  }

  private async deliveryStats(organisationId: Types.ObjectId, supplierIds: Types.ObjectId[]) {
    const pos = await this.db.purchaseOrders.find({ organisationId, supplierId: { $in: supplierIds }, expectedDate: { $ne: null } }, { supplierId: 1, expectedDate: 1 }).lean();
    const firstReceipts = await this.db.goodsReceipts.aggregate<{ _id: Types.ObjectId; first: Date }>([{ $match: { organisationId, purchaseOrderId: { $in: pos.map((p) => p._id) } } }, { $group: { _id: '$purchaseOrderId', first: { $min: '$date' } } }]);
    const out = new Map<string, { ordersDelivered: number; onTime: number; onTimePercent: number | null }>();
    for (const p of pos) {
      const got = firstReceipts.find((r) => r._id.equals(p._id));
      if (!got) continue;
      const key = p.supplierId.toHexString();
      const row = out.get(key) ?? { ordersDelivered: 0, onTime: 0, onTimePercent: null };
      row.ordersDelivered++;
      if (got.first <= p.expectedDate!) row.onTime++;
      row.onTimePercent = Math.round((row.onTime / row.ordersDelivered) * 100);
      out.set(key, row);
    }
    return out;
  }

  private async spend(organisationId: Types.ObjectId, supplierIds: Types.ObjectId[]) {
    const since = new Date(Date.now() - 365 * DAY);
    const rows = await this.db.invoices.aggregate<{ _id: Types.ObjectId; total: unknown }>([
      { $match: { organisationId, partyId: { $in: supplierIds }, kind: 'PURCHASE_BILL', status: 'POSTED', date: { $gte: since } } },
      { $group: { _id: '$partyId', total: { $sum: '$totalFunctional' } } },
    ]);
    return new Map(rows.map((r) => [r._id.toHexString(), dec(r.total as string)]));
  }
}

function summarise(ratings: { quality: number; delivery: number; price: number; service: number }[]) {
  if (!ratings.length) return { ratingCount: 0, averages: null, overall: null };
  const avg = (k: 'quality' | 'delivery' | 'price' | 'service') => Math.round((ratings.reduce((t, r) => t + r[k], 0) / ratings.length) * 10) / 10;
  const averages = { quality: avg('quality'), delivery: avg('delivery'), price: avg('price'), service: avg('service') };
  return { ratingCount: ratings.length, averages, overall: Math.round(((averages.quality + averages.delivery + averages.price + averages.service) / 4) * 10) / 10 };
}
