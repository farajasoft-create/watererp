'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { Card, ErrorBox, Stat } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';

interface Portal {
  organisation: string;
  branding?: Branding;
  donor: string;
  at: string;
  grants: {
    code: string;
    title: string;
    currency: string;
    startDate?: string;
    endDate?: string;
    position: { amount: string; received: string; spent: string; absorptionPct: number | null; timeElapsedPct: number | null };
    tables: { label: string; columns: { key: string; label: string; type: string }[]; rows: Record<string, unknown>[] }[];
  }[];
}

const cell = (type: string, v: unknown) => (v === null || v === undefined ? '' : type === 'money' ? fmtMoney(Number(v)) : type === 'date' ? String(v).slice(0, 10) : String(v));

/** The donor's read-only portal: live figures for their grants, opened by the link they were given. */
export default function DonorPortalPage() {
  const { token } = useParams<{ token: string }>();
  const { data, error, isLoading } = useQuery({
    queryKey: ['donor-portal', token],
    queryFn: async () => {
      const res = await fetch(`/api/v1/projects/donor-portal/${encodeURIComponent(token)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? 'This link is not valid');
      return body as Portal;
    },
    refetchInterval: 300_000,
    retry: false,
  });
  return (
    <PortalShell organisation={data?.organisation ?? ''} fallbackTitle="Donor portal" branding={data?.branding}>
      <ErrorBox error={error} />
      {isLoading && <p className="text-sm text-muted">Loading…</p>}
      {data && (
        <>
          <header>
            <h1 className="text-2xl font-semibold">{data.organisation}</h1>
            <p className="text-sm text-muted">Grant report for {data.donor}. Figures come straight from the accounts; updated {fmtDateTime(data.at)}.</p>
          </header>
          {data.grants.map((g) => (
            <section key={g.code} className="space-y-3">
              <h2 className="text-lg font-semibold">{g.code} · {g.title}</h2>
              <p className="text-xs text-muted">{g.startDate && `${fmtDate(g.startDate)} – ${fmtDate(g.endDate ?? null)}`} · {g.currency}</p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Grant" value={fmtMoney(Number(g.position.amount))} />
                <Stat label="Received" value={fmtMoney(Number(g.position.received))} />
                <Stat label="Spent" value={fmtMoney(Number(g.position.spent))} />
                <Stat label="Absorbed" value={g.position.absorptionPct === null ? '—' : `${g.position.absorptionPct}%`} hint={g.position.timeElapsedPct !== null ? `${g.position.timeElapsedPct}% of the period gone` : undefined} />
              </div>
              {g.tables.filter((t) => t.rows.length).map((t) => (
                <Card key={t.label} padded={false} title={t.label}>
                  <div className="overflow-x-auto">
                    <table className="table-base">
                      <thead><tr>{t.columns.map((c) => <th key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                      <tbody>{t.rows.map((r, i) => <tr key={i}>{t.columns.map((c) => <td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : ''}>{cell(c.type, r[c.key])}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                </Card>
              ))}
            </section>
          ))}
          {!data.grants.length && <Card><p className="text-sm text-muted">No active grants to show.</p></Card>}
        </>
      )}
    </PortalShell>
  );
}
