import { routeFor } from '@/platform/http/route';
import type { PortalsServices } from './container';

/** Portals, Library & MSMEs routes: handlers get the module's services as `s`. Paths are mounted under /api/v1/portals. */
export const route = routeFor<PortalsServices>();
