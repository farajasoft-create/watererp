import { routeFor } from '@/platform/http/route';
import type { ProjectsServices } from './container';

/** Projects & Donors routes: handlers get the module's services as `s`. Paths are mounted under /api/v1/projects. */
export const route = routeFor<ProjectsServices>();
