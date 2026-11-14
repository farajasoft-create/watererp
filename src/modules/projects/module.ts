import { defineModule } from '@/platform/module';
import { projectsManifest } from './manifest';
import { buildProjectsServices, ProjectsServices } from './server/container';
import { projectsModels, ProjectsModels } from './server/db';
import { projectsRoutes } from './server/routes';

export const projectsModule = defineModule<ProjectsServices, ProjectsModels>({
  manifest: projectsManifest,
  models: projectsModels,
  services: ({ db, core }) => buildProjectsServices(db, core),
  routes: projectsRoutes,
});
