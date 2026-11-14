import { defineManifest } from '@/platform/manifest';

/**
 * Finance (general ledger, receivables and payables, banking and M-Pesa, budgets, fixed assets,
 * expenses and imprest, procurement and stores, tax and eTIMS, consolidation, reports). The fine-grained
 * finance permissions (journal.approve, ap.manage…) live in finance's own roles, set under
 * Finance → Setup → Users & roles; the platform role chooses the starting finance role.
 */
export const PERMISSIONS = {
  ACCESS: 'finance.access',
} as const;

const P = PERMISSIONS;

export const financeManifest = defineManifest({
  key: 'finance',
  name: 'Finance & Procurement',
  description: 'General ledger, receivables, payables, banking and M-Pesa, budgets, fixed assets, imprest, procurement and stores, tax and eTIMS, reports.',
  home: '/finance',
  permissions: P,
  roles: {
    FINANCE_DIRECTOR: { label: 'Finance director', description: 'Approves and posts; manages finance settings.', permissions: [P.ACCESS] },
    ACCOUNTANT: { label: 'Accountant', description: 'Prepares journals, invoices, bills and payments.', permissions: [P.ACCESS] },
    FINANCE_REVIEWER: { label: 'Finance reviewer', description: 'Approves documents and payments, reconciles banks.', permissions: [P.ACCESS] },
    BRANCH_MANAGER: { label: 'Branch / department manager', description: 'Requisitions, approvals within limits, budgets view.', permissions: [P.ACCESS] },
    AUDITOR: { label: 'Auditor (read only)', permissions: [P.ACCESS] },
    ADMINISTRATOR: { label: 'Finance administrator', description: 'Finance settings, users and roles.', permissions: [P.ACCESS] },
    STAFF: { label: 'Staff (requisitions, claims, imprest)', description: 'Any member of staff: purchase and store requisitions, expense claims and imprest.', permissions: [P.ACCESS] },
  },
  nav: [
    { href: '/finance', label: 'Finance dashboard', permission: P.ACCESS },
    { href: '/finance/journals', label: 'Journals', permission: P.ACCESS },
    { href: '/finance/purchases/requisitions', label: 'Procurement', permission: P.ACCESS },
    { href: '/finance/banking', label: 'Cash & banking', permission: P.ACCESS },
    { href: '/finance/reports/trial-balance', label: 'Financial reports', permission: P.ACCESS },
  ],
});
