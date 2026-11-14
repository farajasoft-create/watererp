'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Badge, Empty, ErrorBanner, Input, Loading, PageHeader, Pager, Select, TableWrap } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { formatDateTime } from '@/modules/finance/ui/lib/format';
import type { AuditEvent, Paged } from '@/modules/finance/ui/lib/types';

const RECORD_TYPES = ['Journal', 'Invoice', 'Payment', 'Allocation', 'Customer', 'Supplier', 'PurchaseRequisition', 'PurchaseOrder', 'BankAccount', 'BankTransfer', 'TaxCode', 'Account', 'Period', 'FiscalYear', 'ExchangeRate', 'Currency', 'LegalEntity', 'Branch', 'DimensionValue', 'User', 'Role', 'Organisation'];

function Diff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !['id', 'organisationId'].includes(k));
  if (!keys.length) return null;
  const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <table className="mt-1 w-full text-xs">
      <tbody>
        {keys.map((k) => (
          <tr key={k} className="align-top">
            <td className="w-48 py-0.5 pr-3 font-mono text-muted">{k}</td>
            <td className="py-0.5 pr-3 text-red-700 line-through decoration-red-300">{before ? show(before[k]) : ''}</td>
            <td className="py-0.5 text-emerald-800">{after ? show(after[k]) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [recordType, setRecordType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', recordType, from, to, page],
    queryFn: () => api.get<Paged<AuditEvent>>('/audit-events', { recordType, from, to, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="Audit trail" description="Every material change with who, when, from where, and before/after values. Read-only." />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="w-48" value={recordType} onChange={(e) => (setRecordType(e.target.value), setPage(1))}>
          <option value="">All records</option>
          {RECORD_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
        <Input type="date" className="w-40" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} aria-label="From" />
        <Input type="date" className="w-40" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} aria-label="To" />
      </div>
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !data?.items.length ? (
          <Empty title="No audit events match" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>When</th>
                <th>User</th>
                <th>Action</th>
                <th>Summary</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => {
                const hasDiff = !!(e.before && Object.keys(e.before).length) || !!(e.after && Object.keys(e.after).length);
                return (
                  <Fragment key={e.id}>
                    <tr className={hasDiff ? 'cursor-pointer' : ''} onClick={() => hasDiff && setExpanded(expanded === e.id ? null : e.id)}>
                      <td className="whitespace-nowrap text-xs text-muted">{formatDateTime(e.createdAt)}</td>
                      <td>{e.userName}</td>
                      <td>
                        <Badge>{e.action}</Badge>
                      </td>
                      <td>
                        {e.recordType === 'Journal' && e.recordId ? (
                          <Link href={`/finance/journals/${e.recordId}`} className="hover:text-brand-700 hover:underline" onClick={(ev) => ev.stopPropagation()}>
                            {e.summary}
                          </Link>
                        ) : (
                          e.summary
                        )}
                        {hasDiff && <span className="ml-2 text-xs text-brand-700">{expanded === e.id ? 'hide changes' : 'changes'}</span>}
                      </td>
                      <td className="text-xs text-muted">{e.ipAddress}</td>
                    </tr>
                    {expanded === e.id && (
                      <tr>
                        <td />
                        <td colSpan={4} className="bg-gray-50">
                          <Diff before={e.before} after={e.after} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>
      {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
    </>
  );
}
