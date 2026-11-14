import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  /** See tenders, bids after opening, and the registers. */
  VIEW: 'tenders.view',
  /** Prepare, publish, amend, answer clarifications, record appeals and contracts. */
  MANAGE: 'tenders.manage',
  /** Head of procurement: the professional opinion (s.84). */
  OPINION: 'tenders.opinion',
  /** Accounting officer: award or cancel (s.63, s.87). */
  AWARD: 'tenders.award',
  /** Method thresholds and notice and standstill periods. */
  SETTINGS: 'tenders.settings',
} as const;

const P = PERMISSIONS;

export const tendersManifest = defineManifest({
  key: 'tenders',
  name: 'Tenders (PPADA)',
  description: 'Tendering under the Public Procurement and Asset Disposal Act, 2015: public notices, sealed online bids, opening and evaluation committees, professional opinion, award, notification, standstill, appeals and the contracts register.',
  home: '/tenders',
  permissions: P,
  roles: {
    OFFICER: { label: 'Procurement officer', permissions: [P.VIEW, P.MANAGE] },
    HEAD: { label: 'Head of procurement', permissions: [P.VIEW, P.MANAGE, P.OPINION, P.SETTINGS] },
    ACCOUNTING_OFFICER: { label: 'Accounting officer', permissions: [P.VIEW, P.AWARD] },
    MEMBER: { label: 'Committee member', permissions: [P.VIEW] },
  },
  nav: [
    { href: '/tenders', label: 'Tenders' },
    { href: '/tenders/contracts', label: 'Contracts register', permission: P.VIEW },
    { href: '/tenders/settings', label: 'Thresholds', permission: P.SETTINGS },
  ],
});
