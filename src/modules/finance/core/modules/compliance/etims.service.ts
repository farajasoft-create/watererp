import { ClientSession, Types } from 'mongoose';
import { assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { BadRequestException, HttpError, NotFoundException } from '../../common/errors';
import { Decimal, dec } from '../../common/money';
import { decryptSecret, encryptSecret } from '../../common/totp';
import { EtimsDevice, EtimsItem, EtimsSubmission } from '../../database/compliance.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { buildSale, EtimsClient, EtimsError, EtimsTaxType, itemCode, receiptUrl, SaleLine, TAX_RATES } from './etims';

const BACKOFF_MINUTES = [1, 5, 30, 120, 480];
const PIN = /^[AP]\d{9}[A-Z]$/;

export interface DeviceInput {
  branchId: Types.ObjectId;
  enabled: boolean;
  environment: 'sandbox' | 'production';
  tin: string;
  bhfId: string;
  dvcSrlNo: string;
  defaultItemClassCode: string;
  defaultTaxType: EtimsTaxType;
}

/**
 * KRA eTIMS for Kenyan branches. Posting a sales invoice or credit note in a connected branch queues it
 * (in the posting transaction); the queue sends each branch's documents to KRA strictly in order, so
 * invoice numbers have no gaps, and KRA's signature and QR code are then printed on the document.
 * KRA does not accept cancellations: a signed invoice is corrected with a credit note.
 */
export class EtimsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ----- Devices ------------------------------------------------------------------------------

  private present(d: EtimsDevice) {
    const { cmcKey, ...rest } = d;
    return { ...rest, initialised: !!cmcKey };
  }

  async devices(user: AuthUser) {
    const rows = await this.db.etimsDevices.find({ organisationId: user.organisationId }).lean();
    const counts = await this.db.etimsSubmissions.aggregate<{ _id: { deviceId: Types.ObjectId; status: string }; n: number }>([
      { $match: { organisationId: user.organisationId, status: { $in: ['PENDING', 'FAILED'] } } },
      { $group: { _id: { deviceId: '$deviceId', status: '$status' }, n: { $sum: 1 } } },
    ]);
    const stock = await this.db.etimsStockReports.aggregate<{ _id: { deviceId: Types.ObjectId; status: string }; n: number }>([
      { $match: { organisationId: user.organisationId, status: { $in: ['PENDING', 'FAILED'] } } },
      { $group: { _id: { deviceId: '$deviceId', status: '$status' }, n: { $sum: 1 } } },
    ]);
    const count = (list: typeof counts, id: Types.ObjectId, status: string) => list.find((c) => c._id.deviceId.equals(id) && c._id.status === status)?.n ?? 0;
    return rows.map((d) => ({
      ...this.present(d),
      pending: count(counts, d._id, 'PENDING'),
      failed: count(counts, d._id, 'FAILED'),
      stockPending: count(stock, d._id, 'PENDING'),
      stockFailed: count(stock, d._id, 'FAILED'),
    }));
  }

  async configure(user: AuthUser, input: DeviceInput) {
    const branch = await this.db.branches.findOne({ _id: input.branchId, organisationId: user.organisationId }).lean();
    if (!branch) throw new NotFoundException('Branch not found');
    assertBranchAccess(user, [branch._id]);
    const entity = (await this.db.entities.findById(branch.entityId).lean())!;
    if (entity.functionalCurrency !== 'KES') throw new BadRequestException('eTIMS is for Kenyan entities reporting in KES');
    const tin = input.tin.trim().toUpperCase();
    if (!PIN.test(tin)) throw new BadRequestException('Enter the KRA PIN, e.g. P051234567A');
    if (!/^\d{2}$/.test(input.bhfId)) throw new BadRequestException('The KRA branch ID is two digits ("00" for the head office)');
    if (input.defaultItemClassCode && !/^\d{6,10}$/.test(input.defaultItemClassCode)) throw new BadRequestException('Item classification codes are 6 to 10 digits, from the KRA list');
    const existing = await this.db.etimsDevices.findOne({ organisationId: user.organisationId, branchId: branch._id }).lean();
    // A new PIN, branch ID, serial or environment means a different device: it must be initialised again.
    const identityChanged = !!existing && (existing.tin !== tin || existing.bhfId !== input.bhfId || existing.dvcSrlNo !== input.dvcSrlNo || existing.environment !== input.environment);
    if (identityChanged && existing.lastInvcNo > 0) throw new BadRequestException('This branch has already reported invoices to KRA; contact KRA before changing its device');
    const device = await this.db.etimsDevices.findOneAndUpdate(
      { organisationId: user.organisationId, branchId: branch._id },
      {
        $set: {
          entityId: branch.entityId,
          enabled: input.enabled,
          environment: input.environment,
          tin,
          bhfId: input.bhfId,
          dvcSrlNo: input.dvcSrlNo.trim(),
          defaultItemClassCode: input.defaultItemClassCode,
          defaultTaxType: input.defaultTaxType,
          ...(identityChanged && { cmcKey: null, initialisedAt: null, sdcId: '', mrcNo: '' }),
        },
      },
      { upsert: true, new: true },
    ).lean();
    if (input.enabled && !device!.cmcKey) await this.db.etimsDevices.updateOne({ _id: device!._id }, { enabled: false });
    await this.audit.log(user, { action: 'etims.configure', recordType: 'Branch', recordId: branch._id, summary: `${input.enabled ? 'Configured' : 'Paused'} KRA eTIMS for ${branch.name} (PIN ${tin}, branch ${input.bhfId}, ${input.environment})` });
    return this.present((await this.db.etimsDevices.findById(device!._id).lean())!);
  }

  /** Initialises the device with KRA and stores the communication key. Required once before reporting. */
  async initialise(user: AuthUser, deviceId: Types.ObjectId) {
    const device = await this.db.etimsDevices.findOne({ _id: deviceId, organisationId: user.organisationId }).lean();
    if (!device) throw new NotFoundException('eTIMS device not found');
    if (device.cmcKey && device.lastInvcNo > 0) throw new BadRequestException('Already initialised and reporting; initialising again would invalidate the key');
    let info;
    try {
      info = await new EtimsClient(device.environment as 'sandbox' | 'production', device.tin, device.bhfId, null).initialise(device.dvcSrlNo);
    } catch (err) {
      const message = err instanceof EtimsError ? err.message : 'Could not reach KRA eTIMS';
      await this.db.etimsDevices.updateOne({ _id: device._id }, { lastError: message });
      throw new HttpError(502, message);
    }
    await this.db.etimsDevices.updateOne({ _id: device._id }, { cmcKey: encryptSecret(info.cmcKey), sdcId: info.sdcId, mrcNo: info.mrcNo, tradeName: info.tradeName, initialisedAt: new Date(), stockReportFrom: new Date(), enabled: true, lastError: '' });
    await this.audit.log(user, { action: 'etims.initialise', recordType: 'Branch', recordId: device.branchId, summary: `Initialised KRA eTIMS device ${device.dvcSrlNo} (SDC ${info.sdcId || 'n/a'})` });
    return this.present((await this.db.etimsDevices.findById(device._id).lean())!);
  }

  // ----- Queueing (inside the posting transaction) -----------------------------------------------

  /** Audit listener: queues sales documents as they post and stops voids KRA would not accept. */
  async onAudit(organisationId: Types.ObjectId, event: { type: string; recordType: string; recordId?: Types.ObjectId | null }, session?: ClientSession) {
    if (event.recordType !== 'Invoice' || !event.recordId) return;
    if (event.type === 'document.approve') await this.queue(organisationId, event.recordId, session);
    if (event.type === 'document.void') await this.guardVoid(event.recordId, session);
  }

  private async queue(organisationId: Types.ObjectId, invoiceId: Types.ObjectId, session?: ClientSession) {
    const doc = await this.db.invoices.findById(invoiceId, { kind: 1, branchId: 1, number: 1, appliesToId: 1, status: 1 }).session(session ?? null).lean();
    if (!doc || doc.status !== 'POSTED' || (doc.kind !== 'SALES_INVOICE' && doc.kind !== 'SALES_CREDIT')) return;
    const device = await this.db.etimsDevices.findOne({ organisationId, branchId: doc.branchId, enabled: true }).session(session ?? null).lean();
    if (!device) return;
    if (doc.kind === 'SALES_CREDIT' && !doc.appliesToId) throw new BadRequestException('This branch reports to KRA eTIMS: raise the credit note against the invoice it corrects');
    await this.db.etimsSubmissions.create([{ organisationId, deviceId: device._id, branchId: doc.branchId, invoiceId: doc._id, documentNumber: doc.number, kind: doc.kind === 'SALES_CREDIT' ? 'CREDIT' : 'SALE' }], { session });
    await this.db.invoices.updateOne({ _id: doc._id }, { etims: { status: 'PENDING' } }, { session });
  }

  private async guardVoid(invoiceId: Types.ObjectId, session?: ClientSession) {
    const sub = await this.db.etimsSubmissions.findOne({ invoiceId }).session(session ?? null).lean();
    if (!sub) return;
    if (sub.status === 'SENT') throw new BadRequestException(`${sub.documentNumber} is registered with KRA eTIMS and cannot be voided; issue a credit note instead`);
    if (sub.invcNo != null) throw new BadRequestException(`${sub.documentNumber} has been numbered for KRA eTIMS (invoice ${sub.invcNo}); let it be sent, then issue a credit note`);
    await this.db.etimsSubmissions.updateOne({ _id: sub._id }, { status: 'CANCELLED', lastError: 'Voided before it was sent to KRA' }, { session });
    await this.db.invoices.updateOne({ _id: invoiceId }, { 'etims.status': 'CANCELLED' }, { session });
  }

  // ----- Sending ----------------------------------------------------------------------------------

  /** Sends what is due, oldest first per device; a document that fails holds back the ones after it. */
  async deliverDue(opts: { organisationId?: Types.ObjectId; limit?: number } = {}) {
    let sent = 0;
    let failed = 0;
    const devices = await this.db.etimsDevices.find({ enabled: true, cmcKey: { $ne: null }, ...(opts.organisationId && { organisationId: opts.organisationId }) }).lean();
    for (const device of devices) {
      for (let i = 0; i < (opts.limit ?? 100); i++) {
        const head = await this.db.etimsSubmissions.findOne({ deviceId: device._id, status: { $in: ['PENDING', 'FAILED'] } }).sort({ createdAt: 1, _id: 1 }).lean();
        if (!head || head.nextAttemptAt > new Date()) break;
        const now = new Date();
        const claimed = await this.db.etimsSubmissions
          .findOneAndUpdate({ _id: head._id, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }, { lockedUntil: new Date(now.getTime() + 120_000) }, { new: true })
          .lean();
        if (!claimed) break;
        const ok = await this.send((await this.db.etimsDevices.findById(device._id).lean())!, claimed);
        if (ok) sent++;
        else {
          failed++;
          break;
        }
      }
    }
    return { sent, failed };
  }

  private async send(device: EtimsDevice, sub: EtimsSubmission): Promise<boolean> {
    try {
      const doc = await this.db.invoices.findById(sub.invoiceId).lean();
      if (!doc) throw new Error('The document no longer exists');
      let orgInvcNo = 0;
      if (sub.kind === 'CREDIT') {
        const original = await this.db.etimsSubmissions.findOne({ invoiceId: doc.appliesToId }).lean();
        if (!original || original.status !== 'SENT' || original.invcNo == null) throw new Error('The invoice this credit note corrects has not been registered with KRA');
        orgInvcNo = original.invcNo!;
      }
      const lines = await this.saleLines(device, doc);
      const invcNo = sub.invcNo ?? (await this.nextNumber(device, sub));
      const [customer, actor] = await Promise.all([
        this.db.customers.findById(doc.partyId, { taxId: 1 }).lean(),
        this.db.users.findById(doc.approvedBy ?? doc.createdBy, { name: 1 }).lean(),
      ]);
      const user = { id: (actor?._id ?? doc.approvedBy ?? '').toString().slice(-20) || 'system', name: actor?.name ?? 'FarajaSoft' };
      const client = new EtimsClient(device.environment as 'sandbox' | 'production', device.tin, device.bhfId, decryptSecret(device.cmcKey!));
      await this.registerItems(device, client, lines.map((l) => l.itemCd), user);
      const taxId = (customer?.taxId ?? '').trim().toUpperCase();
      const payload = buildSale({
        tin: device.tin,
        bhfId: device.bhfId,
        invcNo,
        orgInvcNo,
        kind: sub.kind as 'SALE' | 'CREDIT',
        documentNumber: doc.number,
        customerTin: PIN.test(taxId) ? taxId : null,
        customerName: doc.partyName,
        date: doc.date,
        confirmedAt: doc.approvedAt ?? new Date(),
        exchangeRate: doc.currency === 'KES' ? new Decimal(1) : dec(doc.exchangeRate),
        paymentTypeCode: '02',
        lines,
        user,
      });
      const res = await client.saveSale(payload);
      const qrUrl = receiptUrl(device.environment as 'sandbox' | 'production', device.tin, device.bhfId, res.rcptSign);
      await this.db.etimsSubmissions.updateOne(
        { _id: sub._id },
        { status: 'SENT', resultCd: '000', lastError: '', attempts: sub.attempts + 1, lockedUntil: null, sentAt: new Date(), curRcptNo: res.curRcptNo, totRcptNo: res.totRcptNo, intrlData: res.intrlData, rcptSign: res.rcptSign, sdcDateTime: res.sdcDateTime },
      );
      await this.db.invoices.updateOne(
        { _id: doc._id },
        { etims: { status: 'SENT', invcNo, curRcptNo: res.curRcptNo, totRcptNo: res.totRcptNo, intrlData: res.intrlData, rcptSign: res.rcptSign, sdcId: device.sdcId, mrcNo: device.mrcNo, sdcDateTime: res.sdcDateTime, qrUrl } },
      );
      if (device.lastError) await this.db.etimsDevices.updateOne({ _id: device._id }, { lastError: '' });
      return true;
    } catch (err) {
      const attempts = sub.attempts + 1;
      const backoff = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];
      const message = (err instanceof Error ? err.message : 'Could not send to KRA').slice(0, 500);
      await this.db.etimsSubmissions.updateOne(
        { _id: sub._id },
        { status: 'FAILED', attempts, lastError: message, resultCd: err instanceof EtimsError ? err.resultCd : null, nextAttemptAt: new Date(Date.now() + backoff * 60_000), lockedUntil: null },
      );
      await this.db.invoices.updateOne({ _id: sub.invoiceId }, { 'etims.status': 'FAILED' });
      await this.db.etimsDevices.updateOne({ _id: device._id }, { lastError: `${sub.documentNumber}: ${message}` });
      return false;
    }
  }

  /** The KRA item code for an item (or a revenue account's services), created on first use. */
  async ensureItem(device: EtimsDevice, key: string, info: { classCode: string; name: string; type: '1' | '2' | '3' }, taxTyCd: EtimsTaxType) {
    const existing = await this.db.etimsItems.findOne({ deviceId: device._id, key, taxTyCd }).lean();
    if (existing) return existing;
    const seq = (await this.db.etimsDevices.findOneAndUpdate({ _id: device._id }, { $inc: { lastItemSeq: 1 } }, { new: true }).lean())!.lastItemSeq;
    const [created] = await this.db.etimsItems.create([{ organisationId: device.organisationId, deviceId: device._id, key, itemCd: itemCode(info.type, seq), itemClsCd: info.classCode, itemNm: info.name, itemTyCd: info.type, taxTyCd }]);
    return created.toObject() as EtimsItem;
  }

  /** Registers with KRA (saveItem) any of these item codes it has not seen yet. */
  async registerItems(device: EtimsDevice, client: EtimsClient, itemCds: string[], user: { id: string; name: string }) {
    for (const item of await this.db.etimsItems.find({ deviceId: device._id, itemCd: { $in: itemCds }, registeredAt: null }).lean()) {
      await client.saveItem({ itemCd: item.itemCd, itemClsCd: item.itemClsCd, itemTyCd: item.itemTyCd, itemNm: item.itemNm, taxTyCd: item.taxTyCd, dftPrc: 0, user });
      await this.db.etimsItems.updateOne({ _id: item._id }, { registeredAt: new Date() });
    }
  }

  /** Allocates the branch's next KRA invoice number, once per submission (retries reuse it). */
  private async nextNumber(device: EtimsDevice, sub: EtimsSubmission) {
    const updated = await this.db.etimsDevices.findOneAndUpdate({ _id: device._id }, { $inc: { lastInvcNo: 1 } }, { new: true }).lean();
    const invcNo = updated!.lastInvcNo;
    await this.db.etimsSubmissions.updateOne({ _id: sub._id }, { invcNo });
    await this.db.invoices.updateOne({ _id: sub.invoiceId }, { 'etims.invcNo': invcNo });
    return invcNo;
  }

  /** Maps document lines to KRA items and tax types, registering items KRA has not seen yet. */
  private async saleLines(device: EtimsDevice, doc: { lines: { itemId?: Types.ObjectId | null; accountId: Types.ObjectId; description: string; quantity: unknown; unitPrice: unknown; discountPercent?: unknown; taxCodeId?: Types.ObjectId | null; netAmount: unknown; taxAmount: unknown }[]; priceIncludesTax: boolean }): Promise<SaleLine[]> {
    const codeIds = doc.lines.map((l) => l.taxCodeId).filter(Boolean) as Types.ObjectId[];
    const [codes, items, accounts] = await Promise.all([
      this.db.taxCodes.find({ _id: { $in: codeIds } }).lean(),
      this.db.items.find({ _id: { $in: doc.lines.map((l) => l.itemId).filter(Boolean) } }, { code: 1, name: 1, type: 1, etimsClassCode: 1 }).lean(),
      this.db.accounts.find({ _id: { $in: doc.lines.map((l) => l.accountId) } }, { code: 1, name: 1 }).lean(),
    ]);
    const out: SaleLine[] = [];
    for (const l of doc.lines) {
      let taxTyCd: EtimsTaxType = device.defaultTaxType as EtimsTaxType;
      if (l.taxCodeId) {
        const code = codes.find((c) => c._id.equals(l.taxCodeId!));
        const rate = dec(l.netAmount as never).isZero() ? null : dec(l.taxAmount as never).div(dec(l.netAmount as never)).times(100).toDecimalPlaces(0).toNumber();
        taxTyCd = (code?.etimsTaxType as EtimsTaxType | null) ?? (rate === 16 ? 'B' : rate === 8 ? 'E' : (null as never));
        if (!taxTyCd) throw new Error(`Set the eTIMS tax type on tax code ${code?.code ?? '?'} (Setup → Tax)`);
        if (TAX_RATES[taxTyCd] > 0 && rate !== null && rate !== TAX_RATES[taxTyCd]) throw new Error(`Tax code ${code?.code} is mapped to eTIMS type ${taxTyCd} (${TAX_RATES[taxTyCd]}%) but the line was taxed at ${rate}%`);
      }
      const item = l.itemId ? items.find((i) => i._id.equals(l.itemId!)) : null;
      const account = accounts.find((a) => a._id.equals(l.accountId));
      const key = item ? `item:${item._id.toHexString()}` : `account:${l.accountId.toHexString()}`;
      const classCode = item?.etimsClassCode || device.defaultItemClassCode;
      if (!classCode) throw new Error('Set a default KRA item classification for this branch (Setup → eTIMS), or one on each item');
      const registered = await this.ensureItem(device, key, { classCode, name: item ? item.name : (account?.name ?? 'Services'), type: item ? (item.type === 'SERVICE' ? '3' : '2') : '3' }, taxTyCd);
      out.push({
        itemCd: registered.itemCd,
        itemClsCd: registered.itemClsCd,
        itemNm: l.description || registered.itemNm,
        quantity: dec(l.quantity as never),
        unitPrice: dec(l.unitPrice as never),
        priceIncludesTax: doc.priceIncludesTax,
        discountPercent: l.discountPercent ? dec(l.discountPercent as never) : null,
        netAmount: dec(l.netAmount as never),
        taxAmount: dec(l.taxAmount as never),
        taxTyCd,
      });
    }
    return out;
  }

  // ----- Review ----------------------------------------------------------------------------------

  async submissions(user: AuthUser, q: { status?: string; limit: number }) {
    return this.db.etimsSubmissions.find({ organisationId: user.organisationId, ...(q.status && { status: q.status }) }, { intrlData: 0 }).sort({ createdAt: -1 }).limit(q.limit).lean();
  }

  /** Sends the device's queue now (after fixing whatever held it up). */
  async retry(user: AuthUser, deviceId: Types.ObjectId) {
    const device = await this.db.etimsDevices.findOne({ _id: deviceId, organisationId: user.organisationId }).lean();
    if (!device) throw new NotFoundException('eTIMS device not found');
    await this.db.etimsSubmissions.updateMany({ deviceId: device._id, status: { $in: ['PENDING', 'FAILED'] } }, { nextAttemptAt: new Date(), lockedUntil: null });
    const res = await this.deliverDue({ organisationId: user.organisationId });
    await this.audit.log(user, { action: 'etims.retry', recordType: 'Branch', recordId: device.branchId, summary: `Resent the KRA eTIMS queue: ${res.sent} sent, ${res.failed} failed` });
    return { ...res, device: this.present((await this.db.etimsDevices.findById(device._id).lean())!) };
  }
}
