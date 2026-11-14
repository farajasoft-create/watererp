import { ClientSession, Types } from 'mongoose';
import { assertBranchAccess } from '../../common/access';
import { AuthUser } from '../../common/auth';
import { issuerOf, renderDocumentPdf } from '../../common/document-pdf';
import { BadRequestException, NotFoundException } from '../../common/errors';
import { Decimal, dec, round, toD128 } from '../../common/money';
import { userNames, withTrail } from '../../common/names';
import { assertSegregation, transition } from '../../common/workflow';
import { StoreRequisition } from '../../database/operational.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { JournalsService, LineInput } from '../journals/journals.service';
import { InventoryService, lotInputs, lotsOf } from './inventory.service';

type Id = Types.ObjectId;

export interface StoreRequisitionInput {
  entityId: Id;
  kind: 'ISSUE' | 'BRANCH';
  date: Date;
  purpose: string;
  warehouseId: Id;
  toWarehouseId?: Id | null;
  departmentId?: Id | null;
  lines: { itemId: Id; quantity: Decimal; accountId?: Id | null }[];
}

/**
 * Stores: departments requisition items from a store (counter requisition and issue voucher), approved
 * by the head before the storekeeper issues them and charges the department's expense; counter issues
 * are issued on the spot; branch stores requisition from another store, which dispatches the goods, and
 * the branch acknowledges what arrived, with any shortfall written off.
 */
