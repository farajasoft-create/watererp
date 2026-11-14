import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  /** The audit universe, risk register, plans, calendar and dashboards. */
  VIEW: 'internalaudit.view',
  /** Keep the universe, risk register, annual plan and audit programmes. */
  PLAN_MANAGE: 'internalaudit.plan.manage',
  /** Approve the annual audit plan (audit committee or accounting officer). */
  PLAN_APPROVE: 'internalaudit.plan.approve',
  /** Work on engagements one is on: working papers, evidence, findings, time. */
  WORK: 'internalaudit.engagement.work',
  /** Open engagements, choose teams, review working papers, see every engagement. */
  MANAGE: 'internalaudit.engagement.manage',
  /** Approve and issue audit reports, verify implemented recommendations. */
  REPORT_APPROVE: 'internalaudit.report.approve',
  /** Issued reports, recommendation status and dashboards (audit committee). */
  REPORTS_VIEW: 'internalaudit.reports.view',
  /** Pull transactions from every module (read-only, logged) to test and sample them. */
  DATA: 'internalaudit.data',
} as const;

const P = PERMISSIONS;

/** Managers who must act on audit recommendations need no role: they see their own actions at /internalaudit/actions. */
export const internalauditManifest = defineManifest({
  key: 'internalaudit',
  name: 'Internal Audit',
  description: 'Audit universe and risk register with heat maps, risk-based annual plan, engagements with electronic working papers and sampling, findings and reports, and tracking of recommendations to closure.',
  home: '/internalaudit',
  permissions: P,
  roles: {
    HEAD: { label: 'Head of internal audit', permissions: Object.values(P) },
    MANAGER: { label: 'Audit manager', description: 'Runs engagements and reviews working papers.', permissions: [P.VIEW, P.PLAN_MANAGE, P.WORK, P.MANAGE, P.REPORTS_VIEW, P.DATA] },
    AUDITOR: { label: 'Auditor', description: 'Works on the engagements they are put on.', permissions: [P.VIEW, P.WORK, P.DATA] },
    COMMITTEE: { label: 'Audit committee', description: 'Approves the plan; sees issued reports and dashboards.', permissions: [P.VIEW, P.PLAN_APPROVE, P.REPORTS_VIEW] },
  },
  nav: [
    { href: '/internalaudit', label: 'Dashboard', permission: P.VIEW },
    { href: '/internalaudit/universe', label: 'Universe & risks', permission: P.VIEW },
    { href: '/internalaudit/plans', label: 'Annual plan', permission: P.VIEW },
    { href: '/internalaudit/engagements', label: 'Engagements', permission: P.VIEW },
    { href: '/internalaudit/recommendations', label: 'Recommendations', permission: P.VIEW },
    { href: '/internalaudit/programmes', label: 'Audit programmes', permission: P.PLAN_MANAGE },
  ],
  links: [{ href: '/internalaudit/actions', label: 'My audit actions →' }],
});
