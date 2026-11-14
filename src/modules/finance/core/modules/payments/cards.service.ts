import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { actorFor, AuthUser } from '../../common/auth';
import { BadRequestException, ForbiddenException, NotFoundException } from '../../common/errors';
import { Decimal, dec, toD128 } from '../../common/money';
import { decryptSecret, encryptSecret } from '../../common/totp';
import { BankAccount } from '../../database/commercial.schemas';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { appUrl } from '../communication/email.service';
import { PaymentsService } from './payments.service';

/** Currencies Stripe charges in whole units (no minor unit). */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const minorUnits = (amount: Decimal, currency: string) => (ZERO_DECIMAL.has(currency) ? amount : amount.times(100)).toDecimalPlaces(0).toNumber();
const fromMinor = (units: number, currency: string) => (ZERO_DECIMAL.has(currency) ? new Decimal(units) : new Decimal(units).div(100));

/** Stripe's REST API (form-encoded requests, bearer secret key). */
class StripeClient {
  constructor(private readonly secretKey: string) {}

  private get base() {
    return process.env.STRIPE_API_BASE ?? 'https://api.stripe.com';
  }

  async checkout(p: { amount: number; currency: string; name: string; description: string; successUrl: string; cancelUrl: string; reference: string; email?: string }) {
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': p.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(p.amount),
      'line_items[0][price_data][product_data][name]': p.name,
      'line_items[0][price_data][product_data][description]': p.description,
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      client_reference_id: p.reference,
      'metadata[reference]': p.reference,
      'payment_method_types[0]': 'card',
    });
    if (p.email) form.set('customer_email', p.email);
    const res = await fetch(`${this.base}/v1/checkout/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': p.reference },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !body.id || !body.url) throw new BadRequestException(`The card gateway refused: ${body.error?.message ?? res.status}`);
    return { id: body.id, url: body.url };
  }
}

/**
 * Verifies a Stripe webhook signature: header "t=<unix>,v1=<hex>[,v1=...]", HMAC-SHA256 of "<t>.<body>"
 * with the endpoint's signing secret, within five minutes.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !signatures.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return signatures.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * Card payments from the customer portal through a hosted checkout (Stripe). The customer is sent to the
 * gateway's page; its signed webhook confirms the payment, which is receipted into the bank account set
 * up for cards (usually a clearing account for the gateway's balance) and applied to the invoice.
 */
export class CardPaymentsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {}

  private async account(user: AuthUser, bankId: Types.ObjectId) {
    const bank = await this.db.bankAccounts.findOne({ _id: bankId, organisationId: user.organisationId }).lean();
    if (!bank) throw new NotFoundException('Bank account not found');
    return bank;
  }

  private view(bank: BankAccount) {
    const c = bank.card;
    return {
      enabled: !!c?.enabled,
      provider: c?.provider ?? 'STRIPE',
      hasSecretKey: !!c?.secretKey,
      hasWebhookSecret: !!c?.webhookSecret,
      postAsUserId: c?.postAsUserId ?? null,
      webhookUrl: c?.callbackSecret ? `${appUrl()}/api/v1/cards/webhooks/${c.callbackSecret}` : null,
    };
  }

  async settings(user: AuthUser, bankId: Types.ObjectId) {
    return this.view(await this.account(user, bankId));
  }

  async configure(user: AuthUser, bankId: Types.ObjectId, input: { enabled: boolean; secretKey?: string; webhookSecret?: string; postAsUserId?: Types.ObjectId | null }) {
    const bank = await this.account(user, bankId);
    if (input.secretKey && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(input.secretKey.trim())) throw new BadRequestException('That does not look like a Stripe secret key (sk_test_… or sk_live_…)');
    if (input.webhookSecret && !/^whsec_[A-Za-z0-9]{10,}$/.test(input.webhookSecret.trim())) throw new BadRequestException('That does not look like a Stripe webhook signing secret (whsec_…)');
    const postAs = input.postAsUserId ?? bank.card?.postAsUserId ?? user.id;
    if (input.enabled) {
      if (!input.secretKey && !bank.card?.secretKey) throw new BadRequestException('Enter the secret API key');
      if (!input.webhookSecret && !bank.card?.webhookSecret) throw new BadRequestException('Enter the webhook signing secret');
      const actor = await actorFor(this.db, postAs);
      if (!actor || !actor.organisationId.equals(user.organisationId)) throw new BadRequestException('Choose an active user to record card receipts');
    }
    const update: Record<string, unknown> = { 'card.enabled': input.enabled, 'card.provider': 'STRIPE', 'card.postAsUserId': postAs };
    if (input.secretKey) update['card.secretKey'] = encryptSecret(input.secretKey.trim());
    if (input.webhookSecret) update['card.webhookSecret'] = encryptSecret(input.webhookSecret.trim());
    if (!bank.card?.callbackSecret) update['card.callbackSecret'] = randomBytes(24).toString('base64url');
    await this.db.bankAccounts.updateOne({ _id: bank._id }, update);
    await this.audit.log(user, { action: 'bank_account.cards', recordType: 'BankAccount', recordId: bank._id, summary: `${input.enabled ? 'Enabled' : 'Disabled'} card payments into ${bank.name}` });
    return this.settings(user, bankId);
  }

  /** The account taking card payments in a currency for the entity, if any. */
  async cardAccount(organisationId: Types.ObjectId, entityId: Types.ObjectId, currency?: string) {
    return this.db.bankAccounts.findOne({ organisationId, entityId, isActive: true, 'card.enabled': true, ...(currency && { currency }) }).lean();
  }

  /** Starts a hosted checkout for (part of) an invoice; returns the gateway page to send the customer to. */
  async start(input: { organisationId: Types.ObjectId; entityId: Types.ObjectId; customerId: Types.ObjectId; invoiceId: Types.ObjectId; amount?: Decimal | null; portalLinkId: Types.ObjectId; returnUrl: string }) {
    const invoice = await this.db.invoices.findOne({ _id: input.invoiceId, organisationId: input.organisationId, partyId: input.customerId, kind: 'SALES_INVOICE', status: 'POSTED' }).lean();
    if (!invoice) throw new NotFoundException('Invoice not found');
    const due = dec(invoice.amountDue);
    if (due.lte(0)) throw new BadRequestException(`${invoice.number} is already paid`);
    const amount = input.amount ?? due;
    if (amount.lte(0) || amount.gt(due)) throw new BadRequestException(`Pay between 0 and ${due.toFixed(2)} ${invoice.currency}`);
    const bank = await this.cardAccount(input.organisationId, input.entityId, invoice.currency);
    if (!bank?.card?.secretKey) throw new BadRequestException(`Card payments in ${invoice.currency} are not available`);
    const entity = await this.db.entities.findById(input.entityId, { name: 1, legalName: 1 }).lean();
    const customer = await this.db.customers.findById(input.customerId, { email: 1 }).lean();
    const reference = `card_${new Types.ObjectId().toHexString()}`;
    const session = await new StripeClient(decryptSecret(bank.card.secretKey)).checkout({
      amount: minorUnits(amount, invoice.currency),
      currency: invoice.currency,
      name: `${invoice.number} · ${entity?.legalName || entity?.name || ''}`.trim(),
      description: `Payment of invoice ${invoice.number}`,
      successUrl: `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}card=done`,
      cancelUrl: `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}card=cancelled`,
      reference,
      email: customer?.email || undefined,
    });
    await this.db.cardPayments.create({
      organisationId: input.organisationId,
      entityId: input.entityId,
      bankAccountId: bank._id,
      customerId: input.customerId,
      invoiceId: invoice._id,
      portalLinkId: input.portalLinkId,
      provider: 'STRIPE',
      sessionId: session.id,
      currency: invoice.currency,
      amount: toD128(amount),
    });
    return { url: session.url };
  }

  /** Signed gateway webhook: a completed checkout becomes a receipt applied to the invoice. */
  async webhook(secret: string, rawBody: string, signature: string | null) {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(secret)) throw new ForbiddenException('Unknown webhook');
    const bank = await this.db.bankAccounts.findOne({ 'card.callbackSecret': secret }).lean();
    if (!bank?.card?.webhookSecret) throw new ForbiddenException('Unknown webhook');
    if (!verifyStripeSignature(rawBody, signature, decryptSecret(bank.card.webhookSecret))) throw new ForbiddenException('Invalid signature');
    const event = JSON.parse(rawBody) as { type?: string; data?: { object?: { id?: string; payment_status?: string; amount_total?: number; currency?: string; payment_intent?: string } } };
    const session = event.data?.object;
    if (!session?.id) return { received: true };
    const card = await this.db.cardPayments.findOne({ provider: 'STRIPE', sessionId: session.id, bankAccountId: bank._id }).lean();
    if (!card || card.status === 'PAID') return { received: true };
    if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      await this.db.cardPayments.updateOne({ _id: card._id, status: 'PENDING' }, { status: event.type.endsWith('expired') ? 'EXPIRED' : 'FAILED' });
      return { received: true };
    }
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type ?? '') || session.payment_status !== 'paid') return { received: true };
    const paid = fromMinor(session.amount_total ?? 0, card.currency);
    if ((session.currency ?? '').toUpperCase() !== card.currency) {
      await this.db.cardPayments.updateOne({ _id: card._id }, { status: 'UNMATCHED', note: `Paid in ${session.currency?.toUpperCase()}, expected ${card.currency}` });
      return { received: true };
    }
    await this.receipt(bank, { ...card, paymentReference: session.payment_intent ?? '' }, paid);
    return { received: true };
  }

  private async receipt(bank: BankAccount, card: { _id: Types.ObjectId; invoiceId: Types.ObjectId; customerId: Types.ObjectId; sessionId: string; paymentReference: string }, amount: Decimal) {
    const actor = bank.card?.postAsUserId ? await actorFor(this.db, bank.card.postAsUserId) : null;
    if (!actor) {
      await this.db.cardPayments.updateOne({ _id: card._id }, { status: 'UNMATCHED', paymentReference: card.paymentReference, note: 'The user who records card receipts is inactive; choose another in the card settings' });
      return;
    }
    const invoice = await this.db.invoices.findById(card.invoiceId, { amountDue: 1, number: 1, status: 1 }).lean();
    const allocate = invoice?.status === 'POSTED' ? Decimal.min(amount, dec(invoice.amountDue)) : new Decimal(0);
    const today = new Date();
    try {
      const payment = await this.payments.create(
        actor,
        {
          entityId: bank.entityId,
          branchId: bank.branchId,
          kind: 'RECEIPT',
          partyId: card.customerId,
          date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
          bankAccountId: bank._id,
          method: 'CARD',
          reference: card.paymentReference || card.sessionId,
          description: `Card payment${invoice ? ` for ${invoice.number}` : ''} (customer portal)`,
          amount,
          allocations: allocate.gt(0) ? [{ documentId: card.invoiceId, amount: allocate }] : [],
        },
        { post: true, idempotencyKey: `card:${card.sessionId}` },
      );
      await this.db.cardPayments.updateOne({ _id: card._id }, { status: 'PAID', paymentId: payment?._id ?? null, paymentReference: card.paymentReference, note: '' });
    } catch (err) {
      await this.db.cardPayments.updateOne({ _id: card._id }, { status: 'UNMATCHED', paymentReference: card.paymentReference, note: err instanceof Error ? err.message.slice(0, 300) : 'Could not record the receipt' });
    }
  }

  async list(user: AuthUser, q: { status?: string; limit: number }) {
    return this.db.cardPayments.find({ organisationId: user.organisationId, ...(q.status && { status: q.status }) }).sort({ createdAt: -1 }).limit(q.limit).lean();
  }
}
