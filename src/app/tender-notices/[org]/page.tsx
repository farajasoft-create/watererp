'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PortalShell, type Branding } from '@/components/portal-shell';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Select, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMoney, label } from '@/lib/format';

const RESERVED: Record<string, string> = { NONE: '', YOUTH: 'Reserved for youth (AGPO)', WOMEN: 'Reserved for women (AGPO)', PWD: 'Reserved for persons with disability (AGPO)', ALL_AGPO: 'Reserved for AGPO groups', LOCAL: 'Reserved for local firms' };

interface Notices { organisation: string; branding: Branding; open: { id: string; number: string; title: string; method: string; category: string; reservedFor: string; closingAt: string; bidSecurity: string; addenda: number }[]; awards: { id: string; number: string; title: string; awardedTo: string; amount: string; at: string }[] }
interface Detail { id: string; number: string; title: string; description?: string; method: string; category: string; reservedFor: string; bidSecurity: string; bidValidityDays: number; closingAt: string; openingAt: string; openingVenue?: string; mandatory: string[]; criteria: { name: string; weight: number }[]; passMark: number | null; open: boolean; addenda: { number: number; text: string; at: string }[]; clarifications: { question: string; answer: string }[]; documents: { id: string; name: string }[] }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/v1/tenders${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? 'Not available');
  return body as T;
}
async function post(path: string, data: unknown) {
  const res = await fetch(`/api/v1/tenders${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? body?.message ?? 'Something went wrong');
  return body;
}

function BidForm({ org, t }: { org: string; t: Detail }) {
  const [f, setF] = useState({ name: '', kraPin: '', email: '', phone: '', agpo: 'NONE', agpoCertificate: '', local: false, amount: '', validityDays: String(t.bidValidityDays), bidSecurityReference: '', technicalProposal: '' });
  const [mand, setMand] = useState(t.mandatory.map((requirement) => ({ requirement, provided: false, reference: '' })));
  const [done, setDone] = useState<{ number: number; path: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setErr(null);
    try {
      setDone(await post(`/public/${org}/${t.id}/bids`, { ...f, email: f.email || undefined, agpoCertificate: f.agpoCertificate || undefined, bidSecurityReference: f.bidSecurityReference || undefined, technicalProposal: f.technicalProposal || undefined, validityDays: Number(f.validityDays), mandatory: mand.map((m) => ({ ...m, reference: m.reference || undefined })) }));
    } catch (e) {
      setErr(e);
    }
  };
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  if (done) return <Notice tone="green">Bid {done.number} received and sealed until opening. Keep this link to change or withdraw it before closing and to see the outcome: <a className="underline" href={done.path}>{typeof window !== 'undefined' ? window.location.origin : ''}{done.path}</a> (also sent to your phone).</Notice>;
  return (
    <div className="space-y-3">
      <ErrorBox error={err} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Firm name"><Input value={f.name} onChange={s('name')} /></Field>
        <Field label="KRA PIN"><Input value={f.kraPin} onChange={s('kraPin')} placeholder="P051234567X" /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={s('phone')} /></Field>
        <Field label="Email"><Input value={f.email} onChange={s('email')} /></Field>
        <Field label="AGPO group"><Select value={f.agpo} onChange={s('agpo')}><option value="NONE">None</option><option value="YOUTH">Youth</option><option value="WOMEN">Women</option><option value="PWD">Persons with disability</option></Select></Field>
        {f.agpo !== 'NONE' && <Field label="AGPO certificate number"><Input value={f.agpoCertificate} onChange={s('agpoCertificate')} /></Field>}
        <Field label="Total bid price (KES, inclusive of taxes)"><Input inputMode="decimal" value={f.amount} onChange={s('amount')} /></Field>
        <Field label="Bid valid for (days)"><Input inputMode="numeric" value={f.validityDays} onChange={s('validityDays')} /></Field>
        {Number(t.bidSecurity) > 0 && <Field label={`Bid security reference (KES ${fmtMoney(t.bidSecurity)})`}><Input value={f.bidSecurityReference} onChange={s('bidSecurityReference')} /></Field>}
        <label className="flex items-center gap-1.5 self-end text-sm"><input type="checkbox" checked={f.local} onChange={(e) => setF({ ...f, local: e.target.checked })} /> Locally owned firm</label>
      </div>
      <div>
        <div className="mb-1 text-sm font-medium">Mandatory requirements</div>
        {mand.map((m, i) => (
          <div key={m.requirement} className="mb-1 grid gap-2 sm:grid-cols-[2fr_auto_2fr]">
            <span className="text-sm">{m.requirement}</span>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={m.provided} onChange={(e) => setMand(mand.map((x, j) => (j === i ? { ...x, provided: e.target.checked } : x)))} /> provided</label>
            <Input placeholder="Certificate number or reference" value={m.reference} onChange={(e) => setMand(mand.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
          </div>
        ))}
      </div>
      <Field label="Technical proposal (summary; methodology, experience, key staff)"><Textarea rows={5} value={f.technicalProposal} onChange={s('technicalProposal')} /></Field>
      <Button onClick={submit} disabled={f.name.length < 2 || !f.kraPin || f.phone.length < 9 || !f.amount}>Submit sealed bid</Button>
    </div>
  );
}

function TenderView({ org, id, onBack }: { org: string; id: string; onBack: () => void }) {
  const { data: t, error } = useQuery({ queryKey: ['tender-notice', org, id], queryFn: () => get<Detail>(`/public/${org}/${id}`) });
  const [q, setQ] = useState({ question: '', askedBy: '' });
  const [asked, setAsked] = useState(false);
  const [bidding, setBidding] = useState(false);
  if (!t) return <><ErrorBox error={error} /><Button variant="secondary" onClick={onBack}>All tenders</Button></>;
  return (
    <>
      <Button variant="secondary" onClick={onBack}>All tenders</Button>
      <Card title={`${t.number}: ${t.title}`}>
        <p className="text-sm text-muted">{label(t.method)} · {label(t.category)} {RESERVED[t.reservedFor] && <Badge tone="green">{RESERVED[t.reservedFor]}</Badge>}</p>
        {t.description && <p className="mt-2 whitespace-pre-line text-sm">{t.description}</p>}
        <p className="mt-2 text-sm">Closes <b>{fmtDateTime(t.closingAt)}</b>; opened in public {fmtDateTime(t.openingAt)}{t.openingVenue && ` at ${t.openingVenue}`}. Bid security KES {fmtMoney(t.bidSecurity)}; bids valid {t.bidValidityDays} days.</p>
        <div className="mt-2 text-sm font-medium">Mandatory requirements</div>
        <ul className="list-disc pl-5 text-sm">{t.mandatory.map((m) => <li key={m}>{m}</li>)}</ul>
        {t.criteria.length > 0 && <><div className="mt-2 text-sm font-medium">Technical evaluation (pass mark {t.passMark})</div><ul className="list-disc pl-5 text-sm">{t.criteria.map((c) => <li key={c.name}>{c.name}: {c.weight}%</li>)}</ul></>}
        {t.documents.length > 0 && <><div className="mt-2 text-sm font-medium">Tender documents</div><ul className="text-sm">{t.documents.map((d) => <li key={d.id}><a href={`/api/v1/tenders/public/${org}/${t.id}/documents/${d.id}`} style={{ color: 'var(--portal-accent)' }}>{d.name}</a></li>)}</ul></>}
      </Card>
      {t.addenda.length > 0 && <Card title="Addenda">{t.addenda.map((a) => <p key={a.number} className="text-sm">{a.number}. {a.text} <span className="text-xs text-muted">{fmtDate(a.at)}</span></p>)}</Card>}
      <Card title="Questions and answers">
        {t.clarifications.map((c, i) => <div key={i} className="mb-2 text-sm"><b>Q:</b> {c.question}<br /><b>A:</b> {c.answer}</div>)}
        {t.open && (asked ? <Notice tone="green">Your question was received; the answer is published here for every bidder.</Notice> : (
          <div className="mt-2 grid gap-2 sm:grid-cols-[3fr_1fr_auto]"><Input placeholder="Your question" value={q.question} onChange={(e) => setQ({ ...q, question: e.target.value })} /><Input placeholder="Firm (optional)" value={q.askedBy} onChange={(e) => setQ({ ...q, askedBy: e.target.value })} /><Button variant="secondary" disabled={q.question.length < 5} onClick={() => post(`/public/${org}/${t.id}/questions`, { question: q.question, askedBy: q.askedBy || undefined }).then(() => setAsked(true))}>Ask</Button></div>
        ))}
      </Card>
      {t.open && <Card title="Submit a bid">{bidding ? <BidForm org={org} t={t} /> : <Button onClick={() => setBidding(true)}>Bid for this tender</Button>}</Card>}
    </>
  );
}

/** The public tenders portal: open tenders, documents, questions, sealed online bids and award notices. */
export default function TenderNoticesPage() {
  const { org } = useParams<{ org: string }>();
  const [id, setId] = useState<string | null>(null);
  const { data, error } = useQuery({ queryKey: ['tender-notices', org], queryFn: () => get<Notices>(`/public/${org}`) });
  return (
    <PortalShell organisation={data?.organisation ?? ''} fallbackTitle="Tenders" branding={data?.branding}>
      <ErrorBox error={error} />
      {id ? <TenderView org={org} id={id} onBack={() => setId(null)} /> : (
        <>
          <Card title="Open tenders">
            {!data?.open.length ? <p className="text-sm text-muted">No open tenders at the moment.</p> : (
              <ul className="divide-y">
                {data.open.map((t) => (
                  <li key={t.id} className="py-2">
                    <button type="button" className="text-left font-medium hover:underline" style={{ color: 'var(--portal-accent)' }} onClick={() => setId(t.id)}>{t.number}: {t.title}</button>
                    <div className="text-xs text-muted">{label(t.method)} · {label(t.category)} · closes {fmtDateTime(t.closingAt)}{t.addenda > 0 && ` · ${t.addenda} addend${t.addenda === 1 ? 'um' : 'a'}`} {RESERVED[t.reservedFor] && <Badge tone="green">{RESERVED[t.reservedFor]}</Badge>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {!!data?.awards.length && (
            <Card title="Award notices">
              <table className="table-base"><thead><tr><th>Tender</th><th>Awarded to</th><th className="num">Amount (KES)</th><th>Date</th></tr></thead>
                <tbody>{data.awards.map((a) => <tr key={a.id}><td>{a.number}<div className="text-xs text-muted">{a.title}</div></td><td>{a.awardedTo}</td><td className="num">{fmtMoney(a.amount)}</td><td>{fmtDate(a.at)}</td></tr>)}</tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </PortalShell>
  );
}
