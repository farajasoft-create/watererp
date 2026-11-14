'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Checkbox, Empty, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, TableWrap, Tabs, Textarea } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useBranches, useCurrencies, useDimensions, useSession } from '@/modules/finance/ui/lib/session';
import type { Branch, Dimension, DimensionType, Entity } from '@/modules/finance/ui/lib/types';

type Tab = 'entities' | 'branches' | 'dimensions';
const DIM_LABELS: Record<DimensionType, string> = { DEPARTMENT: 'Department', COST_CENTRE: 'Cost centre', PROJECT: 'Project', FUND: 'Fund / grant' };

type Editing =
  | { kind: 'entity'; id?: string; form: Partial<Entity> }
  | { kind: 'branch'; id?: string; form: Partial<Branch> }
  | { kind: 'dimension'; id?: string; form: Partial<Dimension> };

export default function StructurePage() {
  const { entities, can, entity: current } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('branches');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: branches = [], isLoading: loadingBranches } = useBranches();
  const { data: dimensions = [], isLoading: loadingDims } = useDimensions();
  const { data: currencies = [] } = useCurrencies();
  const manage = can('structure.manage');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ id: string; name: string; isActive: boolean }[]>('/users'), enabled: can('users.manage') });

  const save = useMutation({
    mutationFn: (e: Editing) => {
      const path = { entity: '/entities', branch: '/branches', dimension: '/dimensions' }[e.kind];
      const { id: _id, ...body } = e.form as Record<string, unknown>;
      if (e.kind === 'dimension' && e.id) delete body.type;
      if (e.kind === 'entity') body.ownershipPercent = body.ownershipPercent || null;
      return e.id ? api.patch(`${path}/${e.id}`, body) : api.post(path, body);
    },
    onSuccess: () => {
      setEditing(null);
      ['entities', 'branches', 'dimensions', 'currencies'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const open = (e: Editing) => {
    setError(null);
    setEditing(e);
  };
  const setForm = (patch: Record<string, unknown>) => setEditing((e) => (e ? ({ ...e, form: { ...e.form, ...patch } } as Editing) : e));
  const entityCode = (id: string | null) => entities.find((e) => e.id === id)?.code ?? '';

  const newButton = manage && (
    <Button
      variant="primary"
      onClick={() =>
        open(
          tab === 'entities'
            ? { kind: 'entity', form: { code: '', name: '', functionalCurrency: current?.functionalCurrency ?? 'USD', country: '', legalName: '', registrationNumber: '', taxId: '' } }
            : tab === 'branches'
              ? { kind: 'branch', form: { entityId: current?.id, code: '', name: '', city: '', country: '', address: '', phone: '', email: '', taxRegistrationNumber: '' } }
              : { kind: 'dimension', form: { type: 'DEPARTMENT', code: '', name: '', entityId: null } },
        )
      }
    >
      {tab === 'entities' ? 'New entity' : tab === 'branches' ? 'New branch' : 'New dimension value'}
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Entities & branches"
        description="Legal entities keep their own books in a functional currency. Branches and dimensions tag every ledger line for reporting."
        actions={newButton}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'entities', label: `Legal entities (${entities.length})` },
          { id: 'branches', label: `Branches (${branches.length})` },
          { id: 'dimensions', label: `Dimensions (${dimensions.length})` },
        ]}
      />

      {tab === 'entities' && (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Country</th>
                <th>Functional currency</th>
                <th>Tax ID</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entities.map((e) => (
                <tr key={e.id}>
                  <td className="font-mono text-xs">{e.code}</td>
                  <td className="font-medium">{e.name}</td>
                  <td>{e.country}</td>
                  <td>{e.functionalCurrency}</td>
                  <td className="text-muted">{e.taxId}</td>
                  <td>{e.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td className="text-right">
                    {manage && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'entity', id: e.id, form: e })}>Edit</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {tab === 'branches' && (
        <TableWrap>
          {loadingBranches ? (
            <Loading />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Entity</th>
                  <th>City</th>
                  <th>Default currency</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {branches.map((b) => (
                  <tr key={b.id}>
                    <td className="font-mono text-xs">{b.code}</td>
                    <td className="font-medium">{b.name}</td>
                    <td>{entityCode(b.entityId)}</td>
                    <td>{b.city}</td>
                    <td>{b.currency}</td>
                    <td>{b.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td className="text-right">
                      {manage && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'branch', id: b.id, form: b })}>Edit</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TableWrap>
      )}

      {tab === 'dimensions' && (
        <TableWrap>
          {loadingDims ? (
            <Loading />
          ) : !dimensions.length ? (
            <Empty title="No dimension values yet" />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Entity</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dimensions.map((d) => (
                  <tr key={d.id}>
                    <td className="text-muted">{DIM_LABELS[d.type]}</td>
                    <td className="font-mono text-xs">{d.code}</td>
                    <td className="font-medium">{d.name}</td>
                    <td>{d.entityId ? entityCode(d.entityId) : <span className="text-muted">All</span>}</td>
                    <td>{d.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td className="text-right">
                      {manage && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'dimension', id: d.id, form: d })}>Edit</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TableWrap>
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `${editing.id ? 'Edit' : 'New'} ${editing.kind}` : ''}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <ErrorBanner error={error} />
            {editing.kind === 'dimension' && (
              <Field label="Type">
                <Select value={editing.form.type} disabled={!!editing.id} onChange={(e) => setForm({ type: e.target.value })}>
                  {Object.entries(DIM_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
            )}
            {editing.kind === 'branch' && (
              <Field label="Legal entity">
                <Select value={editing.form.entityId} onChange={(e) => setForm({ entityId: e.target.value })}>
                  {entities.map((en) => (
                    <option key={en.id} value={en.id}>{en.code} · {en.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid grid-cols-[8rem_1fr] gap-3">
              <Field label="Code">
                <Input value={editing.form.code ?? ''} onChange={(e) => setForm({ code: e.target.value })} />
              </Field>
              <Field label="Name">
                <Input value={editing.form.name ?? ''} onChange={(e) => setForm({ name: e.target.value })} />
              </Field>
            </div>
            {editing.kind === 'entity' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Registered legal name" className="col-span-2">
                  <Input value={editing.form.legalName ?? ''} onChange={(e) => setForm({ legalName: e.target.value })} />
                </Field>
                <Field label="Functional currency">
                  <Select value={editing.form.functionalCurrency} onChange={(e) => setForm({ functionalCurrency: e.target.value })}>
                    {currencies.map((c) => (
                      <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Country">
                  <Input value={editing.form.country ?? ''} onChange={(e) => setForm({ country: e.target.value })} />
                </Field>
                <Field label="Registration number">
                  <Input value={editing.form.registrationNumber ?? ''} onChange={(e) => setForm({ registrationNumber: e.target.value })} />
                </Field>
                <Field label="Tax ID">
                  <Input value={editing.form.taxId ?? ''} onChange={(e) => setForm({ taxId: e.target.value })} />
                </Field>
                <Field label="Group ownership (%)" hint="Blank means wholly owned; below 100 shows a non-controlling interest on consolidation">
                  <Input inputMode="decimal" value={editing.form.ownershipPercent ?? ''} onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setForm({ ownershipPercent: e.target.value })} />
                </Field>
                <p className="col-span-2 mt-1 text-xs font-medium uppercase tracking-wide text-muted">On invoices</p>
                <Field label="Address" className="col-span-2">
                  <Textarea rows={2} value={editing.form.address ?? ''} onChange={(e) => setForm({ address: e.target.value })} />
                </Field>
                <Field label="Phone">
                  <Input value={editing.form.phone ?? ''} onChange={(e) => setForm({ phone: e.target.value })} />
                </Field>
                <Field label="Billing email" hint="Customers' replies go here">
                  <Input type="email" value={editing.form.email ?? ''} onChange={(e) => setForm({ email: e.target.value })} />
                </Field>
                <Field label="Website" className="col-span-2">
                  <Input value={editing.form.website ?? ''} onChange={(e) => setForm({ website: e.target.value })} />
                </Field>
                <Field label="How to pay" hint="Bank details and other payment instructions, printed on every invoice" className="col-span-2">
                  <Textarea rows={3} value={editing.form.paymentInstructions ?? ''} onChange={(e) => setForm({ paymentInstructions: e.target.value })} />
                </Field>
              </div>
            )}
            {editing.kind === 'branch' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Address" className="col-span-2">
                  <Input value={editing.form.address ?? ''} onChange={(e) => setForm({ address: e.target.value })} />
                </Field>
                <Field label="City">
                  <Input value={editing.form.city ?? ''} onChange={(e) => setForm({ city: e.target.value })} />
                </Field>
                <Field label="Country">
                  <Input value={editing.form.country ?? ''} onChange={(e) => setForm({ country: e.target.value })} />
                </Field>
                <Field label="Phone">
                  <Input value={editing.form.phone ?? ''} onChange={(e) => setForm({ phone: e.target.value })} />
                </Field>
                <Field label="Email">
                  <Input type="email" value={editing.form.email ?? ''} onChange={(e) => setForm({ email: e.target.value })} />
                </Field>
                <Field label="Tax registration number">
                  <Input value={editing.form.taxRegistrationNumber ?? ''} onChange={(e) => setForm({ taxRegistrationNumber: e.target.value })} />
                </Field>
                <Field label="Default transaction currency">
                  <Select value={editing.form.currency ?? ''} onChange={(e) => setForm({ currency: e.target.value || undefined })}>
                    <option value="">Entity functional currency</option>
                    {currencies.filter((c) => c.isActive).map((c) => (
                      <option key={c.code} value={c.code}>{c.code}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            {editing.kind === 'dimension' && editing.form.type === 'DEPARTMENT' && users.data && (
              <Field label="Head of department" hint="Receives budget balance notices for the department">
                <Select value={editing.form.headUserId ?? ''} onChange={(e) => setForm({ headUserId: e.target.value || null })}>
                  <option value="">None</option>
                  {users.data.filter((u) => u.isActive || u.id === editing.form.headUserId).map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            {editing.kind === 'dimension' && (
              <Field label="Restrict to entity">
                <Select value={editing.form.entityId ?? ''} onChange={(e) => setForm({ entityId: e.target.value || null })}>
                  <option value="">All entities</option>
                  {entities.map((en) => (
                    <option key={en.id} value={en.id}>{en.code}</option>
                  ))}
                </Select>
              </Field>
            )}
            {editing.id && <Checkbox label="Active" checked={editing.form.isActive ?? true} onChange={(v) => setForm({ isActive: v })} />}
          </div>
        )}
      </Modal>
    </>
  );
}
