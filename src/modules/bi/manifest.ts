import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  /** Open reports and dashboards shared with you; run ad-hoc queries on the data you may already see. */
  VIEW: 'bi.view',
  /** Build and save reports and dashboards, and schedule them. */
  BUILD: 'bi.build',
  /** Share with everyone, see every saved report, the access log and the organisation-wide analytics. */
  ADMIN: 'bi.admin',
} as const;

const P = PERMISSIONS;

export const biManifest = defineManifest({
  key: 'bi',
  name: 'Reports & Analytics',
  description: 'Report builder over every module (filters, grouping, pivots, charts, drill-through), saved and scheduled reports with versions, configurable dashboards, trends and forecasts, turnaround monitoring and risk scoring.',
  home: '/bi',
  permissions: P,
  roles: {
    ANALYST: { label: 'Analyst', description: 'Builds reports and dashboards.', permissions: [P.VIEW, P.BUILD] },
    MANAGER: { label: 'Management (BI administrator)', description: 'Everything, including organisation-wide analytics and the access log.', permissions: [P.VIEW, P.BUILD, P.ADMIN] },
    VIEWER: { label: 'Report reader', description: 'Opens reports and dashboards shared with them.', permissions: [P.VIEW] },
  },
  nav: [
    { href: '/bi', label: 'Dashboards', permission: P.VIEW },
    { href: '/bi/reports', label: 'Reports', permission: P.VIEW },
    { href: '/bi/explore', label: 'Report builder', permission: P.VIEW },
    { href: '/bi/analytics', label: 'Turnaround & risk', permission: P.ADMIN },
  ],
});
