'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Card, ErrorBox, Input, Loading, Notice, PageHeader, Stat } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { currentPeriod, fmtUnits } from '@/lib/format';

interface Row {
  zoneId: string;
  code: string;
  name: string;
  type: string;
  hasBulkMeter: boolean;
  systemInput: string;
  revenueWater: string;
  nonRevenueWater: string;
  nrwPercent: string | null;
  rating: string | null;
}
interface Balance {
  period: string;
  zones: Row[];
  total: { systemInput: string; revenueWater: string; nonRevenueWater: string; nrwPercent: string | null; rating: string | null };
}

export default function NrwPage() {
  const [period, setPeriod] = useState(currentPeriod());
  const { data, error, isLoading } = useQuery({ queryKey: ['water-balance', period], queryFn: () => api.get<Balance>('/reports/water-balance', { period }) });
  const unmetered = data?.zones.filter((z) => !z.hasBulkMeter) ?? [];
  return (
    <>
      <PageHeader
        title="Non-revenue water"
        subtitle="Water balance per zone / DMA: bulk-meter input against water billed"
        actions={<Input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="w-40" />}
      />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="System input" value={`${fmtUnits(data.total.systemInput)} m³`} hint="Zones with a bulk meter" />
            <Stat label="Revenue water" value={`${fmtUnits(data.total.revenueWater)} m³`} hint="Billed (metered + estimated)" />
            <Stat label="Non-revenue water" value={`${fmtUnits(data.total.nonRevenueWater)} m³`} />
            <Stat
              label="NRW"
              value={data.total.nrwPercent === null ? '—' : `${data.total.nrwPercent}%`}
              tone={data.total.rating === 'GOOD' ? 'good' : data.total.rating === 'ACCEPTABLE' ? 'warn' : data.total.rating ? 'bad' : undefined}
              hint="WASREB: good < 20%, acceptable ≤ 25%"
            />
          </div>
          {unmetered.length > 0 && (
            <Notice tone="amber">
              {unmetered.length} zone(s) have no bulk-meter reading for {data.period} ({unmetered.map((z) => z.code).join(', ')}), so their NRW cannot be measured. Install a bulk meter on each zone inlet and read it every cycle.
            </Notice>
          )}
          <Card padded={false} title="By zone / DMA">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Zone</th>
                  <th className="num">System input (m³)</th>
                  <th className="num">Billed (m³)</th>
                  <th className="num">NRW (m³)</th>
                  <th className="num">NRW %</th>
                  <th>Rating</th>
                </tr>
              </thead>
              <tbody>
                {data.zones.map((z) => (
                  <tr key={z.zoneId}>
                    <td>
                      <b>{z.code}</b> · {z.name} {z.type === 'DMA' && <Badge tone="blue">DMA</Badge>}
                    </td>
                    <td className="num">{z.hasBulkMeter ? fmtUnits(z.systemInput) : '—'}</td>
                    <td className="num">{fmtUnits(z.revenueWater)}</td>
                    <td className="num">{z.hasBulkMeter ? fmtUnits(z.nonRevenueWater) : '—'}</td>
                    <td className="num font-medium">{z.nrwPercent === null ? '—' : `${z.nrwPercent}%`}</td>
                    <td>{z.rating ? <Badge value={z.rating} /> : <span className="text-xs text-muted">no bulk meter</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}
