'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ReactNode, useCallback } from 'react';
import { useBranches, useDimensions, useSession } from '@/modules/finance/ui/lib/session';
import { Button, Field, Input, Select } from './ui';

export interface ReportParams {
  from: string;
  to: string;
  asOf: string;
  branchIds: string;
  departmentId: string;
  costCentreId: string;
  projectId: string;
  accountId: string;
  byBranch: string;
}

/** Report filters live in the URL so drill-down links and refreshes keep their context. */
export function useReportParams(defaults: Partial<ReportParams>) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = (k: keyof ReportParams) => params.get(k) ?? defaults[k] ?? '';
  const values: ReportParams = {
    from: get('from'),
    to: get('to'),
    asOf: get('asOf'),
    branchIds: get('branchIds'),
    departmentId: get('departmentId'),
    costCentreId: get('costCentreId'),
    projectId: get('projectId'),
    accountId: get('accountId'),
    byBranch: get('byBranch'),
  };
  const set = useCallback(
    (patch: Partial<ReportParams>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.replace(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );
  return [values, set] as const;
}

export function ReportFilters({
  values,
  set,
  mode,
  extra,
}: {
  values: ReportParams;
  set: (p: Partial<ReportParams>) => void;
  mode: 'range' | 'asOf';
  extra?: ReactNode;
}) {
  const { entity } = useSession();
  const { data: branches = [] } = useBranches(entity?.id);
  const { data: dimensions = [] } = useDimensions();
  const dims = (type: string) => dimensions.filter((d) => d.type === type && (!d.entityId || d.entityId === entity?.id));

  return (
    <div className="no-print mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-white p-3 shadow-xs">
      {mode === 'range' ? (
        <>
          <Field label="From">
            <Input type="date" className="w-40" value={values.from} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="date" className="w-40" value={values.to} onChange={(e) => set({ to: e.target.value })} />
          </Field>
        </>
      ) : (
        <Field label="As of">
          <Input type="date" className="w-40" value={values.asOf} onChange={(e) => set({ asOf: e.target.value })} />
        </Field>
      )}
      <Field label="Branch">
        <Select className="w-44" value={values.branchIds} onChange={(e) => set({ branchIds: e.target.value })}>
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} · {b.name}
            </option>
          ))}
        </Select>
      </Field>
      {(
        [
          ['departmentId', 'DEPARTMENT', 'Department'],
          ['costCentreId', 'COST_CENTRE', 'Cost centre'],
          ['projectId', 'PROJECT', 'Project'],
        ] as const
      ).map(([key, type, label]) =>
        dims(type).length ? (
          <Field key={key} label={label}>
            <Select className="w-36" value={values[key]} onChange={(e) => set({ [key]: e.target.value })}>
              <option value="">All</option>
              {dims(type).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                </option>
              ))}
            </Select>
          </Field>
        ) : null,
      )}
      {extra}
      <div className="ml-auto flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => window.print()}>
          Print
        </Button>
      </div>
    </div>
  );
}

/** Downloads rows as CSV. Values are written as-is so amounts keep full precision. */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportTitle({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  const { entity } = useSession();
  return (
    <div className="mb-3">
      <p className="text-xs font-medium uppercase tracking-wider text-muted">{entity?.name}</p>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted">{subtitle}</p>
    </div>
  );
}
