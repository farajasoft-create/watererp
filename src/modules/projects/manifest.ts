import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  /** Projects, grants, donors, spending, KPIs and donor reports. */
  VIEW: 'projects.view',
  /** Set up donors, grants and projects; record disbursements, progress, KPIs and capitalisation. */
  MANAGE: 'projects.manage',
} as const;

const P = PERMISSIONS;

export const projectsManifest = defineManifest({
  key: 'projects',
  name: 'Projects & Donors',
  description: 'Donor-funded and capital projects: grants and disbursements, budgets against live ledger spending, CAPEX and work in progress, milestones and KPIs, donor dashboards, reports and a donor portal.',
  home: '/projects',
  permissions: P,
  dependsOn: ['finance'],
  roles: {
    MANAGER: { label: 'Projects manager', permissions: [P.VIEW, P.MANAGE] },
    VIEWER: { label: 'Projects viewer', description: 'Management, board and finance staff who follow projects.', permissions: [P.VIEW] },
  },
  nav: [
    { href: '/projects', label: 'Projects', permission: P.VIEW },
    { href: '/projects/grants', label: 'Grants & donors', permission: P.VIEW },
  ],
});
