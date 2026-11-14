import { Connection } from 'mongoose';
import { SERVER_MODULES } from '@/modules/server';
import { createDb, Db, openConnection, syncAllIndexes } from './db';
import { EventBus } from './events';
import { AccountingClient } from './ledger/accounting.client';
import { LedgerService } from './ledger/ledger.service';
import { InstalledModule } from './module';
import { manifestProblems, ModuleManifest } from './manifest';
import { AuditService } from './services/audit.service';
import { PrivacyService } from './services/privacy.service';
import { WarehouseService } from './services/warehouse.service';
import { OrganisationService } from './services/organisation.service';
import { SmsService } from './services/sms.service';
import { UsersService } from './services/users.service';
import { ApprovalsService } from './services/approvals.service';
import { DocumentsService } from './services/documents.service';
import { EmailService, MailTransport } from './services/email.service';
import { NotificationsService } from './services/notifications.service';
import { SsoService } from './services/sso.service';
import { TasksService } from './services/tasks.service';

export interface PlatformOptions {
  /** Replaces `fetch` for outgoing calls (ledger, SMS); used by the tests. */
  fetch?: typeof fetch;
  /** Replaces the SMTP connection; used by the tests. */
  mail?: () => MailTransport;
  /** Modules to load; defaults to every installed module. */
  modules?: InstalledModule[];
}

function buildCore(db: Db, opts: PlatformOptions, manifests: readonly ModuleManifest[]) {
  const audit = new AuditService(db);
  const ledger = new LedgerService(db, opts.fetch ? (c) => new AccountingClient(c, opts.fetch) : undefined);
  const events = new EventBus();
  const email = new EmailService(db, opts.mail);
  const notifications = new NotificationsService(db, email);
  return {
    db,
    /** The installed modules' manifests. */
    manifests,
    events,
    audit,
    sms: new SmsService(db, opts.fetch),
    email,
    notifications,
    documents: new DocumentsService(db, audit),
    tasks: new TasksService(db, audit, notifications),
    approvals: new ApprovalsService(db, audit, events, notifications, manifests),
    sso: new SsoService(db, audit, opts.fetch),
    ledger,
    users: new UsersService(db, audit, manifests),
    privacy: new PrivacyService(db, audit),
    warehouse: new WarehouseService(db),
    organisation: new OrganisationService(db, audit, ledger, manifests),
  };
}

export type CoreServices = ReturnType<typeof buildCore>;

export interface Platform {
  core: CoreServices;
  /** Each module's services, by module key. */
  modules: Record<string, unknown>;
  manifests: Record<string, ModuleManifest>;
  installed: InstalledModule[];
}

/** Builds the platform on an open connection: core services first, then every module on top of them. */
export function buildPlatform(conn: Connection, opts: PlatformOptions = {}): Platform {
  const installed = opts.modules ?? SERVER_MODULES;
  const manifests = installed.map((m) => m.manifest);
  const problems = manifestProblems(manifests);
  if (problems.length) throw new Error(`Module set-up problems:\n${problems.join('\n')}`);

  const db = createDb(conn);
  const core = buildCore(db, opts, manifests);
  const modules: Record<string, unknown> = {};
  for (const m of installed) {
    const models = m.models?.(conn) ?? {};
    modules[m.manifest.key] = m.services({ db: { ...db, ...models }, core });
  }
  for (const m of installed) m.start?.({ core, services: modules[m.manifest.key] });
  return { core, modules, manifests: Object.fromEntries(installed.map((m) => [m.manifest.key, m.manifest])), installed };
}

export async function createPlatform(conn: Connection, opts: PlatformOptions = {}): Promise<Platform> {
  const platform = buildPlatform(conn, opts);
  await syncAllIndexes(conn);
  return platform;
}

const globalForPlatform = globalThis as unknown as { __platform?: Promise<Platform> };

export function getPlatform(): Promise<Platform> {
  if (!globalForPlatform.__platform) {
    globalForPlatform.__platform = openConnection()
      .then((conn) => createPlatform(conn))
      .catch((err) => {
        globalForPlatform.__platform = undefined;
        throw err;
      });
  }
  return globalForPlatform.__platform;
}
