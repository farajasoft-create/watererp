import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { allowedBranches } from '../../common/access';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { Permission, PERMISSIONS } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { ApprovalRequest, ApprovalRule, WorkflowDocumentType } from '../../database/platform.schemas';
import { AuditService } from '../audit/audit.service';

const P = PERMISSIONS;

/** The permission that lets someone approve each kind of document (used by default steps). */
export const APPROVE_PERMISSION: Record<WorkflowDocumentType, Permission> = {
  JOURNAL: P.JOURNAL_APPROVE,
  SALES_INVOICE: P.AR_APPROVE,
  SALES_CREDIT: P.AR_APPROVE,
  PURCHASE_BILL: P.AP_APPROVE,
  PURCHASE_CREDIT: P.AP_APPROVE,
  SUPPLIER_PAYMENT: P.PAYMENTS_APPROVE,
  PURCHASE_REQUISITION: P.PROCUREMENT_APPROVE,
  PURCHASE_ORDER: P.PROCUREMENT_APPROVE,
  EXPENSE_CLAIM: P.EXPENSES_APPROVE,
  IMPREST: P.EXPENSES_APPROVE,
  IMPREST_SURRENDER: P.EXPENSES_APPROVE,
  BUDGET: P.BUDGETS_APPROVE,
  BUDGET_SUBMISSION: P.BUDGETS_APPROVE,
  BUDGET_REALLOCATION: P.BUDGETS_APPROVE,
  STOCK_DOCUMENT: P.INVENTORY_APPROVE,
  CONSOLIDATION_ADJUSTMENT: P.CONSOLIDATION_APPROVE,
};

export const DOCUMENT_LABEL: Record<WorkflowDocumentType, string> = {
  JOURNAL: 'Journal',
  SALES_INVOICE: 'Sales invoice',
  SALES_CREDIT: 'Credit note',
  PURCHASE_BILL: 'Supplier bill',
  PURCHASE_CREDIT: 'Supplier credit',
  SUPPLIER_PAYMENT: 'Supplier payment',
  PURCHASE_REQUISITION: 'Purchase requisition',
  PURCHASE_ORDER: 'Purchase order',
  EXPENSE_CLAIM: 'Expense claim',
  IMPREST: 'Imprest request',
  IMPREST_SURRENDER: 'Imprest surrender',
  BUDGET: 'Budget',
  BUDGET_SUBMISSION: 'Department budget',
  BUDGET_REALLOCATION: 'Budget change',
  STOCK_DOCUMENT: 'Stock adjustment / transfer',
  CONSOLIDATION_ADJUSTMENT: 'Group adjustment',
};

/** Where each document opens in the app (for inbox links and notifications). */
export function documentLink(type: WorkflowDocumentType, id: Types.ObjectId | string): string {
  const x = String(id);
  switch (type) {
    case 'JOURNAL':
      return `/finance/journals/${x}`;
    case 'SALES_INVOICE':
    case 'SALES_CREDIT':
      return `/finance/sales/invoices/${x}`;
    case 'PURCHASE_BILL':
    case 'PURCHASE_CREDIT':
      return `/finance/purchases/bills/${x}`;
    case 'SUPPLIER_PAYMENT':
      return `/finance/purchases/payments/${x}`;
    case 'PURCHASE_REQUISITION':
      return `/finance/purchases/requisitions/${x}`;
    case 'PURCHASE_ORDER':
      return `/finance/purchases/orders/${x}`;
    case 'EXPENSE_CLAIM':
      return '/finance/expenses';
    case 'IMPREST':
    case 'IMPREST_SURRENDER':
      return `/finance/imprest?open=${x}`;
    case 'BUDGET':
      return '/finance/budgets';
    case 'BUDGET_SUBMISSION':
      return `/finance/budgets/planning?submission=${x}`;
    case 'BUDGET_REALLOCATION':
      return `/finance/budgets/planning?tab=changes&change=${x}`;
    case 'STOCK_DOCUMENT':
      return '/finance/inventory/documents';
    case 'CONSOLIDATION_ADJUSTMENT':
      return '/finance/consolidation/adjustments';
  }
}

