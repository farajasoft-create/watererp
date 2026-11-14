import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { dec } from '../../common/money';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';

type Id = Types.ObjectId;
const secret = () => process.env.SIGNATURE_SECRET || process.env.JWT_SECRET || '';

/** The electronic signature over what the cheque says: number, payee, amount, date and the signer. */
export function chequeSignatureHash(p: { paymentId: string; number: string; payee: string; amount: string; date: string; userId: string; at: string }) {
  return createHmac('sha256', secret()).update([p.paymentId, p.number, p.payee, p.amount, p.date, p.userId, p.at].join('|')).digest('hex');
}

/**
 * Online cheque signing: each bank account names its cheque signatories and how many must sign (e.g. two
 * of three). A posted cheque payment is signed electronically by them, never by whoever prepared or
 * submitted it, and the cheque cannot be printed until enough have signed. Every signature is a hash over
 * the cheque's details, so a later change to the payment shows the signatures no longer match.
 */
export class ChequeSigningService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async setSignatories(user: AuthUser, bankAccountId: Id, input: { userIds: Id[]; required: number }) {
    const bank = await this.db.bankAccounts.findOne({ _id: bankAccountId, organisationId: user.organisationId }).lean();
    if (!bank) throw new NotFoundException('Bank account not found');
    const ids = [...new Set(input.userIds.map(String))].map((x) => new Types.ObjectId(x));
    if (input.required < 0 || input.required > ids.length) throw new BadRequestException('The number of signatures needed must be between 0 and the number of signatories');
    const users = await this.db.users.countDocuments({ _id: { $in: ids }, organisationId: user.organisationId });
    if (users !== ids.length) throw new BadRequestException('A signatory is not a user of this organisation');
    await this.db.bankAccounts.updateOne({ _id: bankAccountId }, { chequeSignatories: ids, chequeSignaturesRequired: input.required });
    await this.audit.log(user, { action: 'bank_account.cheque_signatories', recordType: 'BankAccount', recordId: bankAccountId, summary: `${bank.name}: ${input.required} of ${ids.length} signatories must sign cheques` });
    return { signatories: ids, required: input.required };
  }

  private async load(user: AuthUser, paymentId: Id) {
    const p = await this.db.payments.findOne({ _id: paymentId, organisationId: user.organisationId }).lean();
    if (!p) throw new NotFoundException('Payment not found');
    const bank = await this.db.bankAccounts.findById(p.bankAccountId).lean();
    return { p, bank };
  }

  private hashOf(p: { _id: Id; number: string; partyName: string; amount: unknown; date: Date }, userId: Id, at: Date) {
    return chequeSignatureHash({ paymentId: String(p._id), number: p.number, payee: p.partyName, amount: dec(p.amount as string).toFixed(2), date: p.date.toISOString().slice(0, 10), userId: String(userId), at: at.toISOString() });
  }

  async status(user: AuthUser, paymentId: Id) {
    const { p, bank } = await this.load(user, paymentId);
    const sigs = (p.chequeSignatures ?? []) as { userId: Id; name: string; at: Date; signatureHash: string }[];
    const required = bank?.chequeSignaturesRequired ?? 0;
    const valid = sigs.every((s) => s.signatureHash === this.hashOf(p, s.userId, s.at));
    const signatories = await this.db.users.find({ _id: { $in: bank?.chequeSignatories ?? [] } }, { name: 1 }).lean();
    return {
      required,
      signatories: signatories.map((u) => ({ id: u._id, name: u.name, signed: sigs.some((s) => s.userId.equals(u._id)) })),
      signatures: sigs.map((s) => ({ name: s.name, at: s.at })),
      complete: sigs.length >= required,
      valid,
      canSign: p.status === 'POSTED' && p.method === 'CHEQUE' && (bank?.chequeSignatories ?? []).some((x) => x.equals(user.id)) && !sigs.some((s) => s.userId.equals(user.id)) && !p.createdBy?.equals(user.id) && !p.submittedBy?.equals(user.id),
    };
  }

  async sign(user: AuthUser, paymentId: Id) {
    const { p, bank } = await this.load(user, paymentId);
    if (p.kind !== 'PAYMENT' || p.method !== 'CHEQUE') throw new BadRequestException('Only cheque payments are signed as cheques');
    if (p.status !== 'POSTED') throw new BadRequestException('Sign the cheque once the payment is approved and posted');
    if (!(bank?.chequeSignatories ?? []).some((x) => x.equals(user.id))) throw new ForbiddenException(`You are not a cheque signatory on ${bank?.name ?? 'this account'}`);
    if (p.createdBy?.equals(user.id) || p.submittedBy?.equals(user.id)) throw new ForbiddenException('Segregation of duties: you cannot sign a cheque you prepared or submitted');
    const sigs = (p.chequeSignatures ?? []) as { userId: Id }[];
    if (sigs.some((s) => s.userId.equals(user.id))) throw new BadRequestException('You have already signed this cheque');
    const at = new Date();
    await this.db.payments.updateOne({ _id: p._id }, { $push: { chequeSignatures: { userId: user.id, name: user.name, at, signatureHash: this.hashOf(p, user.id, at), ip: user.ip ?? '' } } });
    await this.audit.log(user, { action: 'payment.cheque_sign', recordType: 'Payment', recordId: p._id, summary: `Signed cheque for ${p.number} (${p.partyName}, ${dec(p.amount).toFixed(2)})` });
    return this.status(user, paymentId);
  }
}
