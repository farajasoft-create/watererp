import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  /** Properties, units, tenants, leases, rent roll, statements and maintenance. */
  VIEW: 'estates.view',
  /** Set up properties and leases, bill rent, receive payments, refund deposits. */
  MANAGE: 'estates.manage',
  /** Work on tenants' maintenance requests. */
  MAINTAIN: 'estates.maintain',
} as const;

const P = PERMISSIONS;

export const estatesManifest = defineManifest({
  key: 'estates',
  name: 'Estates & Tenants',
  description: 'Rented property: units, tenants and leases with deposits, monthly rent bills, receipts and statements, arrears, maintenance requests, and a tenant portal.',
  home: '/estates',
  permissions: P,
  roles: {
    MANAGER: { label: 'Estates officer', permissions: [P.VIEW, P.MANAGE, P.MAINTAIN] },
    CARETAKER: { label: 'Caretaker / maintenance', permissions: [P.VIEW, P.MAINTAIN] },
    VIEWER: { label: 'Estates viewer', permissions: [P.VIEW] },
  },
  nav: [
    { href: '/estates', label: 'Rent roll', permission: P.VIEW },
    { href: '/estates/maintenance', label: 'Maintenance', permission: P.VIEW },
  ],
});
