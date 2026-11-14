/**
 * Installed modules, safe to import in the browser. To add a system, run `npm run module:new -- <key> "<Name>"`
 * or add its manifest here and its server module in ./server.ts.
 */
import { ModuleManifest } from '@/platform/manifest';
import { financeManifest } from './finance/manifest';
import { hrManifest } from './hr/manifest';
import { waterManifest } from './water/manifest';
import { ictManifest } from './ict/manifest';
import { internalauditManifest } from './internalaudit/manifest';
import { biManifest } from './bi/manifest';
import { projectsManifest } from './projects/manifest';
import { estatesManifest } from './estates/manifest';
import { portalsManifest } from './portals/manifest';
import { tendersManifest } from './tenders/manifest';

export const MANIFESTS: readonly ModuleManifest[] = [waterManifest, hrManifest, financeManifest, ictManifest, internalauditManifest, biManifest, projectsManifest, estatesManifest, portalsManifest, tendersManifest];
