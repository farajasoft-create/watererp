import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, Message, MessageCreateParamsNonStreaming, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { Types } from 'mongoose';
import { AuthUser, hasPermission } from '../../common/auth';
import { BadRequestException, ForbiddenException, HttpError } from '../../common/errors';
import { Decimal } from '../../common/money';
import { PERMISSIONS as P } from '../../common/permissions';
import { serialize } from '../../common/serialize';
import { Db } from '../../database/db.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { BudgetsService } from '../budgets/budgets.service';
import { AttachmentsService } from '../documents/attachments.service';
import { ReportsService } from '../reports/reports.service';
import { SubledgerReportsService } from '../reports/subledger-reports.service';
import { similarity, SuggestionsService, tokens } from './suggestions.service';

/** The part of the Anthropic client this service uses (a scripted fake in tests). */
export interface ModelClient {
  messages: { create(params: MessageCreateParamsNonStreaming): Promise<Message> };
}

const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const INVOICE_TOOL: Tool = {
  name: 'record_invoice',
  description: 'Record the details read from a supplier invoice. Use null for anything that is not on the document; never guess.',
  input_schema: {
    type: 'object',
    properties: {
      supplierName: { type: ['string', 'null'] },
      supplierTaxId: { type: ['string', 'null'], description: 'VAT / tax registration number of the supplier (PIN, TIN, VAT no.)' },
      invoiceNumber: { type: ['string', 'null'] },
      invoiceDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      dueDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      currency: { type: ['string', 'null'], description: 'ISO 4217 code, e.g. KES' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'string', description: 'decimal as a string' },
            unitPrice: { type: 'string', description: 'decimal as a string, excluding tax' },
            taxRatePercent: { type: ['string', 'null'] },
            amount: { type: 'string', description: 'line amount excluding tax' },
          },
          required: ['description', 'quantity', 'unitPrice', 'amount'],
        },
      },
      subtotal: { type: ['string', 'null'] },
      taxTotal: { type: ['string', 'null'] },
      total: { type: ['string', 'null'] },
      pricesIncludeTax: { type: 'boolean' },
      notes: { type: ['string', 'null'], description: 'Anything a reviewer should check (illegible, handwritten, credit note, foreign tax).' },
    },
    required: ['lines'],
  },
};

interface ExtractedInvoice {
  supplierName: string | null;
  supplierTaxId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string | null;
  lines: { description: string; quantity: string; unitPrice: string; taxRatePercent?: string | null; amount: string }[];
  subtotal: string | null;
  taxTotal: string | null;
  total: string | null;
  pricesIncludeTax?: boolean;
  notes: string | null;
}

