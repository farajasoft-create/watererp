import { ClientSession, Types } from 'mongoose';
import { AuthUser } from '../../common/auth';
import { BadRequestException } from '../../common/errors';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';

export const TEMPLATE_KEYS = ['rfq', 'lpo', 'remittance'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

interface Template { subject: string; intro: string; body: string; footer: string }

/** The wording each procurement email starts with; organisations change it under Communication → Email templates. */
export const TEMPLATE_DEFAULTS: Record<TemplateKey, Template & { name: string; placeholders: string[] }> = {
  rfq: {
    name: 'Request for quotation',
    placeholders: ['organisation', 'supplier', 'number', 'title', 'due', 'currency', 'sender'],
    subject: 'Request for quotation {{number}}: {{title}}',
    intro: '{{organisation}} invites {{supplier}} to quote for: {{title}}.',
    body: 'Please reply with your unit prices in {{currency}}, excluding tax, with lead times, by {{due}}.',
    footer: 'Sent by {{sender}} on behalf of {{organisation}}.',
  },
  lpo: {
    name: 'Purchase order (LPO)',
    placeholders: ['organisation', 'supplier', 'number', 'amendment', 'currency', 'amount'],
    subject: 'Purchase order {{number}} from {{organisation}}',
    intro: 'Dear {{supplier}},',
    body: 'Please find attached our purchase order {{number}}{{amendment}} for {{currency}} {{amount}}.\n\nPlease quote the order number on your delivery note and invoice.\n\n{{organisation}}',
    footer: 'Sent on behalf of {{organisation}}.',
  },
  remittance: {
    name: 'Remittance advice',
    placeholders: ['organisation', 'supplier', 'number', 'currency', 'amount', 'date', 'method', 'reference'],
    subject: 'Remittance advice {{number}} from {{organisation}}',
    intro: 'Dear {{supplier}},',
    body: 'We have paid you {{currency}} {{amount}} on {{date}} by {{method}}{{reference}}.',
    footer: 'Please contact our accounts office if anything here does not match your records.',
  },
};

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');

/** The organisation's wording for an email with the placeholders filled in. */
export async function renderTemplate(db: Db, organisationId: Types.ObjectId, key: TemplateKey, vars: Record<string, string>, session?: ClientSession) {
  const saved = await db.emailTemplates.findOne({ organisationId, key }).session(session ?? null).lean();
  const t = { ...TEMPLATE_DEFAULTS[key], ...(saved && { subject: saved.subject, intro: saved.intro, body: saved.body, footer: saved.footer }) };
  return {
    subject: fill(t.subject, vars),
    intro: fill(t.intro, vars),
    paragraphs: fill(t.body, vars).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
    footer: fill(t.footer, vars),
  };
}

export class EmailTemplatesService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser) {
    const saved = await this.db.emailTemplates.find({ organisationId: user.organisationId }).lean();
    return TEMPLATE_KEYS.map((key) => {
      const s = saved.find((x) => x.key === key);
      const d = TEMPLATE_DEFAULTS[key];
      return { key, name: d.name, placeholders: d.placeholders, customised: !!s, subject: s?.subject ?? d.subject, intro: s?.intro ?? d.intro, body: s?.body ?? d.body, footer: s?.footer ?? d.footer };
    });
  }

  async save(user: AuthUser, key: TemplateKey, input: Template) {
    const allowed = new Set(TEMPLATE_DEFAULTS[key].placeholders);
    const used = [...`${input.subject} ${input.intro} ${input.body} ${input.footer}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    const unknown = [...new Set(used.filter((u) => !allowed.has(u)))];
    if (unknown.length) throw new BadRequestException(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{{${u}}}`).join(', ')}. Use ${[...allowed].map((a) => `{{${a}}}`).join(', ')}`);
    await this.db.emailTemplates.updateOne({ organisationId: user.organisationId, key }, { ...input, updatedBy: user.id }, { upsert: true });
    await this.audit.log(user, { action: 'email-template.save', recordType: 'EmailTemplate', recordId: user.organisationId, summary: `Changed the ${TEMPLATE_DEFAULTS[key].name} email` });
    return (await this.list(user)).find((t) => t.key === key);
  }

  async reset(user: AuthUser, key: TemplateKey) {
    await this.db.emailTemplates.deleteOne({ organisationId: user.organisationId, key });
    await this.audit.log(user, { action: 'email-template.reset', recordType: 'EmailTemplate', recordId: user.organisationId, summary: `Restored the standard ${TEMPLATE_DEFAULTS[key].name} email` });
    return (await this.list(user)).find((t) => t.key === key);
  }

  /** Sample rendering with made-up values, for the editor. */
  preview(key: TemplateKey, input: Template) {
    const sample: Record<string, string> = { organisation: 'Tachasis Water Co', supplier: 'Eldoret Pipes Ltd', number: 'DOC-KE-000123', title: 'HDPE pipes and fittings', due: '2026-12-15', currency: 'KES', amount: '125,000.00', sender: 'Procurement officer', amendment: '', date: '2026-12-01', method: 'bank transfer', reference: ' (reference EFT-55)' };
    return { subject: fill(input.subject, sample), intro: fill(input.intro, sample), paragraphs: fill(input.body, sample).split(/\n\s*\n/).filter(Boolean), footer: fill(input.footer, sample) };
  }
}
