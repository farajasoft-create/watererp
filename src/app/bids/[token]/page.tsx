'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice } from '@/components/ui';
import { fmtDateTime, fmtMoney } from '@/lib/format';

interface Bid {
  tender: { number: string; title: string; closingAt: string; openingAt: string; status: string; cancellation?: string };
  number: number;
  bidder: { name: string; kraPin: string; phone: string; email?: string; agpo: string; agpoCertificate?: string; local: boolean };
  amount: string;
  validityDays: number;
  bidSecurityReference?: string;
  mandatory: { requirement: string; provided: boolean; reference?: string }[];
  technicalProposal?: string;
  status: string;
  canChange: boolean;
  outcome: string;
  outcomeReason?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/tenders/bid/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.errors?.[0]?.message ?? data?.message ?? 'Something went wrong');
  return data as T;
}

/** The bidder's own link: the sealed bid, changes or withdrawal before closing, and the outcome with reasons. */
export default function BidPage() {
  const { token } = useParams<{ token: string }>();
  const qc = useQueryClient();
  const { data: b, error } = useQuery({ queryKey: ['bid', token], queryFn: () => call<Bid>('GET', encodeURIComponent(token)) });
  const [amount, setAmount] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['bid', token] });
  const change = async () => {
    if (!b) return;
    setErr(null);
    try {
      await call('PUT', encodeURIComponent(token), { name: b.bidder.name, kraPin: b.bidder.kraPin, phone: b.bidder.phone, email: b.bidder.email || undefined, agpo: b.bidder.agpo, agpoCertificate: b.bidder.agpoCertificate || undefined, local: b.bidder.local, amount: amount ?? b.amount, validityDays: b.validityDays, bidSecurityReference: b.bidSecurityReference || undefined, mandatory: b.mandatory.map((m) => ({ ...m, reference: m.reference || undefined })), technicalProposal: b.technicalProposal || undefined });
      setAmount(null);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  const withdraw = async () => {
    setErr(null);
    try {
      await call('POST', `${encodeURIComponent(token)}/withdraw`);
      reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <ErrorBox error={error || err} />
      {b && (
        <>
          <Card title={`${b.tender.number}: ${b.tender.title}`}>
            <p className="text-sm">Bid {b.number} by {b.bidder.name} ({b.bidder.kraPin}) · <Badge value={b.status} /></p>
            <p className="mt-1 text-sm text-muted">Closing {fmtDateTime(b.tender.closingAt)} · opening {fmtDateTime(b.tender.openingAt)}</p>
            {b.tender.cancellation && <Notice tone="amber">The tender was cancelled: {b.tender.cancellation}</Notice>}
            {b.outcome !== 'PENDING' && <div className="mt-2"><Notice tone={b.outcome === 'SUCCESSFUL' ? 'green' : 'amber'}>{b.outcomeReason}</Notice></div>}
          </Card>
          <Card title="Your bid">
            <p className="text-sm">Price: KES {fmtMoney(b.amount)} · valid {b.validityDays} days{b.bidSecurityReference && ` · bid security ${b.bidSecurityReference}`}</p>
            <ul className="mt-1 text-sm">{b.mandatory.map((m) => <li key={m.requirement}>{m.provided ? '✓' : '✗'} {m.requirement}{m.reference && ` (${m.reference})`}</li>)}</ul>
            {b.canChange && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="Change the price (KES)"><Input inputMode="decimal" value={amount ?? b.amount} onChange={(e) => setAmount(e.target.value)} /></Field>
                <Button onClick={change}>Save change</Button>
                <Button variant="secondary" onClick={withdraw}>Withdraw the bid</Button>
              </div>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
