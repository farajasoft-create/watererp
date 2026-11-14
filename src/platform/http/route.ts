import type { ZodType, ZodTypeDef } from 'zod';
import type { AuthUser } from '../auth';
import type { CoreServices } from '../container';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface RouteContext<B, Q, S> {
  req: Request;
  /** The caller. Undefined only on public routes. */
  user: AuthUser;
  body: B;
  query: Q;
  params: Record<string, string>;
  /** The services of the module that owns the route (the platform's own on core routes). */
  s: S;
  /** Platform services: users, audit, SMS, ledger, events. */
  core: CoreServices;
  ip: string | null;
  setCookie: (name: string, value: string, options?: CookieOptions) => void;
}

interface RouteSpec<B, Q, S> {
  method: Method;
  path: string;
  public?: boolean;
  permissions?: string[];
  /** Response status on success; POST defaults to 201. */
  status?: number;
  /** Requests per minute per IP for this route (in addition to the global limit). */
  rateLimit?: number;
  /** The handler reads the request body itself (file uploads); no JSON parsing or idempotency. */
  raw?: boolean;
  body?: ZodType<B, ZodTypeDef, unknown>;
  query?: ZodType<Q, ZodTypeDef, unknown>;
  handler: (ctx: RouteContext<B, Q, S>) => unknown;
}

export interface RouteDef {
  method: Method;
  path: string;
  public?: boolean;
  permissions?: string[];
  status?: number;
  rateLimit?: number;
  raw?: boolean;
  body?: ZodType<unknown, ZodTypeDef, unknown>;
  query?: ZodType<unknown, ZodTypeDef, unknown>;
  /** Set when the platform mounts a module's routes under /<module>. */
  module?: string;
  handler: (ctx: RouteContext<never, never, never>) => unknown;
}

/**
 * Returns a `route()` whose handlers see `s` typed as the given services. Each module makes its own:
 *   export const route = routeFor<WaterServices>();
 */
export function routeFor<S>() {
  return function route<B = undefined, Q = undefined>(def: RouteSpec<B, Q, S>): RouteDef {
    return def as unknown as RouteDef;
  };
}

/** Routes of the platform itself. */
export const route = routeFor<CoreServices>();
