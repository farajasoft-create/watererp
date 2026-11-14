import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { allowedBranches } from '../common/access';
import { parseCsvRecords, toCsv } from '../common/csv';
import { BadRequestException, ForbiddenException, HttpError, NotFoundException } from '../common/errors';
import { PERMISSIONS as P } from '../common/permissions';
import { parseId, parseWith, zDate, zDecimal, zId } from '../common/validation';
import { route, RouteDef } from '../http/router';
import { buildOpenApi } from '../http/openapi';
import { ledgerExport, LEDGER_EXPORT_COLUMNS, loadRefs, TRANSFER_KINDS } from '../modules/integrations/data-transfer';
import { WEBHOOK_EVENTS } from '../modules/integrations/webhooks.service';

const ServiceAccountBody = z.object({
  name: z.string().trim().min(1).max(100),
  roleIds: z.array(zId).min(1, 'Give the service account at least one role'),
  allBranches: z.boolean().default(true),
  branchIds: z.array(zId).default([]),
  approvalLimit: zDecimal.refine((d) => d.gte(0), 'Must not be negative').nullable().optional(),
  isActive: z.boolean().optional(),
});

const WebhookBody = z.object({
  url: z.string().trim().url().max(2000),
  description: z.string().trim().max(500).optional(),
  events: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
});

const csvResponse = (filename: string, csv: string) =>
  new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' } });

/** Lazily loaded to avoid a cycle: the route table includes these routes. */
const allRoutes = async (): Promise<RouteDef[]> => (await import('./index')).routes;
const api = async () => (await import('./index')).handleApi;

