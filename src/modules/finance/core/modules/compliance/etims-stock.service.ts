import { Types } from 'mongoose';
import { allowedBranches } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { decryptSecret } from '../../common/totp';
import { EtimsDevice, EtimsStockReport, SAR_TYPES } from '../../database/compliance.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { buildStockIO, EtimsClient, EtimsError, EtimsTaxType, StockLine } from './etims';
import { EtimsService } from './etims.service';

const BACKOFF_MINUTES = [1, 5, 30, 120, 480];
/** Movements younger than this may still be in an open transaction; they are collected next time. */
const SETTLE_MS = 60_000;

/** KRA's stock in/out type for one of our movements. */
export function sarTypeFor(type: string, quantity: Decimal, imported = false): string {
  const inward = quantity.gt(0);
  switch (type) {
    case 'PURCHASE':
      return inward ? (imported ? SAR_TYPES.IMPORT : SAR_TYPES.PURCHASE) : SAR_TYPES.RETURN_OUT;
    case 'SALE':
      return inward ? SAR_TYPES.RETURN_IN : SAR_TYPES.SALE;
    case 'SALES_RETURN':
      return SAR_TYPES.RETURN_IN;
    case 'PURCHASE_RETURN':
      return SAR_TYPES.RETURN_OUT;
    case 'TRANSFER_IN':
      return SAR_TYPES.TRANSFER_IN;
    case 'TRANSFER_OUT':
      return SAR_TYPES.TRANSFER_OUT;
    default:
      // Openings, counts, write-offs and reversals.
      return inward ? SAR_TYPES.ADJUSTMENT_IN : SAR_TYPES.ADJUSTMENT_OUT;
  }
}

/**
 * KRA eTIMS stock reporting. Stock movements at a connected branch (sales issues, receipts, returns,
 * transfers, counts) are collected per source document and direction, reported to KRA in order
 * (insertStockIO), followed by each item's remaining quantity at the branch (saveStockMaster).
 */
