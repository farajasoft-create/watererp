/**
 * A small client for Safaricom's Daraja API (M-Pesa): OAuth tokens, STK push ("Lipa na M-Pesa Online")
 * and C2B URL registration. Amounts are whole shillings; phone numbers are 2547XXXXXXXX / 2541XXXXXXXX.
 */

export type DarajaEnvironment = 'sandbox' | 'production';

const BASE: Record<DarajaEnvironment, string> = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

const tokens = new Map<string, { token: string; expires: number }>();

export class DarajaError extends Error {}

/** Normalises Kenyan mobile numbers to 2547XXXXXXXX / 2541XXXXXXXX, or returns null. */
export function normalisePhone(input: string): string | null {
  let d = input.replace(/[^\d]/g, '');
  if (d.startsWith('0') && d.length === 10) d = `254${d.slice(1)}`;
  if (d.length === 9 && /^[17]/.test(d)) d = `254${d}`;
  return /^254[17]\d{8}$/.test(d) ? d : null;
}

/** Daraja timestamps (YYYYMMDDHHmmss) are in East Africa Time (UTC+3). */
export function parseDarajaTime(value: string | number | undefined | null): Date | null {
  const s = String(value ?? '');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`) : null;
}

export function darajaTimestamp(now = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 3_600_000).toISOString();
  return eat.slice(0, 19).replace(/[-T:]/g, '');
}

export class DarajaClient {
  private readonly base: string;

  constructor(
    environment: DarajaEnvironment,
    private readonly consumerKey: string,
    private readonly consumerSecret: string,
  ) {
    // Tests point this at a stand-in server.
    this.base = (process.env.MPESA_BASE_URL ?? BASE[environment]).replace(/\/$/, '');
  }

  private async token(): Promise<string> {
    const key = `${this.base}|${this.consumerKey}`;
    const cached = tokens.get(key);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const res = await fetch(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { authorization: `Basic ${Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: string | number; errorMessage?: string };
    if (!res.ok || !body.access_token) throw new DarajaError(`M-Pesa sign-in failed (${res.status}${body.errorMessage ? `: ${body.errorMessage}` : ''}); check the consumer key and secret`);
    tokens.set(key, { token: body.access_token, expires: Date.now() + Number(body.expires_in ?? 3599) * 1000 });
    return body.access_token;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { errorMessage?: string; ResponseCode?: string; ResponseDescription?: string };
    if (!res.ok || (body.ResponseCode !== undefined && body.ResponseCode !== '0')) {
      throw new DarajaError(body.errorMessage ?? body.ResponseDescription ?? `M-Pesa request failed (${res.status})`);
    }
    return body;
  }

  /** Sends a payment prompt to the customer's phone. */
  stkPush(input: { shortCode: string; passkey: string; till: boolean; partyB?: string; amount: number; phone: string; callbackUrl: string; accountReference: string; description: string }) {
    const timestamp = darajaTimestamp();
    return this.post<{ MerchantRequestID: string; CheckoutRequestID: string; CustomerMessage: string }>('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: input.shortCode,
      Password: Buffer.from(`${input.shortCode}${input.passkey}${timestamp}`).toString('base64'),
      Timestamp: timestamp,
      TransactionType: input.till ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: input.amount,
      PartyA: input.phone,
      PartyB: input.partyB || input.shortCode,
      PhoneNumber: input.phone,
      CallBackURL: input.callbackUrl,
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: input.description.slice(0, 13),
    });
  }

  /** Pays a phone number (B2C). The result arrives later at `resultUrl`. */
  b2c(input: { originatorConversationId: string; initiatorName: string; securityCredential: string; shortCode: string; phone: string; amount: number; remarks: string; occasion: string; resultUrl: string; timeoutUrl: string }) {
    return this.post<{ ConversationID: string; OriginatorConversationID: string; ResponseDescription: string }>('/mpesa/b2c/v3/paymentrequest', {
      OriginatorConversationID: input.originatorConversationId,
      InitiatorName: input.initiatorName,
      SecurityCredential: input.securityCredential,
      CommandID: 'BusinessPayment',
      Amount: input.amount,
      PartyA: input.shortCode,
      PartyB: input.phone,
      Remarks: input.remarks.slice(0, 100),
      QueueTimeOutURL: input.timeoutUrl,
      ResultURL: input.resultUrl,
      Occasion: input.occasion.slice(0, 100),
    });
  }

  /** Pays another business's paybill (with an account number) or till (B2B). */
  b2b(input: { originatorConversationId: string; initiatorName: string; securityCredential: string; shortCode: string; till: boolean; partyB: string; accountReference: string; amount: number; remarks: string; resultUrl: string; timeoutUrl: string }) {
    return this.post<{ ConversationID: string; OriginatorConversationID: string; ResponseDescription: string }>('/mpesa/b2b/v1/paymentrequest', {
      OriginatorConversationID: input.originatorConversationId,
      Initiator: input.initiatorName,
      SecurityCredential: input.securityCredential,
      CommandID: input.till ? 'BusinessBuyGoods' : 'BusinessPayBill',
      SenderIdentifierType: '4',
      RecieverIdentifierType: input.till ? '2' : '4',
      Amount: input.amount,
      PartyA: input.shortCode,
      PartyB: input.partyB,
      AccountReference: input.accountReference.slice(0, 13),
      Remarks: input.remarks.slice(0, 100),
      QueueTimeOutURL: input.timeoutUrl,
      ResultURL: input.resultUrl,
    });
  }

  /** Asks whether a payment prompt was completed (answers at once). */
  stkQuery(input: { shortCode: string; passkey: string; checkoutRequestId: string }) {
    const timestamp = darajaTimestamp();
    return this.post<{ ResultCode?: string | number; ResultDesc?: string; ResponseDescription?: string }>('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: input.shortCode,
      Password: Buffer.from(`${input.shortCode}${input.passkey}${timestamp}`).toString('base64'),
      Timestamp: timestamp,
      CheckoutRequestID: input.checkoutRequestId,
    });
  }

  /** Asks what became of a transaction; the answer arrives at `resultUrl`. */
  transactionStatus(input: { initiatorName: string; securityCredential: string; shortCode: string; transactionId?: string | null; originalConversationId: string; resultUrl: string; timeoutUrl: string }) {
    return this.post<{ ConversationID: string }>('/mpesa/transactionstatus/v1/query', {
      Initiator: input.initiatorName,
      SecurityCredential: input.securityCredential,
      CommandID: 'TransactionStatusQuery',
      TransactionID: input.transactionId ?? '',
      OriginalConversationID: input.originalConversationId,
      PartyA: input.shortCode,
      IdentifierType: '4',
      ResultURL: input.resultUrl,
      QueueTimeOutURL: input.timeoutUrl,
      Remarks: 'Payout status',
      Occasion: '',
    });
  }

  /** Asks for the short code's balances; the answer arrives at `resultUrl`. */
  accountBalance(input: { initiatorName: string; securityCredential: string; shortCode: string; resultUrl: string; timeoutUrl: string }) {
    return this.post<{ ConversationID: string }>('/mpesa/accountbalance/v1/query', {
      Initiator: input.initiatorName,
      SecurityCredential: input.securityCredential,
      CommandID: 'AccountBalance',
      PartyA: input.shortCode,
      IdentifierType: '4',
      Remarks: 'Float check',
      QueueTimeOutURL: input.timeoutUrl,
      ResultURL: input.resultUrl,
    });
  }

  /** Tells Safaricom where to send paybill/till payment confirmations. */
  registerC2B(input: { shortCode: string; confirmationUrl: string; validationUrl: string }) {
    return this.post<{ ResponseDescription?: string }>('/mpesa/c2b/v2/registerurl', {
      ShortCode: input.shortCode,
      ResponseType: 'Completed',
      ConfirmationURL: input.confirmationUrl,
      ValidationURL: input.validationUrl,
    });
  }
}

/**
 * Parses Daraja's AccountBalance result ("Working Account|KES|700.00|700.00|0.00|0.00&Utility Account|...")
 * into accounts with their available balance.
 */
export function parseBalances(value: string | number | null | undefined): { name: string; currency: string; available: string }[] {
  return String(value ?? '')
    .split('&')
    .map((part) => part.split('|'))
    .filter((f) => f.length >= 3 && /^-?\d+(\.\d+)?$/.test(f[2]))
    .map((f) => ({ name: f[0].trim(), currency: f[1].trim(), available: f[2] }));
}
