import { routeFor } from '@/platform/http/route';
import type { IctServices } from './container';

/** ICT & Administration routes: handlers get the module's services as `s`. Paths are mounted under /api/v1/ict. */
export const route = routeFor<IctServices>();