const integrations = [
  route({ method: 'GET', path: '/service-accounts', permissions: [P.INTEGRATIONS_MANAGE], handler: ({ s, user }) => s.apiKeys.list(user) }),
  route({ method: 'POST', path: '/service-accounts', permissions: [P.INTEGRATIONS_MANAGE], body: ServiceAccountBody, handler: ({ s, user, body }) => s.apiKeys.createAccount(user, body) }),
  route({
    method: 'PATCH',
    path: '/service-accounts/:id',
    permissions: [P.INTEGRATIONS_MANAGE],
    body: ServiceAccountBody.partial(),
    handler: ({ s, user, body, params }) => s.apiKeys.updateAccount(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/service-accounts/:id/keys',
    permissions: [P.INTEGRATIONS_MANAGE],
    body: z.object({ name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(730).nullable().optional() }),
    handler: ({ s, user, body, params }) => s.apiKeys.createKey(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/api-keys/:id/revoke', permissions: [P.INTEGRATIONS_MANAGE], handler: ({ s, user, params }) => s.apiKeys.revokeKey(user, parseId(params.id)) }),

  route({ method: 'GET', path: '/webhooks/events', handler: () => WEBHOOK_EVENTS }),
  route({ method: 'GET', path: '/webhooks', permissions: [P.INTEGRATIONS_MANAGE], handler: ({ s, user }) => s.webhooks.list(user) }),
  route({ method: 'POST', path: '/webhooks', permissions: [P.INTEGRATIONS_MANAGE], body: WebhookBody, handler: ({ s, user, body }) => s.webhooks.create(user, body) }),
  route({
    method: 'PATCH',
    path: '/webhooks/:id',
    permissions: [P.INTEGRATIONS_MANAGE],
    body: WebhookBody.partial().extend({ isActive: z.boolean().optional() }),
    handler: ({ s, user, body, params }) => s.webhooks.update(user, parseId(params.id), body),
  }),
  route({ method: 'DELETE', path: '/webhooks/:id', permissions: [P.INTEGRATIONS_MANAGE], handler: ({ s, user, params }) => s.webhooks.remove(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/webhooks/:id/rotate-secret', permissions: [P.INTEGRATIONS_MANAGE], handler: ({ s, user, params }) => s.webhooks.rotateSecret(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/webhooks/:id/test', status: 200, permissions: [P.INTEGRATIONS_MANAGE], handler: ({ s, user, params }) => s.webhooks.test(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/webhooks/deliveries',
    permissions: [P.INTEGRATIONS_MANAGE],
    query: z.object({ endpointId: zId.optional(), status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
    handler: ({ s, user, query }) => s.webhooks.deliveries(user, query),
  }),
  route({ method: 'POST', path: '/webhooks/deliveries/:id/redeliver', status: 200, permissions: [P.INTEGRATIONS_MANAGE], handler: ({ s, user, params }) => s.webhooks.redeliver(user, parseId(params.id)) }),
];

const dataTransfer = [
  route({
    method: 'GET',
    path: '/export/:kind',
    permissions: [P.DATA_EXPORT],
    query: z.object({ format: z.enum(['csv', 'json']).default('csv'), entityId: zId.optional(), from: zDate.optional(), to: zDate.optional() }),
    handler: async ({ s, user, params, query }) => {
      if (params.kind === 'ledger') {
        if (!user.permissions.includes(P.JOURNAL_VIEW)) throw new ForbiddenException('Missing permission: journal.view');
        if (!query.entityId || !query.from || !query.to) throw new BadRequestException('entityId, from and to are required for the ledger export');
        const rows = await ledgerExport(s.db, user, { entityId: query.entityId, from: query.from, to: query.to, branchIds: allowedBranches(user) });
        await s.audit.log(user, { action: 'data.export', recordType: 'LedgerEntry', summary: `Exported ${rows.length} ledger lines ${query.from.toISOString().slice(0, 10)} to ${query.to.toISOString().slice(0, 10)}` });
        if (query.format === 'json') return rows.map((r) => Object.fromEntries(LEDGER_EXPORT_COLUMNS.map((c, i) => [c, r[i]])));
        return csvResponse(`ledger-${query.from.toISOString().slice(0, 10)}-${query.to.toISOString().slice(0, 10)}.csv`, toCsv(LEDGER_EXPORT_COLUMNS, rows));
      }
      const kind = TRANSFER_KINDS[params.kind];
      if (!kind) throw new NotFoundException(`Unknown export ${params.kind}`);
      const [docs, refs] = await Promise.all([kind.find(s.db, user), loadRefs(s.db, user)]);
      const rows = docs.map((d) => kind.toRow(d, refs));
      await s.audit.log(user, { action: 'data.export', recordType: kind.label, summary: `Exported ${rows.length} ${kind.label.toLowerCase()}` });
      if (query.format === 'json') return rows.map((r) => Object.fromEntries(kind.columns.map((c, i) => [c, r[i]])));
      return csvResponse(`${params.kind}.csv`, toCsv(kind.columns, rows));
    },
  }),
  route({
    method: 'GET',
    path: '/import/:kind/template',
    permissions: [P.DATA_IMPORT],
    handler: ({ params }) => {
      const kind = TRANSFER_KINDS[params.kind];
      if (!kind) throw new NotFoundException(`Unknown import ${params.kind}`);
      return csvResponse(`${params.kind}-template.csv`, toCsv(kind.columns, []));
    },
  }),
  /**
   * Imports rows by calling the regular create/update endpoint for each one with the caller's own
   * credentials, so imported records get exactly the same validation, permissions and audit trail.
   * Rows are matched on code: existing records are updated, new ones created. Each row stands alone.
   */
  route({
    method: 'POST',
    path: '/import/:kind',
    status: 200,
    permissions: [P.DATA_IMPORT],
    rateLimit: 20,
    body: z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) }),
    handler: async ({ s, user, params, body, req }) => {
      const kind = TRANSFER_KINDS[params.kind];
      if (!kind) throw new NotFoundException(`Unknown import ${params.kind}`);
      const { headers, records } = parseCsvRecords(body.csv);
      const unknown = headers.filter((h) => h && !kind.columns.includes(h));
      if (unknown.length) throw new BadRequestException(`Unknown column(s): ${unknown.join(', ')}. Expected: ${kind.columns.join(', ')}`);
      const missing = kind.required.filter((c) => !headers.includes(c));
      if (missing.length) throw new BadRequestException(`Missing required column(s): ${missing.join(', ')}`);
      if (records.length > 2000) throw new BadRequestException('Import at most 2,000 rows at a time');

      const [refs, existing, routes, handle] = await Promise.all([loadRefs(s.db, user), kind.find(s.db, user), allRoutes(), api()]);
      const byCode = new Map(existing.map((d) => [String(d.code).toUpperCase(), String(d._id)]));
      const createDef = routes.find((r) => r.method === 'POST' && r.path === kind.path)!;
      const updateDef = routes.find((r) => r.method === 'PATCH' && r.path === `${kind.path}/:id`)!;
      const origin = new URL(req.url).origin;
      const auth = { authorization: req.headers.get('authorization') ?? '', cookie: req.headers.get('cookie') ?? '' };
      const seen = new Set<string>();
      const results: { row: number; code: string; action: 'create' | 'update' | 'error'; message?: string; id?: string }[] = [];
      for (const [i, row] of records.entries()) {
        const rowNo = i + 2;
        const code = (row.code ?? '').toUpperCase();
        try {
          for (const c of kind.required) if (!row[c]) throw new BadRequestException(`${c} is required`);
          if (seen.has(code)) throw new BadRequestException(`code ${code} appears more than once in the file`);
          seen.add(code);
          const payload = kind.toBody(row, refs);
          const id = byCode.get(code);
          const def = id ? updateDef : createDef;
          if (def.body) parseWith(def.body, payload);
          if (body.dryRun) {
            results.push({ row: rowNo, code, action: id ? 'update' : 'create' });
            continue;
          }
          const res = await handle(
            new Request(`${origin}${process.env.FINANCE_STANDALONE === 'true' ? '/api/v1' : '/api/v1/finance'}${id ? `${kind.path}/${id}` : kind.path}`, { method: id ? 'PATCH' : 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
            { internal: true },
          );
          const json = (await res.json()) as { _id?: string; id?: string; message?: string; errors?: { path: string; message: string }[] };
          if (!res.ok) throw new HttpError(res.status, [json.message, ...(json.errors ?? []).map((e) => `${e.path}: ${e.message}`)].filter(Boolean).join('; '));
          results.push({ row: rowNo, code, action: id ? 'update' : 'create', id: json.id ?? json._id });
        } catch (err) {
          const message = err instanceof HttpError ? [err.message, ...((err.details as { path: string; message: string }[] | undefined) ?? []).map((e) => `${e.path}: ${e.message}`)].join('; ') : 'Unexpected error';
          results.push({ row: rowNo, code, action: 'error', message });
        }
      }
      const summary = { rows: records.length, created: results.filter((r) => r.action === 'create').length, updated: results.filter((r) => r.action === 'update').length, errors: results.filter((r) => r.action === 'error').length };
      if (!body.dryRun) await s.audit.log(user, { action: 'data.import', recordType: kind.label, summary: `Imported ${kind.label.toLowerCase()}: ${summary.created} created, ${summary.updated} updated, ${summary.errors} failed` });
      return { dryRun: body.dryRun, ...summary, results };
    },
  }),
];

const platform = [
  route({
    method: 'GET',
    path: '/openapi.json',
    public: true,
    handler: async ({ req }) => buildOpenApi(await allRoutes(), `${new URL(req.url).origin}/api/v1`),
  }),
  /**
   * Background jobs, called by Vercel Cron (see vercel.json) with `Authorization: Bearer $CRON_SECRET`:
   * webhook deliveries and retries, approval escalations and the reporting warehouse refresh.
   */
  route({
    method: 'GET',
    path: '/cron/run',
    public: true,
    handler: async ({ s, req }) => {
      const secret = process.env.CRON_SECRET;
      if (!secret) throw new HttpError(503, 'CRON_SECRET is not configured');
      const given = Buffer.from(req.headers.get('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${secret}`);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid cron secret');
      const started = Date.now();
      const webhooks = await s.webhooks.deliverDue({ limit: 500 });
      const workflow = await s.workflow.escalateOverdue();
      const warehouse = await s.warehouse.refreshAll();
      const uploads = { ...(await s.attachments.cleanupPending()), scan: await s.attachments.scanBacklog() };
      const recurring = await s.recurring.processDue();
      const imprest = await s.imprest.remindOverdue();
      const suppliers = await s.supplierManagement.liftExpiredSuspensions();
      const budgets = await s.budgetPlanning.notifyBalances();
      const investments = await s.investments.remindMaturities();
      const digests = await s.notificationEmails.sendDigests();
      const packs = await s.notificationEmails.sendPacks();
      const prompts = await s.mpesa.queryPending();
      const mpesa = { ...(await s.mpesa.expireStale()), ...prompts, ...(await s.payouts.reconcile()) };
      const emails = await s.email.deliverDue({ limit: 500 });
      const sms = await s.sms.deliverDue({ limit: 500 });
      const etims = { ...(await s.etims.deliverDue({ limit: 200 })), purchases: await s.etimsPurchases.fetch(), purchaseReports: await s.etimsPurchases.deliverReports(), imports: { ...(await s.etimsImports.fetch()), ...(await s.etimsImports.deliverReports()) }, stock: { ...(await s.etimsStock.collect()), ...(await s.etimsStock.deliver()) } };
      const payouts = await s.payouts.deliverDue({ limit: 200 });
      const feeds = await s.feeds.syncAll();
      return { payouts, feeds, etims, sms, mpesa, webhooks, workflow, recurring, imprest, suppliers, budgets, investments, digests, packs, emails, warehouse, uploads, ms: Date.now() - started };
    },
  }),
];

export const platformRoutes = [...integrations, ...dataTransfer, ...platform];
