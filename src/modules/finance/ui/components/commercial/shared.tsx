'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import type { Trail } from '@/modules/finance/ui/lib/commercial';
import { formatDateTime, today } from '@/modules/finance/ui/lib/format';
import type { Account, AccountClass } from '@/modules/finance/ui/lib/types';
import { Button, Card, Field, Input, Modal, Textarea } from '../ui';

const CLASS_LABELS: Record<AccountClass, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Revenue',
  COST_OF_SALES: 'Cost of sales',
  EXPENSE: 'Expenses',
};

/** Postable, non-control accounts grouped by class, with the given classes first. */
export function AccountOptions({ accounts, classes, placeholder = 'Select account…' }: { accounts: Account[]; classes?: string[]; placeholder?: string }) {
  const usable = accounts.filter((a) => a.isPostable && a.isActive && a.allowManualPosting);
  const order = [...(classes ?? []), ...Object.keys(CLASS_LABELS).filter((c) => !classes?.includes(c))] as AccountClass[];
  return (
    <>
      <option value="">{placeholder}</option>
      {order.map((cls) => {
        const items = usable.filter((a) => a.accountClass === cls);
        return items.length ? (
          <optgroup key={cls} label={CLASS_LABELS[cls]}>
            {items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
                {a.currency ? ` [${a.currency}]` : ''}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </>
  );
}

/** Who prepared, submitted, approved, rejected or voided a record. */
export function ApprovalTrail({ record, approvedLabel = 'Approved & posted' }: { record: Trail; approvedLabel?: string }) {
  const steps = [
    { label: 'Prepared', who: record.createdByName, at: record.createdAt },
    { label: 'Submitted', who: record.submittedByName, at: record.submittedAt },
    { label: 'Rejected', who: record.rejectedByName, at: record.rejectedAt, note: record.rejectionReason },
    { label: approvedLabel, who: record.approvedByName, at: record.approvedAt },
    { label: 'Voided', who: record.voidedByName, at: record.voidedAt, note: record.voidReason },
  ].filter((s) => s.at);
  return (
    <Card title="Approval trail">
      <ol className="space-y-2.5 text-sm">
        {steps.map((s) => (
          <li key={s.label}>
            <p className="font-medium">
              {s.label} <span className="font-normal text-muted">by {s.who || '—'}</span>
            </p>
            <p className="text-xs text-muted">{formatDateTime(s.at)}</p>
            {s.note && <p className="text-xs text-amber-800">{s.note}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** POSTs to `${base}/${action}` and refreshes the given queries; errors are surfaced via onError. */
export function useActions(base: string, invalidate: unknown[][], onError: (message: string | null) => void) {
  const queryClient = useQueryClient();
  const m = useMutation({
    mutationFn: ({ action, body, method = 'POST' }: { action: string; body?: object; method?: 'POST' | 'DELETE' }) =>
      method === 'DELETE' ? api.delete(base) : api.post(`${base}/${action}`, body ?? {}),
    onSuccess: () => {
      onError(null);
      for (const key of invalidate) queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => onError(errorMessage(err)),
  });
  return {
    run: (action: string, body?: object) => m.mutateAsync({ action, body }).catch(() => undefined),
    remove: () => m.mutateAsync({ action: '', method: 'DELETE' }),
    busy: (action: string) => m.isPending && m.variables?.action === action,
    pending: m.isPending,
  };
}

/** A confirmation dialog that collects a reason and, optionally, an effective date. */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  withDate,
  minDate,
  required = true,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  withDate?: boolean;
  minDate?: string;
  required?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (v: { reason: string; date: string }) => void;
}) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={required && !reason.trim()} loading={busy} onClick={() => onConfirm({ reason: reason.trim(), date })}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {description && <div className="text-sm text-muted">{description}</div>}
        {withDate && (
          <Field label="Effective date">
            <Input type="date" value={date} min={minDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
        <Field label={required ? 'Reason' : 'Reason (optional)'}>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

/** Key/value grid for document headers. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="mt-0.5 font-medium">{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
