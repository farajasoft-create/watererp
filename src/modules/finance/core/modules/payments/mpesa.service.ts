import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { actorFor, AuthUser } from '../../common/auth';
import { BadRequestException, ForbiddenException, HttpError, NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { decryptSecret, encryptSecret } from '../../common/totp';
import { Db } from '../../database/db.service';
import { BankAccount } from '../../database/commercial.schemas';
import { MobileMoneyTransaction } from '../../database/payments.schemas';
import { AuditService } from '../audit/audit.service';
import { BankingService } from '../banking/banking.service';
import { appUrl } from '../communication/email.service';
import { PaymentsService } from '../payments/payments.service';
import { SmsService } from '../communication/sms.service';
import { DarajaClient, DarajaError, normalisePhone, parseDarajaTime } from './daraja';

/** Account numbers are compared without spaces, dashes or case ("inv-ke01 000012" matches "INV-KE01-000012"). */
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface MpesaSettingsInput {
  enabled: boolean;
  environment: 'sandbox' | 'production';
  shortCode: string;
  shortCodeType: 'PAYBILL' | 'TILL';
  partyB?: string;
  consumerKey?: string;
  consumerSecret?: string;
  passkey?: string;
  postAsUserId?: Types.ObjectId | null;
}

/**
 * M-Pesa through Safaricom Daraja: payment prompts to customers' phones (STK push) and paybill/till
 * payments (C2B). Every confirmed payment becomes a customer receipt allocated to the invoice it names,
 * plus a statement line already matched to it, so the M-Pesa account reconciles itself. Payments that
 * cannot be matched wait for someone to assign them.
 */
export class MpesaService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly banking: BankingService,
    private readonly sms: SmsService,
  ) {}

  // ----- Configuration --------------------------------------------------------------------------

  private async account(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.db.bankAccounts.findOne({ _id: bankId, organisationId: user.organisationId }).lean();
    if (!bank) throw new NotFoundException('Bank account not found');
    return bank;
  }

  callbacks(bank: Pick<BankAccount, 'mpesa'>) {
    const secret = bank.mpesa?.callbackSecret;
    const base = `${appUrl()}/api/v1/mpesa/callbacks/${secret}`;
    return {
      stk: `${base}/stk`,
      confirmation: `${base}/confirmation`,
      validation: `${base}/validation`,
      payoutResult: `${base}/payout-result`,
      payoutTimeout: `${base}/payout-timeout`,
      statusResult: (payoutId: string) => `${base}/status-result/${payoutId}`,
      balanceResult: `${base}/balance-result`,
      queryTimeout: `${base}/query-timeout`,
    };
  }

  async settings(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.account(user, bankId);
    const m = bank.mpesa;
    return {
      enabled: !!m?.enabled,
      environment: m?.environment ?? 'sandbox',
      shortCode: m?.shortCode ?? '',
      shortCodeType: m?.shortCodeType ?? 'PAYBILL',
      partyB: m?.partyB ?? '',
      hasConsumerKey: !!m?.consumerKey,
      hasConsumerSecret: !!m?.consumerSecret,
      hasPasskey: !!m?.passkey,
      postAsUserId: m?.postAsUserId ?? null,
      registeredAt: m?.registeredAt ?? null,
      payouts: {
        enabled: !!m?.payouts?.enabled,
        shortCode: m?.payouts?.shortCode ?? '',
        initiatorName: m?.payouts?.initiatorName ?? '',
        hasSecurityCredential: !!m?.payouts?.securityCredential,
        dailyLimit: m?.payouts?.dailyLimit ?? null,
        lowBalanceAlert: m?.payouts?.lowBalanceAlert ?? null,
        tariff: m?.payouts?.tariff ?? [],
        chargesAccountId: m?.payouts?.chargesAccountId ?? null,
        balance: m?.payouts?.balance?.checkedAt ? { available: m.payouts.balance.available, accounts: m.payouts.balance.accounts, checkedAt: m.payouts.balance.checkedAt } : null,
      },
      callbackUrls: m?.callbackSecret ? this.callbacks(bank) : null,
    };
  }

  async configure(user: AuthUser, bankId: Types.ObjectId, input: MpesaSettingsInput) {
    const bank = await this.account(user, bankId);
    if (input.enabled) {
      if (bank.type !== 'MOBILE_MONEY') throw new BadRequestException('M-Pesa connects to a mobile-money account; change the account type first');
      if (bank.currency !== 'KES') throw new BadRequestException('M-Pesa accounts are in KES');
      if (!/^\d{5,7}$/.test(input.shortCode)) throw new BadRequestException('Enter the paybill or till number');
      if (!(input.consumerKey || bank.mpesa?.consumerKey) || !(input.consumerSecret || bank.mpesa?.consumerSecret) || !(input.passkey || bank.mpesa?.passkey)) {
        throw new BadRequestException('Enter the consumer key, consumer secret and passkey from the Daraja portal');
      }
    }
    const postAs = input.postAsUserId ?? bank.mpesa?.postAsUserId ?? user.id;
    const poster = await actorFor(this.db, postAs);
    if (input.enabled && (!poster || !poster.permissions.includes('ar.manage'))) throw new BadRequestException('Receipts must be recorded by an active user who can manage receivables');
    const update: Record<string, unknown> = {
      'mpesa.enabled': input.enabled,
      'mpesa.environment': input.environment,
      'mpesa.shortCode': input.shortCode,
      'mpesa.shortCodeType': input.shortCodeType,
      'mpesa.partyB': input.partyB ?? '',
      'mpesa.postAsUserId': postAs,
    };
    if (input.consumerKey) update['mpesa.consumerKey'] = encryptSecret(input.consumerKey);
    if (input.consumerSecret) update['mpesa.consumerSecret'] = encryptSecret(input.consumerSecret);
    if (input.passkey) update['mpesa.passkey'] = encryptSecret(input.passkey);
    if (!bank.mpesa?.callbackSecret) update['mpesa.callbackSecret'] = randomBytes(24).toString('base64url');
    await this.db.bankAccounts.updateOne({ _id: bank._id }, update);
    await this.audit.log(user, { action: 'bank_account.mpesa', recordType: 'BankAccount', recordId: bank._id, summary: `${input.enabled ? 'Connected' : 'Disconnected'} M-Pesa ${input.shortCodeType.toLowerCase()} ${input.shortCode} (${input.environment}) on ${bank.name}` });
    return this.settings(user, bankId);
  }

  client(bank: BankAccount) {
    const m = bank.mpesa;
    if (!m?.enabled || !m.consumerKey || !m.consumerSecret) throw new BadRequestException(`M-Pesa is not connected on ${bank.name}`);
    return new DarajaClient(m.environment as 'sandbox' | 'production', decryptSecret(m.consumerKey), decryptSecret(m.consumerSecret));
  }

  /** Registers the confirmation and validation URLs with Safaricom (once per short code). */
  async register(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.account(user, bankId);
    const urls = this.callbacks(bank);
    try {
      await this.client(bank).registerC2B({ shortCode: bank.mpesa!.shortCode, confirmationUrl: urls.confirmation, validationUrl: urls.validation });
    } catch (err) {
      throw new HttpError(502, err instanceof DarajaError ? err.message : 'Could not reach M-Pesa');
    }
    await this.db.bankAccounts.updateOne({ _id: bank._id }, { 'mpesa.registeredAt': new Date() });
    await this.audit.log(user, { action: 'bank_account.mpesa_register', recordType: 'BankAccount', recordId: bank._id, summary: `Registered M-Pesa payment notifications for ${bank.mpesa!.shortCode}` });
    return this.settings(user, bankId);
  }

  // ----- Requesting payment (STK push) ----------------------------------------------------------

  /** The connected M-Pesa account that collects for an entity, if any. */
  async collectingAccount(organisationId: Types.ObjectId, entityId: Types.ObjectId) {
    return this.db.bankAccounts.findOne({ organisationId, entityId, isActive: true, type: 'MOBILE_MONEY', currency: 'KES', 'mpesa.enabled': true }).lean();
  }

  /**
   * Sends a payment prompt for an invoice to the customer's phone. Called by staff (with their user)
   * or from the customer portal (no user; the portal link is the authority).
   */
  async requestPayment(input: { organisationId: Types.ObjectId; invoiceId: Types.ObjectId; phone: string; amount?: Decimal | null; requestedBy?: Types.ObjectId | null; via: 'app' | 'portal' }) {
    const invoice = await this.db.invoices.findOne({ _id: input.invoiceId, organisationId: input.organisationId, kind: 'SALES_INVOICE', status: 'POSTED' }).lean();
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.currency !== 'KES') throw new BadRequestException('M-Pesa payments are in KES; this invoice is in another currency');
    const due = dec(invoice.amountDue);
    if (due.lte(0)) throw new BadRequestException(`${invoice.number} is already paid`);
    const phone = normalisePhone(input.phone);
    if (!phone) throw new BadRequestException('Enter a Safaricom number such as 0712 345 678');
    const amount = (input.amount ?? due).toDecimalPlaces(0, Decimal.ROUND_UP);
    if (amount.lt(1) || amount.gt(due.toDecimalPlaces(0, Decimal.ROUND_UP))) throw new BadRequestException(`Enter an amount between 1 and ${due.toDecimalPlaces(0, Decimal.ROUND_UP).toFixed()}`);
    if (amount.gt(250_000)) throw new BadRequestException('M-Pesa prompts are limited to KES 250,000; pay the rest by paybill or bank transfer');
    const bank = await this.collectingAccount(input.organisationId, invoice.entityId);
    if (!bank) throw new BadRequestException('This business does not take M-Pesa payments online yet');
    // One prompt at a time per invoice and phone, so a double click does not charge twice.
    const recent = await this.db.mobileMoney.findOne({ invoiceId: invoice._id, phone, status: 'PENDING', createdAt: { $gte: new Date(Date.now() - 2 * 60_000) } }).lean();
    if (recent) throw new BadRequestException('A payment prompt was just sent to that phone; complete or cancel it first');
    let res: { MerchantRequestID: string; CheckoutRequestID: string; CustomerMessage: string };
    try {
      res = await this.client(bank).stkPush({
        shortCode: bank.mpesa!.shortCode,
        passkey: decryptSecret(bank.mpesa!.passkey!),
        till: bank.mpesa!.shortCodeType === 'TILL',
        partyB: bank.mpesa!.partyB ?? undefined,
        amount: amount.toNumber(),
        phone,
        callbackUrl: this.callbacks(bank).stk,
        accountReference: clean(invoice.number).slice(-12),
        description: `Inv ${invoice.number}`.slice(0, 13),
      });
    } catch (err) {
      throw new HttpError(502, err instanceof DarajaError ? err.message : 'Could not reach M-Pesa; try again');
    }
    const [tx] = await this.db.mobileMoney.create([
      {
        organisationId: input.organisationId,
        entityId: invoice.entityId,
        bankAccountId: bank._id,
        kind: 'STK',
        amount: toD128(amount),
        phone,
        accountReference: invoice.number,
        status: 'PENDING',
        customerId: invoice.partyId,
        invoiceId: invoice._id,
        checkoutRequestId: res.CheckoutRequestID,
        merchantRequestId: res.MerchantRequestID,
        requestedBy: input.requestedBy ?? null,
        requestedVia: input.via,
      },
    ]);
    await this.audit.log(
      { organisationId: input.organisationId, name: input.via === 'portal' ? 'Customer portal' : 'M-Pesa' },
      { action: 'mpesa.request', recordType: 'Invoice', recordId: invoice._id, summary: `Sent an M-Pesa prompt for KES ${amount.toFixed()} on ${invoice.number} to ${phone.slice(0, 6)}••••${phone.slice(-2)}` },
    );
    return { id: tx._id, message: res.CustomerMessage, amount: amount.toFixed(), status: 'PENDING' };
  }

  /** Prompts Safaricom never answered (the phone was off, the callback was lost) are given up after 15 minutes. */
  async expireStale(organisationId?: Types.ObjectId) {
    const res = await this.db.mobileMoney.updateMany(
      { ...(organisationId && { organisationId }), kind: 'STK', status: 'PENDING', createdAt: { $lt: new Date(Date.now() - 15 * 60_000) } },
      { status: 'FAILED', resultDescription: 'No answer from M-Pesa; the prompt expired' },
    );
    return { expired: res.modifiedCount };
  }

  /**
   * Asks M-Pesa what became of payment prompts still waiting for their callback (lost callbacks, or the
   * customer walked away). Each prompt is asked about at most every 30 seconds.
   */
  async queryPending(filter: { organisationId?: Types.ObjectId; id?: Types.ObjectId } = {}) {
    const now = Date.now();
    const pending = await this.db.mobileMoney
      .find({
        ...(filter.organisationId && { organisationId: filter.organisationId }),
        ...(filter.id && { _id: filter.id }),
        kind: 'STK',
        status: 'PENDING',
        createdAt: { $lte: new Date(now - 45_000) },
        $or: [{ queriedAt: null }, { queriedAt: { $lte: new Date(now - 30_000) } }],
      })
      .limit(50)
      .lean();
    let resolved = 0;
    for (const tx of pending) {
      await this.db.mobileMoney.updateOne({ _id: tx._id }, { queriedAt: new Date() });
      const bank = await this.db.bankAccounts.findById(tx.bankAccountId).lean();
      if (!bank?.mpesa?.enabled || !bank.mpesa.passkey) continue;
      let res: { ResultCode?: string | number; ResultDesc?: string };
      try {
        res = await this.client(bank).stkQuery({ shortCode: bank.mpesa.shortCode, passkey: decryptSecret(bank.mpesa.passkey), checkoutRequestId: tx.checkoutRequestId! });
      } catch {
        // Still being processed, or M-Pesa is unreachable: ask again later.
        continue;
      }
      if (res.ResultCode === undefined || res.ResultCode === null || res.ResultCode === '') continue;
      if (Number(res.ResultCode) === 0) {
        // The query does not return the M-Pesa receipt number; the request ID stands in until the callback.
        const claimed = await this.db.mobileMoney
          .findOneAndUpdate({ _id: tx._id, status: 'PENDING' }, { status: 'UNMATCHED', transactionId: `STK-${tx.checkoutRequestId}`, transactionDate: new Date(), resultDescription: res.ResultDesc ?? 'Paid', note: 'Confirmed by status query' }, { new: true })
          .lean();
        if (claimed) await this.settle(bank, claimed);
      } else {
        await this.db.mobileMoney.updateOne({ _id: tx._id, status: 'PENDING' }, { status: 'FAILED', resultDescription: res.ResultDesc ?? 'Not completed' });
      }
      resolved++;
    }
    return { queried: pending.length, resolved };
  }

  async status(organisationId: Types.ObjectId, id: Types.ObjectId) {
    await this.queryPending({ organisationId, id });
    await this.expireStale(organisationId);
    const tx = await this.db.mobileMoney.findOne({ _id: id, organisationId }, { status: 1, resultDescription: 1, transactionId: 1, amount: 1 }).lean();
    if (!tx) throw new NotFoundException('Payment not found');
    return tx;
  }

  // ----- Callbacks from Safaricom ---------------------------------------------------------------

  /**
   * Paying out from this account: the disbursement short code, the API initiator and its security
   * credential (generated on the Daraja portal), and an optional daily limit.
   */
  async configurePayouts(
    user: AuthUser,
    bankId: Types.ObjectId,
    input: { enabled: boolean; shortCode: string; initiatorName: string; securityCredential?: string; dailyLimit?: Decimal | null; lowBalanceAlert?: Decimal | null; tariff?: { upTo: Decimal; charge: Decimal }[]; chargesAccountId?: Types.ObjectId | null },
  ) {
    const bank = await this.account(user, bankId);
    if (input.enabled) {
      if (!bank.mpesa?.enabled) throw new BadRequestException('Connect M-Pesa on this account first');
      if (!/^\d{5,7}$/.test(input.shortCode)) throw new BadRequestException('Enter the disbursement short code');
      if (!input.initiatorName.trim()) throw new BadRequestException('Enter the API initiator name from the M-Pesa portal');
      if (!input.securityCredential && !bank.mpesa?.payouts?.securityCredential) throw new BadRequestException('Paste the security credential generated for the initiator');
    }
    if (input.dailyLimit && input.dailyLimit.lte(0)) throw new BadRequestException('The daily limit must be positive');
    const tariff = [...(input.tariff ?? [])].sort((a, b) => a.upTo.comparedTo(b.upTo));
    if (tariff.some((b) => b.upTo.lte(0) || b.charge.isNeg())) throw new BadRequestException('Each charge band needs a positive upper amount and a charge of zero or more');
    if (new Set(tariff.map((b) => b.upTo.toFixed())).size !== tariff.length) throw new BadRequestException('Two charge bands end at the same amount');
    if (input.chargesAccountId) {
      const a = await this.db.accounts.findOne({ _id: input.chargesAccountId, organisationId: user.organisationId }).lean();
      if (!a?.isPostable || a.accountClass !== 'EXPENSE') throw new BadRequestException('M-Pesa charges go to a postable expense account');
    }
    const update: Record<string, unknown> = {
      'mpesa.payouts.enabled': input.enabled,
      'mpesa.payouts.shortCode': input.shortCode,
      'mpesa.payouts.initiatorName': input.initiatorName.trim(),
      'mpesa.payouts.dailyLimit': input.dailyLimit ? toD128(input.dailyLimit) : null,
      'mpesa.payouts.lowBalanceAlert': input.lowBalanceAlert ? toD128(input.lowBalanceAlert) : null,
      ...(input.tariff && { 'mpesa.payouts.tariff': tariff.map((b) => ({ upTo: toD128(b.upTo), charge: toD128(b.charge) })) }),
      ...(input.chargesAccountId !== undefined && { 'mpesa.payouts.chargesAccountId': input.chargesAccountId }),
    };
    if (input.securityCredential) update['mpesa.payouts.securityCredential'] = encryptSecret(input.securityCredential.trim());
    await this.db.bankAccounts.updateOne({ _id: bank._id }, update);
    await this.audit.log(user, {
      action: 'bank_account.mpesa_payouts',
      recordType: 'BankAccount',
      recordId: bank._id,
      summary: `${input.enabled ? 'Enabled' : 'Disabled'} M-Pesa payouts from ${bank.name}${input.enabled ? ` (short code ${input.shortCode}${input.dailyLimit ? `, daily limit KES ${input.dailyLimit.toFixed()}` : ''})` : ''}`,
    });
    return this.settings(user, bankId);
  }

  async bySecret(secret: string) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(secret)) return null;
    return this.db.bankAccounts.findOne({ 'mpesa.callbackSecret': secret, 'mpesa.enabled': true }).lean();
  }

  /** Result of a payment prompt. */
  async stkCallback(secret: string, body: unknown) {
    const bank = await this.bySecret(secret);
    if (!bank) throw new ForbiddenException('Unknown callback');
    const cb = (body as { Body?: { stkCallback?: { CheckoutRequestID?: string; ResultCode?: number | string; ResultDesc?: string; CallbackMetadata?: { Item?: { Name: string; Value?: string | number }[] } } } })?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) throw new BadRequestException('Not an STK callback');
    const tx = await this.db.mobileMoney.findOne({ bankAccountId: bank._id, checkoutRequestId: cb.CheckoutRequestID }).lean();
    if (tx && tx.status !== 'PENDING' && tx.transactionId?.startsWith('STK-') && Number(cb.ResultCode) === 0) {
      // Already settled from a status query: record the real receipt number now that it is known.
      const receipt = String(cb.CallbackMetadata?.Item?.find((i) => i.Name === 'MpesaReceiptNumber')?.Value ?? '');
      if (receipt) {
        await this.db.mobileMoney.updateOne({ _id: tx._id }, { transactionId: receipt, note: '' });
        if (tx.paymentId) await this.db.payments.updateOne({ _id: tx.paymentId }, { reference: receipt });
        if (tx.statementLineId) await this.db.bankStatementLines.updateOne({ _id: tx.statementLineId }, { reference: receipt });
      }
      return { ok: true };
    }
    if (!tx || tx.status !== 'PENDING') return { ok: true };
    if (Number(cb.ResultCode) !== 0) {
      await this.db.mobileMoney.updateOne({ _id: tx._id, status: 'PENDING' }, { status: 'FAILED', resultDescription: cb.ResultDesc ?? 'Cancelled' });
      return { ok: true };
    }
    const item = (name: string) => cb.CallbackMetadata?.Item?.find((i) => i.Name === name)?.Value;
    const receipt = String(item('MpesaReceiptNumber') ?? '');
    const amount = new Decimal(String(item('Amount') ?? tx.amount?.toString() ?? '0'));
    const claimed = await this.db.mobileMoney.findOneAndUpdate(
      { _id: tx._id, status: 'PENDING' },
      { transactionId: receipt || null, amount: toD128(amount), transactionDate: parseDarajaTime(item('TransactionDate') as string) ?? new Date(), resultDescription: cb.ResultDesc ?? '', status: 'UNMATCHED' },
      { new: true },
    ).lean();
    if (claimed) await this.settle(bank, claimed);
    return { ok: true };
  }

  /** Paybill / till payment confirmation. Idempotent: Safaricom may send the same payment twice. */
  async c2bConfirmation(secret: string, body: Record<string, unknown>) {
    const bank = await this.bySecret(secret);
    if (!bank) throw new ForbiddenException('Unknown callback');
    const transactionId = String(body.TransID ?? '');
    const amount = new Decimal(String(body.TransAmount ?? '0'));
    if (!transactionId || amount.lte(0)) throw new BadRequestException('Not a C2B confirmation');
    if (await this.db.mobileMoney.exists({ bankAccountId: bank._id, transactionId })) return { ResultCode: 0, ResultDesc: 'Accepted' };
    const reference = String(body.BillRefNumber ?? body.InvoiceNumber ?? '').trim();
    const name = [body.FirstName, body.MiddleName, body.LastName].filter((x) => x && String(x).trim()).join(' ');
    let tx: MobileMoneyTransaction;
    try {
      const [created] = await this.db.mobileMoney.create([
        {
          organisationId: bank.organisationId,
          entityId: bank.entityId,
          bankAccountId: bank._id,
          kind: 'C2B',
          transactionId,
          amount: toD128(amount),
          phone: String(body.MSISDN ?? ''),
          payerName: name,
          accountReference: reference,
          transactionDate: parseDarajaTime(body.TransTime as string) ?? new Date(),
          status: 'UNMATCHED',
        },
      ]);
      tx = created.toObject() as MobileMoneyTransaction;
    } catch {
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }
    // Match the account number to an open invoice first, then to a customer code.
    const ref = clean(reference);
    if (ref) {
      const invoices = await this.db.invoices.find({ organisationId: bank.organisationId, entityId: bank.entityId, kind: 'SALES_INVOICE', status: 'POSTED', currency: 'KES' }, { number: 1, partyId: 1, amountDue: 1 }).sort({ date: -1 }).limit(5000).lean();
      // Payers often type only the number part ("12" or "000012" for INV-KE01-000012).
      const digits = /^\d{1,9}$/.test(ref) ? Number(ref) : null;
      const exact = invoices.find((i) => clean(i.number) === ref);
      const byNumber = digits !== null ? invoices.filter((i) => Number(/(\d+)$/.exec(i.number)?.[1] ?? NaN) === digits) : [];
      const invoice = exact ?? (byNumber.length === 1 ? byNumber[0] : undefined);
      if (invoice) await this.db.mobileMoney.updateOne({ _id: tx._id }, { invoiceId: invoice._id, customerId: invoice.partyId });
      else {
        const customer = (await this.db.customers.find({ organisationId: bank.organisationId, currency: 'KES', isActive: true }, { code: 1 }).lean()).find((c) => clean(c.code) === ref);
        if (customer) await this.db.mobileMoney.updateOne({ _id: tx._id }, { customerId: customer._id });
      }
    }
    await this.settle(bank, (await this.db.mobileMoney.findById(tx._id).lean())!);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  // ----- Turning payments into receipts ---------------------------------------------------------

  /** The day's M-Pesa statement, created on first use. */
  async statementFor(bank: BankAccount, date: Date) {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const name = `M-Pesa ${day.toISOString().slice(0, 10)}`;
    return this.db.bankStatements.findOneAndUpdate(
      { organisationId: bank.organisationId, bankAccountId: bank._id, name },
      { $setOnInsert: { organisationId: bank.organisationId, bankAccountId: bank._id, name, fromDate: day, toDate: day, closingBalance: null } },
      { upsert: true, new: true },
    ).lean();
  }

  /** Records the statement line, and if the customer is known, the receipt matched to it. */
  private async settle(bank: BankAccount, tx: MobileMoneyTransaction) {
    const date = tx.transactionDate ?? new Date();
    let lineId = tx.statementLineId;
    if (!lineId) {
      const statement = await this.statementFor(bank, date);
      const [line] = await this.db.bankStatementLines.create([
        { organisationId: bank.organisationId, bankAccountId: bank._id, statementId: statement!._id, date: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())), description: `M-Pesa ${tx.payerName || tx.phone} ${tx.accountReference}`.trim(), reference: tx.transactionId ?? '', amount: tx.amount! },
      ]);
      lineId = line._id;
      await this.db.mobileMoney.updateOne({ _id: tx._id }, { statementLineId: lineId });
    }
    if (!tx.customerId) return;
    const actor = bank.mpesa?.postAsUserId ? await actorFor(this.db, bank.mpesa.postAsUserId) : null;
    if (!actor) {
      await this.db.mobileMoney.updateOne({ _id: tx._id }, { note: 'The user who records M-Pesa receipts is inactive; choose another in the M-Pesa settings' });
      return;
    }
    await this.receipt(actor, bank, { ...tx, statementLineId: lineId });
  }

  private async receipt(actor: AuthUser, bank: BankAccount, tx: MobileMoneyTransaction) {
    const customer = await this.db.customers.findOne({ _id: tx.customerId!, organisationId: bank.organisationId }).lean();
    if (!customer || customer.currency !== 'KES') {
      await this.db.mobileMoney.updateOne({ _id: tx._id }, { status: 'UNMATCHED', note: customer ? `${customer.name} is billed in ${customer.currency}, not KES` : 'Customer not found' });
      return;
    }
    const amount = dec(tx.amount!);
    const invoice = tx.invoiceId ? await this.db.invoices.findOne({ _id: tx.invoiceId, status: 'POSTED' }, { amountDue: 1, number: 1 }).lean() : null;
    const allocate = invoice ? Decimal.min(amount, dec(invoice.amountDue)) : new Decimal(0);
    try {
      const payment = await this.payments.create(
        actor,
        {
          entityId: bank.entityId,
          branchId: bank.branchId,
          kind: 'RECEIPT',
          partyId: customer._id,
          date: new Date(Date.UTC((tx.transactionDate ?? new Date()).getUTCFullYear(), (tx.transactionDate ?? new Date()).getUTCMonth(), (tx.transactionDate ?? new Date()).getUTCDate())),
          bankAccountId: bank._id,
          method: 'MOBILE_MONEY',
          reference: tx.transactionId ?? '',
          description: `M-Pesa from ${tx.payerName || tx.phone}${invoice ? ` for ${invoice.number}` : ''}`,
          amount,
          allocations: allocate.gt(0) ? [{ documentId: invoice!._id, amount: allocate }] : [],
        },
        { post: true, idempotencyKey: `mpesa:${bank._id.toHexString()}:${tx.transactionId}` },
      );
      if (!payment) throw new Error('Could not record the receipt');
      const entry = payment.journalId ? await this.db.ledger.findOne({ journalId: payment.journalId, accountId: bank.glAccountId }).lean() : null;
      if (entry && tx.statementLineId) {
        await this.banking.match(actor, bank._id, [tx.statementLineId], [entry._id], 'AUTO').catch(() => undefined);
      }
      await this.db.mobileMoney.updateOne({ _id: tx._id }, { status: 'RECEIPTED', paymentId: payment._id, note: '' });
      await this.confirm(bank, tx, amount, invoice?._id ?? null).catch(() => undefined);
    } catch (err) {
      await this.db.mobileMoney.updateOne({ _id: tx._id }, { status: 'UNMATCHED', note: err instanceof Error ? err.message.slice(0, 300) : 'Could not record the receipt' });
    }
  }

  /** Thanks the payer by text message, with what is still due, when the organisation sends SMS. */
  private async confirm(bank: BankAccount, tx: MobileMoneyTransaction, amount: Decimal, invoiceId: Types.ObjectId | null) {
    const settings = await this.sms.settings(bank.organisationId);
    if (!settings.enabled || !settings.paymentConfirmations || !tx.phone) return;
    const [entity, invoice] = await Promise.all([
      this.db.entities.findById(bank.entityId, { name: 1 }).lean(),
      invoiceId ? this.db.invoices.findById(invoiceId, { number: 1, amountDue: 1 }).lean() : null,
    ]);
    const fmt = (d: Decimal) => d.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const balance = invoice ? dec(invoice.amountDue) : null;
    const message = `${entity?.name ?? 'We'}: received KES ${fmt(amount)}${invoice ? ` for ${invoice.number}` : ''}, M-Pesa ref ${tx.transactionId}.${balance ? (balance.gt(0) ? ` Balance due KES ${fmt(balance)}.` : ' Paid in full.') : ''} Thank you.`;
    await this.sms.enqueue({ organisationId: bank.organisationId, to: tx.phone, message, category: 'payment', related: { type: 'Payment', id: tx._id } }, { optional: true });
  }

  // ----- Review of unmatched payments -----------------------------------------------------------

  async list(user: AuthUser, q: { status?: string; bankAccountId?: Types.ObjectId; limit: number }) {
    await this.expireStale(user.organisationId);
    const rows = await this.db.mobileMoney.find({ organisationId: user.organisationId, ...(q.status && { status: q.status }), ...(q.bankAccountId && { bankAccountId: q.bankAccountId }) }).sort({ createdAt: -1 }).limit(q.limit).lean();
    const customers = await this.db.customers.find({ _id: { $in: rows.map((r) => r.customerId).filter(Boolean) } }, { name: 1, code: 1 }).lean();
    const invoices = await this.db.invoices.find({ _id: { $in: rows.map((r) => r.invoiceId).filter(Boolean) } }, { number: 1 }).lean();
    return rows.map((r) => ({
      ...r,
      phone: r.phone.length > 6 ? `${r.phone.slice(0, 6)}••••${r.phone.slice(-2)}` : r.phone,
      customer: customers.find((c) => r.customerId?.equals(c._id)) ?? null,
      invoiceNumber: invoices.find((i) => r.invoiceId?.equals(i._id))?.number ?? null,
    }));
  }

  /** Assigns an unmatched payment to a customer (and optionally an invoice) and records the receipt. */
  async assign(user: AuthUser, id: Types.ObjectId, input: { customerId: Types.ObjectId; invoiceId?: Types.ObjectId | null }) {
    const tx = await this.db.mobileMoney.findOne({ _id: id, organisationId: user.organisationId, status: 'UNMATCHED' }).lean();
    if (!tx) throw new NotFoundException('Unmatched payment not found');
    if (!user.permissions.includes('ar.manage')) throw new ForbiddenException('Missing permission: ar.manage');
    const bank = (await this.db.bankAccounts.findById(tx.bankAccountId).lean())!;
    if (input.invoiceId && !(await this.db.invoices.exists({ _id: input.invoiceId, partyId: input.customerId, organisationId: user.organisationId }))) throw new BadRequestException('That invoice is not for this customer');
    await this.db.mobileMoney.updateOne({ _id: tx._id }, { customerId: input.customerId, invoiceId: input.invoiceId ?? null });
    await this.receipt(user, bank, { ...tx, customerId: input.customerId, invoiceId: input.invoiceId ?? null });
    const after = (await this.db.mobileMoney.findById(tx._id).lean())!;
    await this.audit.log(user, { action: 'mpesa.assign', recordType: 'MobileMoneyTransaction', recordId: tx._id, summary: `Assigned M-Pesa ${tx.transactionId} (KES ${dec(tx.amount!).toFixed()}) to a customer${after.status === 'RECEIPTED' ? '' : `: ${after.note}`}` });
    return after;
  }

  async ignore(user: AuthUser, id: Types.ObjectId, note: string) {
    const tx = await this.db.mobileMoney.findOneAndUpdate({ _id: id, organisationId: user.organisationId, status: 'UNMATCHED' }, { status: 'IGNORED', note }, { new: true }).lean();
    if (!tx) throw new NotFoundException('Unmatched payment not found');
    await this.audit.log(user, { action: 'mpesa.ignore', recordType: 'MobileMoneyTransaction', recordId: tx._id, summary: `Set aside M-Pesa ${tx.transactionId}: ${note}` });
    return tx;
  }
}
