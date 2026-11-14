'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { uploadDocument } from '@/components/attachments';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Money, Notice, PageHeader, Select, Stat, Textarea } from '@/components/ui';
import { useDirectory } from '@/lib/directory';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/tenders/ui/api';
import { RESERVED_LABEL, Tender, TenderForm, toIso } from '@/modules/tenders/ui/shared';

type Member = { userId: string; role: string; name: string };
interface Bid { id: string; number: number; bidder: { name: string; kraPin: string; phone: string; email?: string; agpo: string }; amount: string; bidSecurityReference?: string; mandatory: { requirement: string; provided: boolean; reference?: string }[]; technicalProposal?: string; responsive: boolean | null; nonResponsiveReason?: string; outcome: string; outcomeReason?: string; status: string }
interface Full extends Tender {
  publishedAt?: string;
  addenda: { number: number; text: string; at: string }[];
  clarifications: { id: string; question: string; askedBy?: string; askedAt: string; answer?: string }[];
  openingCommittee: Member[];
  evaluationCommittee: Member[];
  myRoles: { opening: boolean; evaluation: string | null };
  myScores: { bidId: string; criterion: string; score: number }[];
  scoredBy: number;
  sealed: boolean;
  bidsReceived: number;
  bids: Bid[];
  opening?: { at?: string; attendees: string[]; bidderRepresentatives?: string; minutes?: string };
  evaluation?: { completedAt?: string; report?: string; recommendedBidId?: string | null; ranking: { bidId: string; technical: number | null; financial: number | null; combined: number | null; rank: number | null; passed: boolean }[] };
  opinion?: { at?: string; text?: string; concurs?: boolean };
  award?: { bidId?: string; amount?: string; at?: string; reason?: string; standstillEnds?: string };
  appeals: { id: string; applicant: string; filedAt: string; grounds: string; status: string; decision?: string }[];
  contract?: { number?: string; signedAt?: string; value?: string; startDate?: string; endDate?: string; performanceSecurity?: string };
  cancellation?: { reason?: string; at?: string };
}

const body = (t: Full, documentIds: string[]) => ({ title: t.title, description: t.description, method: t.method, category: t.category, reservedFor: t.reservedFor, estimate: t.estimate, planReference: t.planReference, budgetLine: t.budgetLine, justification: t.justification, bidSecurity: t.bidSecurity, bidValidityDays: t.bidValidityDays, documentIds, closingAt: t.closingAt, openingAt: t.openingAt, openingVenue: t.openingVenue, mandatory: t.mandatory, criteria: t.criteria, passMark: t.passMark, financialWeight: t.financialWeight });

function Committees({ t, onDone }: { t: Full; onDone: () => void }) {
  const people = useDirectory('tenders');
  const blank = [{ userId: '', role: 'CHAIR' }, { userId: '', role: 'SECRETARY' }, { userId: '', role: 'MEMBER' }];
  const [opening, setOpening] = useState(t.openingCommittee.length ? t.openingCommittee : blank);
  const [evaluation, setEvaluation] = useState(t.evaluationCommittee.length ? t.evaluationCommittee : blank);
  const save = useMutation({ mutationFn: () => api.put(`/tenders/${t.id}/committees`, { opening: opening.filter((m) => m.userId).map(({ userId, role }) => ({ userId, role })), evaluation: evaluation.filter((m) => m.userId).map(({ userId, role }) => ({ userId, role })) }), onSuccess: onDone });
  const list = (rows: { userId: string; role: string }[], set: (r: { userId: string; role: string }[]) => void) => (
    <div className="space-y-1">
      {rows.map((m, i) => (
        <div key={i} className="flex gap-1">
          <Select value={m.userId} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, userId: e.target.value } : x)))}><option value="">Choose</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Select value={m.role} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} className="w-36"><option value="CHAIR">Chair</option><option value="SECRETARY">Secretary</option><option value="MEMBER">Member</option></Select>
        </div>
      ))}
      <Button variant="secondary" onClick={() => set([...rows, { userId: '', role: 'MEMBER' }])}>Add member</Button>
    </div>
  );
  return (
    <Card title="Appoint the committees" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-4 md:grid-cols-2">
        <div><div className="mb-1 text-sm font-medium">Opening committee</div>{list(opening, setOpening)}</div>
        <div><div className="mb-1 text-sm font-medium">Evaluation committee</div>{list(evaluation, setEvaluation)}</div>
      </div>
    </Card>
  );
}