const decimal = (v: unknown): Decimal | null => {
  const s = String(v ?? '').replace(/[,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? new Decimal(s) : null;
};
const isoDate = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * AI assistance, as decision support only: reading supplier invoices into a draft for review, and
 * answering questions about the figures from read-only reports run with the asker's own permissions.
 * Off unless the organisation enables it and a model key is configured; every request is logged.
 */
export class AiService {
  private client: ModelClient | null;
  readonly model: string;

  constructor(
    private readonly db: Db,
    private readonly attachments: AttachmentsService,
    private readonly suggestions: SuggestionsService,
    private readonly reports: ReportsService,
    private readonly subledgers: SubledgerReportsService,
    private readonly analytics: AnalyticsService,
    private readonly budgets: BudgetsService,
    client?: ModelClient,
  ) {
    this.client = client ?? (process.env.ANTHROPIC_API_KEY ? (new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as unknown as ModelClient) : null);
    this.model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
  }

  /** Lets tests (and future providers) swap the model client. */
  useClient(client: ModelClient | null) {
    this.client = client;
  }

  async status(user: AuthUser) {
    const org = await this.db.organisations.findById(user.organisationId, { 'settings.aiEnabled': 1 }).lean();
    return { configured: !!this.client, enabled: !!org?.settings?.aiEnabled, allowed: hasPermission(user, P.AI_USE), model: this.client ? this.model : null };
  }

  private async assertAvailable(user: AuthUser) {
    if (!hasPermission(user, P.AI_USE)) throw new ForbiddenException('Missing permission: ai.use');
    if (!this.client) throw new HttpError(503, 'AI assistance is not configured on this server (ANTHROPIC_API_KEY)');
    const org = await this.db.organisations.findById(user.organisationId, { 'settings.aiEnabled': 1 }).lean();
    if (!org?.settings?.aiEnabled) throw new ForbiddenException('AI assistance is turned off for your organisation. An administrator can turn it on in Organisation settings.');
    return this.client;
  }

  private async call(user: AuthUser, feature: string, params: Omit<MessageCreateParamsNonStreaming, 'model'>, recordId?: Types.ObjectId | null): Promise<Message> {
    const client = await this.assertAvailable(user);
    try {
      const msg = await client.messages.create({ ...params, model: this.model });
      await this.db.aiRequests.create([{ organisationId: user.organisationId, userId: user.id, feature, model: this.model, recordId: recordId ?? null, inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 }]);
      return msg;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Model request failed';
      await this.db.aiRequests.create([{ organisationId: user.organisationId, userId: user.id, feature, model: this.model, recordId: recordId ?? null, ok: false, error: message.slice(0, 500) }]);
      throw new HttpError(502, `The AI service could not complete the request: ${message.slice(0, 200)}`);
    }
  }

  // ----- Invoice capture -------------------------------------------------------------------------

  /**
   * Reads a supplier invoice (PDF or photo) and proposes a draft bill: supplier matched by tax number
   * or name, lines with suggested accounts and tax codes, and checks that the arithmetic adds up.
   * Nothing is saved; the user reviews the proposal and creates the bill.
   */
  async extractInvoice(user: AuthUser, input: { entityId: Types.ObjectId; data?: Buffer; mimeType?: string; attachmentId?: Types.ObjectId }) {
    let data = input.data;
    let mimeType = input.mimeType;
    if (input.attachmentId) {
      const file = await this.attachments.content(user, input.attachmentId);
      data = file.data;
      mimeType = file.attachment.mimeType;
    }
    if (!data?.length || !mimeType) throw new BadRequestException('Send the invoice file');
    if (data.length > MAX_INVOICE_BYTES) throw new BadRequestException('Invoices can be at most 10 MB');
    if (!hasPermission(user, P.AP_MANAGE)) throw new ForbiddenException('Missing permission: ap.manage');
    let block: ContentBlockParam;
    if (mimeType === 'application/pdf' && data.subarray(0, 5).toString('latin1') === '%PDF-') block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') } };
    else if ((IMAGE_TYPES as readonly string[]).includes(mimeType)) block = { type: 'image', source: { type: 'base64', media_type: mimeType as (typeof IMAGE_TYPES)[number], data: data.toString('base64') } };
    else throw new BadRequestException('Invoice capture reads PDFs and images (PNG, JPEG, GIF, WebP)');

    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const msg = await this.call(
      user,
      'invoice_capture',
      {
        max_tokens: 4096,
        system: `You read supplier invoices for an accounts payable team in ${entity.country || 'East Africa'} (functional currency ${entity.functionalCurrency}). Transcribe exactly what the document says. Amounts are decimal strings without thousands separators. Do not infer values that are not printed.`,
        tools: [INVOICE_TOOL],
        tool_choice: { type: 'tool', name: INVOICE_TOOL.name },
        messages: [{ role: 'user', content: [block, { type: 'text', text: 'Record this invoice.' }] }],
      },
      input.attachmentId,
    );
    const call = msg.content.find((c) => c.type === 'tool_use');
    if (!call || call.type !== 'tool_use') throw new HttpError(502, 'The AI service did not return the invoice details');
    const x = call.input as ExtractedInvoice;
    return this.proposal(user, entity, x);
  }

  private async proposal(user: AuthUser, entity: { _id: Types.ObjectId; functionalCurrency: string }, x: ExtractedInvoice) {
    const warnings: string[] = [];
    // Supplier: tax number first, then the closest name.
    const suppliers = await this.db.suppliers.find({ organisationId: user.organisationId, isActive: true }, { code: 1, name: 1, taxId: 1, currency: 1, defaultTaxCodeId: 1 }).lean();
    const cleanTax = (t: string | null | undefined) => (t ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    let supplier = x.supplierTaxId ? suppliers.find((s) => s.taxId && cleanTax(s.taxId) === cleanTax(x.supplierTaxId)) : undefined;
    let supplierMatch: 'tax_id' | 'name' | null = supplier ? 'tax_id' : null;
    if (!supplier && x.supplierName) {
      const t = tokens(x.supplierName);
      const best = suppliers.map((s) => ({ s, score: similarity(t, tokens(s.name)) })).sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.6) {
        supplier = best.s;
        supplierMatch = 'name';
      }
    }
    if (!supplier) warnings.push(`No supplier matches "${x.supplierName ?? 'unknown'}"${x.supplierTaxId ? ` (tax number ${x.supplierTaxId})` : ''}; choose or create the supplier.`);
    const currency = (x.currency ?? supplier?.currency ?? entity.functionalCurrency).toUpperCase();
    if (supplier && currency !== supplier.currency) warnings.push(`The invoice is in ${currency} but ${supplier.name} is set up in ${supplier.currency}.`);

    // Possible duplicate: the same supplier invoice number already entered.
    if (supplier && x.invoiceNumber) {
      const dup = await this.db.invoices.findOne({ organisationId: user.organisationId, kind: 'PURCHASE_BILL', partyId: supplier._id, supplierInvoiceNumber: x.invoiceNumber, status: { $ne: 'VOID' } }, { number: 1 }).lean();
      if (dup) warnings.push(`Invoice ${x.invoiceNumber} from ${supplier.name} is already entered as ${dup.number}.`);
    }

    const taxCodes = await this.db.taxCodes.find({ organisationId: user.organisationId, kind: 'VAT', isActive: true }).lean();
    const taxFor = (rate: Decimal | null) => {
      if (!rate) return null;
      return taxCodes.find((t) => t.rates?.some((r: { rate: unknown }) => new Decimal(String(r.rate)).eq(rate))) ?? null;
    };
    const lines = [];
    for (const [i, l] of (x.lines ?? []).entries()) {
      const qty = decimal(l.quantity) ?? new Decimal(1);
      const price = decimal(l.unitPrice);
      const amount = decimal(l.amount);
      if (!price) warnings.push(`Line ${i + 1}: the unit price could not be read.`);
      if (price && amount && !qty.times(price).toDecimalPlaces(2).eq(amount.toDecimalPlaces(2))) warnings.push(`Line ${i + 1}: ${qty.toFixed()} × ${price.toFixed()} does not equal ${amount.toFixed()}.`);
      const rate = decimal(l.taxRatePercent);
      const tax = taxFor(rate) ?? (supplier?.defaultTaxCodeId ? taxCodes.find((t) => t._id.equals(supplier!.defaultTaxCodeId!)) ?? null : null);
      const [suggested] = await this.suggestions.coding(user, { side: 'purchase', partyId: supplier?._id, description: l.description });
      lines.push({
        description: l.description,
        quantity: qty.toFixed(),
        unitPrice: price?.toFixed() ?? '',
        amount: amount?.toFixed() ?? null,
        taxCodeId: tax?._id ?? null,
        taxCode: tax?.code ?? null,
        accountId: suggested?.accountId ?? null,
        account: suggested ? `${suggested.code} ${suggested.name}` : null,
        accountConfidence: suggested?.confidence ?? null,
      });
    }
    if (!lines.length) warnings.push('No lines could be read from the invoice.');
    const subtotal = decimal(x.subtotal);
    const linesTotal = lines.reduce((s, l) => s.plus(decimal(l.amount) ?? new Decimal(0)), new Decimal(0));
    if (subtotal && lines.length && !linesTotal.toDecimalPlaces(2).eq(subtotal.toDecimalPlaces(2))) warnings.push(`The lines add up to ${linesTotal.toFixed(2)}, not the subtotal of ${subtotal.toFixed(2)}.`);
    const total = decimal(x.total);
    const taxTotal = decimal(x.taxTotal);
    if (subtotal && taxTotal && total && !subtotal.plus(taxTotal).toDecimalPlaces(2).eq(total.toDecimalPlaces(2))) warnings.push(`Subtotal plus tax (${subtotal.plus(taxTotal).toFixed(2)}) does not equal the total of ${total.toFixed(2)}.`);
    if (x.notes) warnings.push(x.notes);
    return serialize({
      supplier: supplier ? { id: supplier._id, code: supplier.code, name: supplier.name, match: supplierMatch } : null,
      read: { supplierName: x.supplierName, supplierTaxId: x.supplierTaxId, invoiceNumber: x.invoiceNumber, invoiceDate: isoDate(x.invoiceDate), dueDate: isoDate(x.dueDate), currency, subtotal: subtotal?.toFixed() ?? null, taxTotal: taxTotal?.toFixed() ?? null, total: total?.toFixed() ?? null, pricesIncludeTax: !!x.pricesIncludeTax },
      lines,
      warnings,
      model: this.model,
    });
  }

  // ----- Questions about the figures ------------------------------------------------------------

  private tools(): Tool[] {
    const range = { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } };
    return [
      { name: 'profit_and_loss', description: 'Income statement for a date range, optionally split by branch.', input_schema: { type: 'object', properties: { ...range, byBranch: { type: 'boolean' } }, required: ['from', 'to'] } },
      { name: 'balance_sheet', description: 'Statement of financial position at a date.', input_schema: { type: 'object', properties: { asOf: { type: 'string' } }, required: ['asOf'] } },
      { name: 'trial_balance', description: 'Trial balance with opening, movement and closing balances per account.', input_schema: { type: 'object', properties: range, required: ['from', 'to'] } },
      { name: 'aged_receivables', description: 'Customer balances by age at a date.', input_schema: { type: 'object', properties: { asOf: { type: 'string' } }, required: ['asOf'] } },
      { name: 'aged_payables', description: 'Supplier balances by age at a date.', input_schema: { type: 'object', properties: { asOf: { type: 'string' } }, required: ['asOf'] } },
      { name: 'budget_vs_actual', description: 'Approved budget against actual by account for a range.', input_schema: { type: 'object', properties: range, required: ['from', 'to'] } },
      { name: 'cash_flow', description: 'Statement of cash flows for a range.', input_schema: { type: 'object', properties: range, required: ['from', 'to'] } },
      { name: 'cash_forecast', description: 'Thirteen-week cash forecast from today.', input_schema: { type: 'object', properties: {} } },
      { name: 'key_exceptions', description: 'Unusual or risky transactions flagged for review in a range.', input_schema: { type: 'object', properties: range, required: ['from', 'to'] } },
      { name: 'account_activity', description: 'Ledger lines on one account (by code) in a range.', input_schema: { type: 'object', properties: { ...range, accountCode: { type: 'string' } }, required: ['accountCode', 'from', 'to'] } },
    ];
  }

  private async runTool(user: AuthUser, entityId: Types.ObjectId, name: string, input: Record<string, string | boolean | undefined>) {
    const date = (v: unknown) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`Expected a date (YYYY-MM-DD), got ${String(v)}`);
      return new Date(`${v}T00:00:00.000Z`);
    };
    const f = { entityId };
    const need = (p: string) => {
      if (!hasPermission(user, p as never)) throw new ForbiddenException(`You do not have access to this report (${p})`);
    };
    switch (name) {
      case 'profit_and_loss':
        need(P.REPORTS_VIEW);
        return this.reports.profitAndLoss(user, f, date(input.from), date(input.to), !!input.byBranch);
      case 'balance_sheet':
        need(P.REPORTS_VIEW);
        return this.reports.balanceSheet(user, f, date(input.asOf));
      case 'trial_balance':
        need(P.REPORTS_VIEW);
        return this.reports.trialBalance(user, f, date(input.from), date(input.to));
      case 'aged_receivables': {
        const r = await this.subledgers.aging(user, 'CUSTOMER', entityId, date(input.asOf));
        return { ...r, rows: r.rows.map(({ documents: _d, ...x }) => x) };
      }
      case 'aged_payables': {
        const r = await this.subledgers.aging(user, 'SUPPLIER', entityId, date(input.asOf));
        return { ...r, rows: r.rows.map(({ documents: _d, ...x }) => x) };
      }
      case 'budget_vs_actual':
        need(P.BUDGETS_VIEW);
        return this.budgets.vsActual(user, { entityId, from: date(input.from), to: date(input.to) });
      case 'cash_flow':
        need(P.REPORTS_VIEW);
        return this.analytics.cashFlow(user, entityId, date(input.from), date(input.to));
      case 'cash_forecast':
        need(P.ANALYTICS_VIEW);
        return this.analytics.forecast(user, entityId);
      case 'key_exceptions':
        need(P.ANALYTICS_VIEW);
        return this.analytics.exceptions(user, entityId, date(input.from), date(input.to));
      case 'account_activity': {
        need(P.REPORTS_VIEW);
        const account = await this.db.accounts.findOne({ organisationId: user.organisationId, code: String(input.accountCode) }).lean();
        if (!account) throw new BadRequestException(`No account ${String(input.accountCode)}`);
        const r = await this.reports.accountActivity(user, f, account._id, date(input.from), date(input.to));
        return { ...r, rows: (r as { rows: unknown[] }).rows.slice(0, 200) };
      }
      default:
        throw new BadRequestException(`Unknown tool ${name}`);
    }
  }

  /**
   * Answers a question about the books. The model can only call read-only reports, each run with the
   * asker's own permissions and branch restrictions, so it can never see more than they can.
   */
  async ask(user: AuthUser, input: { entityId: Types.ObjectId; question: string; history?: { role: 'user' | 'assistant'; content: string }[] }) {
    const entity = await this.db.entities.findOne({ _id: input.entityId, organisationId: user.organisationId }).lean();
    if (!entity) throw new BadRequestException('Entity not found');
    const today = new Date().toISOString().slice(0, 10);
    const fy = await this.db.fiscalYears.findOne({ organisationId: user.organisationId, entityId: entity._id, startDate: { $lte: new Date() }, endDate: { $gte: new Date() } }).lean();
    const system = [
      `You are a finance analyst answering questions about the books of ${entity.name} (${entity.code}); amounts are in ${entity.functionalCurrency} unless stated.`,
      `Today is ${today}.${fy ? ` The fiscal year runs from ${fy.startDate.toISOString().slice(0, 10)} to ${fy.endDate.toISOString().slice(0, 10)}.` : ''}`,
      'Use the tools to fetch figures; never state a number you did not get from a tool. If a tool fails or the data is not available, say so.',
      'Answer briefly and directly: lead with the answer, then the key figures (formatted with thousands separators) and, if useful, one or two observations. Use plain text and short bullet lists, no tables.',
    ].join(' ');
    const messages: MessageParam[] = [...(input.history ?? []).slice(-6).map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: input.question }];
    const used: { tool: string; input: unknown; ok: boolean }[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const msg = await this.call(user, 'ask', { max_tokens: 1500, system, tools: this.tools(), messages });
      const calls = msg.content.filter((c) => c.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || !calls.length) {
        const answer = msg.content
          .filter((c) => c.type === 'text')
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n')
          .trim();
        return { answer: answer || 'I could not find an answer to that.', tools: used, model: this.model };
      }
      messages.push({ role: 'assistant', content: msg.content as ContentBlockParam[] });
      const results: ContentBlockParam[] = [];
      for (const c of calls) {
        if (c.type !== 'tool_use') continue;
        try {
          const data = await this.runTool(user, entity._id, c.name, c.input as Record<string, string>);
          const text = JSON.stringify(serialize(data));
          results.push({ type: 'tool_result', tool_use_id: c.id, content: text.length > 60_000 ? `${text.slice(0, 60_000)}… (truncated)` : text });
          used.push({ tool: c.name, input: c.input, ok: true });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: err instanceof Error ? err.message : 'Failed' });
          used.push({ tool: c.name, input: c.input, ok: false });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return { answer: 'That needed more steps than allowed; try a narrower question.', tools: used, model: this.model };
  }

  async usage(user: AuthUser, since: Date) {
    const rows = await this.db.aiRequests.aggregate<{ _id: string; requests: number; inputTokens: number; outputTokens: number; failures: number }>([
      { $match: { organisationId: user.organisationId, createdAt: { $gte: since } } },
      { $group: { _id: '$feature', requests: { $sum: 1 }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' }, failures: { $sum: { $cond: ['$ok', 0, 1] } } } },
    ]);
    return rows.map((r) => ({ feature: r._id, requests: r.requests, inputTokens: r.inputTokens, outputTokens: r.outputTokens, failures: r.failures }));
  }
}
