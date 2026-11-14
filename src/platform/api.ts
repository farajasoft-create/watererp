import { SERVER_MODULES } from '@/modules/server';
import { getPlatform, Platform } from './container';
import { createRouter } from './http/router';
import { RouteDef } from './http/route';
import { InstalledModule } from './module';
import { coreRoutes } from './routes';

/** The platform's routes plus every module's, each module mounted under /<key>. */
export function allRoutes(modules: InstalledModule[] = SERVER_MODULES): RouteDef[] {
  return [...coreRoutes, ...modules.flatMap((m) => m.routes.map((r) => ({ ...r, module: m.manifest.key, path: `/${m.manifest.key}${r.path}` })))];
}

export function createApi(platform: () => Promise<Platform>, modules: InstalledModule[] = SERVER_MODULES) {
  const router = createRouter(allRoutes(modules), platform);
  const mounted = modules.filter((m) => m.mount).map((m) => ({ prefix: `/api/v1/${m.manifest.key}/`, load: m.mount!, handler: null as null | ((req: Request) => Promise<Response>) }));
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const m = mounted.find((x) => path.startsWith(x.prefix));
    if (!m) return router(req);
    await platform();
    m.handler ??= await m.load();
    return m.handler(req);
  };
}

/** The whole REST API (/api/v1/*) as one fetch handler, mounted by the Next.js catch-all route. */
export const handleApi = createApi(getPlatform);