/** What the engine needs to know about a document. */
export interface WorkflowSubject {
  documentType: WorkflowDocumentType;
  documentId: Types.ObjectId;
  documentNumber: string;
  description: string;
  entityId: Types.ObjectId | null;
  branchId: Types.ObjectId | null;
  /** Value in functional currency (reporting currency for group adjustments), for amount routing. */
  amount: Decimal | null;
  currency: string | null;
  preparedBy: Types.ObjectId | null;
  submittedBy: Types.ObjectId | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- lean documents of many collections */
const money = (v: any) => (v === null || v === undefined ? null : dec(v));
/** Builds the workflow subject from any approvable document. */
export function subjectOf(type: WorkflowDocumentType, doc: any): WorkflowSubject {
  const base = { documentType: type, documentId: doc._id as Types.ObjectId, documentNumber: doc.number ?? '', entityId: doc.entityId ?? null, branchId: doc.branchId ?? null, preparedBy: doc.createdBy ?? null, submittedBy: doc.submittedBy ?? null };
  switch (type) {
    case 'JOURNAL':
      return { ...base, description: doc.description, amount: money(doc.totalDebit), currency: doc.functionalCurrency };
    case 'SALES_INVOICE':
    case 'SALES_CREDIT':
    case 'PURCHASE_BILL':
    case 'PURCHASE_CREDIT':
      return { ...base, description: doc.partyName, amount: money(doc.total)!.times(dec(doc.exchangeRate)), currency: doc.functionalCurrency };
    case 'SUPPLIER_PAYMENT':
      return { ...base, description: doc.partyName, amount: money(doc.amount)!.times(dec(doc.exchangeRate)), currency: doc.functionalCurrency };
    case 'PURCHASE_REQUISITION':
      return { ...base, description: doc.description, amount: money(doc.estimatedTotal), currency: doc.currency };
    case 'PURCHASE_ORDER':
      return { ...base, description: doc.supplierName, amount: money(doc.total)!.times(dec(doc.exchangeRate ?? 1)), currency: doc.functionalCurrency ?? null };
    case 'EXPENSE_CLAIM':
      return { ...base, preparedBy: doc.claimantId, description: `${doc.claimantName}: ${doc.title}`, amount: money(doc.total), currency: doc.currency };
    case 'IMPREST':
      return { ...base, preparedBy: doc.applicantId, description: `${doc.applicantName}: ${doc.purpose}`, amount: money(doc.amount), currency: doc.currency };
    case 'IMPREST_SURRENDER':
      return { ...base, preparedBy: doc.applicantId, submittedBy: doc.surrender?.submittedBy ?? null, description: `${doc.applicantName}: surrender of ${doc.purpose}`, amount: money(doc.surrender?.spent), currency: doc.currency };
    case 'BUDGET':
      return { ...base, documentNumber: doc.name, description: `${doc.kind === 'FORECAST' ? 'Forecast' : 'Budget'} ${doc.name}`, amount: null, currency: doc.currency };
    case 'BUDGET_SUBMISSION':
      return { ...base, description: `Department budget: ${doc.title}`, amount: money(doc.total), currency: null };
    case 'BUDGET_REALLOCATION':
      return { ...base, description: `${doc.kind === 'REALLOCATION' ? 'Reallocation' : doc.kind === 'SUPPLEMENTARY' ? 'Supplementary budget' : 'Budget reduction'}: ${doc.reason}`, amount: money(doc.kind === 'REDUCTION' ? doc.decrease : doc.increase), currency: null };
    case 'STOCK_DOCUMENT':
      return { ...base, description: doc.reason || (doc.kind === 'TRANSFER' ? 'Stock transfer' : 'Stock adjustment'), amount: null, currency: null };
    case 'CONSOLIDATION_ADJUSTMENT':
      return { ...base, description: doc.description, amount: money(doc.total), currency: doc.currency };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type Step = ApprovalRequest['steps'][number];
interface StepState {
  name: string;
  approverType: string;
  roleId: Types.ObjectId | null;
  userId: Types.ObjectId | null;
  requiredApprovals: number;
  status: string;
  approvals: { userId: Types.ObjectId; userName: string; onBehalfOfId: Types.ObjectId | null; onBehalfOfName: string | null; comment: string; at: Date }[];
  startedAt: Date | null;
  completedAt?: Date | null;
}
interface Principal {
  id: Types.ObjectId;
  name: string;
  roleIds: Types.ObjectId[];
  permissions: string[];
}

/**
 * Approval workflow engine. Every submission opens an approval request whose steps come from the first
 * matching rule (document type, entity, branch, amount band) or a default single step for anyone with
 * the approve permission. Steps run in sequence; a step can need several different approvers (parallel
 * approval). Approvers can delegate, overdue steps escalate, and the final approval is the one that
 * lets the document post. All of it is recorded on the request and in the audit trail.
 */
type NotifyListener = (organisationId: Types.ObjectId, userIds: Types.ObjectId[], n: { kind: string; title: string; body?: string; link?: string | null }, session?: ClientSession) => Promise<void>;

export class WorkflowService {
  private listeners: NotifyListener[] = [];

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Other channels (email) for in-app notifications. */
  onNotify(listener: NotifyListener) {
    this.listeners.push(listener);
  }

  // ----- Engine ---------------------------------------------------------------------------------

  private async matchRule(organisationId: Types.ObjectId, s: WorkflowSubject, session?: ClientSession): Promise<ApprovalRule | null> {
    const rules = await this.db.approvalRules.find({ organisationId, documentType: s.documentType, isActive: true }).sort({ priority: 1, createdAt: 1 }).session(session ?? null).lean();
    return (
      rules.find((r) => {
        if (r.entityId && !(s.entityId && r.entityId.equals(s.entityId))) return false;
        if (r.branchIds.length && !(s.branchId && r.branchIds.some((b) => b.equals(s.branchId!)))) return false;
        if (r.minAmount && !(s.amount && s.amount.gte(dec(r.minAmount)))) return false;
        if (r.maxAmount && !(s.amount && s.amount.lt(dec(r.maxAmount)))) return false;
        return true;
      }) ?? null
    );
  }

  /** Starts approval when a document is submitted (cancelling any earlier pending request for it). */
  async open(user: AuthUser, subject: WorkflowSubject, session?: ClientSession) {
    const org = user.organisationId;
    await this.db.approvalRequests.updateMany(
      { organisationId: org, documentType: subject.documentType, documentId: subject.documentId, status: 'PENDING' },
      { status: 'CANCELLED', completedAt: new Date(), rejectionReason: 'Resubmitted' },
      { session },
    );
    const rule = await this.matchRule(org, subject, session);
    const now = new Date();
    const steps = (rule?.steps.length ? rule.steps : [{ name: 'Approval', approverType: 'PERMISSION', roleId: null, userId: null, requiredApprovals: 1 }]).map((st, i) => ({
      name: st.name,
      approverType: st.approverType,
      roleId: st.roleId ?? null,
      userId: st.userId ?? null,
      requiredApprovals: st.requiredApprovals ?? 1,
      status: i === 0 ? 'ACTIVE' : 'WAITING',
      approvals: [],
      startedAt: i === 0 ? now : null,
    }));
    const submitter = subject.submittedBy ?? user.id;
    const submitterName = submitter.equals(user.id) && user.email ? user.name : ((await this.db.users.findById(submitter, { name: 1 }).session(session ?? null).lean())?.name ?? '');
    const [request] = await this.db.approvalRequests.create(
      [
        {
          organisationId: org,
          documentType: subject.documentType,
          documentId: subject.documentId,
          documentNumber: subject.documentNumber,
          description: subject.description,
          entityId: subject.entityId,
          branchId: subject.branchId,
          amount: subject.amount ? toD128(subject.amount) : null,
          currency: subject.currency,
          ruleId: rule?._id ?? null,
          ruleName: rule?.name ?? 'Default approval',
          steps,
          currentStep: 0,
          submittedBy: submitter,
          submittedByName: submitterName,
          preparedBy: subject.preparedBy,
          submittedAt: now,
          dueAt: rule?.slaHours ? new Date(now.getTime() + rule.slaHours * 3_600_000) : null,
          escalateToUserId: rule?.escalateToUserId ?? null,
          escalateToRoleId: rule?.escalateToRoleId ?? null,
        },
      ],
      { session },
    );
    await this.notifyStep(request.toObject() as ApprovalRequest, session);
    return request.toObject() as ApprovalRequest;
  }

  private async principal(id: Types.ObjectId, session?: ClientSession): Promise<Principal | null> {
    const u = await this.db.users.findOne({ _id: id, isActive: true }, { name: 1, roleIds: 1, organisationId: 1 }).session(session ?? null).lean();
    if (!u) return null;
    const roles = await this.db.roles.find({ _id: { $in: u.roleIds }, organisationId: u.organisationId }, { permissions: 1 }).session(session ?? null).lean();
    return { id: u._id, name: u.name, roleIds: u.roleIds, permissions: [...new Set(roles.flatMap((r) => r.permissions))] };
  }

  private canActOnStep(p: Principal, request: ApprovalRequest, step: Step): boolean {
    const permission = APPROVE_PERMISSION[request.documentType as WorkflowDocumentType];
    let direct = false;
    if (step.approverType === 'PERMISSION') direct = p.permissions.includes(permission);
    else if (step.approverType === 'ROLE') direct = !!step.roleId && p.roleIds.some((r) => r.equals(step.roleId!));
    else direct = !!step.userId && p.id.equals(step.userId);
    if (direct) return true;
    if (request.escalatedAt) {
      if (request.escalateToUserId?.equals(p.id)) return true;
      if (request.escalateToRoleId && p.roleIds.some((r) => r.equals(request.escalateToRoleId!))) return true;
    }
    return false;
  }

  /** Whom the user may act for on this request: themselves, or a delegator who is eligible. */
  private async actingAs(user: AuthUser, request: ApprovalRequest, step: Step, session?: ClientSession): Promise<{ self: Principal; principal: Principal } | null> {
    const self = await this.principal(user.id, session);
    if (!self) return null;
    if (this.canActOnStep(self, request, step)) return { self, principal: self };
    const now = new Date();
    const delegations = await this.db.delegations
      .find({ organisationId: user.organisationId, toUserId: user.id, isActive: true, startDate: { $lte: now }, endDate: { $gte: now } })
      .session(session ?? null)
      .lean();
    for (const d of delegations) {
      if (d.documentTypes.length && !d.documentTypes.includes(request.documentType)) continue;
      const from = await this.principal(d.fromUserId, session);
      if (from && this.canActOnStep(from, request, step)) return { self, principal: from };
    }
    return null;
  }

  private describeStep(step: Step, roleName?: string, userName?: string) {
    if (step.approverType === 'ROLE') return `members of ${roleName ?? 'the assigned role'}`;
    if (step.approverType === 'USER') return userName ?? 'the assigned approver';
    return 'anyone with approval rights';
  }

  /**
   * Records an approval. Returns final=true when this approval completes the request, so the caller
   * goes on to post the document; otherwise the document stays submitted for the next approver.
   */
  async gate(user: AuthUser, subject: WorkflowSubject, comment: string | undefined, session?: ClientSession): Promise<{ final: boolean; request: ApprovalRequest }> {
    const found = (await this.db.approvalRequests
      .findOne({ organisationId: user.organisationId, documentType: subject.documentType, documentId: subject.documentId, status: 'PENDING' })
      .session(session ?? null)
      .lean()) as ApprovalRequest | null;
    // Documents submitted before the workflow engine existed get their request now.
    const request = found ?? (await this.open(user, subject, session));
    const step = request.steps[request.currentStep];
    const acting = await this.actingAs(user, request, step, session);
    if (!acting) {
      const [role, assignee] = await Promise.all([
        step.roleId ? this.db.roles.findById(step.roleId, { name: 1 }).session(session ?? null).lean() : null,
        step.userId ? this.db.users.findById(step.userId, { name: 1 }).session(session ?? null).lean() : null,
      ]);
      throw new ForbiddenException(`Step "${step.name}" of ${request.ruleName} is for ${this.describeStep(step, role?.name, assignee?.name)}`);
    }
    const { self, principal } = acting;
    for (const who of [self.id, principal.id]) {
      if (request.preparedBy?.equals(who) || request.submittedBy?.equals(who)) {
        throw new ForbiddenException('Segregation of duties: the preparer or submitter cannot approve');
      }
      if (request.steps.some((st) => st.approvals.some((a) => a.userId.equals(who) || a.onBehalfOfId?.equals(who)))) {
        throw new ForbiddenException('Each step needs a different approver; you have already approved this request');
      }
    }
    const now = new Date();
    const approval = {
      userId: self.id,
      userName: self.name,
      onBehalfOfId: principal === self ? null : principal.id,
      onBehalfOfName: principal === self ? null : principal.name,
      comment: comment ?? '',
      at: now,
    };
    const steps = request.steps.map((st) => ({ ...(st as unknown as StepState), approvals: [...(st.approvals as unknown as StepState['approvals'])] }));
    const current = steps[request.currentStep];
    current.approvals.push(approval);
    let currentStep = request.currentStep;
    let status: string = 'PENDING';
    let dueAt = request.dueAt;
    const stepDone = current.approvals.length >= current.requiredApprovals;
    if (stepDone) {
      current.status = 'APPROVED';
      current.completedAt = now;
      if (currentStep + 1 < steps.length) {
        currentStep += 1;
        steps[currentStep].status = 'ACTIVE';
        steps[currentStep].startedAt = now;
        const rule = request.ruleId ? await this.db.approvalRules.findById(request.ruleId, { slaHours: 1 }).session(session ?? null).lean() : null;
        dueAt = rule?.slaHours ? new Date(now.getTime() + rule.slaHours * 3_600_000) : null;
      } else status = 'APPROVED';
    }
    const updated = await this.db.approvalRequests
      .findOneAndUpdate(
        { _id: request._id, status: 'PENDING', currentStep: request.currentStep, [`steps.${request.currentStep}.approvals`]: { $size: request.steps[request.currentStep].approvals.length } },
        {
          steps,
          currentStep,
          status,
          dueAt,
          ...(stepDone && { escalatedAt: null }),
          ...(status === 'APPROVED' && { completedAt: now, outcomeBy: user.id }),
        },
        { new: true, session },
      )
      .lean();
    if (!updated) throw new BadRequestException('Someone else acted on this approval at the same time; reload and try again');
    const final = status === 'APPROVED';
    const label = DOCUMENT_LABEL[subject.documentType];
    await this.audit.log(
      user,
      {
        action: 'workflow.step',
        recordType: 'ApprovalRequest',
        recordId: updated._id,
        summary: `${label} ${subject.documentNumber}: "${current.name}" approved by ${self.name}${principal === self ? '' : ` for ${principal.name}`}${final ? ' (final approval)' : stepDone ? `; next: "${steps[currentStep].name}"` : ` (${current.approvals.length} of ${current.requiredApprovals})`}`,
      },
      session,
    );
    if (stepDone && !final) await this.notifyStep(updated, session);
    if (final && updated.submittedBy) {
      await this.notify(updated.organisationId, [updated.submittedBy], { kind: 'approved', title: `${label} ${updated.documentNumber} approved`, body: updated.description, link: documentLink(subject.documentType, subject.documentId) }, session);
    }
    return { final, request: updated };
  }

  /** Ends the request when the document is rejected, deleted, cancelled or voided. */
  async close(user: AuthUser, type: WorkflowDocumentType, documentId: Types.ObjectId, outcome: 'REJECTED' | 'CANCELLED', reason: string, session?: ClientSession) {
    const request = await this.db.approvalRequests
      .findOneAndUpdate(
        { organisationId: user.organisationId, documentType: type, documentId, status: 'PENDING' },
        { status: outcome, completedAt: new Date(), outcomeBy: user.id, rejectionReason: reason },
        { new: true, session },
      )
      .lean();
    if (request && outcome === 'REJECTED' && request.submittedBy && !request.submittedBy.equals(user.id)) {
      await this.notify(request.organisationId, [request.submittedBy], { kind: 'rejected', title: `${DOCUMENT_LABEL[type]} ${request.documentNumber} rejected`, body: reason, link: documentLink(type, documentId) }, session);
    }
    return request;
  }

  // ----- Notifications --------------------------------------------------------------------------

  async notify(organisationId: Types.ObjectId, userIds: Types.ObjectId[], n: { kind: string; title: string; body?: string; link?: string | null }, session?: ClientSession) {
    const unique = [...new Map(userIds.map((u) => [u.toHexString(), u])).values()];
    if (!unique.length) return;
    await this.db.notifications.insertMany(
      unique.map((userId) => ({ organisationId, userId, kind: n.kind, title: n.title, body: n.body ?? '', link: n.link ?? null })),
      { session },
    );
    for (const listener of this.listeners) await listener(organisationId, unique, n, session);
  }

  /** Users who may act on the request's current step (excluding its preparer and submitter). */
  async eligibleApprovers(request: ApprovalRequest, session?: ClientSession): Promise<{ _id: Types.ObjectId; name: string }[]> {
    const step = request.steps[request.currentStep];
    const org = request.organisationId;
    const filter: Record<string, unknown> = { organisationId: org, isActive: true, isServiceAccount: { $ne: true } };
    const ors: Record<string, unknown>[] = [];
    if (step.approverType === 'USER' && step.userId) ors.push({ _id: step.userId });
    if (step.approverType === 'ROLE' && step.roleId) ors.push({ roleIds: step.roleId });
    if (step.approverType === 'PERMISSION') {
      const roles = await this.db.roles.find({ organisationId: org, permissions: APPROVE_PERMISSION[request.documentType as WorkflowDocumentType] }, { _id: 1 }).session(session ?? null).lean();
      ors.push({ roleIds: { $in: roles.map((r) => r._id) } });
    }
    if (request.escalatedAt) {
      if (request.escalateToUserId) ors.push({ _id: request.escalateToUserId });
      if (request.escalateToRoleId) ors.push({ roleIds: request.escalateToRoleId });
    }
    if (!ors.length) return [];
    const users = await this.db.users.find({ ...filter, $or: ors }, { name: 1, allBranches: 1, branchIds: 1 }).limit(200).session(session ?? null).lean();
    const excluded = [request.preparedBy, request.submittedBy, ...request.steps.flatMap((s) => s.approvals.map((a) => a.onBehalfOfId ?? a.userId))].filter(Boolean) as Types.ObjectId[];
    return users.filter((u) => !excluded.some((x) => x.equals(u._id)) && (u.allBranches || !request.branchId || u.branchIds.some((b) => b.equals(request.branchId!))));
  }

  private async notifyStep(request: ApprovalRequest, session?: ClientSession) {
    const users = await this.eligibleApprovers(request, session);
    const now = new Date();
    const delegates = await this.db.delegations
      .find({ organisationId: request.organisationId, fromUserId: { $in: users.map((u) => u._id) }, isActive: true, startDate: { $lte: now }, endDate: { $gte: now } }, { toUserId: 1 })
      .session(session ?? null)
      .lean();
    const label = DOCUMENT_LABEL[request.documentType as WorkflowDocumentType];
    const step = request.steps[request.currentStep];
    await this.notify(
      request.organisationId,
      [...users.map((u) => u._id), ...delegates.map((d) => d.toUserId)].slice(0, 100),
      { kind: 'approval', title: `${label} ${request.documentNumber} awaits your approval`, body: `${step.name} · ${request.description}`, link: documentLink(request.documentType as WorkflowDocumentType, request.documentId) },
      session,
    );
  }

  /** Escalates overdue steps: the escalation target can then act, and everyone involved is told. */
  async escalateOverdue(now = new Date()) {
    const overdue = await this.db.approvalRequests.find({ status: 'PENDING', dueAt: { $lt: now }, escalatedAt: null }).limit(500).lean();
    let escalated = 0;
    for (const r of overdue) {
      const updated = await this.db.approvalRequests.findOneAndUpdate({ _id: r._id, escalatedAt: null, status: 'PENDING' }, { escalatedAt: now }, { new: true }).lean();
      if (!updated) continue;
      escalated++;
      const system = { organisationId: r.organisationId, name: 'Workflow' };
      const label = DOCUMENT_LABEL[r.documentType as WorkflowDocumentType];
      await this.audit.log(system, { action: 'workflow.escalate', recordType: 'ApprovalRequest', recordId: r._id, summary: `${label} ${r.documentNumber} overdue at step "${r.steps[r.currentStep].name}"; escalated` });
      const targets: Types.ObjectId[] = [];
      if (r.escalateToUserId) targets.push(r.escalateToUserId);
      if (r.escalateToRoleId) targets.push(...(await this.db.users.find({ organisationId: r.organisationId, roleIds: r.escalateToRoleId, isActive: true }, { _id: 1 }).lean()).map((u) => u._id));
      targets.push(...(await this.eligibleApprovers(updated)).map((u) => u._id));
      await this.notify(r.organisationId, targets, { kind: 'escalation', title: `Overdue: ${label} ${r.documentNumber}`, body: `Waiting at "${r.steps[r.currentStep].name}" since ${r.steps[r.currentStep].startedAt?.toISOString().slice(0, 16).replace('T', ' ')}`, link: documentLink(r.documentType as WorkflowDocumentType, r.documentId) });
    }
    return { escalated };
  }

  // ----- Queries --------------------------------------------------------------------------------

  /** Requests the user can act on now (directly, by delegation or by escalation). */
  async inbox(user: AuthUser) {
    const restricted = allowedBranches(user);
    const pending = await this.db.approvalRequests
      .find({ organisationId: user.organisationId, status: 'PENDING', ...(restricted && { $or: [{ branchId: null }, { branchId: { $in: restricted } }] }) })
      .sort({ submittedAt: 1 })
      .limit(1000)
      .lean();
    const out = [];
    for (const r of pending) {
      const step = r.steps[r.currentStep];
      if (r.preparedBy?.equals(user.id) || r.submittedBy?.equals(user.id)) continue;
      if (r.steps.some((s) => s.approvals.some((a) => a.userId.equals(user.id) || a.onBehalfOfId?.equals(user.id)))) continue;
      const acting = await this.actingAs(user, r, step);
      if (!acting) continue;
      out.push(this.view(r, acting.principal.id.equals(user.id) ? null : acting.principal.name));
    }
    return out;
  }

  view(r: ApprovalRequest, onBehalfOf: string | null = null) {
    const step = r.steps[r.currentStep];
    const now = Date.now();
    return {
      id: r._id,
      documentType: r.documentType,
      documentLabel: DOCUMENT_LABEL[r.documentType as WorkflowDocumentType],
      documentId: r.documentId,
      documentNumber: r.documentNumber,
      description: r.description,
      link: documentLink(r.documentType as WorkflowDocumentType, r.documentId),
      amount: r.amount,
      currency: r.currency,
      ruleName: r.ruleName,
      stepName: step?.name ?? '',
      stepNumber: r.currentStep + 1,
      stepCount: r.steps.length,
      approvalsOnStep: step?.approvals.length ?? 0,
      requiredOnStep: step?.requiredApprovals ?? 1,
      submittedByName: r.submittedByName,
      submittedAt: r.submittedAt,
      waitingHours: step?.startedAt ? Math.round((now - step.startedAt.getTime()) / 360_000) / 10 : null,
      dueAt: r.dueAt,
      overdue: !!r.dueAt && r.dueAt.getTime() < now && r.status === 'PENDING',
      escalated: !!r.escalatedAt,
      status: r.status,
      onBehalfOf,
    };
  }

  async list(user: AuthUser, q: { status?: string; documentType?: string; limit: number }) {
    const restricted = allowedBranches(user);
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.status) filter.status = q.status;
    if (q.documentType) filter.documentType = q.documentType;
    if (restricted) filter.$or = [{ branchId: null }, { branchId: { $in: restricted } }];
    const rows = await this.db.approvalRequests.find(filter).sort({ submittedAt: -1 }).limit(q.limit).lean();
    return rows.map((r) => this.view(r));
  }

  /** The approval history of one document (all requests, newest first). */
  async history(user: AuthUser, documentType: WorkflowDocumentType, documentId: Types.ObjectId) {
    const rows = await this.db.approvalRequests.find({ organisationId: user.organisationId, documentType, documentId }).sort({ submittedAt: -1 }).lean();
    const [roles, users] = await Promise.all([
      this.db.roles.find({ organisationId: user.organisationId }, { name: 1 }).lean(),
      this.db.users.find({ organisationId: user.organisationId }, { name: 1 }).lean(),
    ]);
    return rows.map((r) => ({
      ...this.view(r),
      rejectionReason: r.rejectionReason,
      completedAt: r.completedAt,
      steps: r.steps.map((s) => ({
        name: s.name,
        status: s.status,
        assignedTo: this.describeStep(s, roles.find((x) => s.roleId && x._id.equals(s.roleId))?.name, users.find((x) => s.userId && x._id.equals(s.userId))?.name),
        requiredApprovals: s.requiredApprovals,
        approvals: s.approvals,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      })),
    }));
  }

  /** Average and longest approval times, and current backlog, by document type (SLA tracking). */
  async stats(user: AuthUser, since: Date) {
    const org = user.organisationId;
    const done = await this.db.approvalRequests.find({ organisationId: org, status: 'APPROVED', completedAt: { $gte: since } }, { documentType: 1, submittedAt: 1, completedAt: 1, steps: 1, dueAt: 1 }).lean();
    const pending = await this.db.approvalRequests.find({ organisationId: org, status: 'PENDING' }, { documentType: 1, submittedAt: 1, dueAt: 1 }).lean();
    const types = [...new Set([...done.map((d) => d.documentType), ...pending.map((p) => p.documentType)])];
    const now = Date.now();
    return types.map((t) => {
      const d = done.filter((x) => x.documentType === t);
      const hours = d.map((x) => (x.completedAt!.getTime() - x.submittedAt.getTime()) / 3_600_000);
      const p = pending.filter((x) => x.documentType === t);
      return {
        documentType: t,
        label: DOCUMENT_LABEL[t as WorkflowDocumentType],
        approved: d.length,
        averageHours: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
        longestHours: hours.length ? Math.round(Math.max(...hours) * 10) / 10 : null,
        multiStep: d.filter((x) => x.steps.length > 1).length,
        pending: p.length,
        overdue: p.filter((x) => x.dueAt && x.dueAt.getTime() < now).length,
        oldestPendingHours: p.length ? Math.round(Math.max(...p.map((x) => (now - x.submittedAt.getTime()) / 3_600_000)) * 10) / 10 : null,
      };
    });
  }

  // ----- Rules & delegations --------------------------------------------------------------------

  listRules(user: AuthUser) {
    return this.db.approvalRules.find({ organisationId: user.organisationId }).sort({ documentType: 1, priority: 1 }).lean();
  }

  private async validateRule(user: AuthUser, input: RuleInput) {
    if (!input.steps.length) throw new BadRequestException('Add at least one approval step');
    if (input.minAmount && input.maxAmount && !input.maxAmount.gt(input.minAmount)) throw new BadRequestException('The maximum amount must be above the minimum');
    const org = user.organisationId;
    for (const [i, st] of input.steps.entries()) {
      if (st.approverType === 'ROLE' && !(st.roleId && (await this.db.roles.exists({ _id: st.roleId, organisationId: org })))) throw new BadRequestException(`Step ${i + 1}: choose a role`);
      if (st.approverType === 'USER' && !(st.userId && (await this.db.users.exists({ _id: st.userId, organisationId: org, isServiceAccount: { $ne: true } })))) throw new BadRequestException(`Step ${i + 1}: choose a user`);
      if (st.approverType === 'USER' && (st.requiredApprovals ?? 1) > 1) throw new BadRequestException(`Step ${i + 1}: a step for one named user can only need one approval`);
    }
    if (input.entityId && !(await this.db.entities.exists({ _id: input.entityId, organisationId: org }))) throw new BadRequestException('Unknown entity');
    if (input.escalateToRoleId && !(await this.db.roles.exists({ _id: input.escalateToRoleId, organisationId: org }))) throw new BadRequestException('Unknown escalation role');
    if (input.escalateToUserId && !(await this.db.users.exists({ _id: input.escalateToUserId, organisationId: org }))) throw new BadRequestException('Unknown escalation user');
    if ((input.escalateToRoleId || input.escalateToUserId) && !input.slaHours) throw new BadRequestException('Set an SLA (hours) for escalation to apply');
  }

  private ruleDoc(input: RuleInput) {
    return {
      ...input,
      minAmount: input.minAmount ? toD128(input.minAmount) : null,
      maxAmount: input.maxAmount ? toD128(input.maxAmount) : null,
      steps: input.steps.map((s) => ({ ...s, roleId: s.approverType === 'ROLE' ? s.roleId : null, userId: s.approverType === 'USER' ? s.userId : null, requiredApprovals: s.requiredApprovals ?? 1 })),
    };
  }

  async createRule(user: AuthUser, input: RuleInput) {
    await this.validateRule(user, input);
    const [rule] = await this.db.approvalRules.create([{ ...this.ruleDoc(input), organisationId: user.organisationId, createdBy: user.id }]);
    await this.audit.log(user, { action: 'approval_rule.create', recordType: 'ApprovalRule', recordId: rule._id, summary: `Created approval rule ${input.name} for ${DOCUMENT_LABEL[input.documentType].toLowerCase()}s`, after: rule });
    return rule;
  }

  async updateRule(user: AuthUser, id: Types.ObjectId, input: RuleInput) {
    const before = await this.db.approvalRules.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!before) throw new NotFoundException('Approval rule not found');
    await this.validateRule(user, input);
    const after = await this.db.approvalRules.findByIdAndUpdate(id, this.ruleDoc(input), { new: true }).lean();
    await this.audit.log(user, { action: 'approval_rule.update', recordType: 'ApprovalRule', recordId: id, summary: `Updated approval rule ${input.name} (applies to new submissions)`, before, after });
    return after;
  }

  async deleteRule(user: AuthUser, id: Types.ObjectId) {
    const rule = await this.db.approvalRules.findOneAndDelete({ _id: id, organisationId: user.organisationId }).lean();
    if (!rule) throw new NotFoundException('Approval rule not found');
    await this.audit.log(user, { action: 'approval_rule.delete', recordType: 'ApprovalRule', recordId: id, summary: `Deleted approval rule ${rule.name}`, before: rule });
    return { deleted: true };
  }

  /** Shows which rule and steps a hypothetical document would get. */
  async simulate(user: AuthUser, q: { documentType: WorkflowDocumentType; entityId?: Types.ObjectId; branchId?: Types.ObjectId; amount?: Decimal }) {
    const rule = await this.matchRule(user.organisationId, { documentType: q.documentType, documentId: new Types.ObjectId(), documentNumber: '', description: '', entityId: q.entityId ?? null, branchId: q.branchId ?? null, amount: q.amount ?? null, currency: null, preparedBy: null, submittedBy: null });
    return { rule: rule ? { id: rule._id, name: rule.name, steps: rule.steps, slaHours: rule.slaHours } : null };
  }

  listDelegations(user: AuthUser, all: boolean) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (!all) filter.$or = [{ fromUserId: user.id }, { toUserId: user.id }];
    return this.db.delegations.find(filter).sort({ startDate: -1 }).lean();
  }

