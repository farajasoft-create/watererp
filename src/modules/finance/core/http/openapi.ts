import { ZodFirstPartyTypeKind, ZodTypeAny } from 'zod';
import { zBool, zCurrency, zDate, zDecimal, zId } from '../common/validation';
import { RouteDef } from './router';

type JsonSchema = Record<string, unknown>;

const KNOWN = new Map<unknown, JsonSchema>([
  [zId, { type: 'string', pattern: '^[a-f0-9]{24}$', description: 'Object id' }],
  [zDate, { type: 'string', format: 'date' }],
  [zDecimal, { type: 'string', format: 'decimal', description: 'Exact decimal as a string, e.g. "1250.00"', example: '1250.00' }],
  [zCurrency, { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 currency code' }],
  [zBool, { type: 'boolean' }],
]);

/** Converts a Zod (v3) schema to JSON Schema for the request side of the API description. */
export function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const known = KNOWN.get(schema);
  if (known) return { ...known };
  const def = schema._def as Record<string, unknown> & { typeName: ZodFirstPartyTypeKind; description?: string };
  const out = convert(schema, def);
  if (def.description) out.description = def.description;
  return out;
}

function convert(schema: ZodTypeAny, def: Record<string, unknown> & { typeName: ZodFirstPartyTypeKind }): JsonSchema {
  const K = ZodFirstPartyTypeKind;
  switch (def.typeName) {
    case K.ZodString: {
      const out: JsonSchema = { type: 'string' };
      for (const c of (def.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? []) {
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'max') out.maxLength = c.value;
        if (c.kind === 'email') out.format = 'email';
        if (c.kind === 'url') out.format = 'uri';
        if (c.kind === 'regex') out.pattern = c.regex!.source;
      }
      return out;
    }
    case K.ZodNumber: {
      const out: JsonSchema = { type: 'number' };
      for (const c of (def.checks as { kind: string; value?: number; inclusive?: boolean }[]) ?? []) {
        if (c.kind === 'int') out.type = 'integer';
        if (c.kind === 'min') out[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
        if (c.kind === 'max') out[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
      }
      return out;
    }
    case K.ZodBoolean:
      return { type: 'boolean' };
    case K.ZodDate:
      return { type: 'string', format: 'date-time' };
    case K.ZodLiteral:
      return { const: def.value };
    case K.ZodEnum:
      return { type: 'string', enum: def.values };
    case K.ZodNativeEnum:
      return { enum: Object.values(def.values as object) };
    case K.ZodArray: {
      const out: JsonSchema = { type: 'array', items: toJsonSchema(def.type as ZodTypeAny) };
      if (def.minLength) out.minItems = (def.minLength as { value: number }).value;
      if (def.maxLength) out.maxItems = (def.maxLength as { value: number }).value;
      return out;
    }
    case K.ZodObject: {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      return { type: 'object', properties, ...(required.length && { required }), additionalProperties: false };
    }
    case K.ZodRecord:
      return { type: 'object', additionalProperties: toJsonSchema(def.valueType as ZodTypeAny) };
    case K.ZodUnion:
    case K.ZodDiscriminatedUnion: {
      const options = (def.options as ZodTypeAny[] | Map<unknown, ZodTypeAny>) ?? [];
      return { oneOf: [...(options instanceof Map ? options.values() : options)].map(toJsonSchema) };
    }
    case K.ZodIntersection:
      return { allOf: [toJsonSchema(def.left as ZodTypeAny), toJsonSchema(def.right as ZodTypeAny)] };
    case K.ZodOptional:
      return toJsonSchema(def.innerType as ZodTypeAny);
    case K.ZodNullable: {
      const inner = toJsonSchema(def.innerType as ZodTypeAny);
      return { anyOf: [inner, { type: 'null' }] };
    }
    case K.ZodDefault:
      return { ...toJsonSchema(def.innerType as ZodTypeAny), default: (def.defaultValue as () => unknown)() };
    case K.ZodEffects:
      return toJsonSchema(def.schema as ZodTypeAny);
    case K.ZodPipeline:
      return toJsonSchema(def.in as ZodTypeAny);
    case K.ZodLazy:
      return {};
    default:
      void schema;
      return {};
  }
}

const TAG_NAMES: Record<string, string> = {
  auth: 'Authentication',
  me: 'Authentication',
  organisation: 'Organisation',
  users: 'Users & roles',
  roles: 'Users & roles',
  permissions: 'Users & roles',
  entities: 'Structure',
  branches: 'Structure',
  dimensions: 'Structure',
  accounts: 'Chart of accounts',
  currencies: 'Currencies & FX',
  'exchange-rates': 'Currencies & FX',
  'fiscal-years': 'Periods',
  periods: 'Periods',
  journals: 'Journals',
  reports: 'Reports',
  customers: 'Customers & suppliers',
  suppliers: 'Customers & suppliers',
  parties: 'Customers & suppliers',
  invoices: 'Invoices & bills',
  payments: 'Payments & receipts',
  allocations: 'Payments & receipts',
  'bank-accounts': 'Banking',
  'bank-transfers': 'Banking',
  'bank-statements': 'Banking',
  reconciliations: 'Banking',
  'tax-codes': 'Tax',
  requisitions: 'Procurement',
  'purchase-orders': 'Procurement',
  items: 'Inventory',
  warehouses: 'Inventory',
  stock: 'Inventory',
  assets: 'Fixed assets',
  'asset-categories': 'Fixed assets',
  depreciation: 'Fixed assets',
  'expense-claims': 'Expenses',
  'expense-categories': 'Expenses',
  budgets: 'Budgets',
  approvals: 'Workflow',
  'approval-rules': 'Workflow',
  delegations: 'Workflow',
  notifications: 'Workflow',
  webhooks: 'Webhooks',
  'service-accounts': 'API keys',
  'api-keys': 'API keys',
  import: 'Bulk import & export',
  export: 'Bulk import & export',
  analytics: 'Analytics',
  'recurring-journals': 'Journals',
  collections: 'Collections',
  suggestions: 'Suggestions',
  ai: 'AI assistance',
  attachments: 'Documents',
  directory: 'Workflow',
  'openapi.json': 'API',
};

function tagOf(path: string): string {
  const first = path.split('/').filter(Boolean)[0] ?? '';
  return TAG_NAMES[first] ?? first.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** OpenAPI 3.1 description of the routes, generated from the same definitions the router runs. */
export function buildOpenApi(routes: RouteDef[], serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const def of routes) {
    // Scheduler, Safaricom and customer-portal endpoints are not part of the integration API.
    if (def.path.startsWith('/cron') || def.path.startsWith('/mpesa/callbacks') || def.path.startsWith('/portal/')) continue;
    const oaPath = def.path.replace(/:(\w+)/g, '{$1}');
    const params = [...def.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (def.query) {
      const q = toJsonSchema(def.query as ZodTypeAny) as { properties?: Record<string, JsonSchema>; required?: string[] };
      for (const [name, schema] of Object.entries(q.properties ?? {})) params.push({ name, in: 'query', required: q.required?.includes(name) ?? false, schema: schema as never });
    }
    const status = String(def.status ?? (def.method === 'POST' ? 201 : 200));
    const operation: Record<string, unknown> = {
      tags: [tagOf(def.path)],
      operationId: `${def.method.toLowerCase()}${def.path.replace(/[/:-](\w)/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')}`,
      ...(params.length && { parameters: params }),
      ...(def.body && { requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(def.body as ZodTypeAny) } } } }),
      responses: {
        [status]: { description: 'Success' },
        ...(def.body && { '400': { $ref: '#/components/responses/ValidationError' } }),
        ...(!def.public && { '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' } }),
        ...(def.path.includes(':') && { '404': { $ref: '#/components/responses/NotFound' } }),
        '429': { $ref: '#/components/responses/RateLimited' },
      },
      ...(def.permissions?.length && { 'x-permissions': def.permissions }),
      ...(def.public ? { security: [] } : {}),
    };
    if (def.method === 'POST' || def.method === 'PATCH') {
      operation.parameters = [
        ...((operation.parameters as unknown[]) ?? []),
        { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 }, description: 'Retries with the same key within 24 hours replay the first response' },
      ];
    }
    (paths[oaPath] ??= {})[def.method.toLowerCase()] = operation;
  }
  const error = { type: 'object', properties: { statusCode: { type: 'integer' }, message: { type: 'string' }, errors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } } } };
  const response = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  return {
    openapi: '3.1.0',
    info: {
      title: 'FarajaSoft Accounting API',
      version: '1.0.0',
      description:
        'Multi-entity, multi-branch, multi-currency accounting API. Authenticate with an API key (`Authorization: Bearer fsk_…`) issued to a service account under Settings → Developers. Money is exchanged as decimal strings. Writes accept an `Idempotency-Key` header. Webhook deliveries are signed with `X-FarajaSoft-Signature: t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">`.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'API key (fsk_…) or session token' } },
      schemas: { Error: error },
      responses: {
        ValidationError: response('The request failed validation'),
        Unauthorized: response('Missing, invalid or revoked credentials'),
        Forbidden: response('Missing permission, branch access or segregation of duties'),
        NotFound: response('Not found'),
        RateLimited: response('Too many requests'),
      },
    },
  };
}
