import { routeFor } from '@/platform/http/route';
import type { WaterServices } from './container';

/** Water routes: handlers get the water services as `s`. Paths are mounted under /api/v1/water. */
export const route = routeFor<WaterServices>();
