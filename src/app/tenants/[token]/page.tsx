'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Notice, Select, Stat, Textarea } from '@/components/ui';
import { fmtDate, fmtMoney, label } from '@/lib/format';

interface Portal {
  organisation: string;
  branding?: Branding;
  tenant: string;
  leases: { id: string; number: string; property?: string; unit: string; status: string; startDate: string; endDate: string; currentRent: string; serviceCharge: string; balance: string; depositHeld: string; statement: { id: string; date: string; kind: string; description?: string; reference?: string; amount: string; balance: string | null }[] }[];
  requests: { id: string; number: string; category: string; description: string; status: string; resolution?: string; createdAt: string }[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/estates/tenant-portal${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.errors?.[0]?.message ?? data?.message ?? 'Something went wrong');
  return data as T;
}

/** The tenant's own view: leases, bills and statement, deposit, and repair requests. */
export default function TenantPortalPage() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['tenant-portal', token], queryFn: () => call<Portal>('GET', `/${encodeURIComponent(token)}`), retry: false });
  const [f, setF] = useState({ leaseId: '', category: 'PLUMBING', description: '' });
  const [sent, setSent] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const report = async () => {
    setFailure(null);
    try {
      const r = await call<{ number: string }>('POST', `/${encodeURIComponent(token)}/requests`, { ...f, leaseId: f.leaseId || data?.leases.find((l) => l.status === 'ACTIVE')?.id });
      setSent(r.number);
      setF({ ...f, description: '' });
      qc.invalidateQueries({ queryKey: ['tenant-portal', token] });
    } catch (e) {
      setFailure(e);
    }
  };
  return (
    <PortalShell organisation={data?.organisation ?? ''} fallbackTitle="Tenant portal" branding={data?.branding}>
      <ErrorBox error={error} />
      {isLoading && <p className="text-sm text-muted">Loading…</p>}
      {data && (
        <>
          <header><h1 className="text-2xl font-semibold">{data.organisation}</h1><p className="text-sm text-muted">Tenant portal for {data.tenant}</p></header>
          {data.leases.map((l) => (
            <section key={l.id} className="space-y-3">
              <h2 className="text-lg font-semibold">{l.property} {l.unit} · {l.number} <Badge value={l.status} /></h2>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Monthly rent" value={`KES ${fmtMoney(Number(l.currentRent) + Number(l.serviceCharge))}`} />
                <Stat label="You owe" value={`KES ${fmtMoney(Number(l.balance))}`} tone={Number(l.balance) > 0 ? 'warn' : 'good'} />
                <Stat label="Deposit held" value={`KES ${fmtMoney(Number(l.depositHeld))}`} />
                <Stat label="Lease ends" value={fmtDate(l.endDate)} />
              </div>
              <Card padded={false} title="Statement">
                <table className="table-base">
                  <thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
                  <tbody>{l.statement.map((e) => <tr key={e.id}><td>{fmtDate(e.date)}</td><td>{e.description ?? label(e.kind)}</td><td>{e.reference}</td><td className="num">{fmtMoney(Number(e.amount))}</td><td className="num">{e.balance === null ? 'deposit' : fmtMoney(Number(e.balance))}</td></tr>)}</tbody>
                </table>
              </Card>
            </section>
          ))}
          <Card title="Report a repair">
            <div className="space-y-2">
              <ErrorBox error={failure} />
              {sent && <Notice tone="green">Request {sent} received. We will text you when it is done.</Notice>}
              {data.leases.filter((l) => l.status === 'ACTIVE').length > 1 && <Select value={f.leaseId} onChange={(e) => setF({ ...f, leaseId: e.target.value })}>{data.leases.filter((l) => l.status === 'ACTIVE').map((l) => <option key={l.id} value={l.id}>{l.property} {l.unit}</option>)}</Select>}
              <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['PLUMBING', 'ELECTRICAL', 'STRUCTURAL', 'SECURITY', 'CLEANING', 'OTHER'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select>
              <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What is wrong and where" />
              <Button onClick={report} disabled={f.description.length < 5 || !data.leases.some((l) => l.status === 'ACTIVE')}>Send</Button>
            </div>
            {data.requests.length > 0 && (
              <ul className="mt-4 space-y-1 text-sm">{data.requests.map((r) => <li key={r.id}>{r.number} · {label(r.category)}: {r.description} <Badge value={r.status} />{r.resolution && <span className="text-muted"> · {r.resolution}</span>}</li>)}</ul>
            )}
          </Card>
        </>
      )}
    </PortalShell>
  );
}
