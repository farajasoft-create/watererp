import { routeFor } from '@/platform/http/route';
import type { EstatesServices } from './container';

/** Estates & Tenants routes: handlers get the module's services as `s`. Paths are mounted under /api/v1/estates. */
export const route = routeFor<EstatesServices>();
