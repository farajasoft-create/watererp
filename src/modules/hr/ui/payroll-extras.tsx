'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Money } from '@/components/ui';
import { fmtDate, today } from '@/lib/format';
import { api } from './api';

interface Advice {
  run: { id: string; period: string; title: string | null };
  previous: { id: string; period: string; title: string | null } | null;
  rows: { employeeId: string; employeeNo: string; name: string; department: string; status: 'JOINED' | 'LEFT' | 'CHANGED'; netWas: string; netNow: string; netChange: string; changes: { code: string; name: string; was: string; now: string; change: string }[] }[];
  totals: { joined: number; left: number; changed: number; netWas: string; netNow: string; netChange: string };
}

const STATUS_TONE = { JOINED: 'green', LEFT: 'red', CHANGED: 'blue' } as const;
const signed = (v: string) => (Number(v) > 0 ? '+' : '');

/** Pay change advice: who joined, left, or is paid differently from the previous payroll of the same kind. */
export function ChangeAdvice({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-payroll-changes', runId], queryFn: () => api.get<Advice>(`/payroll/${runId}/changes`), enabled: open });
  return (
    <Card
      padded={false}
      className="mb-5"
      title="Pay change advice"
      actions={
        <>
          <span className="flex gap-2 text-sm">{(['csv', 'xls', 'doc', 'pdf'] as const).map((f) => <a key={f} href={`/api/v1/hr/payroll/${runId}/changes?format=${f}`} className="text-brand-700 hover:underline">{f.toUpperCase()}</a>)}</span>
          <Button variant="secondary" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show changes'}</Button>
        </>
      }
    >
      {open && (
        <>
          <div className="px-4 pt-3"><ErrorBox error={error} /></div>
          {isLoading ? (
            <Loading />
          ) : (
            data && (
              <>
                <p className="px-4 py-2 text-sm text-muted">
                  {data.previous ? <>Against {data.previous.title ?? `payroll ${data.previous.period}`}. </> : 'No earlier approved payroll of this kind, so everyone shows as joining. '}
                  {data.totals.joined} joined, {data.totals.left} left, {data.totals.changed} paid differently. Net pay moved by KES {signed(data.totals.netChange)}<Money value={data.totals.netChange} />.
                </p>
                {!data.rows.length ? (
                  <Empty>Nobody&apos;s pay changed.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="table-base">
                      <thead>
                        <tr><th>Employee</th><th>Change</th><th>What changed</th><th className="num">Net was</th><th className="num">Net now</th><th className="num">Difference</th></tr>
                      </thead>
                      <tbody>
                        {data.rows.map((r) => (
                          <tr key={r.employeeId}>
                            <td>{r.employeeNo} · {r.name}<div className="text-xs text-muted">{r.department}</div></td>
                            <td><Badge tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</Badge></td>
                            <td className="text-xs">
                              {r.changes.map((c) => (
                                <div key={c.code + c.name}>{c.name}: <Money value={c.was} /> → <Money value={c.now} /></div>
                              ))}
                            </td>
                            <td className="num"><Money value={r.netWas} /></td>
                            <td className="num"><Money value={r.netNow} /></td>
                            <td className="num font-medium">{signed(r.netChange)}<Money value={r.netChange} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )
          )}
        </>
      )}
    </Card>
  );
}

interface Pension {
  rows: { scheme: string; memberNo: string; employeeNo: string; name: string; employee: string; employer: string; total: string }[];
  schemes: { scheme: string; members: number; employee: string; employer: string }[];
  totals: { employee: string; employer: string; total: string };
}

/** Each pension scheme's remittance for the payroll, as a file for the scheme's portal. */
export function PensionRemittance({ runId }: { runId: string }) {
  const { data } = useQuery({ queryKey: ['hr-payroll-pension', runId], queryFn: () => api.get<Pension>(`/payroll/${runId}/pension`) });
  if (!data?.schemes.length) return null;
  return (
    <Card title="Pension remittance" className="mb-5">
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {data.schemes.map((s) => (
          <div key={s.scheme} className="rounded-md border border-line p-3 text-sm">
            <div className="font-medium">{s.scheme}</div>
            <div className="text-muted">{s.members} members · members <Money value={s.employee} /> + employer <Money value={s.employer} /></div>
            <div className="mt-1 text-lg font-semibold tabular-nums">KES <Money value={Number(s.employee) + Number(s.employer)} /></div>
            <a href={`/api/v1/hr/payroll/${runId}/pension?format=csv&scheme=${encodeURIComponent(s.scheme)}`} className="text-brand-700 hover:underline">Upload file for the scheme (CSV)</a>
          </div>
        ))}
      </div>
    </Card>
  );
}

interface Gratuity {
  rows: { employeeId: string; employeeNo: string; name: string; department: string; gratuityRate: number; contractEndDate: string | null; status: string; accrued: string; paid: string; balance: string }[];
  totals: { accrued: string; paid: string; balance: string };
}

/** A file download from the API, not a page. */
const GRATUITY_CSV = '/api/v1/hr/gratuity?format=csv';

/** Gratuity owed to contract staff: accrued on approved payrolls, less what final dues paid out. */
export function GratuityReport() {
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-gratuity'], queryFn: () => api.get<Gratuity>('/gratuity') });
  return (
    <Card padded={false} title="Contract gratuity" actions={<a href={GRATUITY_CSV} className="text-sm text-brand-700 hover:underline">CSV</a>}>
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.rows.length ? (
        <Empty>No gratuity accrued yet. Set a gratuity rate on a contract employee&apos;s pay details; each approved payroll then accrues it.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr><th>Employee</th><th className="num">Rate</th><th>Contract ends</th><th className="num">Accrued</th><th className="num">Paid</th><th className="num">Owed</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.employeeId}>
                  <td>{r.employeeNo} · {r.name}<div className="text-xs text-muted">{r.department}</div></td>
                  <td className="num">{r.gratuityRate}%</td>
                  <td>{r.contractEndDate ? fmtDate(r.contractEndDate) : '—'}</td>
                  <td className="num"><Money value={r.accrued} /></td>
                  <td className="num"><Money value={r.paid} /></td>
                  <td className="num font-medium"><Money value={r.balance} /></td>
                </tr>
              ))}
              <tr className="font-medium">
                <td colSpan={3}>Total</td>
                <td className="num"><Money value={data.totals.accrued} /></td>
                <td className="num"><Money value={data.totals.paid} /></td>
                <td className="num"><Money value={data.totals.balance} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

interface AuditRow { at: string; action: string; label: string; by: string; employee: string; payroll: string; detail: Record<string, unknown> }

const monthStart = () => `${today().slice(0, 7)}-01`;
const describe = (d: Record<string, unknown>) =>
  Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('; ');

/** Every change to pay, pay items, statutory rates and payrolls, with who made it. */
export function PayrollAuditTrail() {
  const [q, setQ] = useState({ from: monthStart(), to: today() });
  const { data, error, isLoading } = useQuery({ queryKey: ['hr-payroll-audit', q], queryFn: () => api.get<AuditRow[]>('/payroll-audit', q), enabled: Boolean(q.from && q.to) });
  return (
    <Card padded={false} title="Payroll audit trail" actions={<span className="flex gap-2 text-sm">{(['csv', 'xls', 'doc', 'pdf'] as const).map((f) => <a key={f} href={`/api/v1/hr/payroll-audit?format=${f}&from=${q.from}&to=${q.to}`} className="text-brand-700 hover:underline">{f.toUpperCase()}</a>)}</span>}>
      <div className="flex flex-wrap gap-3 border-b border-line p-3">
        <Field label="From"><Input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
      </div>
      <ErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>No payroll changes in these dates.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr><th>When</th><th>Change</th><th>By</th><th>Employee or payroll</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {data.map((r, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                  <td>{r.label}</td>
                  <td>{r.by}</td>
                  <td>{r.employee || r.payroll}</td>
                  <td className="max-w-md truncate text-xs text-muted" title={describe(r.detail)}>{describe(r.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
