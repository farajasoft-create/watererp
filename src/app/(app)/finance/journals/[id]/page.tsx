'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBanner, Field, Input, LinkButton, Loading, Modal, Notice, PageHeader, StatusBadge, TableWrap, Textarea } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate, formatDateTime, isZero, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useBranches, useDimensions, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import type { AuditEvent, Journal, Paged } from '@/modules/finance/ui/lib/types';
import { ApprovalHistory } from '@/modules/finance/ui/components/workflow';
import { AttachmentsCard } from '@/modules/finance/ui/components/attachments';

type Dialog = null | 'reject' | 'reverse' | 'delete';

export default function JournalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { me, can } = useSession();
  const precision = usePrecision();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [reverseDate, setReverseDate] = useState(today());
  const [error, setError] = useState<string | null>(null);

  const { data: j, isLoading, error: loadError } = useQuery({ queryKey: ['journal', id], queryFn: () => api.get<Journal>(`/journals/${id}`) });
  const { data: accounts = [] } = useAccounts();
  const { data: branches = [] } = useBranches();
  const { data: dimensions = [] } = useDimensions();
  const { data: audit } = useQuery({
    queryKey: ['audit', 'Journal', id],
    queryFn: () => api.get<Paged<AuditEvent>>('/audit-events', { recordType: 'Journal', recordId: id, pageSize: 50 }),
    enabled: can('audit.view'),
  });

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) =>
      path === 'delete' ? api.delete(`/journals/${id}`) : api.post<Journal>(`/journals/${id}/${path}`, body),
    onSuccess: (_res, vars) => {
      setDialog(null);
      setReason('');
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['journals'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (vars.path === 'delete') router.replace('/finance/journals');
      else {
        queryClient.invalidateQueries({ queryKey: ['journal', id] });
        queryClient.invalidateQueries({ queryKey: ['audit', 'Journal', id] });
      }
    },
    onError: (err) => setError(errorMessage(err)),
  });

  if (isLoading) return <Loading />;
  if (!j) return <ErrorBanner error={loadError ?? 'Journal not found'} />;

  const p = precision(j.functionalCurrency);
  const account = (aid: string) => accounts.find((a) => a.id === aid);
  const branch = (bid: string) => branches.find((b) => b.id === bid);
  const dim = (did: string | null) => (did ? dimensions.find((d) => d.id === did)?.code : null);
  const isPreparer = j.createdBy === me.id;
  const editable = j.status === 'DRAFT' || j.status === 'REJECTED';
  const run = (path: string, body?: object) => action.mutate({ path, body });
  const busy = (path: string) => action.isPending && action.variables?.path === path;
  const hasForeign = j.lines.some((l) => l.currency !== j.functionalCurrency);

  const timeline = [
    { label: 'Prepared', who: j.createdByName, at: j.createdAt },
    { label: 'Submitted', who: j.submittedByName, at: j.submittedAt },
    { label: 'Rejected', who: j.rejectedByName, at: j.rejectedAt, note: j.rejectionReason },
    { label: 'Approved', who: j.approvedByName, at: j.approvedAt },
    { label: 'Posted', who: j.postedByName, at: j.postedAt },
  ].filter((t) => t.at);

  return (
    <>
      <PageHeader
        title={j.number}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={j.status} />
            <span>{j.description}</span>
          </span>
        }
        actions={
          <>
            {editable && can('journal.create') && (
              <>
                <Button variant="danger" onClick={() => setDialog('delete')}>Delete</Button>
                <LinkButton href={`/finance/journals/${j.id}/edit`}>Edit</LinkButton>
                <Button variant="primary" loading={busy('submit')} onClick={() => run('submit')}>Submit for approval</Button>
              </>
            )}
            {j.status === 'SUBMITTED' && can('journal.approve') && (
              <>
                <Button onClick={() => setDialog('reject')}>Reject</Button>
                <Button loading={busy('approve') && !action.variables?.body} disabled={isPreparer} onClick={() => run('approve', {})}>
                  Approve
                </Button>
                {can('journal.post') && (
                  <Button variant="primary" loading={busy('approve')} disabled={isPreparer} onClick={() => run('approve', { post: true })}>
                    Approve & post
                  </Button>
                )}
              </>
            )}
            {j.status === 'APPROVED' && (
              <>
                {can('journal.approve') && <Button onClick={() => setDialog('reject')}>Reject</Button>}
                {can('journal.post') && (
                  <Button variant="primary" loading={busy('post')} onClick={() => run('post')}>Post to ledger</Button>
                )}
              </>
            )}
            {j.status === 'POSTED' && !j.reversedById && !j.reversalOfId && can('journal.reverse') && (
              <Button onClick={() => setDialog('reverse')}>Reverse</Button>
            )}
          </>
        }
      />

      <div className="space-y-4">
        <ErrorBanner error={error} />
        {j.status === 'SUBMITTED' && isPreparer && can('journal.approve') && (
          <Notice tone="amber">You prepared this journal, so another user must approve it (segregation of duties).</Notice>
        )}
        {j.status === 'REJECTED' && j.rejectionReason && <Notice tone="amber">Rejected: {j.rejectionReason}</Notice>}
        {j.reversedByNumber && (
          <Notice>
            Reversed by <Link className="font-medium underline" href={`/finance/journals/${j.reversedById}`}>{j.reversedByNumber}</Link>.
          </Notice>
        )}
        {j.reversalOfNumber && (
          <Notice>
            Reversal of <Link className="font-medium underline" href={`/finance/journals/${j.reversalOfId}`}>{j.reversalOfNumber}</Link>.
          </Notice>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Card>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
              {[
                ['Date', formatDate(j.journalDate)],
                ['Branch', branch(j.branchId) ? `${branch(j.branchId)!.code} · ${branch(j.branchId)!.name}` : '—'],
                ['Type', j.type.charAt(0) + j.type.slice(1).toLowerCase()],
                ['Source', j.source.charAt(0) + j.source.slice(1).toLowerCase()],
                ['Reference', j.reference || '—'],
                ['Functional currency', j.functionalCurrency],
                ['Total', formatAmount(j.totalDebit, p)],
                ['Auto-reverse', j.autoReverseDate ? formatDate(j.autoReverseDate) : '—'],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="mt-0.5 font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title="Approval trail">
            <ol className="space-y-2.5 text-sm">
              {timeline.map((t) => (
                <li key={t.label}>
                  <p className="font-medium">
                    {t.label} <span className="font-normal text-muted">by {t.who || '—'}</span>
                  </p>
                  <p className="text-xs text-muted">{formatDateTime(t.at)}</p>
                  {t.note && <p className="text-xs text-amber-800">{t.note}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>#</th>
                <th>Account</th>
                <th>Description</th>
                <th>Branch</th>
                <th>Dimensions</th>
                {hasForeign && (
                  <>
                    <th>Currency</th>
                    <th className="num">Rate</th>
                    <th className="num">Debit (tx)</th>
                    <th className="num">Credit (tx)</th>
                  </>
                )}
                <th className="num">Debit {j.functionalCurrency}</th>
                <th className="num">Credit {j.functionalCurrency}</th>
              </tr>
            </thead>
            <tbody>
              {j.lines.map((l) => {
                const a = account(l.accountId);
                const dimsText = [dim(l.departmentId), dim(l.costCentreId), dim(l.projectId), dim(l.fundId)].filter(Boolean);
                const txp = precision(l.currency);
                return (
                  <tr key={l.lineNo}>
                    <td className="text-xs text-muted">{l.lineNo}</td>
                    <td>
                      <span className="font-mono text-xs">{a?.code}</span> {a?.name}
                    </td>
                    <td className="text-muted">
                      {l.description} {l.autoInterBranch && <Badge tone="violet">auto inter-branch</Badge>}
                    </td>
                    <td>{branch(l.branchId)?.code}</td>
                    <td>{dimsText.length ? dimsText.map((d) => <Badge key={d}>{d}</Badge>) : <span className="text-muted">—</span>}</td>
                    {hasForeign && (
                      <>
                        <td>{l.currency}</td>
                        <td className="num">{l.currency === j.functionalCurrency ? '' : l.exchangeRate}</td>
                        <td className="num">{formatAmount(l.debitTx, txp, { blankZero: true })}</td>
                        <td className="num">{formatAmount(l.creditTx, txp, { blankZero: true })}</td>
                      </>
                    )}
                    <td className="num">{formatAmount(l.debit, p, { blankZero: true })}</td>
                    <td className="num">{formatAmount(l.credit, p, { blankZero: true })}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={hasForeign ? 9 : 5}>Total</td>
                <td className="num">{formatAmount(j.totalDebit, p)}</td>
                <td className="num">{formatAmount(j.totalCredit, p)}</td>
              </tr>
            </tfoot>
          </table>
        </TableWrap>

        {audit && audit.items.length > 0 && (
          <Card title="Audit history" padded={false}>
            <table className="table-base">
              <tbody>
                {audit.items.map((e) => (
                  <tr key={e.id}>
                    <td className="w-44 whitespace-nowrap text-xs text-muted">{formatDateTime(e.createdAt)}</td>
                    <td className="w-40">{e.userName}</td>
                    <td>{e.summary}</td>
                    <td className="text-xs text-muted">{e.ipAddress}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      <Modal
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title={`Reject ${j.number}`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" disabled={!reason.trim()} loading={busy('reject')} onClick={() => run('reject', { reason })}>
              Reject journal
            </Button>
          </>
        }
      >
        <Field label="Reason (shown to the preparer)">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </Modal>

      <Modal
        open={dialog === 'reverse'}
        onClose={() => setDialog(null)}
        title={`Reverse ${j.number}`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" disabled={!reason.trim()} loading={busy('reverse')} onClick={() => run('reverse', { date: reverseDate, reason })}>
              Post reversal
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            A new journal with debits and credits swapped will be posted immediately, using the original exchange rates. The original stays on the ledger.
          </p>
          <Field label="Reversal date">
            <Input type="date" value={reverseDate} min={j.journalDate.slice(0, 10)} onChange={(e) => setReverseDate(e.target.value)} />
          </Field>
          <Field label="Reason">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title={`Delete ${j.number}?`}
        footer={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="danger" loading={busy('delete')} onClick={() => run('delete')}>
              Delete draft
            </Button>
          </>
        }
      >
        <p className="text-sm">
          This removes the {j.status.toLowerCase()} journal. The deletion is recorded in the audit trail
          {isZero(j.totalDebit) ? '' : ` (value ${formatAmount(j.totalDebit, p)} ${j.functionalCurrency})`}.
        </p>
      </Modal>
      <ApprovalHistory documentType="JOURNAL" documentId={j.id} />
      <AttachmentsCard recordType="Journal" recordId={j.id} />
    </>
  );
}
