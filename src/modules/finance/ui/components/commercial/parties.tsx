'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { KIND_LABEL, OpenItems, Party, SALES, SideConfig } from '@/modules/finance/ui/lib/commercial';
import { useParties, useTaxCodes } from '@/modules/finance/ui/lib/commercial-hooks';
import { addAll, compare, formatAmount, formatDate, isZero, startOfYear, today } from '@/modules/finance/ui/lib/format';
import { useAccounts, useCurrencies, usePrecision, useSession } from '@/modules/finance/ui/lib/session';
import { downloadCsv } from '../report-filters';
import { Badge, Button, Card, Checkbox, cx, Empty, ErrorBanner, Field, Input, LinkButton, Loading, Modal, Notice, PageHeader, Select, StatusBadge, TableWrap, Tabs, Textarea } from '../ui';
import { AccountOptions } from './shared';
import { AttachmentsCard } from '../attachments';
import { PortalLinksCard } from '../getting-paid';
import { SupplierProfile, SupplierStatusBadge, type SupplierParty } from './supplier-management';

type PartyForm = Omit<Party, 'id' | 'outstanding' | 'overdue' | 'unappliedCredits' | 'creditLimit'> & { creditLimit: string };

const blank = (currency: string): PartyForm => ({
  code: '',
  name: '',
  legalName: '',
  email: '',
  phone: '',
  address: '',
  city: '',
  country: '',
  taxId: '',
  currency,
  paymentTermsDays: 30,
  defaultAccountId: null,
  defaultTaxCodeId: null,
  creditLimit: '',
  onHold: false,
  bankName: '',
  bankAccountName: '',
  bankAccountNumber: '',
  bankBranch: '',
  withholdingTaxCodeId: null,
  withholdingTaxCodeIds: [],
  mpesaPayee: null,
  intercompanyEntityId: null,
  notes: '',
  isActive: true,
});

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

