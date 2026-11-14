import { createHash } from 'node:crypto';
import { mongo } from 'mongoose';
import { authenticate, AuthUser } from '../auth';
import { ForbiddenException, HttpError, NotFoundException, TooManyRequestsException } from '../common/errors';
import { serialize } from '../common/serialize';
import { parseWith } from '../common/validation';
import type { Platform } from '../container';
import { RateLimiter } from './rate-limit';
import { RouteContext, RouteDef } from './route';

export type { RouteContext, RouteDef } from './route';

interface Compiled {
  def: RouteDef;
  segments: string[];
  /** Static segments outrank parameters, so /customers/search wins over /customers/:id. */
  score: number[];
}

function compile(def: RouteDef): Compiled {
  const segments = def.path.split('/').filter(Boolean);
  return { def, segments, score: segments.map((s) => (s.startsWith(':') ? 1 : 2)) };
}

function matchPath(c: Compiled, parts: string[]): Record<string, string> | null {
  if (c.segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = c.segments[i];
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
    else if (seg !== parts[i]) return null;
  }
  return params;
}

const better = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

function queryObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || null;
}

function errorResponse(err: unknown): Response {
  let status = 500;
  let body: Record<string, unknown> = { statusCode: 500, message: 'Internal server error' };
  if (err instanceof HttpError) {
    status = err.status;
    body = { statusCode: status, message: err.message, ...(err.details && { errors: err.details }) };
  } else if (err instanceof mongo.MongoServerError && err.code === 11000) {
    const fields = Object.keys((err.keyValue as Record<string, unknown>) ?? {}).filter((k) => k !== 'organisationId');
    status = 409;
    body = { statusCode: 409, message: `A record with the same ${fields.join(', ') || 'key'} already exists` };
  } else {
    console.error(err);
  }
  return Response.json(body, { status });
}

const globalLimiter = new RateLimiter(600);
const routeLimiters = new Map<string, RateLimiter>();

