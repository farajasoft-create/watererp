import { routeFor } from '@/platform/http/route';
import type { TendersServices } from './container';

/** Tenders (PPADA) routes: handlers get the module's services as `s`. Paths are mounted under /api/v1/tenders. */
export const route = routeFor<TendersServices>();
