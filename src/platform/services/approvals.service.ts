import { createHash, createHmac, createPublicKey, verify as verifySignature, X509Certificate } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '../auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../common/errors';
import { Db } from '../db';
import { EventBus } from '../events';
import { ModuleManifest, withCustomRoles } from '../manifest';
import { AuditService } from './audit.service';
import { NotificationsService } from './notifications.service';

export interface StepRule {
  name: string;
  roles?: string[];
  userIds?: Types.ObjectId[];
  minAmount?: number;
  parallel?: boolean;
}

export interface StartInput {
  module: string;
  docType: string;
  docId: Types.ObjectId;
  title: string;
  amount?: number;
  link?: string;
  /** The document's content (any JSON); its hash is signed with every decision. */
  content?: unknown;
  /** The chain to use when the organisation has not configured one for this document type. */
  defaultSteps: StepRule[];
}

type Decision = 'APPROVED' | 'REJECTED' | 'RETURNED';

function secret() {
  return process.env.SIGNATURE_SECRET || process.env.JWT_SECRET || '';
}

export const hashContent = (content: unknown) => createHash('sha256').update(JSON.stringify(content ?? null)).digest('hex');

/** What a certificate signature covers: the request, the step, the document's hash and the decision. */
export const signedPayload = (requestId: string, step: number, documentHash: string, decision: string) => `${requestId}|${step}|${documentHash}|${decision}`;

/** Reads a public key or an X.509 certificate (PEM); returns the key, its fingerprint and the certificate's details. */
export function readSigningKey(pem: string) {
  const text = pem.trim();
  if (text.includes('BEGIN CERTIFICATE')) {
    const cert = new X509Certificate(text);
    return { kind: 'CERTIFICATE' as const, key: cert.publicKey, publicKeyPem: cert.publicKey.export({ type: 'spki', format: 'pem' }).toString(), certificatePem: text, fingerprint: cert.fingerprint256, subject: cert.subject.replace(/\n/g, ', '), validTo: new Date(cert.validTo), validFrom: new Date(cert.validFrom) };
  }
  const key = createPublicKey(text);
  const der = key.export({ type: 'spki', format: 'der' });
  return { kind: 'KEY' as const, key, publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(), certificatePem: undefined, fingerprint: createHash('sha256').update(der).digest('hex').replace(/(..)(?!$)/g, '$1:').toUpperCase(), subject: undefined, validTo: undefined, validFrom: undefined };
}

export function signatureHash(parts: { requestId: string; step: number; userId: string; at: string; documentHash: string; decision: string }) {
  return createHmac('sha256', secret()).update([parts.requestId, parts.step, parts.userId, parts.at, parts.documentHash, parts.decision].join('|')).digest('hex');
}

/**
 * Approval chains every module uses: configurable steps per document type (by module role or named
 * users, with amount thresholds), maker-checker (nobody approves their own request), notifications to
 * the next approvers, and an electronic signature on each decision. When a chain finishes the module
 * hears `<module>.approval.approved` (or rejected / returned) with the document id.
 */
