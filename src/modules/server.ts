/** Installed modules, server side. Keep in the same order as ./manifests.ts. */
import { InstalledModule } from '@/platform/module';
import { financeModule } from './finance/module';
import { hrModule } from './hr/module';
import { waterModule } from './water/module';
import { ictModule } from './ict/module';
import { internalauditModule } from './internalaudit/module';
import { biModule } from './bi/module';
import { projectsModule } from './projects/module';
import { estatesModule } from './estates/module';
import { portalsModule } from './portals/module';
import { tendersModule } from './tenders/module';

export const SERVER_MODULES: InstalledModule[] = [waterModule, hrModule, financeModule, ictModule, internalauditModule, biModule, projectsModule, estatesModule, portalsModule, tendersModule];