function Scoring({ t, bid, act }: { t: Full; bid: Bid; act: (path: string, b: unknown) => void }) {
  const [s, setS] = useState<Record<string, string>>(Object.fromEntries(t.criteria.map((c) => [c.name, String(t.myScores.find((x) => x.bidId === bid.id && x.criterion === c.name)?.score ?? '')])));
  return (
    <tr>
      <td>{bid.number}. {bid.bidder.name}</td>
      {t.criteria.map((c) => <td key={c.name}><Input inputMode="numeric" className="w-20" value={s[c.name]} onChange={(e) => setS({ ...s, [c.name]: e.target.value })} /></td>)}
      <td><Button onClick={() => act('scores', { bidId: bid.id, scores: t.criteria.map((c) => ({ criterion: c.name, score: Number(s[c.name] || 0) })) })}>Save</Button></td>
    </tr>
  );
}

export default function TenderPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const qc = useQueryClient();
  const { data: t, error, isLoading } = useQuery({ queryKey: ['tenders', id], queryFn: () => api.get<Full>(`/tenders/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['tenders'] });
  const run = useMutation({ mutationFn: (x: { path: string; body?: unknown }) => api.post(`/tenders/${id}/${x.path}`, x.body), onSuccess: refresh });
  const act = (path: string, b?: unknown) => run.mutate({ path, body: b });
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ addendum: '', addClosing: '', answer: {} as Record<string, string>, attendees: [] as string[], reps: '', minutes: '', prelim: {} as Record<string, { responsive: boolean; reason: string }>, report: '', opinion: '', concurs: true, awardBid: '', awardReason: '', cancel: '', appellant: '', grounds: '', filedAt: '', decision: {} as Record<string, string>, contract: { number: '', signedAt: '', value: '', startDate: '', endDate: '', performanceSecurity: '0' } });
  const attach = useMutation({
    mutationFn: async (file: File) => {
      const doc = await uploadDocument(file, { module: 'tenders', category: 'TENDER_DOCUMENT', access: 'ORGANISATION' });
      return api.put(`/tenders/${id}`, body(t!, [...t!.documentIds, doc.id]));
    },
    onSuccess: refresh,
  });
  if (isLoading || !t) return <><ErrorBox error={error} />{isLoading && <Loading />}</>;
  const name = (bidId?: string | null) => t.bids.find((b) => b.id === bidId)?.bidder.name ?? '';
  const responsive = t.bids.filter((b) => b.status === 'SUBMITTED' && b.responsive);
  return (
    <>
      <PageHeader
        title={`${t.number} · ${t.title}`}
        subtitle={<><Badge value={t.status} /> {label(t.method)} · {label(t.category)} · {RESERVED_LABEL[t.reservedFor]}</>}
        actions={
          <div className="flex flex-wrap gap-2">
            {t.status === 'DRAFT' && can('tenders.manage') && <><Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button><Button onClick={() => act('publish')}>Publish</Button></>}
            {!['CONTRACTED', 'CANCELLED'].includes(t.status) && can('tenders.award') && <><Input placeholder="Reason to cancel" value={f.cancel} onChange={(e) => setF({ ...f, cancel: e.target.value })} className="w-48" /><Button variant="secondary" disabled={f.cancel.length < 5} onClick={() => act('cancel', { reason: f.cancel })}>Cancel tender</Button></>}
          </div>
        }
      />
      <ErrorBox error={run.error || attach.error} />
      {t.cancellation?.reason && <Notice tone="amber">Cancelled {fmtDate(t.cancellation.at)}: {t.cancellation.reason}</Notice>}
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Estimate" value={<Money value={t.estimate} />} />
        <Stat label="Closing" value={fmtDateTime(t.closingAt)} hint={`Opening ${fmtDateTime(t.openingAt)}${t.openingVenue ? `, ${t.openingVenue}` : ''}`} />
        <Stat label="Bids" value={t.bidsReceived} hint={t.sealed ? 'sealed until opening' : undefined} />
        <Stat label="Bid security" value={<Money value={t.bidSecurity} />} hint={`valid ${t.bidValidityDays} days`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Requirements">
          {t.description && <p className="mb-2 whitespace-pre-line text-sm">{t.description}</p>}
          <div className="text-xs font-medium text-muted">Mandatory</div>
          <ul className="mb-2 list-disc pl-5 text-sm">{t.mandatory.map((m) => <li key={m}>{m}</li>)}</ul>
          {t.criteria.length > 0 && <><div className="text-xs font-medium text-muted">Technical (pass mark {t.passMark}; price weight {t.financialWeight})</div><ul className="list-disc pl-5 text-sm">{t.criteria.map((c) => <li key={c.name}>{c.name}: {c.weight}</li>)}</ul></>}
          {t.justification && <p className="mt-2 text-xs text-muted">Method justification: {t.justification}</p>}
          <div className="mt-2 text-xs text-muted">{t.documentIds.length} tender document(s){t.status === 'DRAFT' && can('tenders.manage') && <> · <label className="cursor-pointer text-brand-700 hover:underline">attach<input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && attach.mutate(e.target.files[0])} /></label></>}</div>
        </Card>
        <Card title="Committees">
          {t.openingCommittee.length ? (
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div><div className="text-xs font-medium text-muted">Opening</div>{t.openingCommittee.map((m) => <div key={m.userId}>{m.name} <span className="text-xs text-muted">{label(m.role)}</span></div>)}</div>
              <div><div className="text-xs font-medium text-muted">Evaluation</div>{t.evaluationCommittee.map((m) => <div key={m.userId}>{m.name} <span className="text-xs text-muted">{label(m.role)}</span></div>)}</div>
            </div>
          ) : <p className="text-sm text-muted">Not yet appointed by the accounting officer.</p>}
        </Card>
      </div>

      {can('tenders.award') && ['DRAFT', 'PUBLISHED', 'CLOSED'].includes(t.status) && <div className="mt-4"><Committees key={t.openingCommittee.map((m) => m.userId).join()} t={t} onDone={refresh} /></div>}

      {['PUBLISHED', 'CLOSED'].includes(t.status) && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title="Questions from bidders">
            {!t.clarifications.length && <p className="text-sm text-muted">None yet.</p>}
            {t.clarifications.map((c) => (
              <div key={c.id} className="mb-2 border-b pb-2 text-sm">
                <div>{c.question} <span className="text-xs text-muted">{c.askedBy} · {fmtDateTime(c.askedAt)}</span></div>
                {c.answer ? <div className="text-muted">Answer: {c.answer}</div> : can('tenders.manage') && <div className="mt-1 flex gap-1"><Input value={f.answer[c.id] ?? ''} onChange={(e) => setF({ ...f, answer: { ...f.answer, [c.id]: e.target.value } })} placeholder="Answer, published to everyone" /><Button onClick={() => act(`clarifications/${c.id}`, { answer: f.answer[c.id] })}>Answer</Button></div>}
              </div>
            ))}
          </Card>
          <Card title="Addenda">
            {t.addenda.map((a) => <p key={a.number} className="mb-1 text-sm">{a.number}. {a.text} <span className="text-xs text-muted">{fmtDateTime(a.at)}</span></p>)}
            {t.status === 'PUBLISHED' && can('tenders.manage') && (
              <div className="space-y-2">
                <Textarea rows={2} placeholder="Addendum text" value={f.addendum} onChange={(e) => setF({ ...f, addendum: e.target.value })} />
                <div className="flex gap-2"><Field label="New closing (optional)"><Input type="datetime-local" value={f.addClosing} onChange={(e) => setF({ ...f, addClosing: e.target.value })} /></Field><Button className="self-end" disabled={f.addendum.length < 5} onClick={() => act('addenda', { text: f.addendum, closingAt: f.addClosing ? toIso(f.addClosing) : undefined })}>Issue addendum</Button></div>
              </div>
            )}
          </Card>
        </div>
      )}

      {t.status === 'CLOSED' && t.myRoles.opening && (
        <Card title="Open the bids" className="mt-4">
          <p className="mb-2 text-sm text-muted">Tick the opening committee members present (at least three).</p>
          <div className="mb-2 flex flex-wrap gap-3">{t.openingCommittee.map((m) => <label key={m.userId} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.attendees.includes(m.userId)} onChange={(e) => setF({ ...f, attendees: e.target.checked ? [...f.attendees, m.userId] : f.attendees.filter((x) => x !== m.userId) })} /> {m.name}</label>)}</div>
          <div className="grid gap-2 sm:grid-cols-2"><Field label="Bidders' representatives present"><Input value={f.reps} onChange={(e) => setF({ ...f, reps: e.target.value })} /></Field><Field label="Minutes"><Input value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></Field></div>
          <Button className="mt-2" onClick={() => act('open', { attendees: f.attendees, bidderRepresentatives: f.reps || undefined, minutes: f.minutes || undefined })}>Open and read out</Button>
        </Card>
      )}

      {!t.sealed && (
        <Card title="Bids" className="mt-4" padded={false}>
          <table className="table-base">
            <thead><tr><th>Bidder</th><th className="num">Price</th><th>Security</th><th>Mandatory</th><th>Preliminary</th><th>Result</th>{t.status === 'OPENED' && t.myRoles.evaluation && <th>Responsive?</th>}</tr></thead>
            <tbody>
              {t.bids.filter((b) => b.status === 'SUBMITTED').map((b) => {
                const r = t.evaluation?.ranking.find((x) => x.bidId === b.id);
                const p = f.prelim[b.id] ?? { responsive: b.responsive ?? true, reason: b.nonResponsiveReason ?? '' };
                return (
                  <tr key={b.id}>
                    <td>{b.number}. {b.bidder.name}<div className="text-xs text-muted">{b.bidder.kraPin} · {b.bidder.phone}{b.bidder.agpo !== 'NONE' && ` · AGPO ${b.bidder.agpo.toLowerCase()}`}</div></td>
                    <td className="num"><Money value={b.amount} /></td>
                    <td className="text-xs">{b.bidSecurityReference}</td>
                    <td className="text-xs">{b.mandatory.map((m) => <div key={m.requirement}>{m.provided ? '✓' : '✗'} {m.requirement}</div>)}</td>
                    <td>{b.responsive === null ? '—' : b.responsive ? <Badge tone="green">responsive</Badge> : <><Badge tone="red">non-responsive</Badge><div className="text-xs text-muted">{b.nonResponsiveReason}</div></>}</td>
                    <td className="text-xs">{r ? <>{r.technical !== null && `tech ${r.technical} · `}{r.rank ? `rank ${r.rank}` : r.passed ? '' : 'failed'}</> : ''}{b.outcome !== 'PENDING' && <div><Badge value={b.outcome} /></div>}</td>
                    {t.status === 'OPENED' && t.myRoles.evaluation && (
                      <td><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={p.responsive} onChange={(e) => setF({ ...f, prelim: { ...f.prelim, [b.id]: { ...p, responsive: e.target.checked } } })} /> yes</label>{!p.responsive && <Input placeholder="Reason" value={p.reason} onChange={(e) => setF({ ...f, prelim: { ...f.prelim, [b.id]: { ...p, reason: e.target.value } } })} />}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {t.status === 'OPENED' && t.myRoles.evaluation && <div className="p-3"><Button onClick={() => act('preliminary', { results: t.bids.filter((b) => b.status === 'SUBMITTED').map((b) => { const p = f.prelim[b.id] ?? { responsive: b.responsive ?? true, reason: b.nonResponsiveReason ?? '' }; return { bidId: b.id, responsive: p.responsive, reason: p.reason || undefined }; }) })}>Save preliminary evaluation</Button></div>}
        </Card>
      )}

      {t.status === 'OPENED' && t.myRoles.evaluation && t.criteria.length > 0 && responsive.length > 0 && (
        <Card title="Your technical scores (0–100 per criterion)" className="mt-4" padded={false}>
          <table className="table-base">
            <thead><tr><th>Bid</th>{t.criteria.map((c) => <th key={c.name}>{c.name} ({c.weight})</th>)}<th /></tr></thead>
            <tbody>{responsive.map((b) => <Scoring key={b.id} t={t} bid={b} act={act} />)}</tbody>
          </table>
          <p className="p-3 text-xs text-muted">{t.scoredBy} of {t.evaluationCommittee.length} members have scored.</p>
        </Card>
      )}
      {t.status === 'OPENED' && t.myRoles.evaluation === 'CHAIR' && (
        <Card title="Complete the evaluation" className="mt-4">
          <Textarea rows={3} placeholder="Evaluation report and recommendation" value={f.report} onChange={(e) => setF({ ...f, report: e.target.value })} />
          <Button className="mt-2" disabled={f.report.length < 10} onClick={() => act('complete', { report: f.report })}>Complete and sign</Button>
        </Card>
      )}

      {t.evaluation?.completedAt && (
        <Card title="Evaluation outcome" className="mt-4">
          <p className="text-sm">Recommended: <b>{name(t.evaluation.recommendedBidId) || 'none (no bid passed)'}</b> · completed {fmtDateTime(t.evaluation.completedAt)}</p>
          <p className="mt-1 whitespace-pre-line text-sm text-muted">{t.evaluation.report}</p>
          {t.opinion?.at && <p className="mt-2 text-sm">Professional opinion ({t.opinion.concurs ? 'concurs' : 'does not concur'}): {t.opinion.text}</p>}
          {t.award?.at && <p className="mt-2 text-sm">Awarded to <b>{name(t.award.bidId)}</b> for <Money value={t.award.amount} /> on {fmtDate(t.award.at)}{t.award.reason && ` (${t.award.reason})`}. Standstill ends {fmtDate(t.award.standstillEnds)}.</p>}
        </Card>
      )}

      {t.status === 'EVALUATED' && can('tenders.opinion') && (
        <Card title="Professional opinion" className="mt-4">
          <Textarea rows={3} value={f.opinion} onChange={(e) => setF({ ...f, opinion: e.target.value })} />
          <label className="mt-1 flex items-center gap-1 text-sm"><input type="checkbox" checked={f.concurs} onChange={(e) => setF({ ...f, concurs: e.target.checked })} /> I concur with the committee&apos;s recommendation</label>
          <Button className="mt-2" disabled={f.opinion.length < 10} onClick={() => act('opinion', { text: f.opinion, concurs: f.concurs })}>Give opinion</Button>
        </Card>
      )}
      {t.status === 'RECOMMENDED' && can('tenders.award') && (
        <Card title="Award" className="mt-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Bid"><Select value={f.awardBid} onChange={(e) => setF({ ...f, awardBid: e.target.value })}><option value="">The recommended bid ({name(t.evaluation?.recommendedBidId)})</option>{t.evaluation?.ranking.filter((r) => r.passed).map((r) => <option key={r.bidId} value={r.bidId}>{name(r.bidId)} (rank {r.rank})</option>)}</Select></Field>
            <Field label="Reasons if not the recommended bid"><Input value={f.awardReason} onChange={(e) => setF({ ...f, awardReason: e.target.value })} /></Field>
          </div>
          <Button className="mt-2" onClick={() => act('award', { bidId: f.awardBid || undefined, reason: f.awardReason || undefined })}>Award and notify every bidder</Button>
        </Card>
      )}

      {['EVALUATED', 'RECOMMENDED', 'AWARDED', 'CANCELLED', 'CONTRACTED'].includes(t.status) && (
        <Card title="Requests for review (PPARB)" className="mt-4">
          {t.appeals.map((a) => (
            <div key={a.id} className="mb-2 border-b pb-2 text-sm">
              <div>{a.applicant} · filed {fmtDate(a.filedAt)} <Badge value={a.status} /></div>
              <div className="text-muted">{a.grounds}{a.decision && ` — ${a.decision}`}</div>
              {a.status === 'PENDING' && can('tenders.manage') && (
                <div className="mt-1 flex flex-wrap gap-1">
                  <Input placeholder="Board decision" value={f.decision[a.id] ?? ''} onChange={(e) => setF({ ...f, decision: { ...f.decision, [a.id]: e.target.value } })} className="max-w-xs" />
                  {(['DISMISSED', 'UPHELD', 'WITHDRAWN'] as const).map((s) => <Button key={s} variant="secondary" onClick={() => act(`appeals/${a.id}`, { status: s, decision: f.decision[a.id] || undefined })}>{label(s)}</Button>)}
                </div>
              )}
            </div>
          ))}
          {can('tenders.manage') && t.status !== 'CONTRACTED' && (
            <div className="grid gap-2 sm:grid-cols-4">
              <Input placeholder="Applicant" value={f.appellant} onChange={(e) => setF({ ...f, appellant: e.target.value })} />
              <Input type="date" value={f.filedAt} onChange={(e) => setF({ ...f, filedAt: e.target.value })} />
              <Input placeholder="Grounds" value={f.grounds} onChange={(e) => setF({ ...f, grounds: e.target.value })} />
              <Button variant="secondary" disabled={!f.appellant || !f.filedAt || f.grounds.length < 5} onClick={() => act('appeals', { applicant: f.appellant, filedAt: f.filedAt, grounds: f.grounds })}>Record request</Button>
            </div>
          )}
        </Card>
      )}

      {t.status === 'AWARDED' && can('tenders.manage') && (
        <Card title="Sign the contract" className="mt-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {(['number', 'signedAt', 'value', 'startDate', 'endDate', 'performanceSecurity'] as const).map((k) => (
              <Field key={k} label={label(k.replace(/([A-Z])/g, '_$1').toUpperCase())}><Input type={['signedAt', 'startDate', 'endDate'].includes(k) ? 'date' : 'text'} value={f.contract[k]} onChange={(e) => setF({ ...f, contract: { ...f.contract, [k]: e.target.value } })} /></Field>
            ))}
          </div>
          <Button className="mt-2" onClick={() => act('contract', f.contract)}>Record the contract</Button>
        </Card>
      )}
      {t.contract?.number && <Card title="Contract" className="mt-4"><p className="text-sm">{t.contract.number}, signed {fmtDate(t.contract.signedAt)}: <Money value={t.contract.value} />, {fmtDate(t.contract.startDate)} to {fmtDate(t.contract.endDate)}; performance security <Money value={t.contract.performanceSecurity} />.</p></Card>}

      {editing && <TenderForm tender={t} onClose={() => setEditing(false)} />}
    </>
  );
}
