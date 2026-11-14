import { ClientSession, Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, HttpError, NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { PERMISSIONS } from '../../common/permissions';
import { decryptSecret } from '../../common/totp';
import { escapeRegex } from '../../common/workflow';
import { EtimsDevice, EtimsPurchase } from '../../database/compliance.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { DocumentInput } from '../documents/documents.service';
import { buildPurchase, EtimsClient, EtimsError, etimsDateTime, SupplierSale } from './etims';

const BACKOFF_MINUTES = [1, 5, 30, 120, 480];
const PIN = /^[AP]\d{9}[A-Z]$/;
/** Supplier invoice numbers compared without punctuation or leading zeros ("INV-00042" matches 42). */
const invoiceKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[A-Z]*0*/, '');

/**
 * KRA eTIMS purchases. Supplier invoices registered against our PIN are fetched into an inbox, matched
 * to supplier bills (or turned into draft bills), and our acceptance (when the bill posts) or rejection
 * is reported back to KRA. Input VAT is only claimable on purchases registered in eTIMS, so bills that
 * carry VAT without a registered invoice are flagged.
 */
export class EtimsPurchasesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private require(user: AuthUser, action: 'view' | 'manage') {
    const p = action === 'view' ? PERMISSIONS.AP_VIEW : PERMISSIONS.AP_MANAGE;
    if (!hasPermission(user, p)) throw new ForbiddenException(`Missing permission: ${p}`);
  }

  // ----- Fetching ---------------------------------------------------------------------------------

  /** Pulls new supplier invoices for every reporting device (cron), or one organisation's (on demand). */
  async fetch(opts: { organisationId?: Types.ObjectId } = {}) {
    const devices = await this.db.etimsDevices.find({ enabled: true, cmcKey: { $ne: null }, ...(opts.organisationId && { organisationId: opts.organisationId }) }).lean();
    let received = 0;
    let matched = 0;
    const errors: string[] = [];
    for (const device of devices) {
      const startedAt = new Date();
      let sales: SupplierSale[];
      try {
        sales = await new EtimsClient(device.environment as 'sandbox' | 'production', device.tin, device.bhfId, decryptSecret(device.cmcKey!)).purchases(device.lastPurchaseFetch);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'KRA eTIMS did not answer');
        continue;
      }
      for (const sale of sales) {
        const r = await this.store(device, sale);
        if (r.created) received++;
        if (r.matched) matched++;
      }
      await this.db.etimsDevices.updateOne({ _id: device._id }, { lastPurchaseFetch: etimsDateTime(startedAt), purchasesFetchedAt: startedAt });
    }
    return { received, matched, errors };
  }

  async fetchNow(user: AuthUser) {
    this.require(user, 'manage');
    const res = await this.fetch({ organisationId: user.organisationId });
    if (res.errors.length && !res.received) throw new HttpError(502, res.errors[0]);
    return res;
  }

  private async store(device: EtimsDevice, sale: SupplierSale) {
    const tin = String(sale.spplrTin ?? '').toUpperCase();
    const invcNo = String(sale.spplrInvcNo ?? '');
    const date = /^\d{8}$/.test(String(sale.salesDt)) ? new Date(`${String(sale.salesDt).slice(0, 4)}-${String(sale.salesDt).slice(4, 6)}-${String(sale.salesDt).slice(6, 8)}T00:00:00Z`) : new Date();
    const supplier = PIN.test(tin) ? await this.db.suppliers.findOne({ organisationId: device.organisationId, taxId: new RegExp(`^${escapeRegex(tin)}$`, 'i') }, { _id: 1 }).lean() : null;
    const res = await this.db.etimsPurchases.updateOne(
      { deviceId: device._id, supplierTin: tin, supplierInvcNo: invcNo, receiptType: sale.rcptTyCd ?? 'S' },
      {
        $setOnInsert: {
          organisationId: device.organisationId,
          branchId: device.branchId,
          supplierName: sale.spplrNm ?? '',
          supplierBhfId: sale.spplrBhfId ?? '',
          paymentType: sale.pmtTyCd ?? null,
          date,
          confirmedAt: sale.cfmDt ?? null,
          taxableAmount: toD128(new Decimal(sale.totTaxblAmt ?? 0)),
          taxAmount: toD128(new Decimal(sale.totTaxAmt ?? 0)),
          totalAmount: toD128(new Decimal(sale.totAmt ?? 0)),
          items: sale.itemList ?? [],
          raw: sale,
          supplierId: supplier?._id ?? null,
        },
      },
      { upsert: true },
    );
    if (!res.upsertedId) return { created: false, matched: false };
    const purchase = (await this.db.etimsPurchases.findById(res.upsertedId).lean())!;
    return { created: true, matched: await this.autoMatch(purchase) };
  }

  /** Links a supplier invoice to the bill already entered for it (same supplier PIN and invoice number). */
  private async autoMatch(purchase: EtimsPurchase, session?: ClientSession) {
    if (!purchase.supplierId) return false;
    const key = invoiceKey(purchase.supplierInvcNo);
    const bills = await this.db.invoices
      .find({ organisationId: purchase.organisationId, kind: 'PURCHASE_BILL', partyId: purchase.supplierId, status: { $ne: 'VOID' }, etimsPurchaseId: null }, { supplierInvoiceNumber: 1, status: 1 })
      .session(session ?? null)
      .lean();
    const bill = bills.find((b) => invoiceKey(b.supplierInvoiceNumber) === key);
    if (!bill) return false;
    await this.linkIn(purchase, bill, session);
    return true;
  }

  private async linkIn(purchase: EtimsPurchase, bill: { _id: Types.ObjectId; status: string }, session?: ClientSession) {
    const posted = bill.status === 'POSTED';
    await this.db.etimsPurchases.updateOne(
      { _id: purchase._id },
      { billId: bill._id, status: posted ? 'ACCEPTED' : 'MATCHED', ...(posted && { 'report.status': 'PENDING', 'report.nextAttemptAt': new Date() }) },
      { session },
    );
    await this.db.invoices.updateOne({ _id: bill._id }, { etimsPurchaseId: purchase._id }, { session });
  }

  // ----- Posting a bill accepts its eTIMS invoice -----------------------------------------------

  async onAudit(organisationId: Types.ObjectId, event: { type: string; recordType: string; recordId?: Types.ObjectId | null }, session?: ClientSession) {
    if (event.type !== 'document.approve' || event.recordType !== 'Invoice' || !event.recordId) return;
    const bill = await this.db.invoices.findById(event.recordId, { kind: 1, status: 1, partyId: 1, supplierInvoiceNumber: 1, etimsPurchaseId: 1 }).session(session ?? null).lean();
    if (!bill || bill.kind !== 'PURCHASE_BILL' || bill.status !== 'POSTED') return;
    if (bill.etimsPurchaseId) {
      await this.db.etimsPurchases.updateOne({ _id: bill.etimsPurchaseId, status: 'MATCHED' }, { status: 'ACCEPTED', 'report.status': 'PENDING', 'report.nextAttemptAt': new Date() }, { session });
      return;
    }
    // Posted before the supplier's invoice was linked: look for it among those received.
    const candidates = await this.db.etimsPurchases.find({ organisationId, supplierId: bill.partyId, billId: null, status: 'RECEIVED' }).session(session ?? null).lean();
    const purchase = candidates.find((p) => invoiceKey(p.supplierInvcNo) === invoiceKey(bill.supplierInvoiceNumber));
    if (purchase) await this.linkIn(purchase, bill, session);
  }

  // ----- Inbox actions ----------------------------------------------------------------------------

  private async load(user: AuthUser, id: Types.ObjectId) {
    const purchase = await this.db.etimsPurchases.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!purchase) throw new NotFoundException('eTIMS purchase not found');
    const restricted = allowedBranches(user);
    if (restricted && !restricted.some((b) => b.equals(purchase.branchId))) throw new ForbiddenException('No access to this branch');
    return purchase;
  }

  async inbox(user: AuthUser, q: { status?: string; limit: number }) {
    this.require(user, 'view');
    const restricted = allowedBranches(user);
    const rows = await this.db.etimsPurchases
      .find({ organisationId: user.organisationId, ...(q.status && { status: q.status }), ...(restricted && { branchId: { $in: restricted } }) }, { raw: 0 })
      .sort({ date: -1, _id: -1 })
      .limit(q.limit)
      .lean();
    const bills = await this.db.invoices.find({ _id: { $in: rows.map((r) => r.billId).filter(Boolean) } }, { number: 1, status: 1, total: 1 }).lean();
    return rows.map((r) => {
      const bill = bills.find((b) => r.billId?.equals(b._id));
      return { ...r, bill: bill ? { id: bill._id, number: bill.number, status: bill.status, total: bill.total } : null };
    });
  }

  async link(user: AuthUser, id: Types.ObjectId, billId: Types.ObjectId) {
    this.require(user, 'manage');
    const purchase = await this.load(user, id);
    if (purchase.billId) throw new BadRequestException('This invoice is already linked to a bill');
    if (purchase.status === 'REJECTED') throw new BadRequestException('This invoice was rejected');
    const bill = await this.db.invoices.findOne({ _id: billId, organisationId: user.organisationId, kind: 'PURCHASE_BILL' }).lean();
    if (!bill) throw new NotFoundException('Bill not found');
    if (bill.status === 'VOID') throw new BadRequestException(`${bill.number} is void`);
    if (bill.etimsPurchaseId) throw new BadRequestException(`${bill.number} is already linked to an eTIMS invoice`);
    const supplier = await this.db.suppliers.findById(bill.partyId, { taxId: 1, name: 1 }).lean();
    if (supplier?.taxId && supplier.taxId.toUpperCase() !== purchase.supplierTin) throw new BadRequestException(`${bill.number} is from ${supplier.name} (PIN ${supplier.taxId}), not PIN ${purchase.supplierTin}`);
    await this.linkIn(purchase, bill);
    if (!purchase.supplierId) await this.db.etimsPurchases.updateOne({ _id: purchase._id }, { supplierId: bill.partyId });
    await this.audit.log(user, { action: 'etims.purchase_link', recordType: 'Invoice', recordId: bill._id, summary: `Linked ${bill.number} to eTIMS invoice ${purchase.supplierInvcNo} from ${purchase.supplierName || purchase.supplierTin}` });
    return this.db.etimsPurchases.findById(purchase._id, { raw: 0 }).lean();
  }

  /**
   * A draft bill for a supplier invoice, ready to code and approve. The supplier is created from its PIN
   * when it is not on file; lines carry the supplier's tax-inclusive prices and the VAT code mapped to each
   * line's eTIMS tax type.
   */
  async billDraft(user: AuthUser, id: Types.ObjectId, input: { accountId?: Types.ObjectId | null }): Promise<DocumentInput> {
    this.require(user, 'manage');
    const purchase = await this.load(user, id);
    if (purchase.billId) throw new BadRequestException('This invoice is already linked to a bill');
    if (purchase.status === 'REJECTED') throw new BadRequestException('This invoice was rejected');
    let supplier = purchase.supplierId ? await this.db.suppliers.findById(purchase.supplierId).lean() : null;
    if (!supplier) {
      const base = (purchase.supplierName || purchase.supplierTin).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || purchase.supplierTin;
      let code = base;
      for (let n = 2; await this.db.suppliers.exists({ organisationId: user.organisationId, code }); n++) code = `${base.slice(0, 8)}${n}`;
      [supplier] = await this.db.suppliers.create([{ organisationId: user.organisationId, code, name: purchase.supplierName || `Supplier ${purchase.supplierTin}`, taxId: purchase.supplierTin, currency: 'KES', createdBy: user.id }]);
      await this.db.etimsPurchases.updateOne({ _id: purchase._id }, { supplierId: supplier!._id });
      await this.audit.log(user, { action: 'supplier.create', recordType: 'Supplier', recordId: supplier!._id, summary: `Created supplier ${supplier!.name} (PIN ${purchase.supplierTin}) from KRA eTIMS` });
    }
    const accountId = input.accountId ?? supplier!.defaultAccountId;
    if (!accountId) throw new BadRequestException(`Choose the account to charge (or set a default account on ${supplier!.name})`);
    const codes = await this.db.taxCodes.find({ organisationId: user.organisationId, kind: 'VAT', isActive: true, etimsTaxType: { $ne: null } }).lean();
    const device = (await this.db.etimsDevices.findById(purchase.deviceId).lean())!;
    const items = purchase.items as { itemNm: string; qty: number; prc: number; dcRt?: number; taxTyCd: string; totAmt: number }[];
    if (!items.length) throw new BadRequestException('KRA sent no line detail for this invoice');
    return {
      entityId: device.entityId,
      branchId: device.branchId,
      kind: 'PURCHASE_BILL',
      partyId: supplier!._id,
      date: purchase.date,
      supplierInvoiceNumber: purchase.supplierInvcNo,
      reference: `eTIMS ${purchase.supplierInvcNo}`,
      priceIncludesTax: true,
      notes: `From KRA eTIMS: ${purchase.supplierName || purchase.supplierTin} invoice ${purchase.supplierInvcNo}`,
      lines: items.map((i) => {
        const code = codes.find((c) => c.etimsTaxType === i.taxTyCd);
        if (!code && i.taxTyCd !== 'D') throw new BadRequestException(`Map a VAT code to eTIMS tax type ${i.taxTyCd} (Setup → Tax codes)`);
        return {
          description: i.itemNm,
          accountId,
          quantity: new Decimal(i.qty || 1),
          unitPrice: new Decimal(i.prc),
          discountPercent: i.dcRt ? new Decimal(i.dcRt) : null,
          taxCodeId: code?._id ?? null,
        };
      }),
    };
  }

  async afterBillCreated(user: AuthUser, id: Types.ObjectId, billId: Types.ObjectId) {
    const purchase = await this.load(user, id);
    const bill = (await this.db.invoices.findById(billId, { status: 1, number: 1, total: 1 }).lean())!;
    await this.linkIn(purchase, bill);
    await this.audit.log(user, { action: 'etims.purchase_bill', recordType: 'Invoice', recordId: bill._id, summary: `Created ${bill.number} from eTIMS invoice ${purchase.supplierInvcNo} of ${purchase.supplierName || purchase.supplierTin}` });
    const difference = dec(bill.total).minus(dec(purchase.totalAmount));
    return { billId: bill._id, number: bill.number, difference: difference.abs().gt(0.05) ? difference : null };
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    this.require(user, 'manage');
    const purchase = await this.load(user, id);
    if (purchase.status === 'ACCEPTED') throw new BadRequestException('The bill for this invoice is posted; void the bill before rejecting the invoice');
    if (purchase.status === 'REJECTED') throw new BadRequestException('Already rejected');
    if (purchase.billId) await this.db.invoices.updateOne({ _id: purchase.billId }, { etimsPurchaseId: null });
    await this.db.etimsPurchases.updateOne({ _id: purchase._id }, { status: 'REJECTED', rejectionReason: reason, billId: null, 'report.status': 'PENDING', 'report.nextAttemptAt': new Date() });
    await this.audit.log(user, { action: 'etims.purchase_reject', recordType: 'EtimsPurchase', recordId: purchase._id, summary: `Rejected eTIMS invoice ${purchase.supplierInvcNo} from ${purchase.supplierName || purchase.supplierTin}: ${reason}` });
    return this.db.etimsPurchases.findById(purchase._id, { raw: 0 }).lean();
  }

  // ----- Reporting decisions to KRA ---------------------------------------------------------------

  async deliverReports(opts: { organisationId?: Types.ObjectId } = {}) {
    let sent = 0;
    let failed = 0;
    const devices = await this.db.etimsDevices.find({ enabled: true, cmcKey: { $ne: null }, ...(opts.organisationId && { organisationId: opts.organisationId }) }).lean();
    for (const device of devices) {
      for (let i = 0; i < 100; i++) {
        const head = await this.db.etimsPurchases.findOne({ deviceId: device._id, 'report.status': { $in: ['PENDING', 'FAILED'] } }).sort({ updatedAt: 1, _id: 1 }).lean();
        if (!head || (head.report?.nextAttemptAt && head.report.nextAttemptAt > new Date())) break;
        if (await this.report((await this.db.etimsDevices.findById(device._id).lean())!, head)) sent++;
        else {
          failed++;
          break;
        }
      }
    }
    return { sent, failed };
  }

  private async report(device: EtimsDevice, purchase: EtimsPurchase) {
    try {
      let invcNo = purchase.report?.invcNo ?? null;
      if (invcNo == null) {
        invcNo = (await this.db.etimsDevices.findOneAndUpdate({ _id: device._id }, { $inc: { lastPurchaseInvcNo: 1 } }, { new: true }).lean())!.lastPurchaseInvcNo;
        await this.db.etimsPurchases.updateOne({ _id: purchase._id }, { 'report.invcNo': invcNo });
      }
      const bill = purchase.billId ? await this.db.invoices.findById(purchase.billId, { number: 1, approvedBy: 1 }).lean() : null;
      const actor = bill?.approvedBy ? await this.db.users.findById(bill.approvedBy, { name: 1 }).lean() : null;
      const payload = buildPurchase({
        tin: device.tin,
        bhfId: device.bhfId,
        invcNo,
        sale: purchase.raw as SupplierSale,
        accepted: purchase.status === 'ACCEPTED',
        confirmedAt: new Date(),
        remark: purchase.status === 'ACCEPTED' ? (bill?.number ?? '') : purchase.rejectionReason,
        user: { id: actor?._id.toString().slice(-20) ?? 'system', name: actor?.name ?? 'FarajaSoft' },
      });
      await new EtimsClient(device.environment as 'sandbox' | 'production', device.tin, device.bhfId, decryptSecret(device.cmcKey!)).savePurchase(payload);
      await this.db.etimsPurchases.updateOne({ _id: purchase._id }, { 'report.status': 'SENT', 'report.sentAt': new Date(), 'report.lastError': '', $inc: { 'report.attempts': 1 } });
      return true;
    } catch (err) {
      const attempts = (purchase.report?.attempts ?? 0) + 1;
      const backoff = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
      await this.db.etimsPurchases.updateOne(
        { _id: purchase._id },
        { 'report.status': 'FAILED', 'report.attempts': attempts, 'report.lastError': (err instanceof EtimsError || err instanceof Error ? err.message : 'Could not reach KRA').slice(0, 300), 'report.nextAttemptAt': new Date(Date.now() + backoff * 60_000) },
      );
      return false;
    }
  }

  // ----- Input VAT at risk --------------------------------------------------------------------------

  /** For a bill: its eTIMS invoice, or why its input VAT may not be claimable. */
  async forBill(user: AuthUser, billId: Types.ObjectId) {
    this.require(user, 'view');
    const bill = await this.db.invoices.findOne({ _id: billId, organisationId: user.organisationId, kind: 'PURCHASE_BILL' }, { etimsPurchaseId: 1, taxTotal: 1, partyId: 1, entityId: 1, status: 1 }).lean();
    if (!bill) throw new NotFoundException('Bill not found');
    if (bill.etimsPurchaseId) return { registered: true, purchase: await this.db.etimsPurchases.findById(bill.etimsPurchaseId, { raw: 0, items: 0 }).lean() };
    const atRisk = await this.atRiskFilter(user.organisationId, bill.entityId);
    const flagged = atRisk && dec(bill.taxTotal).gt(0) && !!(await this.db.suppliers.exists({ _id: bill.partyId, taxId: PIN }));
    return { registered: false, purchase: null, inputVatAtRisk: flagged };
  }

  /** eTIMS applies to entities with a reporting device. */
  private async atRiskFilter(organisationId: Types.ObjectId, entityId: Types.ObjectId) {
    return !!(await this.db.etimsDevices.exists({ organisationId, entityId, cmcKey: { $ne: null } }));
  }

  /** Posted bills with VAT from PIN-registered suppliers that are not matched to an eTIMS invoice. */
  async unregistered(user: AuthUser, q: { entityId: Types.ObjectId; from: Date; to: Date }) {
    this.require(user, 'view');
    const suppliers = await this.db.suppliers.find({ organisationId: user.organisationId, taxId: PIN }, { _id: 1, name: 1, taxId: 1 }).lean();
    const restricted = allowedBranches(user);
    const bills = await this.db.invoices
      .find(
        {
          organisationId: user.organisationId,
          entityId: q.entityId,
          kind: 'PURCHASE_BILL',
          status: 'POSTED',
          etimsPurchaseId: null,
          date: { $gte: q.from, $lte: q.to },
          partyId: { $in: suppliers.map((s) => s._id) },
          taxTotal: { $gt: toD128(0) },
          ...(restricted && { branchId: { $in: restricted } }),
        },
        { number: 1, date: 1, partyId: 1, partyName: 1, supplierInvoiceNumber: 1, taxTotal: 1, total: 1, currency: 1, exchangeRate: 1 },
      )
      .sort({ date: 1 })
      .limit(2000)
      .lean();
    const items = bills.map((b) => ({ ...b, supplierTaxId: suppliers.find((s) => s._id.equals(b.partyId))?.taxId ?? '', taxFunctional: dec(b.taxTotal).times(dec(b.exchangeRate)).toDecimalPlaces(2) }));
    return { items, inputVatAtRisk: items.reduce((t, b) => t.plus(b.taxFunctional), new Decimal(0)) };
  }
}
