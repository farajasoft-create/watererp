'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RateTools } from '@/modules/finance/ui/components/group';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Pager, Select, StatusBadge, TableWrap, Tabs } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatDate, today } from '@/modules/finance/ui/lib/format';
import { useCurrencies, useSession } from '@/modules/finance/ui/lib/session';
import type { ExchangeRate, Paged } from '@/modules/finance/ui/lib/types';

export default function CurrenciesPage() {
  const { can, me, entity, entities } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'rates' | 'currencies'>('rates');
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ fromCurrency: '', status: '' });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fromCurrency: 'USD', toCurrency: entity?.functionalCurrency ?? 'KES', rateType: 'SPOT', rate: '', effectiveDate: today(), source: 'MANUAL' });
  const [error, setError] = useState<string | null>(null);
  const { data: currencies = [], isLoading: loadingCurrencies } = useCurrencies();
  const { data: rates, isLoading } = useQuery({
    queryKey: ['rates', filter, page],
    queryFn: () => api.get<Paged<ExchangeRate>>('/exchange-rates', { ...filter, page, pageSize: 25 }),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['rates'] });
    queryClient.invalidateQueries({ queryKey: ['rate'] });
    queryClient.invalidateQueries({ queryKey: ['currencies'] });
  };
  const mutate = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api.post(path, body),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const active = currencies.filter((c) => c.isActive);
  const functional = new Set(entities.map((e) => e.functionalCurrency));

  return (
    <>
      <PageHeader
        title="Currencies & exchange rates"
        description="Rates convert transaction currency into each entity's functional currency. Journals use the latest approved rate on or before their date."
        actions={
          can('fx.rates.manage') &&
          tab === 'rates' && (
            <>
              <RateTools />
              <Button variant="primary" onClick={() => setOpen(true)}>
                Capture rate
              </Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'rates', label: 'Exchange rates' },
          { id: 'currencies', label: `Currencies (${active.length} active)` },
        ]}
      />
      <ErrorBanner error={error} className="mb-3" />

      {tab === 'rates' ? (
        <>
          <div className="mb-3 flex gap-2">
            <Select className="w-40" value={filter.fromCurrency} onChange={(e) => (setFilter({ ...filter, fromCurrency: e.target.value }), setPage(1))}>
              <option value="">All currencies</option>
              {active.map((c) => (
                <option key={c.code}>{c.code}</option>
              ))}
            </Select>
            <Select className="w-40" value={filter.status} onChange={(e) => (setFilter({ ...filter, status: e.target.value }), setPage(1))}>
              <option value="">Any status</option>
              <option value="PENDING">Pending approval</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </Select>
          </div>
          <TableWrap>
            {isLoading ? (
              <Loading />
            ) : !rates?.items.length ? (
              <Empty title="No exchange rates yet" />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Effective</th>
                    <th>Pair</th>
                    <th className="num">Rate</th>
                    <th>Type</th>
                    <th>Source</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rates.items.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDate(r.effectiveDate)}</td>
                      <td className="font-medium">
                        1 {r.fromCurrency} = <span className="text-muted">{r.toCurrency}</span>
                      </td>
                      <td className="num font-mono text-xs">{r.rate}</td>
                      <td className="text-muted">{r.rateType.toLowerCase()}</td>
                      <td className="text-muted">{r.source}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="text-right">
                        {r.status === 'PENDING' && can('fx.rates.approve') && r.createdBy !== me.id && (
                          <span className="space-x-1">
                            <Button size="sm" onClick={() => mutate.mutate({ path: `/exchange-rates/${r.id}/reject` })}>Reject</Button>
                            <Button size="sm" variant="primary" onClick={() => mutate.mutate({ path: `/exchange-rates/${r.id}/approve` })}>
                              Approve
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </TableWrap>
          {rates && <Pager page={page} pageSize={rates.pageSize} total={rates.total} onPage={setPage} />}
        </>
      ) : (
        <TableWrap>
          {loadingCurrencies ? (
            <Loading />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Symbol</th>
                  <th className="num">Decimals</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {currencies.map((c) => (
                  <tr key={c.code}>
                    <td className="font-mono text-xs font-semibold">{c.code}</td>
                    <td>{c.name}</td>
                    <td>{c.symbol}</td>
                    <td className="num">{c.precision}</td>
                    <td className="space-x-1">
                      {c.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
                      {functional.has(c.code) && <Badge tone="blue">Functional</Badge>}
                      {me.organisation.reportingCurrency === c.code && <Badge tone="violet">Reporting</Badge>}
                    </td>
                    <td className="text-right">
                      {can('currency.manage') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={c.isActive && functional.has(c.code)}
                          onClick={() => mutate.mutate({ path: `/currencies/${c.code}/${c.isActive ? 'deactivate' : 'activate'}` })}
                        >
                          {c.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TableWrap>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Capture exchange rate"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={mutate.isPending} onClick={() => mutate.mutate({ path: '/exchange-rates', body: form })}>
              Save rate
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ErrorBanner error={error} />
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
            <Field label="1 unit of">
              <Select value={form.fromCurrency} onChange={(e) => setForm({ ...form, fromCurrency: e.target.value })}>
                {active.map((c) => (
                  <option key={c.code}>{c.code}</option>
                ))}
              </Select>
            </Field>
            <span className="pb-2 text-muted">=</span>
            <Field label="Rate in">
              <Select value={form.toCurrency} onChange={(e) => setForm({ ...form, toCurrency: e.target.value })}>
                {active.map((c) => (
                  <option key={c.code}>{c.code}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rate">
              <Input inputMode="decimal" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} placeholder="129.5000" />
            </Field>
            <Field label="Effective date">
              <Input type="date" value={form.effectiveDate} onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })} />
            </Field>
            <Field label="Rate type">
              <Select value={form.rateType} onChange={(e) => setForm({ ...form, rateType: e.target.value })}>
                <option value="SPOT">Spot (transactions)</option>
                <option value="CLOSING">Closing (revaluation)</option>
                <option value="AVERAGE">Average</option>
              </Select>
            </Field>
            <Field label="Source">
              <Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
            </Field>
          </div>
          <p className="text-xs text-muted">
            {can('fx.rates.approve')
              ? 'You can approve rates, so this rate takes effect immediately.'
              : 'This rate will be pending until another user approves it.'}
          </p>
        </div>
      </Modal>
      <Card className="mt-4" title="How rates are applied">
        <p className="text-sm text-muted">
          Each journal line keeps its original currency amount and rate alongside the translated functional amount. If only the opposite
          direction is quoted (e.g. KES→USD), the inverse is used automatically.
        </p>
      </Card>
    </>
  );
}
