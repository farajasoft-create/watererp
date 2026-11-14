import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  /** The e-library and the MSME register, as staff. */
  VIEW: 'portals.view',
  /** Add library items; approve MSMEs and their products. */
  MANAGE: 'portals.manage',
  /** Each portal's branding, wording and whether it is open. */
  SETTINGS: 'portals.settings',
} as const;

const P = PERMISSIONS;

export const portalsManifest = defineManifest({
  key: 'portals',
  name: 'Portals, Library & MSMEs',
  description: 'The e-library (public and staff), the MSME products portal with registration and approval, and the branding and opening of every public portal.',
  home: '/portals',
  permissions: P,
  roles: {
    MANAGER: { label: 'Portals manager', permissions: [P.VIEW, P.MANAGE, P.SETTINGS] },
    LIBRARIAN: { label: 'Librarian / MSME officer', permissions: [P.VIEW, P.MANAGE] },
  },
  nav: [
    { href: '/portals', label: 'E-library' },
    { href: '/portals/msme', label: 'MSME register', permission: P.VIEW },
    { href: '/portals/settings', label: 'Portal settings', permission: P.SETTINGS },
  ],
});
