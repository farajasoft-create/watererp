'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, cx, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, TableWrap } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useAccounts, useCurrencies, useSession } from '@/modules/finance/ui/lib/session';
import type { Account, AccountClass } from '@/modules/finance/ui/lib/types';

const CLASSES: { id: AccountClass; label: string; types: string[] }[] = [
  { id: 'ASSET', label: 'Assets', types: ['BANK', 'CASH', 'RECEIVABLE', 'INVENTORY', 'PREPAYMENT', 'CURRENT_ASSET', 'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'NON_CURRENT_ASSET', 'INTER_BRANCH'] },
  { id: 'LIABILITY', label: 'Liabilities', types: ['PAYABLE', 'TAX_PAYABLE', 'ACCRUAL', 'CURRENT_LIABILITY', 'LOAN', 'NON_CURRENT_LIABILITY'] },
  { id: 'EQUITY', label: 'Equity', types: ['SHARE_CAPITAL', 'RETAINED_EARNINGS', 'RESERVE', 'EQUITY'] },
  { id: 'REVENUE', label: 'Revenue', types: ['REVENUE', 'OTHER_INCOME', 'FX_GAIN'] },
  { id: 'COST_OF_SALES', label: 'Cost of sales', types: ['COST_OF_SALES'] },
  { id: 'EXPENSE', label: 'Expenses', types: ['EXPENSE', 'DEPRECIATION', 'FX_LOSS', 'TAX_EXPENSE'] },
];
const humanise = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

type Form = Omit<Account, 'id'>;
const blank = (): Form => ({
  code: '',
  name: '',
  description: '',
  accountClass: 'EXPENSE',
  accountType: 'EXPENSE',
  parentId: null,
  isPostable: true,
  isControl: false,
  allowManualPosting: true,
  currency: null,
  requiresDepartment: false,
  requiresCostCentre: false,
  requiresProject: false,
  entityIds: [],
  isActive: true,
});

export default function AccountsPage() {
  const { can, entities } = useSession();
  const queryClient = useQueryClient();
  const { data: accounts = [], isLoading } = useAccounts();
  const { data: currencies = [] } = useCurrencies();
  const [search, setSearch] = useState('');
  const [cls, setCls] = useState<AccountClass | ''>('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; form: Form } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Depth-first order so children appear under their parents.
  const ordered = useMemo(() => {
    const children = new Map<string | null, Account[]>();
    for (const a of accounts) {
      const key = a.parentId && accounts.some((p) => p.id === a.parentId) ? a.parentId : null;
      children.set(key, [...(children.get(key) ?? []), a]);
    }
    const out: { account: Account; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const a of (children.get(parent) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
        out.push({ account: a, depth });
        walk(a.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [accounts]);

  const q = search.trim().toLowerCase();
  const visible = ordered.filter(
    ({ account: a }) =>
      (!cls || a.accountClass === cls) && (showInactive || a.isActive) && (!q || a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)),
  );

  const save = useMutation({
    mutationFn: ({ id, form }: { id?: string; form: Form }) => (id ? api.patch(`/accounts/${id}`, form) : api.post('/accounts', form)),
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const open = (a?: Account) => {
    setError(null);
    if (!a) return setEditing({ form: blank() });
    const { id, ...form } = a;
    setEditing({ id, form });
  };
  const f = editing?.form;
  const setF = (patch: Partial<Form>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  const headers = accounts.filter((a) => !a.isPostable && a.accountClass === f?.accountClass && a.id !== editing?.id);

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="Shared by every entity in the organisation. Header accounts group others and cannot be posted to."
        actions={can('coa.manage') && <Button variant="primary" onClick={() => open()}>New account</Button>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="w-64" placeholder="Search code or name" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select className="w-44" value={cls} onChange={(e) => setCls(e.target.value as AccountClass | '')}>
          <option value="">All classes</option>
          {CLASSES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </Select>
        <Checkbox label="Show inactive" checked={showInactive} onChange={setShowInactive} />
      </div>
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Class</th>
                <th>Type</th>
                <th>Rules</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map(({ account: a, depth }) => (
                <tr key={a.id} className={cx(!a.isActive && 'opacity-50')}>
                  <td className="font-mono text-xs">{a.code}</td>
                  <td style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }} className={cx(!a.isPostable && 'font-semibold')}>
                    {a.isPostable && can('reports.view') ? (
                      <Link href={`/finance/reports/account-activity?accountId=${a.id}`} className="hover:text-brand-700 hover:underline">
                        {a.name}
                      </Link>
                    ) : (
                      a.name
                    )}
                  </td>
                  <td className="text-muted">{CLASSES.find((c) => c.id === a.accountClass)?.label}</td>
                  <td className="text-muted">{humanise(a.accountType)}</td>
                  <td className="space-x-1">
                    {!a.isPostable && <Badge>Header</Badge>}
                    {a.isControl && <Badge tone="violet">Control</Badge>}
                    {a.currency && <Badge tone="blue">{a.currency} only</Badge>}
                    {a.requiresDepartment && <Badge tone="amber">Dept</Badge>}
                    {a.requiresCostCentre && <Badge tone="amber">Cost centre</Badge>}
                    {a.requiresProject && <Badge tone="amber">Project</Badge>}
                    {a.entityIds.length > 0 && <Badge>{a.entityIds.length} entit{a.entityIds.length === 1 ? 'y' : 'ies'}</Badge>}
                    {!a.isActive && <Badge tone="red">Inactive</Badge>}
                  </td>
                  <td className="text-right">
                    {can('coa.manage') && (
                      <Button size="sm" variant="ghost" onClick={() => open(a)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>

      <Modal
        wide
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Edit ${f?.code}` : 'New account'}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              Save account
            </Button>
          </>
        }
      >
        {f && (
          <div className="space-y-4">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field label="Code">
                <Input value={f.code} onChange={(e) => setF({ code: e.target.value })} />
              </Field>
              <Field label="Name">
                <Input value={f.name} onChange={(e) => setF({ name: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Class">
                <Select
                  value={f.accountClass}
                  onChange={(e) => {
                    const c = CLASSES.find((x) => x.id === e.target.value)!;
                    setF({ accountClass: c.id, accountType: c.types[0], parentId: null });
                  }}
                >
                  {CLASSES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Type">
                <Select value={f.accountType} onChange={(e) => setF({ accountType: e.target.value })}>
                  {CLASSES.find((c) => c.id === f.accountClass)!.types.map((t) => (
                    <option key={t} value={t}>{humanise(t)}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Parent">
                <Select value={f.parentId ?? ''} onChange={(e) => setF({ parentId: e.target.value || null })}>
                  <option value="">None (top level)</option>
                  {headers.map((h) => (
                    <option key={h.id} value={h.id}>{h.code} · {h.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Description">
              <Input value={f.description} onChange={(e) => setF({ description: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Restrict to currency" hint="For foreign-currency bank or cash accounts">
                <Select value={f.currency ?? ''} onChange={(e) => setF({ currency: e.target.value || null })}>
                  <option value="">Any currency</option>
                  {currencies.filter((c) => c.isActive).map((c) => (
                    <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Available in entities" hint="None selected means all entities">
                <div className="flex flex-wrap gap-3 pt-1.5">
                  {entities.map((en) => (
                    <Checkbox
                      key={en.id}
                      label={en.code}
                      checked={f.entityIds.includes(en.id)}
                      onChange={(v) => setF({ entityIds: v ? [...f.entityIds, en.id] : f.entityIds.filter((x) => x !== en.id) })}
                    />
                  ))}
                </div>
              </Field>
            </div>
            <div className="grid gap-2 rounded-md bg-gray-50 p-3 sm:grid-cols-2">
              <Checkbox label="Header account (no postings)" checked={!f.isPostable} onChange={(v) => setF({ isPostable: !v })} />
              <Checkbox label="Control account (subledger only)" checked={f.isControl} onChange={(v) => setF({ isControl: v, allowManualPosting: !v })} />
              <Checkbox label="Requires department" checked={f.requiresDepartment} onChange={(v) => setF({ requiresDepartment: v })} />
              <Checkbox label="Requires cost centre" checked={f.requiresCostCentre} onChange={(v) => setF({ requiresCostCentre: v })} />
              <Checkbox label="Requires project" checked={f.requiresProject} onChange={(v) => setF({ requiresProject: v })} />
              <Checkbox label="Active" checked={f.isActive} onChange={(v) => setF({ isActive: v })} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
