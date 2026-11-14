'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ReactNode, Suspense, useState } from 'react';
import { NotificationsBell } from '@/modules/finance/ui/components/workflow';
import { cx, ErrorBanner, Loading, Select } from '@/modules/finance/ui/components/ui';
import { ApiError } from '@/modules/finance/ui/lib/api';
import { SessionProvider, useMe, useSession } from '@/modules/finance/ui/lib/session';

/**
 * Finance inside the platform: the platform shell (sign-in, sidebar, notifications) around finance's own
 * workspace, which keeps its entity selector and its full menu filtered by the finance roles.
 */

interface NavItem {
  href: string;
  label: string;
  permission?: string;
  match?: (path: string, search: string) => boolean;
}

const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: '',
    items: [
      { href: '/finance', label: 'Dashboard', match: (p) => p === '/finance' },
      { href: '/finance/approvals', label: 'Finance approvals' },
      { href: '/finance/documents', label: 'Finance documents' },
    ],
  },
  {
    title: 'Insights',
    items: [
      { href: '/finance/analytics', label: 'Executive dashboard', permission: 'analytics.view', match: (p) => p === '/finance/analytics' },
      { href: '/finance/analytics/forecast', label: 'Cash forecast', permission: 'analytics.view' },
      { href: '/finance/analytics/exceptions', label: 'Key exceptions', permission: 'analytics.view' },
      { href: '/finance/ask', label: 'Ask about the books', permission: 'ai.use' },
    ],
  },
  {
    title: 'Sales',
    items: [
      { href: '/finance/sales/customers', label: 'Customers', permission: 'ar.view' },
      { href: '/finance/sales/invoices', label: 'Invoices & credits', permission: 'ar.view' },
      { href: '/finance/sales/receipts', label: 'Receipts', permission: 'ar.view' },
      { href: '/finance/sales/refunds', label: 'Refunds', permission: 'ar.view' },
      { href: '/finance/sales/collections', label: 'Collections', permission: 'ar.view' },
      { href: '/finance/sales/withholding', label: 'Withholding certificates', permission: 'ar.view' },
    ],
  },
  {
    title: 'Purchases',
    items: [
      { href: '/finance/purchases/suppliers', label: 'Suppliers', permission: 'ap.view' },
      { href: '/finance/purchases/supplier-management', label: 'Supplier management', permission: 'ap.view' },
      { href: '/finance/purchases/supplier-invoices', label: 'Invoices from suppliers', permission: 'ap.view' },
      { href: '/finance/purchases/procurement-plan', label: 'Procurement plan', permission: 'ap.view' },
      { href: '/finance/purchases/requisitions', label: 'Requisitions', permission: 'ap.view' },
      { href: '/finance/purchases/rfqs', label: 'Requests for quotes', permission: 'ap.view' },
      { href: '/finance/purchases/inspections', label: 'Inspection & acceptance', permission: 'ap.view' },
      { href: '/finance/purchases/orders', label: 'Purchase orders', permission: 'ap.view' },
      { href: '/finance/purchases/received-not-invoiced', label: 'Received not invoiced', permission: 'ap.view' },
      { href: '/finance/purchases/bills', label: 'Bills & credits', permission: 'ap.view' },
      { href: '/finance/purchases/etims', label: 'KRA eTIMS purchases', permission: 'ap.view' },
      { href: '/finance/purchases/payments', label: 'Payments', permission: 'ap.view', match: (p) => p.startsWith('/finance/purchases/payment') },
    ],
  },
  {
    title: 'Banking',
    items: [
      { href: '/finance/banking', label: 'Cash & banking', permission: 'banking.view', match: (p) => p.startsWith('/finance/banking') && !p.startsWith('/finance/banking/mpesa') && !p.startsWith('/finance/banking/salaries') && !p.startsWith('/finance/banking/investments') },
      { href: '/finance/banking/investments', label: 'Investments & treasury', permission: 'banking.view' },
      { href: '/finance/banking/mpesa', label: 'M-Pesa', permission: 'banking.view' },
      { href: '/finance/banking/salaries', label: 'Salary payments', permission: 'banking.manage' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: '/finance/inventory', label: 'Inventory', permission: 'inventory.view', match: (p) => p.startsWith('/finance/inventory') && !p.startsWith('/finance/inventory/requisitions') },
      { href: '/finance/inventory/requisitions', label: 'Store requisitions', permission: 'inventory.view' },
      { href: '/finance/stock-dashboard', label: 'Stock dashboard', permission: 'inventory.view' },
      { href: '/finance/email-templates', label: 'Email templates', permission: 'procurement.manage' },
      { href: '/finance/assets', label: 'Fixed assets', permission: 'assets.view' },
      { href: '/finance/expenses', label: 'Expense claims', permission: 'expenses.submit' },
      { href: '/finance/imprest', label: 'Staff imprest', permission: 'expenses.submit' },
      { href: '/finance/petty-cash', label: 'Petty cash', permission: 'expenses.submit' },
      { href: '/finance/sponsorships', label: 'Sponsorships and donations', permission: 'expenses.submit' },
      { href: '/finance/budgets', label: 'Budgets & forecasts', permission: 'budgets.view', match: (p) => p === '/finance/budgets' },
      { href: '/finance/budgets/planning', label: 'Budget planning', permission: 'budgets.view' },
      { href: '/finance/budgets/programmes', label: 'Programmes', permission: 'budgets.view' },
    ],
  },
  {
    title: 'Ledger',
    items: [
      { href: '/finance/journals', label: 'Journals', permission: 'journal.view', match: (p, s) => p.startsWith('/finance/journals') && !p.startsWith('/finance/journals/recurring') && !s.includes('status=SUBMITTED') },
      { href: '/finance/journals/recurring', label: 'Recurring journals', permission: 'journal.view' },
      { href: '/finance/journals?status=SUBMITTED', label: 'Journal approvals', permission: 'journal.approve', match: (p, s) => p === '/finance/journals' && s.includes('status=SUBMITTED') },
      { href: '/finance/accounts', label: 'Chart of accounts' },
    ],
  },
  {
    title: 'Reports',
    items: [
      { href: '/finance/reports/pack', label: 'Management pack', permission: 'reports.view' },
      { href: '/finance/reports/trial-balance', label: 'Trial balance', permission: 'reports.view' },
      { href: '/finance/reports/profit-and-loss', label: 'Profit & loss', permission: 'reports.view' },
      { href: '/finance/reports/balance-sheet', label: 'Balance sheet', permission: 'reports.view' },
      { href: '/finance/reports/changes-in-net-assets', label: 'Changes in net assets', permission: 'reports.view' },
      { href: '/finance/reports/cash-flow', label: 'Cash flow', permission: 'reports.view' },
      { href: '/finance/reports/account-activity', label: 'Account activity', permission: 'reports.view' },
      { href: '/finance/reports/aged-receivables', label: 'Aged receivables', permission: 'ar.view' },
      { href: '/finance/reports/aged-payables', label: 'Aged payables', permission: 'ap.view' },
      { href: '/finance/reports/tax', label: 'Tax (VAT & WHT)', permission: 'reports.view' },
      { href: '/finance/reports/subledger-control', label: 'Subledger control', permission: 'reports.view' },
      { href: '/finance/reports/inter-branch', label: 'Inter-branch', permission: 'reports.view' },
      { href: '/finance/reports/fx-exposure', label: 'FX exposure', permission: 'reports.view' },
      { href: '/finance/reports/fx-gains', label: 'FX gains & losses', permission: 'reports.view' },
      { href: '/finance/reports/budget-vs-actual', label: 'Budget vs actual', permission: 'budgets.view' },
      { href: '/finance/reports/projects', label: 'Project profitability', permission: 'reports.view' },
    ],
  },
  {
    title: 'Group',
    items: [
      { href: '/finance/consolidation', label: 'Consolidation', permission: 'consolidation.view', match: (p) => p === '/finance/consolidation' },
      { href: '/finance/consolidation/adjustments', label: 'Group adjustments', permission: 'consolidation.view' },
    ],
  },
  {
    title: 'Controls',
    items: [
      { href: '/finance/currencies', label: 'Currencies & FX rates' },
      { href: '/finance/fx/revaluation', label: 'FX revaluation', permission: 'reports.view' },
      { href: '/finance/periods', label: 'Fiscal periods' },
      { href: '/finance/audit', label: 'Audit trail', permission: 'audit.view' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { href: '/finance/setup/structure', label: 'Entities & branches' },
      { href: '/finance/setup/tax', label: 'Tax codes' },
      { href: '/finance/setup/etims', label: 'KRA eTIMS', permission: 'ar.view' },
      { href: '/finance/setup/users', label: 'Users & roles', permission: 'users.manage' },
      { href: '/finance/setup/organisation', label: 'Organisation' },
      { href: '/finance/setup/workflow', label: 'Approval workflow', permission: 'workflow.manage' },
      { href: '/finance/setup/data', label: 'Import & export', permission: 'data.export' },
      { href: '/finance/setup/developers', label: 'Developers', permission: 'integrations.manage' },
      { href: '/finance/setup/emails', label: 'Email log', permission: 'users.manage' },
      { href: '/finance/setup/sms', label: 'SMS log', permission: 'users.manage' },
    ],
  },
];

