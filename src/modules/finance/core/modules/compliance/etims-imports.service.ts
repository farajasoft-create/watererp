import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, HttpError, NotFoundException } from '../../common/errors';
import { PERMISSIONS } from '../../common/permissions';
import { decryptSecret } from '../../common/totp';
import { EtimsDevice, EtimsImport } from '../../database/compliance.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { EtimsClient, EtimsError, etimsDateTime, EtimsTaxType, ImportItem } from './etims';
import { EtimsService } from './etims.service';

const BACKOFF_MINUTES = [1, 5, 30, 120, 480];

/**
 * KRA eTIMS imports. Items declared at customs for a connected branch's PIN are fetched into an inbox;
 * each is mapped to our own inventory item (and the supplier bill that receives it) and approved with
 * KRA, or rejected. Stock received on a bill with approved imports is reported to KRA as an import.
 */
export class EtimsImportsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly etims: EtimsService,
  ) {}

  private require(user: AuthUser, action: 'view' | 'manage') {
    const ok = action === 'view' ? hasPermission(user, PERMISSIONS.AP_VIEW) || hasPermission(user, PERMISSIONS.INVENTORY_VIEW) : hasPermission(user, PERMISSIONS.INVENTORY_MANAGE);
    if (!ok) throw new ForbiddenException(`Missing permission: ${action === 'view' ? 'ap.view or inventory.view' : 'inventory.manage'}`);
  }

  private client(device: EtimsDevice) {
    return new EtimsClient(device.environment as 'sandbox' | 'production', device.tin, device.bhfId, decryptSecret(device.cmcKey!));
  }

  // ----- Fetching ---------------------------------------------------------------------------------

  async fetch(opts: { organisationId?: Types.ObjectId } = {}) {
    const devices = await this.db.etimsDevices.find({ enabled: true, cmcKey: { $ne: null }, ...(opts.organisationId && { organisationId: opts.organisationId }) }).lean();
    let received = 0;
    const errors: string[] = [];
    for (const device of devices) {
      const startedAt = new Date();
      let items: ImportItem[];
      try {
        items = await this.client(device).imports(device.lastImportFetch);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'KRA eTIMS did not answer');
        continue;
      }
      for (const i of items) {
        const res = await this.db.etimsImports.updateOne(
          { deviceId: device._id, taskCd: String(i.taskCd), declarationDate: String(i.dclDe), itemSeq: Number(i.itemSeq) },
          {
            $setOnInsert: {
              organisationId: device.organisationId,
              branchId: device.branchId,
              declarationNumber: i.dclNo ?? '',
              hsCode: i.hsCd ?? '',
              itemName: i.itemNm,
              originCountry: i.orgnNatCd ?? '',
              exportCountry: i.exptNatCd ?? '',
              quantity: Number(i.qty ?? 0),
              quantityUnit: i.qtyUnitCd ?? '',
              packages: i.pkg ?? null,
              packageUnit: i.pkgUnitCd ?? '',
              grossWeight: i.totWt ?? null,
              netWeight: i.netWt ?? null,
              supplierName: i.spplrNm ?? '',
              agentName: i.agntNm ?? '',
              invoiceAmount: i.invcFcurAmt ?? null,
              invoiceCurrency: i.invcFcurCd ?? '',
              invoiceExchangeRate: i.invcFcurExcrt ?? null,
              raw: i,
            },
          },
          { upsert: true },
        );
        if (res.upsertedId) received++;
      }
      await this.db.etimsDevices.updateOne({ _id: device._id }, { lastImportFetch: etimsDateTime(startedAt), importsFetchedAt: startedAt });
    }
    return { received, errors };
  }

  async fetchNow(user: AuthUser) {
    this.require(user, 'manage');
    const res = await this.fetch({ organisationId: user.organisationId });
    if (res.errors.length && !res.received) throw new HttpError(502, res.errors[0]);
    return res;
  }

  // ----- Inbox ------------------------------------------------------------------------------------

  private async load(user: AuthUser, id: Types.ObjectId) {
    const row = await this.db.etimsImports.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!row) throw new NotFoundException('Import item not found');
    const restricted = allowedBranches(user);
    if (restricted && !restricted.some((b) => b.equals(row.branchId))) throw new ForbiddenException('No access to this branch');
    return row;
  }

  async list(user: AuthUser, q: { status?: string; limit: number }) {
    this.require(user, 'view');
    const restricted = allowedBranches(user);
    const rows = await this.db.etimsImports
      .find({ organisationId: user.organisationId, ...(q.status && { status: q.status }), ...(restricted && { branchId: { $in: restricted } }) }, { raw: 0 })
      .sort({ declarationDate: -1, taskCd: 1, itemSeq: 1 })
      .limit(q.limit)
      .lean();
    const [items, bills] = await Promise.all([
      this.db.items.find({ _id: { $in: rows.map((r) => r.itemId).filter(Boolean) } }, { code: 1, name: 1 }).lean(),
      this.db.invoices.find({ _id: { $in: rows.map((r) => r.billId).filter(Boolean) } }, { number: 1, partyName: 1 }).lean(),
    ]);
    return rows.map((r) => ({
      ...r,
      item: items.find((i) => r.itemId?.equals(i._id)) ?? null,
      bill: bills.find((b) => r.billId?.equals(b._id)) ?? null,
    }));
  }

  /** Accepts a declared item as received into our stock under one of our items (and, optionally, a bill). */
  async approve(user: AuthUser, id: Types.ObjectId, input: { itemId: Types.ObjectId; billId?: Types.ObjectId | null }) {
    this.require(user, 'manage');
    const row = await this.load(user, id);
    if (row.status !== 'RECEIVED') throw new BadRequestException(`This item is already ${row.status.toLowerCase()}`);
    const item = await this.db.items.findOne({ _id: input.itemId, organisationId: user.organisationId }).lean();
    if (!item) throw new BadRequestException('Item not found');
    if (item.type !== 'STOCK') throw new BadRequestException(`${item.name} is not a stock item`);
    if (input.billId) {
      const device = (await this.db.etimsDevices.findById(row.deviceId).lean())!;
      const bill = await this.db.invoices.findOne({ _id: input.billId, organisationId: user.organisationId, kind: 'PURCHASE_BILL' }).lean();
      if (!bill) throw new BadRequestException('Bill not found');
      if (!bill.entityId.equals(device.entityId)) throw new BadRequestException(`${bill.number} belongs to another entity`);
      if (bill.status === 'VOID') throw new BadRequestException(`${bill.number} is void`);
      await this.db.invoices.updateOne({ _id: bill._id }, { etimsImport: true });
    }
    await this.db.etimsImports.updateOne(
      { _id: row._id },
      { status: 'APPROVED', itemId: item._id, billId: input.billId ?? null, decidedBy: user.id, 'report.status': 'PENDING', 'report.nextAttemptAt': new Date() },
    );
    await this.audit.log(user, { action: 'etims.import_approve', recordType: 'EtimsImport', recordId: row._id, summary: `Approved customs item ${row.itemName} (declaration ${row.declarationNumber || row.taskCd}, line ${row.itemSeq}) as ${item.code} ${item.name}` });
    return this.db.etimsImports.findById(row._id, { raw: 0 }).lean();
  }

  async reject(user: AuthUser, id: Types.ObjectId, reason: string) {
    this.require(user, 'manage');
    const row = await this.load(user, id);
    if (row.status !== 'RECEIVED') throw new BadRequestException(`This item is already ${row.status.toLowerCase()}`);
    await this.db.etimsImports.updateOne({ _id: row._id }, { status: 'REJECTED', rejectionReason: reason, decidedBy: user.id, 'report.status': 'PENDING', 'report.nextAttemptAt': new Date() });
    await this.audit.log(user, { action: 'etims.import_reject', recordType: 'EtimsImport', recordId: row._id, summary: `Rejected customs item ${row.itemName} (declaration ${row.declarationNumber || row.taskCd}): ${reason}` });
    return this.db.etimsImports.findById(row._id, { raw: 0 }).lean();
  }

  // ----- Reporting decisions to KRA ---------------------------------------------------------------

  async deliverReports(opts: { organisationId?: Types.ObjectId } = {}) {
    let sent = 0;
    let failed = 0;
    const due = await this.db.etimsImports
      .find({ ...(opts.organisationId && { organisationId: opts.organisationId }), 'report.status': { $in: ['PENDING', 'FAILED'] }, 'report.nextAttemptAt': { $lte: new Date() } })
      .sort({ updatedAt: 1 })
      .limit(200)
      .lean();
    for (const row of due) {
      const device = await this.db.etimsDevices.findOne({ _id: row.deviceId, enabled: true, cmcKey: { $ne: null } }).lean();
      if (!device) continue;
      if (await this.report(device, row)) sent++;
      else failed++;
    }
    return { sent, failed };
  }

  private async report(device: EtimsDevice, row: EtimsImport) {
    try {
      const actor = row.decidedBy ? await this.db.users.findById(row.decidedBy, { name: 1 }).lean() : null;
      const user = { id: actor?._id.toString().slice(-20) ?? 'system', name: actor?.name ?? 'FarajaSoft' };
      let itemCd: string | null = null;
      let itemClsCd: string | null = null;
      const client = this.client(device);
      if (row.status === 'APPROVED' && row.itemId) {
        const item = (await this.db.items.findById(row.itemId, { name: 1, type: 1, etimsClassCode: 1, salesTaxCodeId: 1 }).lean())!;
        const code = item.salesTaxCodeId ? await this.db.taxCodes.findById(item.salesTaxCodeId, { etimsTaxType: 1 }).lean() : null;
        const classCode = item.etimsClassCode || device.defaultItemClassCode;
        if (!classCode) throw new Error(`Set a KRA item classification on ${item.name} or a default for the branch`);
        const registered = await this.etims.ensureItem(device, `item:${item._id.toHexString()}`, { classCode, name: item.name, type: '2' }, ((code?.etimsTaxType as EtimsTaxType | null) ?? device.defaultTaxType) as EtimsTaxType);
        await this.etims.registerItems(device, client, [registered.itemCd], user);
        itemCd = registered.itemCd;
        itemClsCd = registered.itemClsCd;
      }
      await client.updateImport({
        taskCd: row.taskCd,
        dclDe: row.declarationDate,
        itemSeq: row.itemSeq,
        hsCd: row.hsCode,
        itemClsCd,
        itemCd,
        approved: row.status === 'APPROVED',
        remark: row.status === 'APPROVED' ? 'Received into stock' : row.rejectionReason,
        user,
      });
      await this.db.etimsImports.updateOne({ _id: row._id }, { 'report.status': 'SENT', 'report.sentAt': new Date(), 'report.lastError': '', $inc: { 'report.attempts': 1 } });
      return true;
    } catch (err) {
      const attempts = (row.report?.attempts ?? 0) + 1;
      const backoff = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
      const message = (err instanceof EtimsError || err instanceof Error ? err.message : 'Could not reach KRA').slice(0, 300);
      await this.db.etimsImports.updateOne({ _id: row._id }, { 'report.status': 'FAILED', 'report.attempts': attempts, 'report.lastError': message, 'report.nextAttemptAt': new Date(Date.now() + backoff * 60_000) });
      return false;
    }
  }
}
