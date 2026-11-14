import { Connection, Types } from 'mongoose';
import type { CoreServices } from './container';
import { Db } from './db';
import { RouteDef } from './http/route';
import { ModuleManifest } from './manifest';

export interface ModuleContext<M> {
  /** The platform database with this module's models added. Other modules' models are not visible here. */
  db: Db & M;
  core: CoreServices;
}

export interface StartContext<S> {
  core: CoreServices;
  services: S;
}

export interface SeedContext<S> {
  db: Db;
  core: CoreServices;
  services: S;
  organisationId: Types.ObjectId;
  /** Also create sample records to try the module with. */
  demo: boolean;
  /** Password for any demo users the module creates. */
  demoPassword: string;
}

/** The server half of a module: its collections, services, API and start-up hooks. */
export interface ServerModule<S, M> {
  manifest: ModuleManifest;
  /** Mongoose models, named with the module's prefix (see `defineModel`). */
  models?: (conn: Connection) => M;
  services: (ctx: ModuleContext<M>) => S;
  /** Mounted under /api/v1/<key>; every route is refused unless the organisation has the module on. */
  routes: RouteDef[];
  /** Runs once all modules are built: subscribe to events, or `core.ledger.use(...)` to provide the ledger. */
  start?: (ctx: StartContext<S>) => void;
  /**
   * A module that brings its own API router (a whole system moved in, like finance) is handed every
   * request under /api/v1/<key>/ and authenticates through the platform itself.
   */
  mount?: () => Promise<(req: Request) => Promise<Response>>;
  /** Starter data for a new organisation (`npm run db:seed`). */
  seed?: (ctx: SeedContext<S>) => Promise<void>;
}

/** A module with its types erased, as the platform holds it. */
export interface InstalledModule {
  manifest: ModuleManifest;
  models?: (conn: Connection) => Record<string, unknown>;
  services: (ctx: ModuleContext<Record<string, unknown>>) => unknown;
  routes: RouteDef[];
  start?: (ctx: StartContext<unknown>) => void;
  seed?: (ctx: SeedContext<unknown>) => Promise<void>;
  mount?: () => Promise<(req: Request) => Promise<Response>>;
}

export function defineModule<S, M = Record<string, never>>(module: ServerModule<S, M>): InstalledModule {
  return module as unknown as InstalledModule;
}