function PartyEditor({ side, party, onClose }: { side: SideConfig; party: Party | null | 'new'; onClose: () => void }) {
  const { entity } = useSession();
  const queryClient = useQueryClient();
  const { data: currencies = [] } = useCurrencies();
  const { data: accounts = [] } = useAccounts();
  const { data: taxCodes = [] } = useTaxCodes();
  const { entities } = useSession();
  const existing = party && party !== 'new' ? party : null;
  const [form, setForm] = useState<PartyForm>(() => (existing ? { ...existing, creditLimit: existing.creditLimit ?? '' } : blank(entity!.functionalCurrency)));
  const [error, setError] = useState<string | null>(null);
  const customer = side === SALES;
  const set = (patch: Partial<PartyForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...form,
        creditLimit: customer && form.creditLimit ? form.creditLimit : null,
        withholdingTaxCodeId: customer ? null : form.withholdingTaxCodeId || null,
        withholdingTaxCodeIds: customer ? (form.withholdingTaxCodeIds ?? []) : [],
        mpesaPayee: customer ? null : (form.mpesaPayee ?? null),
        defaultAccountId: form.defaultAccountId || null,
        defaultTaxCodeId: form.defaultTaxCodeId || null,
        intercompanyEntityId: form.intercompanyEntityId || null,
        onHold: customer ? form.onHold : false,
      };
      return existing ? api.patch(`${side.partyType === 'CUSTOMER' ? '/customers' : '/suppliers'}/${existing.id}`, body) : api.post(side.partyType === 'CUSTOMER' ? '/customers' : '/suppliers', body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parties'] });
      queryClient.invalidateQueries({ queryKey: ['party'] });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <Modal
      wide
      open={!!party}
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : `New ${side.party.toLowerCase()}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => (setError(null), save.mutate())}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code">
            <Input value={form.code} maxLength={20} onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Name" className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Currency" hint={existing ? 'Fixed once documents exist' : 'All documents for this party use it'}>
            <Select value={form.currency} onChange={(e) => set({ currency: e.target.value })}>
              {currencies.filter((c) => c.isActive || c.code === form.currency).map((c) => (
                <option key={c.code}>{c.code}</option>
              ))}
            </Select>
          </Field>
          <Field label="Payment terms (days)">
            <Input type="number" min={0} max={365} value={form.paymentTermsDays} onChange={(e) => set({ paymentTermsDays: Number(e.target.value) })} />
          </Field>
          <Field label="Tax ID / PIN">
            <Input value={form.taxId} onChange={(e) => set({ taxId: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field label="City / country">
            <div className="flex gap-2">
              <Input value={form.city} onChange={(e) => set({ city: e.target.value })} aria-label="City" />
              <Input value={form.country} onChange={(e) => set({ country: e.target.value })} aria-label="Country" />
            </div>
          </Field>
          <Field label="Address" className="sm:col-span-3">
            <Input value={form.address} onChange={(e) => set({ address: e.target.value })} />
          </Field>
          <Field label={customer ? 'Default revenue account' : 'Default expense account'}>
            <Select value={form.defaultAccountId ?? ''} onChange={(e) => set({ defaultAccountId: e.target.value || null })}>
              <AccountOptions accounts={accounts} classes={side.accountClasses} placeholder="None" />
            </Select>
          </Field>
          <Field label="Default tax code">
            <Select value={form.defaultTaxCodeId ?? ''} onChange={(e) => set({ defaultTaxCodeId: e.target.value || null })}>
              <option value="">None</option>
              {taxCodes.filter((t) => t.kind === 'VAT').map((t) => (
                <option key={t.id} value={t.id}>{t.code} · {t.name}</option>
              ))}
            </Select>
          </Field>
          {customer ? (
            <>
              <Field label={`Credit limit (${form.currency})`} hint="Blank for no limit">
                <Input inputMode="decimal" value={form.creditLimit} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && set({ creditLimit: e.target.value })} />
              </Field>
              {!!taxCodes.filter((t) => t.kind === 'WITHHOLDING' && t.isActive && (!t.country || t.country.toLowerCase() === (entity?.country ?? '').toLowerCase())).length && (
                <Field label="Taxes this customer withholds" hint="Withholding agents (government, large companies) deduct these from payments; they are suggested on receipts" className="sm:col-span-3">
                  <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1">
                    {taxCodes
                      .filter((t) => t.kind === 'WITHHOLDING' && t.isActive && (!t.country || t.country.toLowerCase() === (entity?.country ?? '').toLowerCase()))
                      .map((t) => (
                        <Checkbox
                          key={t.id}
                          label={`${t.code} · ${t.name}`}
                          checked={(form.withholdingTaxCodeIds ?? []).includes(t.id)}
                          onChange={(on) => set({ withholdingTaxCodeIds: on ? [...(form.withholdingTaxCodeIds ?? []), t.id] : (form.withholdingTaxCodeIds ?? []).filter((x) => x !== t.id) })}
                        />
                      ))}
                  </div>
                </Field>
              )}
            </>
          ) : (
            <Field label="Withholding tax on payments">
              <Select value={form.withholdingTaxCodeId ?? ''} onChange={(e) => set({ withholdingTaxCodeId: e.target.value || null })}>
                <option value="">None</option>
                {taxCodes.filter((t) => t.kind === 'WITHHOLDING').map((t) => (
                  <option key={t.id} value={t.id}>{t.code} · {t.name}</option>
                ))}
              </Select>
            </Field>
          )}
          {!customer && (
            <>
              <Field label="Bank">
                <Input value={form.bankName} onChange={(e) => set({ bankName: e.target.value })} />
              </Field>
              <Field label="Account name">
                <Input value={form.bankAccountName} onChange={(e) => set({ bankAccountName: e.target.value })} />
              </Field>
              <Field label="Account number">
                <Input value={form.bankAccountNumber} onChange={(e) => set({ bankAccountNumber: e.target.value })} />
              </Field>
              <Field label="M-Pesa payments to">
                <Select
                  value={form.mpesaPayee?.type ?? ''}
                  onChange={(e) => set({ mpesaPayee: e.target.value ? { type: e.target.value as 'PHONE' | 'PAYBILL' | 'TILL', number: form.mpesaPayee?.number ?? '', accountReference: form.mpesaPayee?.accountReference ?? '' } : null })}
                >
                  <option value="">Not paid by M-Pesa</option>
                  <option value="PHONE">Phone number</option>
                  <option value="PAYBILL">Paybill</option>
                  <option value="TILL">Buy Goods till</option>
                </Select>
              </Field>
              {form.mpesaPayee && (
                <Field label={form.mpesaPayee.type === 'PHONE' ? 'Safaricom number' : form.mpesaPayee.type === 'TILL' ? 'Till number' : 'Paybill number'}>
                  <Input inputMode="tel" value={form.mpesaPayee.number} onChange={(e) => set({ mpesaPayee: { ...form.mpesaPayee!, number: e.target.value } })} />
                </Field>
              )}
              {form.mpesaPayee?.type === 'PAYBILL' && (
                <Field label="Account number at the paybill">
                  <Input maxLength={13} value={form.mpesaPayee.accountReference} onChange={(e) => set({ mpesaPayee: { ...form.mpesaPayee!, accountReference: e.target.value } })} />
                </Field>
              )}
            </>
          )}
          <Field label="Intercompany" hint="Link to a group entity so balances are eliminated on consolidation">
            <Select value={form.intercompanyEntityId ?? ''} onChange={(e) => set({ intercompanyEntityId: e.target.value || null })}>
              <option value="">Not intercompany</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} · {e.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Notes" className="sm:col-span-3">
            <Textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
        <div className="flex gap-6">
          {customer && <Checkbox label="On credit hold" checked={form.onHold} onChange={(v) => set({ onHold: v })} />}
          {existing && <Checkbox label="Active" checked={form.isActive} onChange={(v) => set({ isActive: v })} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function PartyList({ side }: { side: SideConfig }) {
  const router = useRouter();
  const { entity, can } = useSession();
  const precision = usePrecision();
  const { data: parties = [], isLoading, error } = useParties(side.partyType, entity?.id);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Party | null | 'new'>(null);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? parties.filter((p) => [p.code, p.name, p.email, p.taxId].some((v) => v?.toLowerCase().includes(q))) : parties;
  }, [parties, search]);

  return (
    <>
      <PageHeader
        title={side.parties}
        description={`Balances are shown in each ${side.party.toLowerCase()}'s own currency for ${entity?.code}.`}
        actions={can(side.perms.manage) && <Button variant="primary" onClick={() => setEditing('new')}>New {side.party.toLowerCase()}</Button>}
      />
      <Input className="mb-3 max-w-md" placeholder="Search code, name, email or tax ID" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ErrorBanner error={error} className="mb-3" />
      <TableWrap>
        {isLoading ? (
          <Loading />
        ) : !filtered.length ? (
          <Empty title={`No ${side.parties.toLowerCase()} yet`} />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Contact</th>
                <th>Terms</th>
                <th className="num">Outstanding</th>
                <th className="num">Overdue</th>
                <th>Currency</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const dp = precision(p.currency);
                return (
                  <tr key={p.id} className={cx('cursor-pointer', !p.isActive && 'opacity-50')} onClick={() => router.push(`${side.partiesPath}/${p.id}`)}>
                    <td className="whitespace-nowrap font-mono text-xs">{p.code}</td>
                    <td className="font-medium">
                      {p.name} {p.onHold && <Badge tone="red">On hold</Badge>} {side !== SALES && <SupplierStatusBadge status={(p as SupplierParty).status} />} {!p.isActive && <Badge>Inactive</Badge>}
                    </td>
                    <td className="text-muted">{p.email || p.phone}</td>
                    <td className="text-muted">{p.paymentTermsDays} days</td>
                    <td className="num">{formatAmount(p.outstanding, dp, { parens: true, blankZero: true })}</td>
                    <td className={cx('num', !isZero(p.overdue) && 'font-medium text-red-700')}>{formatAmount(p.overdue, dp, { blankZero: true })}</td>
                    <td className="text-xs text-muted">{p.currency}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>
      {editing && <PartyEditor side={side} party={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail: statement, open items and applying credits
// ---------------------------------------------------------------------------------------------

interface Statement {
  currency: string;
  openingBalance: string;
  closingBalance: string;
  lines: { date: string; type: string; number: string; id: string; reference: string; dueDate?: string; charge: string; credit: string; balance: string; link: 'invoices' | 'payments' }[];
  aging: Record<'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'over90' | 'credits', string> | null;
}

export function PartyDetail({ side, id }: { side: SideConfig; id: string }) {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const [tab, setTab] = useState<'statement' | 'open' | 'details' | 'profile'>('statement');
  const [editing, setEditing] = useState<Party | null>(null);
  const [range, setRange] = useState({ from: startOfYear(), to: today() });
  const path = side.partyType === 'CUSTOMER' ? '/customers' : '/suppliers';
  const { data: party, isLoading, error } = useQuery({ queryKey: ['party', id], queryFn: () => api.get<Party>(`${path}/${id}`) });
  const statement = useQuery({
    queryKey: ['statement', id, entity?.id, range],
    queryFn: () => api.get<Statement>('/reports/statement', { entityId: entity!.id, partyType: side.partyType, partyId: id, ...range }),
    enabled: !!entity && can('reports.view'),
  });

  if (isLoading) return <Loading />;
  if (!party) return <ErrorBanner error={error ?? 'Not found'} />;
  const dp = precision(party.currency);
  const s = statement.data;
  const docsPath = side.documentsPath;

  return (
    <>
      <PageHeader
        title={party.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono">{party.code}</span> · {party.currency} · {party.paymentTermsDays}-day terms
            {party.onHold && <Badge tone="red">On credit hold</Badge>}
            {side !== SALES && <SupplierStatusBadge status={(party as SupplierParty).status} />}
            {!party.isActive && <Badge>Inactive</Badge>}
          </span>
        }
        actions={
          can(side.perms.manage) && (
            <>
              <Button onClick={() => setEditing(party)}>Edit</Button>
              <LinkButton href={`${side.paymentsPath}/new?party=${party.id}`}>New {side.payment.toLowerCase()}</LinkButton>
              <LinkButton variant="primary" href={`${docsPath}/new?party=${party.id}`}>
                New {KIND_LABEL[side.documentKind].toLowerCase()}
              </LinkButton>
            </>
          )
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {[
          ['Outstanding', party.outstanding],
          ['Overdue', party.overdue],
          ['Unapplied credits', party.unappliedCredits],
          [side === SALES ? 'Credit limit' : 'Withholding', side === SALES ? party.creditLimit : null],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-white p-3 shadow-xs">
            <p className="text-xs text-muted">{label}</p>
            <p className={cx('mt-0.5 text-lg font-semibold tabular-nums', label === 'Overdue' && value && !isZero(value) && 'text-red-700')}>
              {value === null ? (side === SALES ? 'No limit' : party.withholdingTaxCodeId ? 'Applies' : 'None') : formatAmount(value, dp, { parens: true })}
            </p>
          </div>
        ))}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'statement', label: 'Statement' },
          { id: 'open', label: 'Open items & credits' },
          { id: 'details', label: 'Details' },
          ...(side === SALES ? [] : [{ id: 'profile' as const, label: 'Profile & compliance' }]),
        ]}
      />

      {tab === 'statement' && (
        <div className="space-y-3">
          <div className="no-print flex flex-wrap items-end gap-2">
            <Field label="From">
              <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </Field>
            <Field label="To">
              <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </Field>
            <Button onClick={() => window.print()}>Print</Button>
            {s && (
              <Button
                onClick={() =>
                  downloadCsv(`statement-${party.code}-${range.to}.csv`, ['Date', 'Type', 'Number', 'Reference', 'Charges', 'Credits', 'Balance'], s.lines.map((l) => [l.date.slice(0, 10), l.type, l.number, l.reference, l.charge, l.credit, l.balance]))
                }
              >
                Export CSV
              </Button>
            )}
          </div>
          <ErrorBanner error={statement.error} />
          <TableWrap>
            {!s ? (
              <Loading />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Number</th>
                    <th>Reference</th>
                    <th className="num">{side === SALES ? 'Charges' : 'Billed'}</th>
                    <th className="num">{side === SALES ? 'Payments & credits' : 'Paid & credited'}</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-gray-50">
                    <td colSpan={6} className="font-medium">Opening balance</td>
                    <td className="num font-medium">{formatAmount(s.openingBalance, dp, { parens: true })}</td>
                  </tr>
                  {s.lines.map((l, i) => (
                    <tr key={`${l.id}-${i}`}>
                      <td className="whitespace-nowrap">{formatDate(l.date)}</td>
                      <td>{l.type}</td>
                      <td className="whitespace-nowrap font-mono text-xs">
                        <Link className="text-brand-700 hover:underline" href={l.link === 'invoices' ? `${docsPath}/${l.id}` : `${side.paymentsPath}/${l.id}`}>{l.number}</Link>
                      </td>
                      <td className="text-muted">{l.reference}</td>
                      <td className="num">{formatAmount(l.charge, dp, { blankZero: true })}</td>
                      <td className="num">{formatAmount(l.credit, dp, { blankZero: true })}</td>
                      <td className="num">{formatAmount(l.balance, dp, { parens: true })}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={6}>Closing balance {s.currency}</td>
                    <td className="num">{formatAmount(s.closingBalance, dp, { parens: true })}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </TableWrap>
          {s?.aging && (
            <div className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
              {(
                [
                  ['Current', 'current'],
                  ['1–30 days', 'days1to30'],
                  ['31–60 days', 'days31to60'],
                  ['61–90 days', 'days61to90'],
                  ['Over 90', 'over90'],
                  ['Credits', 'credits'],
                ] as const
              ).map(([label, key]) => (
                <div key={key} className="rounded-md border border-line bg-white p-2">
                  <p className="text-xs text-muted">{label}</p>
                  <p className="font-medium tabular-nums">{formatAmount(s.aging![key], dp)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'open' && <ApplyCredits side={side} party={party} />}

      {tab === 'profile' && side !== SALES && <SupplierProfile party={party as SupplierParty} />}

      {tab === 'details' && (
        <Card>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            {[
              ['Legal name', party.legalName],
              ['Tax ID / PIN', party.taxId],
              ['Email', party.email],
              ['Phone', party.phone],
              ['Address', [party.address, party.city, party.country].filter(Boolean).join(', ')],
              ...(side === SALES ? [] : [['Bank', [party.bankName, party.bankAccountName, party.bankAccountNumber].filter(Boolean).join(' · ')]]),
              ['Notes', party.notes],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="mt-0.5">{v || '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
      {side === SALES ? <PortalLinksCard customerId={id} /> : <PortalLinksCard supplierId={id} />}
      <AttachmentsCard recordType={side.partyType === 'CUSTOMER' ? 'Customer' : 'Supplier'} recordId={id} />
      {editing && <PartyEditor side={side} party={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** Applies a payment on account or a credit note to one or more open documents. */
function ApplyCredits({ side, party }: { side: SideConfig; party: Party }) {
  const { entity, can } = useSession();
  const precision = usePrecision();
  const queryClient = useQueryClient();
  const dp = precision(party.currency);
  const [creditKey, setCreditKey] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['open-items', side.partyType, party.id, entity!.id],
    queryFn: () => api.get<OpenItems>('/allocations/open-items', { partyType: side.partyType, partyId: party.id, entityId: entity!.id }),
  });
  const credit = data?.credits.find((c) => `${c.type}:${c.id}` === creditKey);
  const applied = addAll(Object.values(alloc));
  const tooMuch = !!credit && compare(applied, credit.available) > 0;

  const apply = useMutation({
    mutationFn: () =>
      api.post('/allocations', {
        partyType: side.partyType,
        partyId: party.id,
        date,
        items: Object.entries(alloc)
          .filter(([, a]) => a && !isZero(a))
          .map(([documentId, amount]) => ({ documentId, sourceType: credit!.type, sourceId: credit!.id, amount })),
      }),
    onSuccess: () => {
      setDone(`Applied ${formatAmount(applied, dp)} ${party.currency} from ${credit!.number}.`);
      setAlloc({});
      setCreditKey('');
      setError(null);
      for (const key of [['open-items'], ['party'], ['parties'], ['statement'], ['documents']]) queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  if (isLoading || !data) return <Loading />;
  return (
    <div className="space-y-4">
      <ErrorBanner error={error} />
      {done && <Notice tone="green">{done}</Notice>}
      <Card title="Unapplied credits" padded={false}>
        {!data.credits.length ? (
          <p className="px-4 py-4 text-sm text-muted">No payments on account or open credit notes.</p>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-8" />
                <th>Number</th>
                <th>Type</th>
                <th>Date</th>
                <th className="num">Available</th>
              </tr>
            </thead>
            <tbody>
              {data.credits.map((c) => (
                <tr key={c.id}>
                  <td>
                    <input type="radio" name="credit" className="accent-brand-600" disabled={!can(side.perms.manage)} checked={creditKey === `${c.type}:${c.id}`} onChange={() => setCreditKey(`${c.type}:${c.id}`)} aria-label={`Apply ${c.number}`} />
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    <Link className="text-brand-700 hover:underline" href={c.type === 'PAYMENT' ? `${side.paymentsPath}/${c.id}` : `${side.documentsPath}/${c.id}`}>{c.number}</Link>
                  </td>
                  <td>{c.type === 'PAYMENT' ? `${side.payment} on account` : 'Credit note'}</td>
                  <td>{formatDate(c.date)}</td>
                  <td className="num">{formatAmount(c.available, dp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={`Open ${side === SALES ? 'invoices' : 'bills'}`} padded={false}>
        {!data.documents.length ? (
          <p className="px-4 py-4 text-sm text-muted">Nothing outstanding.</p>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Due</th>
                <th>Status</th>
                <th className="num">Outstanding</th>
                {credit && <th className="num w-40">Apply</th>}
              </tr>
            </thead>
            <tbody>
              {data.documents.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap font-mono text-xs">
                    <Link className="text-brand-700 hover:underline" href={`${side.documentsPath}/${d.id}`}>{d.number}</Link>
                  </td>
                  <td>{formatDate(d.date)}</td>
                  <td className={cx(d.dueDate.slice(0, 10) < today() && 'text-red-700')}>{formatDate(d.dueDate)}</td>
                  <td><StatusBadge status={d.paymentStatus} /></td>
                  <td className="num">{formatAmount(d.amountDue, dp)}</td>
                  {credit && (
                    <td>
                      <Input className="h-8 text-right text-xs" inputMode="decimal" value={alloc[d.id] ?? ''} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setAlloc((a) => ({ ...a, [d.id]: e.target.value }))} aria-label={`Apply to ${d.number}`} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {credit && (
          <div className="flex flex-wrap items-end justify-end gap-3 border-t border-line px-4 py-3">
            <span className={cx('text-sm', tooMuch && 'text-red-700')}>
              Applying {formatAmount(applied, dp)} of {formatAmount(credit.available, dp)} available
            </span>
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Button variant="primary" disabled={tooMuch || isZero(applied)} loading={apply.isPending} onClick={() => apply.mutate()}>
              Apply credit
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