  async createDelegation(user: AuthUser, input: { fromUserId?: Types.ObjectId; toUserId: Types.ObjectId; startDate: Date; endDate: Date; documentTypes: string[]; reason?: string }, manageAll: boolean) {
    const fromUserId = input.fromUserId ?? user.id;
    if (!fromUserId.equals(user.id) && !manageAll) throw new ForbiddenException('You can only delegate your own approvals');
    if (fromUserId.equals(input.toUserId)) throw new BadRequestException('Choose someone else to delegate to');
    if (input.endDate < input.startDate) throw new BadRequestException('The delegation ends before it starts');
    const to = await this.db.users.findOne({ _id: input.toUserId, organisationId: user.organisationId, isActive: true, isServiceAccount: { $ne: true } }).lean();
    if (!to) throw new BadRequestException('The delegate must be an active user');
    const endOfDay = new Date(input.endDate.getTime() + 86_400_000 - 1);
    const [d] = await this.db.delegations.create([{ organisationId: user.organisationId, fromUserId, toUserId: to._id, startDate: input.startDate, endDate: endOfDay, documentTypes: input.documentTypes, reason: input.reason ?? '', createdBy: user.id }]);
    const fromName = fromUserId.equals(user.id) ? user.name : ((await this.db.users.findById(fromUserId, { name: 1 }).lean())?.name ?? '');
    await this.audit.log(user, { action: 'delegation.create', recordType: 'Delegation', recordId: d._id, summary: `${fromName} delegated approvals to ${to.name} from ${input.startDate.toISOString().slice(0, 10)} to ${input.endDate.toISOString().slice(0, 10)}` });
    await this.notify(user.organisationId, [to._id], { kind: 'delegation', title: `${fromName} delegated approvals to you`, body: `${input.startDate.toISOString().slice(0, 10)} – ${input.endDate.toISOString().slice(0, 10)}${input.reason ? ` · ${input.reason}` : ''}`, link: '/finance/approvals' });
    return d;
  }

