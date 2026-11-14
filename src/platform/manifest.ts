/**
 * What a module tells the platform about itself. Manifests are plain data with no server imports, so the
 * browser uses the same file to build the menu, the role pickers and permission checks.
 */
export interface RoleTemplate {
  label: string;
  description?: string;
  permissions: readonly string[];
}

export interface NavItem {
  href: string;
  label: string;
  /** Hidden unless the user holds this permission. */
  permission?: string;
}

export interface ModuleManifest {
  /** Lowercase id. It is the URL prefix (/water), the API prefix (/api/v1/water) and the collection prefix (water_). */
  key: string;
  name: string;
  description: string;
  /** Landing page of the module. */
  home: string;
  /** Every permission the module checks, as CONSTANT_NAME → 'key.thing.action'. */
  permissions: Record<string, string>;
  /** Roles an administrator can give users in this module. */
  roles: Record<string, RoleTemplate>;
  nav: NavItem[];
  /** Shortcuts shown under the menu, such as a field app. */
  links?: NavItem[];
  /**
   * Lets a user's access be limited to some records (a meter reader's zones, a cashier's branches).
   * `endpoint` returns `[{ id, label }]` to pick from; the chosen ids reach the server as `user.access[key].scope`.
   */
  scope?: { label: string; endpoint: string };
  /** Modules that must be switched on for this one to work. */
  dependsOn?: string[];
}

export function defineManifest<const M extends ModuleManifest>(manifest: M): M {
  return manifest;
}

/** Permissions of the platform itself; only administrators hold them. */
export const CORE_PERMISSIONS = {
  USERS_MANAGE: 'core.users.manage',
  SETTINGS_MANAGE: 'core.settings.manage',
  AUDIT_VIEW: 'core.audit.view',
} as const;

/** Path segments the platform's own API uses, so no module may take them as its key. */
export const RESERVED_KEYS = ['core', 'auth', 'users', 'roles', 'modules', 'settings', 'sms', 'audit', 'health', 'ledger', 'login', 'api', 'documents', 'notifications', 'tasks', 'approvals', 'emails', 'portal', 'account'];

/** A role an organisation defines for itself in a module, from that module's permissions. */
export interface CustomRole {
  module: string;
  key: string;
  label: string;
  description?: string | null;
  permissions: readonly string[];
}

/** The manifests with the organisation's own roles added (permissions outside the module are ignored). */
export function withCustomRoles(manifests: readonly ModuleManifest[], custom: readonly CustomRole[] | null | undefined): ModuleManifest[] {
  if (!custom?.length) return manifests as ModuleManifest[];
  return manifests.map((m) => {
    const mine = custom.filter((c) => c.module === m.key);
    if (!mine.length) return m;
    const own = new Set(Object.values(m.permissions));
    const extra = Object.fromEntries(mine.filter((c) => !m.roles[c.key]).map((c) => [c.key, { label: c.label, description: c.description ?? undefined, permissions: c.permissions.filter((p) => own.has(p)) }]));
    return { ...m, roles: { ...m.roles, ...extra } };
  });
}

export interface UserAccess {
  module: string;
  role: string;
  scope?: readonly string[];
}

/**
 * The permissions a user holds: administrators get everything in the modules switched on for their
 * organisation, everyone else gets what their role in each enabled module grants.
 */
export function resolvePermissions(
  manifests: readonly ModuleManifest[],
  user: { isAdmin: boolean; access: readonly UserAccess[] },
  enabled: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const m of manifests) {
    if (!enabled.includes(m.key)) continue;
    if (user.isAdmin) {
      for (const p of Object.values(m.permissions)) out.add(p);
      continue;
    }
    const grant = user.access.find((a) => a.module === m.key);
    for (const p of (grant && m.roles[grant.role]?.permissions) || []) out.add(p);
  }
  if (user.isAdmin) for (const p of Object.values(CORE_PERMISSIONS)) out.add(p);
  return [...out];
}

/** Checks a set of manifests for clashes; run at start-up and in the tests. */
export function manifestProblems(manifests: readonly ModuleManifest[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const m of manifests) {
    if (!/^[a-z][a-z0-9]{1,19}$/.test(m.key)) problems.push(`${m.key}: the key must be 2–20 lowercase letters or digits`);
    if (RESERVED_KEYS.includes(m.key)) problems.push(`${m.key}: the key is reserved by the platform`);
    if (keys.has(m.key)) problems.push(`${m.key}: installed twice`);
    keys.add(m.key);
    const own = new Set(Object.values(m.permissions));
    for (const p of own) if (!p.startsWith(`${m.key}.`)) problems.push(`${m.key}: permission ${p} must start with "${m.key}."`);
    for (const [role, r] of Object.entries(m.roles)) {
      for (const p of r.permissions) if (!own.has(p)) problems.push(`${m.key}: role ${role} grants unknown permission ${p}`);
    }
    for (const n of [...m.nav, ...(m.links ?? [])]) {
      if (!n.href.startsWith(`/${m.key}`)) problems.push(`${m.key}: page ${n.href} must live under /${m.key}`);
      if (n.permission && !own.has(n.permission)) problems.push(`${m.key}: page ${n.href} checks unknown permission ${n.permission}`);
    }
    for (const dep of m.dependsOn ?? []) if (!manifests.some((x) => x.key === dep)) problems.push(`${m.key}: depends on ${dep}, which is not installed`);
  }
  return problems;
}
