'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Card, Empty, ErrorBox, Loading, Money, PageHeader } from '@/components/ui';
import { fmtDate, label } from '@/lib/format';
import { api } from '@/modules/tenders/ui/api';

interface Row { id: string; number: string; tender: string; title: string; method: string; contractor: string; kraPin: string; agpo: string; value: string; signedAt: string; startDate: string; endDate: string; performanceSecurity: string; state: string }

export default function ContractsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['tenders', 'contracts'], queryFn: () => api.get<Row[]>('/contracts') });
  return (
    <>
      <PageHeader title="Contracts register" subtitle="Every contract signed from a tender, with its value, term and performance security." actions={<a href={`/api/v1/tenders/contracts?format=csv`} className="text-sm text-brand-700 hover:underline">Download (CSV)</a>} />
      <ErrorBox error={error} />
      <Card padded={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty>No contracts yet.</Empty> : (
          <table className="table-base">
            <thead><tr><th>Contract</th><th>Contractor</th><th>Method</th><th className="num">Value</th><th>Term</th><th className="num">Performance security</th><th /></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>{r.number}<div className="text-xs text-muted"><Link href={`/tenders/${r.id}`} className="hover:underline">{r.tender}</Link> · {r.title}</div></td>
                  <td>{r.contractor}<div className="text-xs text-muted">{r.kraPin}{r.agpo !== 'NONE' && ` · AGPO ${r.agpo.toLowerCase()}`}</div></td>
                  <td>{label(r.method)}</td>
                  <td className="num"><Money value={r.value} /></td>
                  <td>{fmtDate(r.startDate)} – {fmtDate(r.endDate)}<div className="text-xs text-muted">signed {fmtDate(r.signedAt)}</div></td>
                  <td className="num"><Money value={r.performanceSecurity} /></td>
                  <td><Badge tone={r.state === 'RUNNING' ? 'green' : r.state === 'ENDING' ? 'amber' : 'gray'}>{r.state.toLowerCase()}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