export class ApprovalsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notifications: NotificationsService,
    private readonly manifests: readonly ModuleManifest[],
  ) {}

  listRules(user: AuthUser, module?: string) {
    return this.db.approvalRules.find({ organisationId: user.organisationId, ...(module && { module }) }).sort({ module: 1, docType: 1 }).lean();
  }

  async saveRule(user: AuthUser, input: { module: string; docType: string; name?: string; steps: StepRule[]; active: boolean }) {
    const org = await this.db.organisations.findById(user.organisationId, { customRoles: 1 }).lean();
    const manifest = withCustomRoles(this.manifests, org?.customRoles).find((m) => m.key === input.module);
    if (!manifest) throw new BadRequestException(`There is no ${input.module} module`);
    for (const s of input.steps) {
      if (s.parallel && (!s.userIds || s.userIds.length < 2 || s.roles?.length)) throw new BadRequestException(`Parallel step "${s.name}" needs two or more named signers (and no roles)`);
      for (const r of s.roles ?? []) if (!manifest.roles[r]) throw new BadRequestException(`${manifest.name} has no role ${r}`);
      if (!s.roles?.length && !s.userIds?.length) throw new BadRequestException(`Step "${s.name}" needs a role or named approvers`);
    }
    const rule = await this.db.approvalRules.findOneAndUpdate({ organisationId: user.organisationId, module: input.module, docType: input.docType }, { ...input, organisationId: user.organisationId }, { upsert: true, new: true }).lean();
    await this.audit.record(user, 'approval.rule.save', 'approvalRule', rule!._id, { module: input.module, docType: input.docType, steps: input.steps.length });
    return rule;
  }

  private async eligibleUsers(organisationId: Types.ObjectId, module: string, step: { roles?: string[] | null; userIds?: Types.ObjectId[] | null }) {
    const or: Record<string, unknown>[] = [];
    if (step.roles?.length) or.push({ access: { $elemMatch: { module, role: { $in: step.roles } } } });
    if (step.userIds?.length) or.push({ _id: { $in: step.userIds } });
    if (!or.length) return [];
    return this.db.users.find({ organisationId, active: true, $or: or }, { _id: 1 }).lean();
  }

  private canAct(user: AuthUser, module: string, step: { roles?: string[] | null; userIds?: Types.ObjectId[] | null; parallel?: boolean | null; signers?: { userId?: Types.ObjectId | null; decision?: string | null }[] | null }) {
    if (step.parallel) return Boolean(step.signers?.some((x) => x.userId?.equals(user.id) && !x.decision));
    if (step.userIds?.some((id) => id.equals(user.id))) return true;
    const role = user.access[module]?.role;
    return Boolean(role && step.roles?.includes(role)) || user.isAdmin;
  }

  /** Opens the chain for a document and tells the first approvers. Returns the request. */
  async start(user: AuthUser, input: StartInput) {
    const open = await this.db.approvalRequests.findOne({ organisationId: user.organisationId, module: input.module, docType: input.docType, docId: input.docId, status: 'PENDING' }).lean();
    if (open) return open;
    const rule = await this.db.approvalRules.findOne({ organisationId: user.organisationId, module: input.module, docType: input.docType, active: true }).lean();
    const amount = input.amount ?? 0;
    const steps = ((rule?.steps?.length ? rule.steps : input.defaultSteps) as StepRule[]).filter((s) => (s.minAmount ?? 0) <= amount);
    if (!steps.length) throw new BadRequestException('No approval step applies to this document');
    const [req] = await this.db.approvalRequests.create([
      {
        organisationId: user.organisationId,
        module: input.module,
        docType: input.docType,
        docId: input.docId,
        title: input.title,
        amount,
        link: input.link,
        requestedBy: user.id,
        steps: steps.map((s) => ({ name: s.name, roles: s.roles ?? [], userIds: s.userIds ?? [], parallel: Boolean(s.parallel), signers: s.parallel ? (s.userIds ?? []).map((userId) => ({ userId })) : [] })),
        documentHash: hashContent(input.content ?? { docId: input.docId, amount, title: input.title }),
      },
    ]);
    await this.audit.record(user, 'approval.start', 'approvalRequest', req._id, { module: input.module, docType: input.docType, docId: input.docId, steps: steps.length });
    await this.tellApprovers(req.toObject());
    return req.toObject();
  }

  private async tellApprovers(req: { _id: Types.ObjectId; organisationId: Types.ObjectId; module: string; title: string; current: number; steps: { name?: string | null; roles?: string[] | null; userIds?: Types.ObjectId[] | null }[]; requestedBy: Types.ObjectId }) {
    const step = req.steps[req.current] as { name?: string | null; roles?: string[] | null; userIds?: Types.ObjectId[] | null; parallel?: boolean | null; signers?: { userId?: Types.ObjectId | null; decision?: string | null }[] };
    if (!step) return;
    const users = step.parallel
      ? (step.signers ?? []).filter((x) => !x.decision && x.userId).map((x) => x.userId!)
      : (await this.eligibleUsers(req.organisationId, req.module, step)).map((u) => u._id).filter((id) => !id.equals(req.requestedBy));
    await this.notifications.notify(req.organisationId, users, { title: `Approval needed: ${req.title}`, body: `Step: ${step.name}`, link: '/approvals', module: req.module, email: true });
  }

  /** Requests waiting at a step the user may approve (never their own). */
  async inbox(user: AuthUser) {
    const pending = await this.db.approvalRequests.find({ organisationId: user.organisationId, status: 'PENDING' }).sort({ createdAt: 1 }).limit(500).lean();
    const mine = pending.filter((r) => !r.requestedBy.equals(user.id) && this.canAct(user, r.module, r.steps[r.current]));
    const users = await this.db.users.find({ _id: { $in: mine.map((r) => r.requestedBy) } }, { name: 1 }).lean();
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    return mine.map((r) => ({ ...r, requestedByName: names.get(r.requestedBy.toHexString()), stepName: r.steps[r.current]?.name }));
  }

  async forDocument(user: AuthUser, module: string, docType: string, docId: Types.ObjectId) {
    return this.db.approvalRequests.find({ organisationId: user.organisationId, module, docType, docId }).sort({ createdAt: -1 }).lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const r = await this.db.approvalRequests.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!r) throw new NotFoundException('Approval not found');
    return { ...r, valid: this.verify(r) };
  }

  /** Re-computes every signature: false if a decision on the record was altered after signing. */
  verify(r: { _id: Types.ObjectId; documentHash?: string | null; steps: { decision?: string | null; by?: Types.ObjectId | null; at?: Date | null; signature?: { signatureHash?: string | null } | null; parallel?: boolean | null; signers?: { userId?: Types.ObjectId | null; decision?: string | null; at?: Date | null; signature?: { signatureHash?: string | null } | null }[] | null }[] }) {
    const ok = (step: number, userId: Types.ObjectId | null | undefined, at: Date | null | undefined, decision: string, hash?: string | null) => Boolean(userId && at) && hash === signatureHash({ requestId: r._id.toHexString(), step, userId: userId!.toHexString(), at: at!.toISOString(), documentHash: r.documentHash ?? '', decision });
    return r.steps.every((s, i) => (s.parallel ? (s.signers ?? []).every((x) => !x.decision || ok(i, x.userId, x.at, x.decision, x.signature?.signatureHash)) : !s.decision || ok(i, s.by, s.at, s.decision, s.signature?.signatureHash)));
  }

  /** Registers a public key or certificate the user will sign with. */
  async addSigningKey(user: AuthUser, input: { label: string; pem: string }) {
    let k;
    try {
      k = readSigningKey(input.pem);
    } catch {
      throw new BadRequestException('That is not a PEM public key or X.509 certificate');
    }
    if (k.validTo && k.validTo < new Date()) throw new BadRequestException('The certificate has expired');
    const u = await this.db.users.findById(user.id, { signingKeys: 1 }).lean();
    if (u?.signingKeys?.some((x) => x.fingerprint === k.fingerprint && !x.revokedAt)) throw new BadRequestException('This key is already registered');
    await this.db.users.updateOne({ _id: user.id }, { $push: { signingKeys: { label: input.label, kind: k.kind, publicKeyPem: k.publicKeyPem, certificatePem: k.certificatePem, fingerprint: k.fingerprint, subject: k.subject, validTo: k.validTo, createdAt: new Date() } } });
    await this.audit.record(user, 'signing-key.add', 'user', user.id, { fingerprint: k.fingerprint, kind: k.kind, subject: k.subject });
    return this.signingKeys(user);
  }

  async signingKeys(user: AuthUser) {
    const u = await this.db.users.findById(user.id, { signingKeys: 1 }).lean();
    return (u?.signingKeys ?? []).map((k) => ({ id: k._id, label: k.label, kind: k.kind, fingerprint: k.fingerprint, subject: k.subject, validTo: k.validTo, createdAt: k.createdAt, revokedAt: k.revokedAt ?? null }));
  }

  async revokeSigningKey(user: AuthUser, keyId: Types.ObjectId) {
    const r = await this.db.users.updateOne({ _id: user.id, 'signingKeys._id': keyId }, { $set: { 'signingKeys.$.revokedAt': new Date() } });
    if (!r.matchedCount) throw new NotFoundException('Key not found');
    await this.audit.record(user, 'signing-key.revoke', 'user', user.id, { keyId });
    return this.signingKeys(user);
  }

  /** Checks a certificate signature over the decision; returns the key's fingerprint. */
  private async checkCertificate(user: AuthUser, payload: string, cert: { keyId: Types.ObjectId; signature: string }) {
    const u = await this.db.users.findById(user.id, { signingKeys: 1 }).lean();
    const k = u?.signingKeys?.find((x) => x._id.equals(cert.keyId));
    if (!k || k.revokedAt) throw new BadRequestException('That signing key is not registered or was revoked');
    if (k.validTo && k.validTo < new Date()) throw new BadRequestException('That certificate has expired');
    const key = createPublicKey(k.publicKeyPem!);
    const sig = Buffer.from(cert.signature, 'base64');
    const good = key.asymmetricKeyType === 'ec' ? verifySignature('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }, sig) || verifySignature('sha256', Buffer.from(payload), key, sig) : verifySignature('sha256', Buffer.from(payload), key, sig);
    if (!good) throw new BadRequestException('The digital signature does not match this decision and document');
    return k.fingerprint!;
  }

  async decide(user: AuthUser, id: Types.ObjectId, input: { decision: Decision; note?: string; signatureImage?: string | null; certificate?: { keyId: Types.ObjectId; signature: string } | null }) {
    const req = await this.db.approvalRequests.findOne({ _id: id, organisationId: user.organisationId });
    if (!req) throw new NotFoundException('Approval not found');
    if (req.status !== 'PENDING') throw new BadRequestException(`Already ${req.status.toLowerCase()}`);
    if (req.requestedBy.equals(user.id) && !user.isAdmin) throw new ForbiddenException('Segregation of duties: someone else must approve what you submitted');
    const step = req.steps[req.current];
    if (!this.canAct(user, req.module, step)) throw new ForbiddenException(`You are not an approver for "${step.name}"`);
    if (input.decision !== 'APPROVED' && !input.note) throw new BadRequestException('Give a reason');
    if (input.signatureImage && (!input.signatureImage.startsWith('data:image/png;base64,') || input.signatureImage.length > 200_000)) throw new BadRequestException('The signature must be a PNG under 150 KB');
    const at = new Date();
    const sig = signatureHash({ requestId: req._id.toHexString(), step: req.current, userId: user.id.toHexString(), at: at.toISOString(), documentHash: req.documentHash ?? '', decision: input.decision });
    const fingerprint = input.certificate ? await this.checkCertificate(user, signedPayload(req._id.toHexString(), req.current, req.documentHash ?? '', input.decision), input.certificate) : undefined;
    const signature = { method: fingerprint ? 'CERTIFICATE' : input.signatureImage ? 'DRAWN' : 'CLICK', ip: user.ip, documentHash: req.documentHash, signatureHash: sig, image: input.signatureImage ?? undefined, keyFingerprint: fingerprint, value: input.certificate?.signature };
    let stepDone = true;
    if (step.parallel) {
      const me = step.signers.find((x) => x.userId?.equals(user.id));
      me!.set({ decision: input.decision, byName: user.name, at, note: input.note, signature });
      // A parallel step closes when anyone rejects or returns, or when every signer has approved.
      stepDone = input.decision !== 'APPROVED' || step.signers.every((x) => x.decision === 'APPROVED');
      if (stepDone) step.set({ decision: input.decision, by: user.id, byName: user.name, at, note: input.note, signature });
    } else step.set({ decision: input.decision, by: user.id, byName: user.name, at, note: input.note, signature });
    if (!stepDone) {
      /* waiting for the other signers of this step */
    } else if (input.decision === 'APPROVED' && req.current < req.steps.length - 1) req.current += 1;
    else req.status = input.decision;
    await req.save();
    await this.audit.record(user, `approval.${input.decision.toLowerCase()}`, 'approvalRequest', id, { module: req.module, docType: req.docType, docId: req.docId, step: step.name, note: input.note });
    if (req.status === 'PENDING' && stepDone) await this.tellApprovers(req.toObject());
    else {
      await this.notifications.notify(req.organisationId, [req.requestedBy], { title: `${req.title}: ${req.status.toLowerCase()}`, body: input.note, link: req.link ?? '/approvals', module: req.module });
      await this.events.emit(req.organisationId, `${req.module}.approval.${req.status.toLowerCase()}`, { docType: req.docType, docId: req.docId, requestId: req._id, by: user.id, note: input.note });
    }
    return req.toObject();
  }

  /** Bulk signing from the inbox: the same decision on several requests. */
  async decideMany(user: AuthUser, ids: Types.ObjectId[], input: { decision: Decision; note?: string }) {
    const results = [];
    for (const id of ids) {
      try {
        const r = await this.decide(user, id, input);
        results.push({ id, ok: true, status: r.status });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : 'Failed' });
      }
    }
    return { results };
  }

  async cancel(user: AuthUser, id: Types.ObjectId) {
    const req = await this.db.approvalRequests.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: 'PENDING', requestedBy: user.id }, { status: 'CANCELLED' }, { new: true }).lean();
    if (!req) throw new BadRequestException('Only your own pending request can be withdrawn');
    await this.events.emit(req.organisationId, `${req.module}.approval.cancelled`, { docType: req.docType, docId: req.docId, requestId: req._id });
    return req;
  }
}