  async endDelegation(user: AuthUser, id: Types.ObjectId, manageAll: boolean) {
    const d = await this.db.delegations.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!d) throw new NotFoundException('Delegation not found');
    if (!manageAll && !d.fromUserId.equals(user.id)) throw new ForbiddenException('Only the person who delegated can end it');
    const after = await this.db.delegations.findByIdAndUpdate(id, { isActive: false }, { new: true }).lean();
    await this.audit.log(user, { action: 'delegation.end', recordType: 'Delegation', recordId: id, summary: 'Ended a delegation of approvals' });
    return after;
  }

  // ----- Notifications API ----------------------------------------------------------------------

  async notifications(user: AuthUser, unreadOnly: boolean) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, userId: user.id };
    if (unreadOnly) filter.readAt = null;
    const [items, unread] = await Promise.all([
      this.db.notifications.find(filter).sort({ createdAt: -1 }).limit(50).lean(),
      this.db.notifications.countDocuments({ organisationId: user.organisationId, userId: user.id, readAt: null }),
    ]);
    return { unread, items };
  }

  async markRead(user: AuthUser, ids: Types.ObjectId[] | 'all') {
    const filter: Record<string, unknown> = { organisationId: user.organisationId, userId: user.id, readAt: null };
    if (ids !== 'all') filter._id = { $in: ids };
    const res = await this.db.notifications.updateMany(filter, { readAt: new Date() });
    return { updated: res.modifiedCount };
  }

  /** Opens requests for documents already awaiting approval (used once when upgrading a tenant). */
  async backfill(organisationId: Types.ObjectId) {
    const system = { id: new Types.ObjectId(), organisationId, name: 'Workflow', email: '', permissions: [], allBranches: true, branchIds: [], approvalLimit: null, ip: null, userAgent: null } as AuthUser;
    const sources: [WorkflowDocumentType | ((d: { kind: string }) => WorkflowDocumentType), () => Promise<unknown[]>][] = [
      ['JOURNAL', () => this.db.journals.find({ organisationId, status: 'SUBMITTED' }).lean()],
      [(d) => d.kind as WorkflowDocumentType, () => this.db.invoices.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['SUPPLIER_PAYMENT', () => this.db.payments.find({ organisationId, status: 'SUBMITTED', kind: 'PAYMENT' }).lean()],
      ['PURCHASE_REQUISITION', () => this.db.requisitions.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['PURCHASE_ORDER', () => this.db.purchaseOrders.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['EXPENSE_CLAIM', () => this.db.expenseClaims.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['IMPREST', () => this.db.imprests.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['BUDGET', () => this.db.budgets.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['BUDGET_SUBMISSION', () => this.db.budgetSubmissions.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['BUDGET_REALLOCATION', () => this.db.budgetReallocations.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['STOCK_DOCUMENT', () => this.db.stockDocuments.find({ organisationId, status: 'SUBMITTED' }).lean()],
      ['CONSOLIDATION_ADJUSTMENT', () => this.db.consolidationAdjustments.find({ organisationId, status: 'SUBMITTED' }).lean()],
    ];
    let opened = 0;
    for (const [type, load] of sources) {
      for (const doc of (await load()) as { _id: Types.ObjectId; kind: string; submittedBy?: Types.ObjectId | null; createdBy?: Types.ObjectId }[]) {
        const t = typeof type === 'function' ? type(doc) : type;
        if (await this.db.approvalRequests.exists({ organisationId, documentType: t, documentId: doc._id, status: 'PENDING' })) continue;
        await this.open({ ...system, id: doc.submittedBy ?? doc.createdBy ?? system.id }, subjectOf(t, doc));
        opened++;
      }
    }
    return opened;
  }
}

export interface RuleInput {
  name: string;
  documentType: WorkflowDocumentType;
  priority: number;
  entityId: Types.ObjectId | null;
  branchIds: Types.ObjectId[];
  minAmount: Decimal | null;
  maxAmount: Decimal | null;
  steps: { name: string; approverType: 'PERMISSION' | 'ROLE' | 'USER'; roleId?: Types.ObjectId | null; userId?: Types.ObjectId | null; requiredApprovals?: number }[];
  slaHours: number | null;
  escalateToUserId: Types.ObjectId | null;
  escalateToRoleId: Types.ObjectId | null;
  isActive: boolean;
}
