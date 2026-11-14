'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDate } from '@/modules/finance/ui/lib/format';
import { usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { Button, Card, ErrorBanner, Field, Input, Modal, Notice, Textarea } from '../ui';

interface Line { lineNo: number; description: string; accountId: string; quantity: string; unitPrice: string; taxCodeId: string | null; itemId: string | null; warehouseId: string | null; departmentId: string | null; quantityReceived: string; quantityBilled: string; netAmount: string }
export interface LpoOrder {
  id: string;
  number: string;
  status: string;
  currency: string;
  total: string;
  expectedDate: string | null;
  lines: Line[];
  version?: number;
  amendment?: { reason: string; requestedBy: string; requestedAt: string; proposed: { total: string; expectedDate: string | null; lines: Line[] } } | null;
  revisions?: { version: number; reason: string; approvedAt: string | null; total: string; newTotal: string }[];
  sentTo?: { email: string; version: number; at: string }[];
}

const decimal = /^\d*(\.\d*)?$/;

/** The LPO after approval: print, email to the supplier, amendments and their versions. */
export function LpoPanel({ order: o }: { order: LpoOrder }) {
  const { me, can } = useSession();
  const precision = usePrecision();
  const qc = useQueryClient();
  const tp = precision(o.currency);
  const [error, setError] = useState<string | null>(null);
  const [amending, setAmending] = useState<null | { reason: string; expectedDate: string; lines: (Partial<Line> & { description: string; accountId: string; quantity: string; unitPrice: string; existing: boolean })[] }>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['purchase-order', o.id] });
  const issued = ['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(o.status);
  const amendable = ['APPROVED', 'PARTIALLY_RECEIVED'].includes(o.status);

  const request = useMutation({
    mutationFn: () =>
      api.post(`/purchase-orders/${o.id}/amendment`, {
        reason: amending!.reason,
        expectedDate: amending!.expectedDate || null,
        lines: amending!.lines.filter((l) => l.description).map((l) => ({ description: l.description, accountId: l.accountId, quantity: l.quantity || '0', unitPrice: l.unitPrice || '0', taxCodeId: l.taxCodeId ?? null, itemId: l.itemId ?? null, warehouseId: l.warehouseId ?? null, departmentId: l.departmentId ?? null })),
      }),
    onSuccess: () => (setAmending(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const decide = useMutation({
    mutationFn: (v: { approve: boolean; reason?: string }) => api.post(`/purchase-orders/${o.id}/amendment/${v.approve ? 'approve' : 'reject'}`, v.reason ? { reason: v.reason } : {}),
    onSuccess: () => (setRejecting(null), setError(null), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });
  const send = useMutation({
    mutationFn: () => api.post<{ to: string }>(`/purchase-orders/${o.id}/email`, emailTo ? { to: emailTo } : {}),
    onSuccess: (r) => (setEmailTo(null), setError(null), setNote(`Sent to ${r.to}.`), refresh()),
    onError: (e) => setError(errorMessage(e)),
  });

  if (!issued && !o.revisions?.length) return null;
  const a = o.amendment;
  return (
    <Card title={`Local purchase order${(o.version ?? 1) > 1 ? ` · version ${o.version}` : ''}`}>
      <div className="space-y-3 text-sm">
        <ErrorBanner error={!amending && !rejecting ? error : null} />
        {note && <Notice tone="green">{note}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => window.open(`/api/v1/finance/purchase-orders/${o.id}/pdf`, '_blank', 'noopener')}>Print LPO</Button>
          {issued && can('procurement.manage') && <Button size="sm" onClick={() => (setNote(null), setEmailTo(''))}>Email to supplier</Button>}
          {amendable && !a && can('procurement.manage') && (
            <Button size="sm" onClick={() => (setError(null), setAmending({ reason: '', expectedDate: o.expectedDate?.slice(0, 10) ?? '', lines: o.lines.map((l) => ({ ...l, existing: true })) }))}>Amend order</Button>
          )}
        </div>
        {a && (
          <Notice tone="amber">
            <p>
              Amendment awaiting approval: total {formatAmount(o.total, tp)} → <strong>{formatAmount(a.proposed.total, tp)}</strong>. {a.reason}
            </p>
            {can('procurement.approve') && (
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => setRejecting('')}>Reject</Button>
                <Button size="sm" variant="primary" disabled={a.requestedBy === me.id} title={a.requestedBy === me.id ? 'You requested this amendment' : undefined} loading={decide.isPending} onClick={() => decide.mutate({ approve: true })}>Approve amendment</Button>
              </div>
            )}
          </Notice>
        )}
        {!!o.revisions?.length && (
          <div>
            <p className="text-xs font-semibold uppercase text-muted">Versions</p>
            <ul className="mt-1 space-y-1">
              {o.revisions.map((r) => (
                <li key={r.version}>v{r.version} → v{r.version + 1} {r.approvedAt && `on ${formatDate(r.approvedAt)}`}: {formatAmount(r.total, tp)} → {formatAmount(r.newTotal, tp)} · {r.reason}</li>
              ))}
            </ul>
          </div>
        )}
        {!!o.sentTo?.length && <p className="text-xs text-muted">Sent: {o.sentTo.map((s) => `${s.email} (v${s.version}, ${formatDate(s.at)})`).join('; ')}</p>}
      </div>

      <Modal open={emailTo !== null} onClose={() => setEmailTo(null)} title="Email the LPO" footer={<><Button onClick={() => setEmailTo(null)}>Cancel</Button><Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}>Send</Button></>}>
        <ErrorBanner error={emailTo !== null ? error : null} />
        <Field label="To" hint="Leave blank to use the supplier's email address"><Input type="email" value={emailTo ?? ''} onChange={(e) => setEmailTo(e.target.value)} /></Field>
      </Modal>

      <Modal open={rejecting !== null} onClose={() => setRejecting(null)} title="Reject the amendment" footer={<><Button onClick={() => setRejecting(null)}>Back</Button><Button variant="primary" disabled={!rejecting?.trim()} loading={decide.isPending} onClick={() => decide.mutate({ approve: false, reason: rejecting! })}>Reject</Button></>}>
        <ErrorBanner error={rejecting !== null ? error : null} />
        <Field label="Reason"><Textarea rows={3} value={rejecting ?? ''} onChange={(e) => setRejecting(e.target.value)} /></Field>
      </Modal>

      <Modal wide open={!!amending} onClose={() => setAmending(null)} title={`Amend ${o.number}`} footer={<><Button onClick={() => setAmending(null)}>Cancel</Button><Button variant="primary" disabled={!amending?.reason.trim()} loading={request.isPending} onClick={() => request.mutate()}>Submit amendment</Button></>}>
        {amending && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            <p className="text-sm text-muted">Existing lines keep their place and cannot go below what was received or billed. New lines are added at the end. Someone else approves the amendment before it takes effect.</p>
            <table className="table-base">
              <thead><tr><th>#</th><th>Description</th><th className="num">Received</th><th className="num">Qty</th><th className="num">Unit price</th></tr></thead>
              <tbody>
                {amending.lines.map((l, i) => {
                  const set = (p: Partial<typeof l>) => setAmending({ ...amending, lines: amending.lines.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                  return (
                    <tr key={i}>
                      <td className="text-xs text-muted">{i + 1}</td>
                      <td><Input className="h-8 text-xs" value={l.description} onChange={(e) => set({ description: e.target.value })} aria-label="Description" /></td>
                      <td className="num text-xs">{l.existing ? l.quantityReceived : ''}</td>
                      <td><Input className="h-8 w-24 text-right text-xs" value={l.quantity} onChange={(e) => decimal.test(e.target.value) && set({ quantity: e.target.value })} aria-label="Quantity" /></td>
                      <td><Input className="h-8 w-28 text-right text-xs" value={l.unitPrice} disabled={l.existing && l.quantityBilled !== undefined && Number(l.quantityBilled) > 0} onChange={(e) => decimal.test(e.target.value) && set({ unitPrice: e.target.value })} aria-label="Unit price" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button size="sm" onClick={() => setAmending({ ...amending, lines: [...amending.lines, { description: '', accountId: o.lines[0]?.accountId ?? '', quantity: '1', unitPrice: '', existing: false }] })}>Add line (same account as line 1)</Button>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Deliver by"><Input type="date" value={amending.expectedDate} onChange={(e) => setAmending({ ...amending, expectedDate: e.target.value })} /></Field>
              <Field label="Reason for the amendment"><Input value={amending.reason} onChange={(e) => setAmending({ ...amending, reason: e.target.value })} /></Field>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
