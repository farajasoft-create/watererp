'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { cx, Empty, ErrorBanner, Input, LinkButton, Loading, PageHeader, Pager, Select, StatusBadge, TableWrap } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate } from '@/modules/finance/ui/lib/format';
import { useBranches, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { Journal, JournalStatus, Paged } from '@/modules/finance/ui/lib/types';
import { useResetPage } from '@/modules/finance/ui/lib/hooks';

const STATUSES: (JournalStatus | '')[] = ['', 'DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED'];
const LABELS: Record<string, string> = { '': 'All', DRAFT: 'Draft', SUBMITTED: 'Awaiting approval', APPROVED: 'Approved', POSTED: 'Posted', REJECTED: 'Rejected' };

function JournalList() {
  const router = useRouter();
  const params = useSearchParams();
  const { entity, can } = useSession();
  const precision = usePrecision();
  const status = (params.get('status') ?? '') as JournalStatus | '';
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [branchId, setBranchId] = useState('');
  const { data: branches = [] } = useBranches(entity?.id);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useResetPage([status, debounced, from, to, branchId, entity?.id], setPage);

  const { data, isLoading, error } = useQuery({
    queryKey: ['journals', entity?.id, status, debounced, from, to, branchId, page],
    queryFn: () =>
      api.get<Paged<Journal> & { statusCounts: Record<string, number> }>('/journals', {
        entityId: entity!.id,
        status,
        search: debounced,
        from,
        to,
        branchId,
        page,
        pageSize: 25,
      }),
    placeholderData: keepPreviousData,
  });

  const branchName = (id: string) => branches.find((b) => b.id === id)?.code ?? '—';
  const counts = data?.statusCounts;

  return (
    <>
      <PageHeader
        title={status === 'SUBMITTED' ? 'Approvals' : 'Journals'}
        description={status === 'SUBMITTED' ? 'Journals submitted for review. You cannot approve journals you prepared.' : 'Manual and system journals for the selected entity.'}
        actions={can('journal.create') && <LinkButton variant="primary" href="/finance/journals/new">New journal</LinkButton>}
      />

      <div className="mb-3 flex flex-wrap gap-1">
        {STATUSES.map((s) => (
          <button
            key={s || 'all'}
            onClick={() => router.replace(s ? `/journals?status=${s}` : '/journals')}
            className={cx(
              'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
              status === s ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-muted ring-line hover:text-ink',
            )}
          >
            {LABELS[s]}
            {s && counts ? <span className="ml-1 opacity-70">{counts[s]}</span> : null}
          </button>
        ))}
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_12rem]">
        <Input placeholder="Search number, description or reference" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="Branch">
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} · {b.name}
            </option>
          ))}
        </Select>
      </div>

      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="No journals found">Adjust the filters or create a new journal.</Empty>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Description</th>
                <th>Branch</th>
                <th>Type</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Prepared by</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((j) => (
                <tr key={j.id} className="cursor-pointer" onClick={() => router.push(`/finance/journals/${j.id}`)}>
                  <td className="font-mono text-xs">
                    <Link href={`/finance/journals/${j.id}`} className="text-brand-700 hover:underline" onClick={(e) => e.stopPropagation()}>
                      {j.number}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{formatDate(j.journalDate)}</td>
                  <td className="max-w-md truncate">
                    {j.description}
                    {j.reference && <span className="ml-2 text-xs text-muted">{j.reference}</span>}
                  </td>
                  <td>{branchName(j.branchId)}</td>
                  <td className="text-xs text-muted">{j.type.charAt(0) + j.type.slice(1).toLowerCase()}</td>
                  <td>
                    <StatusBadge status={j.status} />
                    {j.reversedById && <span className="ml-1 text-xs text-muted">reversed</span>}
                  </td>
                  <td className="num">{formatAmount(j.totalDebit, precision(j.functionalCurrency))}</td>
                  <td className="text-muted">{j.createdByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </>
  );
}

export default function JournalsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <JournalList />
    </Suspense>
  );
}