export class EtimsStockService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly etims: EtimsService,
  ) {}

  /** Turns new stock movements into reports. Safe to run repeatedly: a cursor marks what was collected. */
  async collect(opts: { organisationId?: Types.ObjectId } = {}) {
    let reports = 0;
    const devices = await this.db.etimsDevices.find({ enabled: true, cmcKey: { $ne: null }, ...(opts.organisationId && { organisationId: opts.organisationId }) }).lean();
    for (const device of devices) {
      if (!device.stockReportFrom) {
        // Reporting starts now: stock already on hand is the opening position KRA was given at registration.
        await this.db.etimsDevices.updateOne({ _id: device._id }, { stockReportFrom: new Date() });
        continue;
      }
      const movements = await this.db.stockMovements
        .find({
          organisationId: device.organisationId,
          branchId: device.branchId,
          createdAt: { $gte: device.stockReportFrom, $lte: new Date(Date.now() - SETTLE_MS) },
          ...(device.stockCursor && { _id: { $gt: device.stockCursor } }),
        })
        .sort({ _id: 1 })
        .limit(5000)
        .lean();
      if (!movements.length) continue;
      // Receipts on bills for customs-cleared goods are imports.
      const importBills = new Set(
        (await this.db.invoices.find({ _id: { $in: [...new Set(movements.filter((m) => m.type === 'PURCHASE').map((m) => m.sourceId.toHexString()))].map((x) => new Types.ObjectId(x)) }, etimsImport: true }, { _id: 1 }).lean()).map((b) => b._id.toHexString()),
      );
      const groups = new Map<string, { sourceType: string; sourceId: Types.ObjectId; sourceNumber: string; sarTyCd: string; date: Date; movementIds: Types.ObjectId[]; lines: Map<string, { quantity: Decimal; value: Decimal }> }>();
      for (const m of movements) {
        const quantity = dec(m.quantity);
        if (quantity.isZero()) continue;
        const sarTyCd = sarTypeFor(m.type, quantity, importBills.has(m.sourceId.toHexString()));
        const key = `${m.sourceId.toHexString()}|${sarTyCd}`;
        const group = groups.get(key) ?? { sourceType: m.sourceType, sourceId: m.sourceId, sourceNumber: m.sourceNumber, sarTyCd, date: m.date, movementIds: [] as Types.ObjectId[], lines: new Map<string, { quantity: Decimal; value: Decimal }>() };
        group.movementIds.push(m._id);
        const line = group.lines.get(m.itemId.toHexString()) ?? { quantity: new Decimal(0), value: new Decimal(0) };
        group.lines.set(m.itemId.toHexString(), { quantity: line.quantity.plus(quantity.abs()), value: line.value.plus(dec(m.value).abs()) });
        groups.set(key, group);
      }
      if (groups.size) {
        await this.db.etimsStockReports.insertMany(
          [...groups.values()].map((g) => ({
            organisationId: device.organisationId,
            deviceId: device._id,
            branchId: device.branchId,
            sourceType: g.sourceType,
            sourceId: g.sourceId,
            sourceNumber: g.sourceNumber,
            sarTyCd: g.sarTyCd,
            date: g.date,
            movementIds: g.movementIds,
            lines: [...g.lines.entries()].map(([itemId, l]) => ({ itemId: new Types.ObjectId(itemId), quantity: toD128(l.quantity), value: toD128(l.value) })),
          })),
        );
        reports += groups.size;
      }
      await this.db.etimsDevices.updateOne({ _id: device._id }, { stockCursor: movements[movements.length - 1]._id });
    }
    return { reports };
  }

  /** Sends what is due, oldest first per device; a report that fails holds back the ones after it. */
  async deliver(opts: { organisationId?: Types.ObjectId } = {}) {
    let sent = 0;
    let failed = 0;
    const devices = await this.db.etimsDevices.find({ enabled: true, cmcKey: { $ne: null }, ...(opts.organisationId && { organisationId: opts.organisationId }) }).lean();
    for (const device of devices) {
      for (let i = 0; i < 100; i++) {
        const head = await this.db.etimsStockReports.findOne({ deviceId: device._id, status: { $in: ['PENDING', 'FAILED'] } }).sort({ createdAt: 1, _id: 1 }).lean();
        if (!head || head.nextAttemptAt > new Date()) break;
        if (await this.send((await this.db.etimsDevices.findById(device._id).lean())!, head)) sent++;
        else {
          failed++;
          break;
        }
      }
    }
    return { sent, failed };
  }

  private async send(device: EtimsDevice, report: EtimsStockReport) {
    try {
      const items = await this.db.items.find({ _id: { $in: report.lines.map((l) => l.itemId) } }, { name: 1, type: 1, etimsClassCode: 1, salesTaxCodeId: 1 }).lean();
      const codes = await this.db.taxCodes.find({ _id: { $in: items.map((i) => i.salesTaxCodeId).filter(Boolean) } }, { etimsTaxType: 1 }).lean();
      const lines: (StockLine & { itemId: Types.ObjectId })[] = [];
      for (const l of report.lines) {
        const item = items.find((i) => i._id.equals(l.itemId));
        if (!item) throw new Error('An item on this movement no longer exists');
        const classCode = item.etimsClassCode || device.defaultItemClassCode;
        if (!classCode) throw new Error(`Set a KRA item classification on ${item.name} or a default for the branch`);
        const taxTyCd = ((item.salesTaxCodeId && codes.find((c) => c._id.equals(item.salesTaxCodeId!))?.etimsTaxType) || device.defaultTaxType) as EtimsTaxType;
        const registered = await this.etims.ensureItem(device, `item:${item._id.toHexString()}`, { classCode, name: item.name, type: item.type === 'SERVICE' ? '3' : '2' }, taxTyCd);
        lines.push({ itemId: item._id, itemCd: registered.itemCd, itemClsCd: registered.itemClsCd, itemNm: item.name, quantity: dec(l.quantity), value: dec(l.value), taxTyCd });
      }
      let sarNo = report.sarNo;
      if (sarNo == null) {
        sarNo = (await this.db.etimsDevices.findOneAndUpdate({ _id: device._id }, { $inc: { lastSarNo: 1 } }, { new: true }).lean())!.lastSarNo;
        await this.db.etimsStockReports.updateOne({ _id: report._id }, { sarNo });
      }
      const user = { id: 'system', name: 'FarajaSoft' };
      const client = new EtimsClient(device.environment as 'sandbox' | 'production', device.tin, device.bhfId, decryptSecret(device.cmcKey!));
      await this.etims.registerItems(device, client, lines.map((l) => l.itemCd), user);
      await client.saveStockIO(buildStockIO({ tin: device.tin, bhfId: device.bhfId, sarNo, sarTyCd: report.sarTyCd, date: report.date, remark: report.sourceNumber, lines, user }));
      // What was left of each item across the branch's warehouses right after these movements (reports
      // can go out late, so the running balance on the movements is used, not today's).
      const warehouses = await this.db.warehouses.find({ organisationId: device.organisationId, branchId: device.branchId }, { _id: 1 }).lean();
      const last = report.movementIds.reduce((a, b) => (b.toHexString() > a.toHexString() ? b : a), report.movementIds[0]);
      for (const l of lines) {
        let rsdQty = new Decimal(0);
        for (const w of warehouses) {
          const latest = await this.db.stockMovements.findOne({ itemId: l.itemId, warehouseId: w._id, _id: { $lte: last } }, { balanceQuantity: 1 }).sort({ _id: -1 }).lean();
          if (latest) rsdQty = rsdQty.plus(dec(latest.balanceQuantity));
        }
        await client.saveStockMaster({ itemCd: l.itemCd, rsdQty: rsdQty.toNumber(), user });
      }
      await this.db.etimsStockReports.updateOne({ _id: report._id }, { status: 'SENT', sentAt: new Date(), lastError: '', $inc: { attempts: 1 } });
      return true;
    } catch (err) {
      const attempts = report.attempts + 1;
      const backoff = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
      const message = (err instanceof EtimsError || err instanceof Error ? err.message : 'Could not reach KRA').slice(0, 300);
      await this.db.etimsStockReports.updateOne({ _id: report._id }, { status: 'FAILED', attempts, lastError: message, nextAttemptAt: new Date(Date.now() + backoff * 60_000) });
      await this.db.etimsDevices.updateOne({ _id: device._id }, { lastError: `Stock ${report.sourceNumber}: ${message}` });
      return false;
    }
  }

  async list(user: AuthUser, q: { status?: string; limit: number }) {
    const restricted = allowedBranches(user);
    const rows = await this.db.etimsStockReports
      .find({ organisationId: user.organisationId, ...(q.status && { status: q.status }), ...(restricted && { branchId: { $in: restricted } }) }, { movementIds: 0 })
      .sort({ createdAt: -1 })
      .limit(q.limit)
      .lean();
    const items = await this.db.items.find({ _id: { $in: rows.flatMap((r) => r.lines.map((l) => l.itemId)) } }, { code: 1, name: 1 }).lean();
    return rows.map((r) => ({ ...r, lines: r.lines.map((l) => ({ ...l, item: items.find((i) => i._id.equals(l.itemId)) ?? null })) }));
  }

  /** Collects and sends the device's stock reports now (after fixing whatever held them up). */
  async retry(user: AuthUser, deviceId: Types.ObjectId) {
    const device = await this.db.etimsDevices.findOne({ _id: deviceId, organisationId: user.organisationId }).lean();
    if (!device) throw new NotFoundException('eTIMS device not found');
    await this.collect({ organisationId: user.organisationId });
    await this.db.etimsStockReports.updateMany({ deviceId: device._id, status: { $in: ['PENDING', 'FAILED'] } }, { nextAttemptAt: new Date() });
    const res = await this.deliver({ organisationId: user.organisationId });
    await this.audit.log(user, { action: 'etims.stock_retry', recordType: 'Branch', recordId: device.branchId, summary: `Resent KRA eTIMS stock reports: ${res.sent} sent, ${res.failed} failed` });
    return res;
  }
}