/** Builds a fetch-style handler for a set of routes mounted under `prefix`. */
export function createRouter(routes: RouteDef[], getPlatform: () => Promise<Platform>, prefix = '/api/v1') {
  const compiled = routes.map(compile);

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const parts = path.split('/').filter(Boolean);
    const cookies: string[] = [];
    try {
      let found: { c: Compiled; params: Record<string, string> } | null = null;
      let pathExists = false;
      for (const c of compiled) {
        const params = matchPath(c, parts);
        if (!params) continue;
        pathExists = true;
        if (c.def.method !== req.method) continue;
        if (!found || better(c.score, found.c.score)) found = { c, params };
      }
      if (!found) {
        if (pathExists) return Response.json({ statusCode: 405, message: 'Method not allowed' }, { status: 405 });
        throw new NotFoundException(`Cannot ${req.method} ${path}`);
      }
      const def = found.c.def;
      const ip = clientIp(req);
      const key = ip ?? 'unknown';
      if (!globalLimiter.allow(key)) throw new TooManyRequestsException();
      if (def.rateLimit) {
        const id = `${def.method} ${def.path}`;
        let limiter = routeLimiters.get(id);
        if (!limiter) routeLimiters.set(id, (limiter = new RateLimiter(def.rateLimit)));
        if (!limiter.allow(key)) throw new TooManyRequestsException();
      }

      const platform = await getPlatform();
      const core = platform.core;
      const s = def.module ? platform.modules[def.module] : core;
      const user = def.public ? (undefined as unknown as AuthUser) : await authenticate(core.db, req, { ip }, core.manifests);
      if (def.module && user && !user.modules.includes(def.module)) {
        throw new ForbiddenException(`The ${platform.manifests[def.module]?.name ?? def.module} module is not switched on for your organisation`);
      }
      if (user?.mustEnrolTwoFactor && !def.path.startsWith('/auth/')) throw new ForbiddenException('Set up two-step sign-in first (your organisation requires it)');
      const missing = (def.permissions ?? []).filter((p) => !user.permissions.includes(p));
      if (missing.length) throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);

      let rawBody: unknown = undefined;
      let text = '';
      if (req.method !== 'GET' && req.method !== 'DELETE' && !def.raw) {
        text = await req.text();
        try {
          rawBody = text ? JSON.parse(text) : {};
        } catch {
          throw new HttpError(400, 'The request body is not valid JSON');
        }
      }

      // Idempotency: a retried write with the same key replays the first response instead of running twice.
      const idempotencyKey = !def.public && !def.raw && (req.method === 'POST' || req.method === 'PATCH') ? req.headers.get('idempotency-key') : null;
      let idempotencyId: unknown = null;
      if (idempotencyKey) {
        if (idempotencyKey.length > 255) throw new HttpError(400, 'Idempotency-Key must be at most 255 characters');
        const requestHash = createHash('sha256').update(`${req.method} ${path}\n${text}`).digest('hex');
        const scope = { organisationId: user.organisationId, userId: user.id, key: idempotencyKey };
        try {
          const [created] = await core.db.idempotency.create([{ ...scope, method: req.method, path, requestHash }]);
          idempotencyId = created._id;
        } catch (err) {
          if (!(err instanceof mongo.MongoServerError && err.code === 11000)) throw err;
          const prior = await core.db.idempotency.findOne(scope).lean();
          if (!prior || prior.status !== 'DONE') throw new HttpError(409, 'A request with this Idempotency-Key is still in progress');
          if (prior.requestHash !== requestHash) throw new HttpError(422, 'This Idempotency-Key was already used for a different request');
          const replay = new Response(prior.responseBody, { status: prior.responseStatus ?? 200, headers: { 'content-type': 'application/json' } });
          replay.headers.set('Idempotent-Replayed', 'true');
          return replay;
        }
      }
      const ctx: RouteContext<unknown, unknown, unknown> = {
        req,
        user,
        body: def.body ? parseWith(def.body, rawBody ?? {}) : rawBody,
        query: def.query ? parseWith(def.query, queryObject(url.searchParams)) : queryObject(url.searchParams),
        params: found.params,
        s,
        core,
        ip,
        setCookie: (name, value, o = {}) => {
          const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
          if (o.httpOnly !== false) attrs.push('HttpOnly');
          if (o.secure) attrs.push('Secure');
          if (o.maxAge !== undefined) attrs.push(`Max-Age=${o.maxAge}`);
          cookies.push(attrs.join('; '));
        },
      };
      let result: unknown;
      try {
        result = await def.handler(ctx as RouteContext<never, never, never>);
      } catch (err) {
        // A failed request may be retried with the same key once the problem is fixed.
        if (idempotencyId) await core.db.idempotency.deleteOne({ _id: idempotencyId });
        throw err;
      }
      // Record views of single records and every file download or export (who saw what).
      if (user && req.method === 'GET') {
        const download = result instanceof Response && /attachment|inline|filename/.test(result.headers.get('content-disposition') ?? '');
        if (download || def.path.includes('/:')) {
          core.db.accessLogs.create({ organisationId: user.organisationId, userId: user.id, module: def.module ?? 'core', kind: download ? 'DOWNLOAD' : 'VIEW', path: `${path}${url.search}`.slice(0, 500), ip }).catch(() => undefined);
        }
      }
      // Handlers may stream files (photos, CSV exports) by returning a Response.
      if (result instanceof Response) {
        for (const c of cookies) result.headers.append('Set-Cookie', c);
        return result;
      }
      const status = def.status ?? (def.method === 'POST' ? 201 : 200);
      const json = JSON.stringify(serialize(result) ?? null);
      if (idempotencyId) await core.db.idempotency.updateOne({ _id: idempotencyId }, { status: 'DONE', responseStatus: status, responseBody: json });
      const response = new Response(json, { status, headers: { 'content-type': 'application/json' } });
      for (const c of cookies) response.headers.append('Set-Cookie', c);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (err) {
      return errorResponse(err);
    }
  };
}
