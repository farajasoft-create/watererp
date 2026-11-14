'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Notice, PageHeader, Select, Tabs, Textarea } from '@/components/ui';
import { api as platformApi } from '@/lib/api';
import { useDirectory } from '@/lib/directory';
import { label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';

interface WaterSettings {
  licenceArea?: string;
  billing: { dueDays: number; penaltyPercent: string; reconnectionFee: string; disconnectionMinArrears: string; disconnectionGraceDays: number; highFactor: number; lowFactor: number; paybill?: string; billFooter?: string; sendBillSms?: boolean; emailBills?: boolean; sendReceipts?: boolean };
  mpesa?: { shortcode?: string; callbackToken?: string };
  accounts: Record<string, string>;
  mappingLabels: Record<string, string>;
  service?: { slaHours?: Record<string, number>; intakeToken?: string; portalEnabled?: boolean; autoCloseDays?: number; reminderAfterDays?: number; routing?: { category: string | null; zoneId: string | null; assignTo: string }[] };
  defaultSlaHours?: Record<string, number>;
  regulatory?: { populationInArea?: number; peoplePerConnection?: number; peoplePerKiosk?: number; staffCount?: number };
  organisationCode?: string;
}

type Tab = 'billing' | 'mpesa' | 'ledger' | 'service' | 'regulatory';

function Billing({ s }: { s: WaterSettings }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ licenceArea: s.licenceArea ?? '', billing: { ...s.billing, paybill: s.billing.paybill ?? '', billFooter: s.billing.billFooter ?? '', sendBillSms: s.billing.sendBillSms ?? false, emailBills: s.billing.emailBills ?? false, sendReceipts: s.billing.sendReceipts ?? false } });
  const b = f.billing;
  const setB = (patch: Partial<typeof b>) => setF({ ...f, billing: { ...b, ...patch } });
  const save = useMutation({ mutationFn: () => api.patch('/settings/billing', f), onSuccess: () => qc.invalidateQueries({ queryKey: ['water-settings'] }) });
  return (
    <Card title="Billing rules" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      {save.isSuccess && <Notice tone="green">Saved.</Notice>}
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <Field label="Licence area" className="sm:col-span-3"><Input value={f.licenceArea} onChange={(e) => setF({ ...f, licenceArea: e.target.value })} /></Field>
        <Field label="Days to pay"><Input inputMode="numeric" value={b.dueDays} onChange={(e) => setB({ dueDays: Number(e.target.value) || 0 })} /></Field>
        <Field label="Late payment penalty (%)" hint="Of the overdue balance, on the next bill"><Input inputMode="decimal" value={b.penaltyPercent} onChange={(e) => setB({ penaltyPercent: e.target.value })} /></Field>
        <Field label="Reconnection fee (KES)"><Input inputMode="decimal" value={b.reconnectionFee} onChange={(e) => setB({ reconnectionFee: e.target.value })} /></Field>
        <Field label="Disconnect from arrears of (KES)"><Input inputMode="decimal" value={b.disconnectionMinArrears} onChange={(e) => setB({ disconnectionMinArrears: e.target.value })} /></Field>
        <Field label="Days overdue before disconnection"><Input inputMode="numeric" value={b.disconnectionGraceDays} onChange={(e) => setB({ disconnectionGraceDays: Number(e.target.value) || 0 })} /></Field>
        <Field label="M-Pesa paybill (printed on bills)"><Input value={b.paybill} onChange={(e) => setB({ paybill: e.target.value })} /></Field>
        <Field label="High reading if above × average"><Input inputMode="decimal" value={b.highFactor} onChange={(e) => setB({ highFactor: Number(e.target.value) || 2 })} /></Field>
        <Field label="Low reading if below × average"><Input inputMode="decimal" value={b.lowFactor} onChange={(e) => setB({ lowFactor: Number(e.target.value) || 0 })} /></Field>
        <Field label="Bill footer" className="sm:col-span-3"><Textarea rows={2} value={b.billFooter} onChange={(e) => setB({ billFooter: e.target.value })} /></Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={b.sendBillSms} onChange={(e) => setB({ sendBillSms: e.target.checked })} /> Text every customer their bill when a run is approved (uses the SMS gateway in platform settings)
      </label>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={b.emailBills} onChange={(e) => setB({ emailBills: e.target.checked })} /> Email the bill to customers with an email address
      </label>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={b.sendReceipts} onChange={(e) => setB({ sendReceipts: e.target.checked })} /> Text and email a receipt for every payment
      </label>
    </Card>
  );
}

