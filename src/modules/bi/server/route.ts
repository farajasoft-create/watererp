import { routeFor } from '@/platform/http/route';
import type { BiServices } from './container';

/** Reports & Analytics routes: handlers get the module's services as `s`. Paths are mounted under /api/v1/bi. */
export const route = routeFor<BiServices>();
