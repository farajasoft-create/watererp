import { Connection } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';

/** The projects module's collections, all prefixed projects_. */
export function projectsModels(conn: Connection) {
  return {
    donors: defineModel(conn, 'ProjectsDonor', S.donorSchema, 'projects_donors'),
    grants: defineModel(conn, 'ProjectsGrant', S.grantSchema, 'projects_grants'),
    projects: defineModel(conn, 'ProjectsProject', S.projectSchema, 'projects_projects'),
  };
}

export type ProjectsModels = ReturnType<typeof projectsModels>;
export type ProjectsDb = Db & ProjectsModels;