function Mpesa({ s }: { s: WaterSettings }) {
  const qc = useQueryClient();
  const [shortcode, setShortcode] = useState(s.mpesa?.shortcode ?? '');
  const save = useMutation({ mutationFn: (rotateToken: boolean) => api.patch('/settings/mpesa', { shortcode: shortcode || undefined, rotateToken }), onSuccess: () => qc.invalidateQueries({ queryKey: ['water-settings'] }) });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const token = s.mpesa?.callbackToken;
  return (
    <Card title="M-Pesa paybill (Daraja C2B)" actions={<Button onClick={() => save.mutate(false)} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <Field label="Paybill / shortcode"><Input value={shortcode} onChange={(e) => setShortcode(e.target.value)} className="max-w-xs" /></Field>
      {token ? (
        <div className="mt-3 space-y-2 text-sm">
          <p>Register these URLs for the shortcode with Safaricom (Daraja → C2B → Register URL, response type <b>Completed</b>):</p>
          <Field label="Validation URL"><Input readOnly value={`${origin}/api/v1/water/mpesa/c2b/${token}/validation`} onFocus={(e) => e.target.select()} /></Field>
          <Field label="Confirmation URL"><Input readOnly value={`${origin}/api/v1/water/mpesa/c2b/${token}/confirmation`} onFocus={(e) => e.target.select()} /></Field>
          <p className="text-muted">Payments whose account number matches a customer post automatically. The rest wait under Payments → Unmatched for a cashier to allocate.</p>
          <Button variant="secondary" onClick={() => save.mutate(true)}>Issue new URLs (old ones stop working)</Button>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">Save the shortcode to generate the callback URLs.</p>
      )}
    </Card>
  );
}

/** Who new tickets go to, by category and zone; the most specific rule wins. */
function Routing({ s }: { s: WaterSettings }) {
  const qc = useQueryClient();
  const staff = useDirectory('water');
  const zones = useQuery({ queryKey: ['water-zones'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/zones') });
  const [rules, setRules] = useState((s.service?.routing ?? []).map((r) => ({ category: r.category ?? '', zoneId: r.zoneId ?? '', assignTo: r.assignTo })));
  const defaults = s.defaultSlaHours ?? {};
  const save = useMutation({
    mutationFn: () => api.patch('/settings/service', { slaHours: s.service?.slaHours ?? {}, portalEnabled: s.service?.portalEnabled ?? true, autoCloseDays: s.service?.autoCloseDays ?? 7, reminderAfterDays: s.service?.reminderAfterDays ?? 14, routing: rules.filter((r) => r.assignTo).map((r) => ({ category: r.category || null, zoneId: r.zoneId || null, assignTo: r.assignTo })) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['water-settings'] }),
  });
  const set = (i: number, k: 'category' | 'zoneId' | 'assignTo', v: string) => setRules(rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Card title="Ticket routing" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <p className="mb-3 text-sm text-muted">New tickets go straight to an officer: a rule for the category and zone wins, then one for the category, then one for the zone. Anything else waits for a supervisor to assign it.</p>
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Select value={r.category} onChange={(e) => set(i, 'category', e.target.value)}><option value="">Any category</option>{Object.keys(defaults).map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select>
            <Select value={r.zoneId} onChange={(e) => set(i, 'zoneId', e.target.value)}><option value="">Any zone</option>{zones.data?.map((z) => <option key={z.id} value={z.id}>{z.code} · {z.name}</option>)}</Select>
            <Select value={r.assignTo} onChange={(e) => set(i, 'assignTo', e.target.value)}><option value="">Send to…</option>{staff.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            <Button variant="secondary" onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label="Remove rule">✕</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setRules([...rules, { category: '', zoneId: '', assignTo: '' }])}>Add a rule</Button>
      </div>
    </Card>
  );
}

function Service({ s }: { s: WaterSettings }) {
  const qc = useQueryClient();
  const defaults = s.defaultSlaHours ?? {};
  const [hours, setHours] = useState<Record<string, string>>(Object.fromEntries(Object.keys(defaults).map((k) => [k, String(s.service?.slaHours?.[k] ?? defaults[k])])));
  const [f, setF] = useState({ portalEnabled: s.service?.portalEnabled ?? true, autoCloseDays: String(s.service?.autoCloseDays ?? 7), reminderAfterDays: String(s.service?.reminderAfterDays ?? 14) });
  const save = useMutation({
    mutationFn: () => api.patch('/settings/service', { slaHours: Object.fromEntries(Object.entries(hours).map(([k, v]) => [k, Number(v)])), portalEnabled: f.portalEnabled, autoCloseDays: Number(f.autoCloseDays), reminderAfterDays: Number(f.reminderAfterDays) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['water-settings'] }),
  });
  const rotate = useMutation({ mutationFn: () => api.post('/settings/intake-token'), onSuccess: () => qc.invalidateQueries({ queryKey: ['water-settings'] }) });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const token = s.service?.intakeToken;
  return (
    <div className="space-y-4">
      <Card title="Resolution targets and the portal" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
        <ErrorBox error={save.error} />
        <p className="mb-3 text-sm text-muted">Hours to resolve each kind of complaint. Urgent tickets get half the time and emergencies a quarter; a ticket past its deadline is escalated.</p>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Object.keys(defaults).map((k) => (
            <Field key={k} label={label(k)}>
              <Input type="number" min={1} value={hours[k]} onChange={(e) => setHours({ ...hours, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Close resolved tickets after (days without reply)"><Input type="number" min={1} value={f.autoCloseDays} onChange={(e) => setF({ ...f, autoCloseDays: e.target.value })} /></Field>
          <Field label="Open a reminder case after (days overdue)"><Input type="number" min={1} value={f.reminderAfterDays} onChange={(e) => setF({ ...f, reminderAfterDays: e.target.value })} /></Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.portalEnabled} onChange={(e) => setF({ ...f, portalEnabled: e.target.checked })} /> Customer self-service portal on</label>
        {f.portalEnabled && s.organisationCode && (
          <p className="mt-1 text-sm">Customers sign in at <a className="text-brand-700 hover:underline" href={`/portal/${s.organisationCode}`} target="_blank" rel="noreferrer">{origin}/portal/{s.organisationCode}</a> with their account number and a code texted to their phone.</p>
        )}
      </Card>
      <Routing s={s} />
      <Card title="Call centre, SMS shortcode, email and USSD" actions={<Button variant="secondary" onClick={() => rotate.mutate()} disabled={rotate.isPending}>{token ? 'Issue new addresses' : 'Create addresses'}</Button>}>
        <ErrorBox error={rotate.error} />
        {token ? (
          <div className="space-y-2 text-sm">
            <Field label="Call centre system (POST JSON: externalRef, category, subject, phone, accountNo…)"><Input readOnly value={`${origin}/api/v1/water/intake/${token}/call-centre`} onFocus={(e) => e.target.select()} /></Field>
            <Field label="Africa's Talking incoming SMS callback"><Input readOnly value={`${origin}/api/v1/water/intake/${token}/sms`} onFocus={(e) => e.target.select()} /></Field>
            <Field label="Africa's Talking USSD callback"><Input readOnly value={`${origin}/api/v1/water/intake/${token}/ussd`} onFocus={(e) => e.target.select()} /></Field>
            <Field label="Inbound email webhook (SendGrid Inbound Parse, Mailgun route, or JSON from/subject/text)"><Input readOnly value={`${origin}/api/v1/water/intake/${token}/email`} onFocus={(e) => e.target.select()} /></Field>
            <p className="text-muted">Customers text BAL for their balance; any other text becomes a ticket. Emails to the complaints address become tickets, matched to the customer by sender or account number. The category of a text or email is guessed from its words. The USSD menu gives the balance, the last bill, problem reporting and current notices. Issuing new addresses stops the old ones.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">Create the addresses to connect a call centre, an SMS shortcode or a USSD code.</p>
        )}
      </Card>
    </div>
  );
}

function Regulatory({ s }: { s: WaterSettings }) {
  const qc = useQueryClient();
  const r = s.regulatory ?? {};
  const [f, setF] = useState({ populationInArea: r.populationInArea ? String(r.populationInArea) : '', peoplePerConnection: String(r.peoplePerConnection ?? 5), peoplePerKiosk: String(r.peoplePerKiosk ?? 300), staffCount: r.staffCount ? String(r.staffCount) : '' });
  const save = useMutation({
    mutationFn: () => api.patch('/settings/regulatory', { populationInArea: f.populationInArea ? Number(f.populationInArea) : null, peoplePerConnection: Number(f.peoplePerConnection), peoplePerKiosk: Number(f.peoplePerKiosk), staffCount: f.staffCount ? Number(f.staffCount) : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['water-settings'] }),
  });
  return (
    <Card title="Figures for the WASREB indicators" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
      <ErrorBox error={save.error} />
      <p className="mb-3 text-sm text-muted">Everything else in the indicators is counted from the system. These few come from outside it.</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Population of the licence area"><Input inputMode="numeric" value={f.populationInArea} onChange={(e) => setF({ ...f, populationInArea: e.target.value })} /></Field>
        <Field label="People per domestic connection"><Input inputMode="decimal" value={f.peoplePerConnection} onChange={(e) => setF({ ...f, peoplePerConnection: e.target.value })} /></Field>
        <Field label="People served per kiosk"><Input inputMode="numeric" value={f.peoplePerKiosk} onChange={(e) => setF({ ...f, peoplePerKiosk: e.target.value })} /></Field>
        <Field label="Number of staff"><Input inputMode="numeric" value={f.staffCount} onChange={(e) => setF({ ...f, staffCount: e.target.value })} /></Field>
      </div>
    </Card>
  );
}

function Ledger({ s }: { s: WaterSettings }) {
  const qc = useQueryClient();
  const canPlatform = useCan()('core.settings.manage');
  const [accounts, setAccounts] = useState<Record<string, string>>({ ...(s.accounts ?? {}) });
  const ledgerAccounts = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => platformApi.get<{ id: string; code: string; name: string }[]>('/ledger/accounts') });
  const save = useMutation({ mutationFn: () => api.patch('/settings/accounts', { accounts }), onSuccess: () => qc.invalidateQueries({ queryKey: ['water-settings'] }) });
  const status = useQuery({ queryKey: ['water-accounting-status'], queryFn: () => api.get<{ billRuns: Record<string, number>; payments: Record<string, number>; adjustments: Record<string, number> }>('/accounting/status') });
  const retry = useMutation({ mutationFn: () => api.post<{ sent: number; failed: number; skipped: number }>('/accounting/retry'), onSuccess: () => status.refetch() });
  const options = ledgerAccounts.data ?? [];

  return (
    <div className="space-y-4">
      <Card title="Ledger accounts for water" actions={<Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}>
        <p className="mb-3 text-sm text-muted">
          Approved billing runs, payments, reversals and adjustments post to these accounts in the platform ledger. The ledger connection itself is shared by every module and set
          {canPlatform ? <> under <Link href="/settings" className="text-brand-700 hover:underline">Settings → Ledger</Link></> : ' by an administrator'}.
        </p>
        <ErrorBox error={save.error || ledgerAccounts.error} />
        {save.isSuccess && <Notice tone="green">Saved.</Notice>}
        {ledgerAccounts.isSuccess && !options.length && <Notice tone="amber">The ledger is not connected yet, so there are no accounts to choose from.</Notice>}
        <div className="mt-1 grid gap-3 sm:grid-cols-2">
          {Object.entries(s.mappingLabels).map(([key, text]) => (
            <Field key={key} label={text}>
              <Select value={accounts[key] ?? ''} onChange={(e) => setAccounts({ ...accounts, [key]: e.target.value })}>
                <option value="">{options.length ? 'Select…' : accounts[key] ? 'Mapped (connect to view)' : 'Connect the ledger first'}</option>
                {options.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
              </Select>
            </Field>
          ))}
        </div>
      </Card>
      <Card title="Ledger sync" actions={<Button variant="secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>Send everything outstanding</Button>}>
        <ErrorBox error={retry.error} />
        {retry.data && <Notice tone="green">Sent {retry.data.sent}, failed {retry.data.failed}, skipped {retry.data.skipped}.</Notice>}
        {status.data && (
          <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
            {(['billRuns', 'payments', 'adjustments'] as const).map((k) => (
              <div key={k}>
                <div className="mb-1 font-medium">{k === 'billRuns' ? 'Billing runs' : k === 'payments' ? 'Payments' : 'Adjustments'}</div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(status.data[k]).map(([st, n]) => <Badge key={st} value={st}>{st.toLowerCase().replace('_', ' ')}: {n}</Badge>)}
                  {!Object.keys(status.data[k]).length && <span className="text-muted">none</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function WaterSettingsPage() {
  const [tab, setTab] = useState<Tab>('billing');
  const { data, error, isLoading } = useQuery({ queryKey: ['water-settings'], queryFn: () => api.get<WaterSettings>('/settings') });
  return (
    <>
      <PageHeader title="Water settings" subtitle="Billing rules, the M-Pesa paybill and ledger accounts" />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'billing', label: 'Billing rules' },
          { id: 'mpesa', label: 'M-Pesa' },
          { id: 'ledger', label: 'Ledger accounts' },
          { id: 'service', label: 'Customer service' },
          { id: 'regulatory', label: 'WASREB figures' },
        ]}
      />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <>
          {tab === 'billing' && <Billing s={data} />}
          {tab === 'mpesa' && <Mpesa s={data} />}
          {tab === 'ledger' && <Ledger s={data} />}
          {tab === 'service' && <Service s={data} />}
          {tab === 'regulatory' && <Regulatory s={data} />}
        </>
      )}
    </>
  );
}
