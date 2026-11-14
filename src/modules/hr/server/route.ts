import { routeFor } from '@/platform/http/route';
import type { HrServices } from './container';

/** HR routes: handlers get the HR services as `s`. Paths are mounted under /api/v1/hr. */
export const route = routeFor<HrServices>();