export class StoreRequisitionsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly journals: JournalsService,
  ) {}

  private async load(user: AuthUser, id: Id, session?: ClientSession) {
    const r = (await this.db.storeRequisitions.findOne({ _id: id, organisationId: user.organisationId }).session(session ?? null).lean()) as StoreRequisition | null;
    if (!r) throw new NotFoundException('Store requisition not found');
    return r;
  }

  list(user: AuthUser, q: { entityId: Id; status?: string; kind?: string }) {
    return this.db.storeRequisitions.find({ organisationId: user.organisationId, entityId: q.entityId, ...(q.status && { status: q.status }), ...(q.kind && { kind: q.kind }) }).sort({ date: -1, createdAt: -1 }).limit(300).lean();
  }

  async get(user: AuthUser, id: Id) {
    return withTrail(this.db, await this.load(user, id));
  }

  private async build(user: AuthUser, input: StoreRequisitionInput, session?: ClientSession) {
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).session(session ?? null).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const from = await this.inventory.warehouse(user.organisationId, input.warehouseId, entity._id, session);
    if (input.kind === 'BRANCH') {
      if (!input.toWarehouseId) throw new BadRequestException('Choose the store being supplied');
      const to = await this.inventory.warehouse(user.organisationId, input.toWarehouseId, entity._id, session);
      if (to._id.equals(from._id)) throw new BadRequestException('The two stores must differ');
      assertBranchAccess(user, [to.branchId]);
    } else if (input.departmentId && !(await this.db.dimensions.exists({ _id: input.departmentId, organisationId: user.organisationId, type: 'DEPARTMENT' }))) {
      throw new BadRequestException('Department not found');
    }
    if (!input.lines.length) throw new BadRequestException('Add the items needed');
    const seen = new Set<string>();
    const lines = [];
    for (const [i, l] of input.lines.entries()) {
      const item = await this.inventory.item(user.organisationId, l.itemId, session);
      if (item.type !== 'STOCK') throw new BadRequestException(`Line ${i + 1}: ${item.code} is not a stock item`);
      if (seen.has(item._id.toHexString())) throw new BadRequestException(`Line ${i + 1}: ${item.code} is listed twice`);
      seen.add(item._id.toHexString());
      if (!l.quantity.gt(0)) throw new BadRequestException(`Line ${i + 1}: quantity must be positive`);
      let accountId: Id | null = null;
      if (input.kind === 'ISSUE') {
        accountId = l.accountId ?? item.cogsAccountId ?? null;
        if (!accountId) throw new BadRequestException(`Line ${i + 1}: choose the expense account charged for ${item.code}`);
        const a = await this.db.accounts.findOne({ _id: accountId, organisationId: user.organisationId }).session(session ?? null).lean();
        if (!a?.isPostable || !['EXPENSE', 'COST_OF_SALES', 'ASSET'].includes(a.accountClass)) throw new BadRequestException(`Line ${i + 1}: choose a postable expense account`);
      }
      lines.push({ lineNo: i + 1, itemId: item._id, accountId, requested: toD128(l.quantity), approved: null, issued: null, received: null, value: null, lots: [] });
    }
    return { entity, from, fields: { entityId: entity._id, kind: input.kind, date: input.date, purpose: input.purpose, warehouseId: from._id, toWarehouseId: input.kind === 'BRANCH' ? input.toWarehouseId! : null, departmentId: input.kind === 'ISSUE' ? (input.departmentId ?? null) : null, lines } };
  }

  async create(user: AuthUser, input: StoreRequisitionInput, counter?: { collectedBy: string }) {
    if (counter && input.kind !== 'ISSUE') throw new BadRequestException('Only issues to users can be made over the counter');
    if (counter && !counter.collectedBy.trim()) throw new BadRequestException('Record who collected the items');
    const created = await this.db.transaction(async (session) => {
      const { entity, fields } = await this.build(user, input, session);
      const number = await this.db.nextNumber(user.organisationId, entity, input.kind === 'BRANCH' ? 'BSV' : 'S11', session);
      const [doc] = await this.db.storeRequisitions.create([{ ...fields, organisationId: user.organisationId, number, counter: !!counter, createdBy: user.id }], { session });
      await this.audit.log(user, { action: 'store_requisition.create', recordType: 'StoreRequisition', recordId: doc._id, summary: `${counter ? 'Counter issue' : 'Store requisition'} ${number}: ${input.purpose}` }, session);
      if (!counter) return doc.toObject() as StoreRequisition;
      // A counter issue is requested and approved by the storekeeper in one step and issued at once.
      const approved = await transition(this.db.storeRequisitions, doc._id, ['DRAFT'], { status: 'APPROVED', submittedBy: user.id, submittedAt: new Date(), approvedBy: user.id, approvedAt: new Date(), lines: fields.lines.map((l) => ({ ...l, approved: l.requested })) }, session);
      return this.issueIn(user, approved as StoreRequisition, { date: input.date, collectedBy: counter.collectedBy, lines: fields.lines.map((l) => ({ lineNo: l.lineNo, quantity: dec(l.requested) })) }, session);
    });
    return created;
  }

  async update(user: AuthUser, id: Id, input: StoreRequisitionInput) {
    const before = await this.load(user, id);
    if (!['DRAFT', 'REJECTED'].includes(before.status)) throw new BadRequestException('Only draft or returned requisitions can be edited');
    const { fields } = await this.build(user, input);
    const after = await transition(this.db.storeRequisitions, id, ['DRAFT', 'REJECTED'], { ...fields, status: 'DRAFT' });
    await this.audit.log(user, { action: 'store_requisition.update', recordType: 'StoreRequisition', recordId: id, summary: `Edited ${before.number}` });
    return after;
  }

  /** Submit, approve (optionally cutting quantities), reject or cancel. */
  async act(user: AuthUser, id: Id, action: 'submit' | 'approve' | 'reject' | 'cancel', input: { reason?: string; approved?: { lineNo: number; quantity: Decimal }[] } = {}) {
    const r = await this.load(user, id);
    const now = new Date();
    let after;
    if (action === 'submit') {
      after = await transition(this.db.storeRequisitions, id, ['DRAFT', 'REJECTED'], { status: 'SUBMITTED', submittedBy: user.id, submittedAt: now });
    } else if (action === 'approve') {
      if (r.status !== 'SUBMITTED') throw new BadRequestException('Only submitted requisitions can be approved');
      assertSegregation(user, r, 'a store requisition');
      const lines = r.lines.map((l) => {
        const cut = input.approved?.find((a) => a.lineNo === l.lineNo);
        const q = cut ? cut.quantity : dec(l.requested);
        if (q.lt(0) || q.gt(dec(l.requested))) throw new BadRequestException(`Line ${l.lineNo}: approve between 0 and the ${dec(l.requested).toFixed()} requested`);
        return { ...l, approved: toD128(q) };
      });
      if (lines.every((l) => dec(l.approved).isZero())) throw new BadRequestException('Approve at least one item, or reject the requisition');
      after = await transition(this.db.storeRequisitions, id, ['SUBMITTED'], { status: 'APPROVED', approvedBy: user.id, approvedAt: now, lines });
    } else if (action === 'reject') {
      if (!input.reason?.trim()) throw new BadRequestException('Give the reason');
      after = await transition(this.db.storeRequisitions, id, ['SUBMITTED'], { status: 'REJECTED', rejectedBy: user.id, rejectedAt: now, rejectionReason: input.reason });
    } else {
      after = await transition(this.db.storeRequisitions, id, ['DRAFT', 'REJECTED', 'SUBMITTED', 'APPROVED'], { status: 'CANCELLED' });
    }
    await this.audit.log(user, { action: `store_requisition.${action}`, recordType: 'StoreRequisition', recordId: id, summary: `${action[0].toUpperCase()}${action.slice(1)} ${r.number}${input.reason ? `: ${input.reason}` : ''}` });
    return after;
  }

  /**
   * The storekeeper issues (ISSUE) or dispatches (BRANCH) up to the approved quantities. Issues charge the
   * department's expense; dispatches move the stock out of the issuing store into transit.
   */
  async issue(user: AuthUser, id: Id, input: { date: Date; collectedBy?: string; reference?: string; lines: { lineNo: number; quantity: Decimal }[] }) {
    return this.db.transaction(async (session) => this.issueIn(user, await this.load(user, id, session), input, session));
  }

  private async issueIn(user: AuthUser, r: StoreRequisition, input: { date: Date; collectedBy?: string; reference?: string; lines: { lineNo: number; quantity: Decimal }[] }, session: ClientSession) {
    if (r.status !== 'APPROVED') throw new BadRequestException(`${r.number} is ${r.status.toLowerCase()}`);
    if (input.date < r.date) throw new BadRequestException('The issue date cannot be before the requisition');
    if (r.kind === 'ISSUE' && !input.collectedBy?.trim()) throw new BadRequestException('Record who collected the items');
    const org = await this.db.organisations.findById(user.organisationId, { settings: 1 }).session(session).lean();
    const entity = (await this.db.entities.findById(r.entityId).session(session).lean())!;
    const from = await this.inventory.warehouse(user.organisationId, r.warehouseId, r.entityId, session);
    const to = r.toWarehouseId ? await this.inventory.warehouse(user.organisationId, r.toWarehouseId, r.entityId, session) : null;
    const source = { type: 'StoreRequisition', id: r._id, number: r.number };
    const journal: LineInput[] = [];
    const leg = (debit: boolean, accountId: Id, branchId: Id, amount: Decimal, description: string, departmentId: Id | null = null): LineInput => ({ accountId, branchId, departmentId, currency: entity.functionalCurrency, description, debit: debit ? amount : null, credit: debit ? null : amount, functionalDebit: debit ? amount : new Decimal(0), functionalCredit: debit ? new Decimal(0) : amount });
    const lines = [];
    for (const l of r.lines) {
      const q = input.lines.find((x) => x.lineNo === l.lineNo)?.quantity ?? new Decimal(0);
      if (q.lt(0) || q.gt(dec(l.approved))) throw new BadRequestException(`Line ${l.lineNo}: issue between 0 and the ${dec(l.approved).toFixed()} approved`);
      if (q.isZero()) {
        lines.push({ ...l, issued: toD128(0), value: toD128(0) });
        continue;
      }
      const item = await this.inventory.item(user.organisationId, l.itemId, session);
      const out = await this.inventory.move(user, { entityId: r.entityId, itemId: item._id, warehouseId: from._id, date: input.date, type: r.kind === 'ISSUE' ? 'ISSUE' : 'TRANSFER_OUT', quantity: q.neg(), source }, session);
      const value = out.value.abs();
      lines.push({ ...l, issued: toD128(q), value: toD128(value), lots: lotsOf(out.lots) });
      if (value.isZero()) continue;
      if (r.kind === 'ISSUE') {
        journal.push(leg(true, l.accountId!, from.branchId, value, `${item.code} issued on ${r.number}`, r.departmentId ?? null));
        journal.push(leg(false, item.inventoryAccountId!, from.branchId, value, `${item.code} issued on ${r.number}`));
      } else {
        // In transit: to the transit account if set, otherwise straight to the receiving branch's inventory.
        const transit = org?.settings?.stockInTransitAccountId ?? null;
        if (transit || !from.branchId.equals(to!.branchId)) {
          journal.push(leg(true, transit ?? item.inventoryAccountId!, transit ? from.branchId : to!.branchId, value, `${item.code} dispatched to ${to!.code}`));
          journal.push(leg(false, item.inventoryAccountId!, from.branchId, value, `${item.code} dispatched to ${to!.code}`));
        }
      }
    }
    if (lines.every((l) => dec(l.issued).isZero())) throw new BadRequestException('Issue at least one item');
    const journalIds: Id[] = [];
    if (journal.length) {
      const j = await this.journals.postSystemJournal(user, { entityId: r.entityId, branchId: from.branchId, journalDate: input.date, description: `${r.kind === 'ISSUE' ? 'Store issue' : 'Branch dispatch'} ${r.number}: ${r.purpose}`, lines: journal }, { sourceType: 'StoreRequisition', sourceId: r._id, sourceNumber: r.number }, session);
      journalIds.push(j._id);
    }
    const after = await transition(
      this.db.storeRequisitions,
      r._id,
      ['APPROVED'],
      { status: r.kind === 'ISSUE' ? 'ISSUED' : 'DISPATCHED', lines, issuedBy: user.id, issuedAt: input.date, collectedBy: input.collectedBy ?? '', reference: input.reference ?? '', journalIds },
      session,
    );
    await this.audit.log(user, { action: r.kind === 'ISSUE' ? 'store_requisition.issue' : 'store_requisition.dispatch', recordType: 'StoreRequisition', recordId: r._id, summary: `${r.kind === 'ISSUE' ? 'Issued' : 'Dispatched'} ${r.number}${input.collectedBy ? ` to ${input.collectedBy}` : ''}` }, session);
    return after;
  }

  /**
   * The receiving store acknowledges a dispatch: what arrived goes into its stock at the dispatched cost;
   * any shortfall is written off to the loss account given.
   */
  async receive(user: AuthUser, id: Id, input: { date: Date; notes?: string; lossAccountId?: Id | null; lines: { lineNo: number; quantity: Decimal }[] }) {
    return this.db.transaction(async (session) => {
      const r = await this.load(user, id, session);
      if (r.kind !== 'BRANCH' || r.status !== 'DISPATCHED') throw new BadRequestException(`${r.number} is not awaiting receipt`);
      if (input.date < (r.issuedAt ?? r.date)) throw new BadRequestException('The receipt date cannot be before the dispatch');
      const org = await this.db.organisations.findById(user.organisationId, { settings: 1 }).session(session).lean();
      const transit = org?.settings?.stockInTransitAccountId ?? null;
      const entity = (await this.db.entities.findById(r.entityId).session(session).lean())!;
      const from = await this.inventory.warehouse(user.organisationId, r.warehouseId, r.entityId, session);
      const to = await this.inventory.warehouse(user.organisationId, r.toWarehouseId!, r.entityId, session);
      assertBranchAccess(user, [to.branchId]);
      const source = { type: 'StoreRequisition', id: r._id, number: r.number };
      const journal: LineInput[] = [];
      const leg = (debit: boolean, accountId: Id, branchId: Id, amount: Decimal, description: string): LineInput => ({ accountId, branchId, currency: entity.functionalCurrency, description, debit: debit ? amount : null, credit: debit ? null : amount, functionalDebit: debit ? amount : new Decimal(0), functionalCredit: debit ? new Decimal(0) : amount });
      const lines = [];
      for (const l of r.lines) {
        const issued = dec(l.issued);
        const got = input.lines.find((x) => x.lineNo === l.lineNo)?.quantity ?? issued;
        if (got.lt(0) || got.gt(issued)) throw new BadRequestException(`Line ${l.lineNo}: receive between 0 and the ${issued.toFixed()} dispatched`);
        lines.push({ ...l, received: toD128(got) });
        if (issued.isZero()) continue;
        const item = await this.inventory.item(user.organisationId, l.itemId, session);
        const value = dec(l.value);
        const gotValue = got.eq(issued) ? value : round(value.times(got).div(issued), 2);
        const lost = value.minus(gotValue);
        if (got.gt(0)) {
          const lots = lotInputs(l.lots);
          await this.inventory.move(user, { entityId: r.entityId, itemId: item._id, warehouseId: to._id, date: input.date, type: 'TRANSFER_IN', quantity: got, value: gotValue, lots: lots.length && got.eq(issued) ? lots : null, source }, session);
        }
        const holding = transit ?? item.inventoryAccountId!;
        const holdingBranch = transit ? from.branchId : to.branchId;
        if (transit && gotValue.gt(0)) {
          journal.push(leg(true, item.inventoryAccountId!, to.branchId, gotValue, `${item.code} received from ${from.code}`));
          journal.push(leg(false, transit, from.branchId, gotValue, `${item.code} received from ${from.code}`));
        }
        if (lost.gt(0)) {
          if (!input.lossAccountId) throw new BadRequestException('Some items did not arrive; choose the account to charge the shortfall to');
          journal.push(leg(true, input.lossAccountId, to.branchId, lost, `${item.code} short on ${r.number}`));
          journal.push(leg(false, holding, holdingBranch, lost, `${item.code} short on ${r.number}`));
        }
      }
      const journalIds = [...r.journalIds];
      if (journal.length) {
        const j = await this.journals.postSystemJournal(user, { entityId: r.entityId, branchId: to.branchId, journalDate: input.date, description: `Branch receipt ${r.number}`, lines: journal }, { sourceType: 'StoreRequisition', sourceId: r._id, sourceNumber: r.number }, session);
        journalIds.push(j._id);
      }
      const after = await transition(this.db.storeRequisitions, r._id, ['DISPATCHED'], { status: 'RECEIVED', lines, receivedBy: user.id, receivedAt: input.date, receiptNotes: input.notes ?? '', journalIds }, session);
      const short = lines.filter((l) => dec(l.received).lt(dec(l.issued)));
      await this.audit.log(user, { action: 'store_requisition.receive', recordType: 'StoreRequisition', recordId: r._id, summary: `Received ${r.number} at ${to.code}${short.length ? `; short on ${short.length} line(s)` : ''}` }, session);
      return after;
    });
  }

  /** The counter requisition and issue voucher (S11) or branch store voucher. */
  async voucher(user: AuthUser, id: Id) {
    const r = await this.load(user, id);
    const [from, to, dept] = await Promise.all([this.db.warehouses.findById(r.warehouseId).lean(), r.toWarehouseId ? this.db.warehouses.findById(r.toWarehouseId).lean() : null, r.departmentId ? this.db.dimensions.findById(r.departmentId).lean() : null]);
    const items = await this.db.items.find({ _id: { $in: r.lines.map((l) => l.itemId) } }, { code: 1, name: 1, unit: 1 }).lean();
    const name = await userNames(this.db, [r.createdBy, r.approvedBy, r.issuedBy, r.receivedBy]);
    const q = (v: unknown) => (v === null || v === undefined ? '' : dec(v as never).toFixed());
    const branch = r.kind === 'BRANCH';
    const data = await renderDocumentPdf({
      title: branch ? 'Branch store voucher' : 'Counter requisition and issue voucher',
      number: r.number,
      date: r.date,
      stamp: ['ISSUED', 'DISPATCHED', 'RECEIVED'].includes(r.status) ? null : r.status === 'CANCELLED' ? 'CANCELLED' : r.status === 'REJECTED' ? 'REJECTED' : 'NOT ISSUED',
      issuer: await issuerOf(this.db, r.entityId, from?.branchId ?? null),
      party: { heading: branch ? 'Supplied to' : 'Requisitioned by', name: branch ? (to?.name ?? '') : (dept?.name ?? name(r.createdBy) ?? ''), lines: [r.purpose] },
      facts: [
        ['From store', from?.name ?? ''],
        ['Status', r.status.charAt(0) + r.status.slice(1).toLowerCase()],
        ...(r.reference ? [['Reference', r.reference] as [string, string]] : []),
      ],
      tables: [
        {
          columns: branch
            ? [{ label: '#', width: 0.06 }, { label: 'Item', width: 0.42 }, { label: 'Requested', width: 0.13, align: 'right' }, { label: 'Approved', width: 0.13, align: 'right' }, { label: 'Dispatched', width: 0.13, align: 'right' }, { label: 'Received', width: 0.13, align: 'right' }]
            : [{ label: '#', width: 0.06 }, { label: 'Item', width: 0.42 }, { label: 'Requested', width: 0.13, align: 'right' }, { label: 'Approved', width: 0.13, align: 'right' }, { label: 'Issued', width: 0.13, align: 'right' }, { label: 'Value', width: 0.13, align: 'right' }],
          rows: r.lines.map((l) => {
            const it = items.find((x) => x._id.equals(l.itemId));
            return [String(l.lineNo), `${it?.code ?? ''} ${it?.name ?? ''}`.trim(), q(l.requested), q(l.approved), q(l.issued), branch ? q(l.received) : l.value ? dec(l.value).toFixed(2) : ''];
          }),
        },
      ],
      sections: r.receiptNotes ? [{ heading: 'Receipt notes', text: r.receiptNotes }] : [],
      signatures: [
        { role: 'Requested by', name: name(r.createdBy) ?? '', date: r.createdAt ?? null },
        { role: 'Approved by', name: name(r.approvedBy) ?? '', date: r.approvedAt ?? null },
        { role: branch ? 'Dispatched by' : 'Issued by', name: name(r.issuedBy) ?? '', date: r.issuedAt ?? null },
        { role: branch ? 'Received by' : 'Collected by', name: branch ? (name(r.receivedBy) ?? '') : r.collectedBy, date: branch ? (r.receivedAt ?? null) : (r.issuedAt ?? null) },
      ],
    });
    return { data, filename: `${branch ? 'Branch store voucher' : 'S11'} ${r.number}.pdf` };
  }
}