function Workspace({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { me, can, entities, entity, setEntityId } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = (
    <nav className="space-y-4 text-sm">
      {NAV.map((group) => {
        const items = group.items.filter((i) => !i.permission || can(i.permission));
        if (!items.length) return null;
        return (
          <div key={group.title || 'root'}>
            {group.title && <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{group.title}</p>}
            {items.map((item) => {
              const active = item.match ? item.match(pathname, search) : pathname.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)} className={cx('block rounded-md px-2 py-1', active ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-700 hover:bg-slate-50')}>
                  {item.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
  return (
    <div className="-m-4 lg:-m-6">
      <header className="no-print flex flex-wrap items-center gap-3 border-b border-line bg-white px-4 py-2">
        <button type="button" className="rounded border border-line px-2 py-1 text-sm xl:hidden" onClick={() => setMenuOpen(!menuOpen)}>
          Finance menu
        </button>
        <label className="flex items-center gap-2 text-sm">
          <span className="hidden text-muted sm:inline">Entity</span>
          <Select className="h-8 w-56 text-sm" value={entity?.id ?? ''} onChange={(e) => setEntityId(e.target.value)}>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.code} · {e.name} ({e.functionalCurrency})
              </option>
            ))}
          </Select>
        </label>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {!me.allBranches && <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-amber-200">Branch-restricted</span>}
          <NotificationsBell />
        </div>
      </header>
      {menuOpen && <div className="no-print border-b border-line bg-white p-3 xl:hidden">{menu}</div>}
      <div className="flex">
        <aside className="no-print hidden w-56 shrink-0 border-r border-line bg-white p-3 xl:block">{menu}</aside>
        <div className="min-w-0 flex-1 p-4 lg:p-6">{entity ? children : <Loading />}</div>
      </div>
    </div>
  );
}

export default function FinanceLayout({ children }: { children: ReactNode }) {
  const { data: me, isLoading, error } = useMe();
  if (error instanceof ApiError && error.status === 403) return <ErrorBanner error={error} className="m-6" />;
  if (error) return <ErrorBanner error={error} className="m-6" />;
  if (isLoading || !me) return <Loading label="Opening Finance…" />;
  return (
    <SessionProvider me={me}>
      <Suspense fallback={<Loading />}>
        <Workspace>{children}</Workspace>
      </Suspense>
    </SessionProvider>
  );
}
