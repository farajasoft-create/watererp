import { createHash } from 'node:crypto';
import { mongo } from 'mongoose';
import { after } from 'next/server';
import { ZodType, ZodTypeDef } from 'zod';
import { authenticate, AuthUser } from '../common/auth';
import { ForbiddenException, HttpError, NotFoundException, TooManyRequestsException } from '../common/errors';
import { Permission } from '../common/permissions';
import { serialize } from '../common/serialize';
import { parseWith } from '../common/validation';
import { getServices, Services } from '../container';
import { RateLimiter } from './rate-limit';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict';
}

export interface RouteContext<B, Q> {
  req: Request;
  /** The caller. Undefined only on public routes. */
  user: AuthUser;
  body: B;
  query: Q;
  params: Record<string, string>;
  s: Services;
  headers: Headers;
  ip: string | null;
  setCookie: (name: string, value: string, options?: CookieOptions) => void;
}

export interface RouteDef {
  method: Method;
  path: string;
  public?: boolean;
  permissions?: Permission[];
  /** Response status on success; POST defaults to 201. */
  status?: number;
  /** Requests per minute per IP for this route (in addition to the global limit). */
  rateLimit?: number;
  /** The handler reads the request body itself (file uploads); no JSON parsing or idempotency. */
  raw?: boolean;
  /** Reachable while the user still has to set up MFA required by their organisation. */
  duringMfaEnrollment?: boolean;
  body?: ZodType<unknown, ZodTypeDef, unknown>;
  query?: ZodType<unknown, ZodTypeDef, unknown>;
  handler: (ctx: RouteContext<never, never>) => unknown;
}

/** Declares a route; body and query types are inferred from their Zod schemas. */
export function route<B = undefined, Q = undefined>(def: {
  method: Method;
  path: string;
  public?: boolean;
  permissions?: Permission[];
  status?: number;
  rateLimit?: number;
  raw?: boolean;
  duringMfaEnrollment?: boolean;
  body?: ZodType<B, ZodTypeDef, unknown>;
  query?: ZodType<Q, ZodTypeDef, unknown>;
  handler: (ctx: RouteContext<B, Q>) => unknown;
}): RouteDef {
  return def as unknown as RouteDef;
}

