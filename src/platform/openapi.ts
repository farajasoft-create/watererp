import { buildOpenApi } from '@/modules/finance/core/http/openapi';
import { MANIFESTS } from '@/modules/manifests';
import type { RouteDef } from './http/route';

/**
 * The whole platform's API as OpenAPI 3.1, one tag per module, from the same route definitions the server
 * runs. Finance publishes its own, fuller description at /api/v1/finance/openapi.json.
 */
export function platformOpenApi(routes: RouteDef[], serverUrl: string) {
  const doc = buildOpenApi(routes as never, serverUrl);
  const names = new Map<string, string>(MANIFESTS.map((m) => [m.key, m.name]));
  for (const [path, ops] of Object.entries(doc.paths)) {
    const first = path.split('/').filter(Boolean)[0] ?? '';
    for (const op of Object.values(ops) as { tags?: string[] }[]) op.tags = [names.get(first) ?? 'Platform'];
  }
  return {
    ...doc,
    info: {
      title: 'gERP API',
      version: '1.0.0',
      description: [
        'REST API of every module (water, HR, finance, projects, estates, tenders and the rest), under /api/v1/<module>.',
        'Authenticate with an API key issued under Settings → Developers (`Authorization: Bearer gk_…`). A key acts as the user it was issued to, so give it to a service user holding only the roles the other system needs; every call is in the audit trail.',
        'Money travels as decimal strings, dates as YYYY-MM-DD. Errors return `{ statusCode, message, errors? }`. Finance has its own description at /api/v1/finance/openapi.json.',
      ].join('\n\n'),
    },
    tags: [...new Set(Object.values(doc.paths).flatMap((ops) => Object.values(ops).flatMap((op) => (op as { tags?: string[] }).tags ?? [])))].sort().map((name) => ({ name })),
  };
}
