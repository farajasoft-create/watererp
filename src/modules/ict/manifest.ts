import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  /** See every help desk ticket and work on them. */
  HELPDESK_WORK: 'ict.helpdesk.work',
  /** Assign tickets, set categories and response times. */
  HELPDESK_MANAGE: 'ict.helpdesk.manage',
  /** Office equipment and consumables: see who holds what. */
  ASSETS_VIEW: 'ict.assets.view',
  /** Issue and take back equipment, receive and issue consumables. */
  ASSETS_MANAGE: 'ict.assets.manage',
  /** Help desk and administrative efficiency reports. */
  REPORTS_VIEW: 'ict.reports.view',
  /** Draft and issue memos, notices and circulars to all staff, and see everyone's read receipts. */
  CIRCULARS_ISSUE: 'ict.circulars.issue',
} as const;

const P = PERMISSIONS;

/** Anyone in an organisation with the module on can raise and follow their own help desk requests. */
export const ictManifest = defineManifest({
  key: 'ict',
  name: 'ICT & Administration',
  description: 'IT help desk with ticket numbers, categories, priorities and response times; office equipment issued to staff and consumables; efficiency reports.',
  home: '/ict/help',
  permissions: P,
  roles: {
    MANAGER: { label: 'ICT manager', description: 'Runs the help desk and office assets.', permissions: Object.values(P) },
    AGENT: { label: 'Help desk officer', description: 'Works on tickets.', permissions: [P.HELPDESK_WORK, P.ASSETS_VIEW, P.REPORTS_VIEW] },
    ADMIN_OFFICER: { label: 'Administration officer', description: 'Office equipment and consumables; memos and notices.', permissions: [P.ASSETS_VIEW, P.ASSETS_MANAGE, P.REPORTS_VIEW, P.CIRCULARS_ISSUE] },
    COMMUNICATIONS: { label: 'Corporate communications', description: 'Issues memos, notices and circulars.', permissions: [P.CIRCULARS_ISSUE] },
  },
  nav: [
    { href: '/ict/help', label: 'My IT requests' },
    { href: '/ict/memos', label: 'Memos and notices' },
    { href: '/ict/desk', label: 'Service desk', permission: P.HELPDESK_WORK },
    { href: '/ict/assets', label: 'Office assets', permission: P.ASSETS_VIEW },
    { href: '/ict/reports', label: 'Reports', permission: P.REPORTS_VIEW },
    { href: '/ict/settings', label: 'Help desk settings', permission: P.HELPDESK_MANAGE },
  ],
});