interface Compiled {
  def: RouteDef;
  segments: string[];
  /** Static segments outrank parameters, so /payments/proposal wins over /payments/:id. */
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

/**
 * Pushes webhook deliveries queued by this request once the response has been sent. Outside a Next.js
 * request (tests, scripts) there is no request scope; the cron job delivers them instead.
 */
function deliverAfterResponse(s: Services, user: AuthUser | undefined) {
  try {
    if (!user) {
      // Public requests (forgot password) can still have queued an email.
      after(() => Promise.all([s.email.deliverDue({ limit: 10 }), s.sms.deliverDue({ limit: 10 })]).then(() => undefined));
      return;
    }
    after(() =>
      Promise.all([
        s.webhooks.deliverDue({ organisationId: user.organisationId, limit: 25 }),
        s.email.deliverDue({ organisationId: user.organisationId, limit: 25 }),
        s.sms.deliverDue({ organisationId: user.organisationId, limit: 25 }),
        s.etims.deliverDue({ organisationId: user.organisationId, limit: 10 }),
        s.etimsPurchases.deliverReports({ organisationId: user.organisationId }),
        s.etimsImports.deliverReports({ organisationId: user.organisationId }),
        s.payouts.deliverDue({ organisationId: user.organisationId, limit: 10 }),
      ]).then(() => undefined),
    );
  } catch {
    // No request scope.
  }
}

const globalLimiter = new RateLimiter(600);
const routeLimiters = new Map<string, RateLimiter>();

/** Builds a fetch-style handler for a set of routes mounted under `prefix`. */
export function createRouter(routes: RouteDef[], prefix = '/api/v1') {
  const compiled = routes.map(compile);

  /** `internal` marks requests the API makes to itself (bulk import), which skip rate limiting. */
  return async function handle(req: Request, opts: { internal?: boolean } = {}): Promise<Response> {
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
      if (!opts.internal && !globalLimiter.allow(key)) throw new TooManyRequestsException();
      if (def.rateLimit && !opts.internal) {
        const id = `${def.method} ${def.path}`;
        let limiter = routeLimiters.get(id);
        if (!limiter) routeLimiters.set(id, (limiter = new RateLimiter(def.rateLimit)));
        if (!limiter.allow(key)) throw new TooManyRequestsException();
      }

      const s = await getServices();
      const user = def.public ? (undefined as unknown as AuthUser) : await authenticate(s.db, req, { ip });
      if (user?.mfaEnrollmentRequired && !def.duringMfaEnrollment) {
        throw new HttpError(403, 'Your organisation requires two-step verification. Set it up to continue.', [{ path: 'code', message: 'MFA_ENROLLMENT_REQUIRED' }]);
      }
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
        const requestHash = createHash('sha256').update(`${req.method} ${path}
${text}`).digest('hex');
        const scope = { organisationId: user.organisationId, userId: user.id, key: idempotencyKey };
        try {
          const [created] = await s.db.idempotency.create([{ ...scope, method: req.method, path, requestHash }]);
          idempotencyId = created._id;
        } catch (err) {
          if (!(err instanceof mongo.MongoServerError && err.code === 11000)) throw err;
          const prior = await s.db.idempotency.findOne(scope).lean();
          if (!prior) throw new HttpError(409, 'A request with this Idempotency-Key is still in progress');
          if (prior.requestHash !== requestHash) throw new HttpError(422, 'This Idempotency-Key was already used for a different request');
          if (prior.status !== 'DONE') throw new HttpError(409, 'A request with this Idempotency-Key is still in progress');
          const replay = new Response(prior.responseBody, { status: prior.responseStatus ?? 200, headers: { 'content-type': 'application/json' } });
          replay.headers.set('Idempotent-Replayed', 'true');
          replay.headers.set('Cache-Control', 'no-store');
          return replay;
        }
      }
      const ctx: RouteContext<unknown, unknown> = {
        req,
        user,
        body: def.body ? parseWith(def.body, rawBody ?? {}) : rawBody,
        query: def.query ? parseWith(def.query, queryObject(url.searchParams)) : queryObject(url.searchParams),
        params: found.params,
        s,
        headers: req.headers,
        ip,
        setCookie: (name, value, o = {}) => {
          const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${o.sameSite ?? 'Lax'}`];
          if (o.httpOnly !== false) attrs.push('HttpOnly');
          if (o.secure) attrs.push('Secure');
          if (o.maxAge !== undefined) attrs.push(`Max-Age=${o.maxAge}`);
          cookies.push(attrs.join('; '));
        },
      };
      let result: unknown;
      try {
        result = await def.handler(ctx as RouteContext<never, never>);
      } catch (err) {
        // A failed request may be retried with the same key once the problem is fixed.
        if (idempotencyId) await s.db.idempotency.deleteOne({ _id: idempotencyId });
        throw err;
      }
      // Handlers may stream files (CSV exports) by returning a Response.
      if (result instanceof Response) {
        for (const c of cookies) result.headers.append('Set-Cookie', c);
        return result;
      }
      const status = def.status ?? (def.method === 'POST' ? 201 : 200);
      const json = JSON.stringify(serialize(result) ?? null);
      if (idempotencyId) await s.db.idempotency.updateOne({ _id: idempotencyId }, { status: 'DONE', responseStatus: status, responseBody: json });
      const response = new Response(json, { status, headers: { 'content-type': 'application/json' } });
      for (const c of cookies) response.headers.append('Set-Cookie', c);
      response.headers.set('Cache-Control', 'no-store');
      if (idempotencyId) response.headers.set('Idempotency-Key', idempotencyKey!);
      if (req.method !== 'GET') deliverAfterResponse(s, user);
      return response;
    } catch (err) {
      return errorResponse(err);
    }
  };
}
