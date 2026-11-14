'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/bi/ui/api';

interface Row { id: string; name: string; description?: string; folder: string; chart: string; ownerName: string; everyone: boolean; version: number; mine: boolean; scheduled: boolean; updatedAt: string; spec: { dataset: string } }

export default function ReportsPage() {
  const can = useCan();
  const { data, error, isLoading } = useQuery({ queryKey: ['bi-reports'], queryFn: () => api.get<Row[]>('/reports') });
  const folders = [...new Set((data ?? []).map((r) => r.folder))];
  return (
    <>
      <PageHeader title="Reports" subtitle="Saved reports you made or that were shared with you" actions={can('bi.build') && <Link href="/bi/explore"><Button>New report</Button></Link>} />
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : !data?.length ? <Card><Empty>No saved reports yet. Build one in the report builder.</Empty></Card> : (
        <div className="space-y-5">
          {folders.map((f) => (
            <Card key={f} padded={false} title={f}>
              <table className="table-base">
                <thead><tr><th>Report</th><th>Data</th><th>Shown as</th><th>Owner</th><th>Version</th><th>Changed</th></tr></thead>
                <tbody>
                  {data.filter((r) => r.folder === f).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/bi/reports/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link>
                        {r.scheduled && <> <Badge tone="blue">scheduled</Badge></>}{r.everyone && <> <Badge tone="gray">everyone</Badge></>}
                        <div className="text-xs text-muted">{r.description}</div>
                      </td>
                      <td className="text-sm">{r.spec.dataset}</td>
                      <td>{r.chart}</td>
                      <td>{r.mine ? 'You' : r.ownerName}</td>
                      <td>{r.version}</td>
                      <td>{fmtDateTime(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
