import { routeFor } from '@/platform/http/route';
import type { InternalauditServices } from './container';

/** Internal Audit routes: handlers get the module's services as `s`. Paths are mounted under /api/v1/internalaudit. */
export const route = routeFor<InternalauditServices>();
