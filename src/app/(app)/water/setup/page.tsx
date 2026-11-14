'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Money, PageHeader, Select, Tabs } from '@/components/ui';
import { api } from '@/modules/water/ui/api';
import { fmtDate, fmtMoney, label, today } from '@/lib/format';
import { useTariffs, useZones } from '@/modules/water/ui/hooks';
import { useCan } from '@/lib/session';
import { BillLine, Tariff, Zone } from '@/modules/water/ui/types';

const CATEGORIES = ['DOMESTIC', 'COMMERCIAL', 'INSTITUTIONAL', 'KIOSK', 'INDUSTRIAL', 'BULK'];

function ZoneForm({ zone, zones, onClose }: { zone?: Zone; zones: Zone[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: zone?.code ?? '', name: zone?.name ?? '', type: zone?.type ?? 'ZONE', parentId: zone?.parentId ?? '', active: zone?.active ?? true });
  const save = useMutation({
    mutationFn: () => (zone ? api.patch(`/zones/${zone.id}`, { ...f, parentId: f.parentId || null }) : api.post('/zones', { ...f, parentId: f.parentId || null })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['zones'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={zone ? `Edit ${zone.code}` : 'New zone'} footer={<Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || !f.name}>Save</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" hint="Prefix of account numbers, e.g. KAM">
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} disabled={Boolean(zone)} />
        </Field>
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Type">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Zone['type'] })}>
            <option value="ZONE">Supply zone</option>
            <option value="DMA">District metered area (DMA)</option>
          </Select>
        </Field>
        <Field label="Within">
          <Select value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
            <option value="">—</option>
            {zones.filter((z) => z.id !== zone?.id).map((z) => (
              <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
        </label>
      </div>
    </Modal>
  );
}

type Block = { upTo: string; rate: string; fixedAmount: string };

function TariffForm({ tariff, onClose }: { tariff?: Tariff; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    code: tariff?.code ?? '',
    name: tariff?.name ?? '',
    category: tariff?.category ?? 'DOMESTIC',
    effectiveFrom: tariff?.effectiveFrom?.slice(0, 10) ?? today(),
    approvalReference: tariff?.approvalReference ?? '',
    meterRent: tariff?.meterRent ?? '0',
    sewerPercent: tariff?.sewerPercent ?? '0',
    minimumCharge: tariff?.minimumCharge ?? '0',
    defaultEstimate: tariff?.defaultEstimate ?? '6',
    active: tariff?.active ?? true,
  });
  const [blocks, setBlocks] = useState<Block[]>(
    tariff?.blocks.map((b) => ({ upTo: b.upTo ?? '', rate: b.rate, fixedAmount: b.fixedAmount ?? '' })) ?? [
      { upTo: '6', rate: '0', fixedAmount: '600' },
      { upTo: '20', rate: '120', fixedAmount: '' },
      { upTo: '', rate: '150', fixedAmount: '' },
    ],
  );
  const [calc, setCalc] = useState({ units: '25', sewered: false });
  const body = () => ({ ...f, blocks: blocks.map((b, i) => ({ upTo: i === blocks.length - 1 ? null : b.upTo, rate: b.rate || '0', fixedAmount: b.fixedAmount || null })) });
  const save = useMutation({
    mutationFn: () => (tariff ? api.patch(`/tariffs/${tariff.id}`, body()) : api.post('/tariffs', body())),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tariffs'] });
      onClose();
    },
  });
  const preview = useMutation({ mutationFn: () => api.post<{ lines: BillLine[]; total: string }>(`/tariffs/${tariff!.id}/calculate`, calc) });
  const setBlock = (i: number, patch: Partial<Block>) => setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  return (
    <Modal open wide onClose={onClose} title={tariff ? `Tariff ${tariff.code}` : 'New tariff'} footer={<Button onClick={() => save.mutate()} disabled={save.isPending || !f.code || !f.name}>Save tariff</Button>}>
      <ErrorBox error={save.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code">
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Name" className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{label(c)}</option>
            ))}
          </Select>
        </Field>
        <Field label="Effective from">
          <Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
        </Field>
        <Field label="WASREB / gazette reference">
          <Input value={f.approvalReference} onChange={(e) => setF({ ...f, approvalReference: e.target.value })} />
        </Field>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-muted">Consumption bands (increasing block)</div>
        <table className="table-base rounded border border-line">
          <thead>
            <tr>
              <th>From (m³)</th>
              <th>Up to (m³)</th>
              <th>Rate per m³</th>
              <th>Or flat charge for the band</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {blocks.map((b, i) => {
              const last = i === blocks.length - 1;
              return (
                <tr key={i}>
                  <td className="text-muted">{i === 0 ? '0' : blocks[i - 1].upTo || '?'}</td>
                  <td>{last ? <span className="text-muted">and above</span> : <Input inputMode="decimal" value={b.upTo} onChange={(e) => setBlock(i, { upTo: e.target.value })} />}</td>
                  <td><Input inputMode="decimal" value={b.rate} onChange={(e) => setBlock(i, { rate: e.target.value })} disabled={Boolean(b.fixedAmount)} /></td>
                  <td><Input inputMode="decimal" value={b.fixedAmount} placeholder="—" onChange={(e) => setBlock(i, { fixedAmount: e.target.value })} /></td>
                  <td>{blocks.length > 1 && <Button variant="ghost" onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))}>Remove</Button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <Button variant="ghost" className="mt-1" onClick={() => setBlocks((bs) => [...bs.slice(0, -1), { upTo: '', rate: '', fixedAmount: '' }, bs[bs.length - 1]])}>+ Add band</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Meter rent / month">
          <Input inputMode="decimal" value={f.meterRent} onChange={(e) => setF({ ...f, meterRent: e.target.value })} />
        </Field>
        <Field label="Sewerage % of water">
          <Input inputMode="decimal" value={f.sewerPercent} onChange={(e) => setF({ ...f, sewerPercent: e.target.value })} />
        </Field>
        <Field label="Minimum water charge">
          <Input inputMode="decimal" value={f.minimumCharge} onChange={(e) => setF({ ...f, minimumCharge: e.target.value })} />
        </Field>
        <Field label="Default estimate (m³)" hint="When a meter has no history">
          <Input inputMode="decimal" value={f.defaultEstimate} onChange={(e) => setF({ ...f, defaultEstimate: e.target.value })} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (offered for new connections)
      </label>
      {tariff && (
        <div className="rounded-md border border-line bg-slate-50 p-3">
          <div className="mb-2 text-xs font-medium text-muted">Bill calculator (saved tariff)</div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Units (m³)">
              <Input inputMode="decimal" value={calc.units} onChange={(e) => setCalc({ ...calc, units: e.target.value })} className="w-28" />
            </Field>
            <label className="flex items-center gap-1.5 pb-2 text-sm">
              <input type="checkbox" checked={calc.sewered} onChange={(e) => setCalc({ ...calc, sewered: e.target.checked })} /> Sewered
            </label>
            <Button variant="secondary" onClick={() => preview.mutate()}>Calculate</Button>
          </div>
          <ErrorBox error={preview.error} />
          {preview.data && (
            <table className="table-base mt-2">
              <tbody>
                {preview.data.lines.map((l) => (
                  <tr key={l.code}>
                    <td>{l.description}</td>
                    <td className="num"><Money value={l.amount} /></td>
                  </tr>
                ))}
                <tr>
                  <td className="font-semibold">Total</td>
                  <td className="num font-semibold">{fmtMoney(preview.data.total)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function SetupPage() {
  const can = useCan();
  const [tab, setTab] = useState<'zones' | 'tariffs'>('zones');
  const zones = useZones();
  const tariffs = useTariffs();
  const [zoneEdit, setZoneEdit] = useState<Zone | 'new' | null>(null);
  const [tariffEdit, setTariffEdit] = useState<Tariff | 'new' | null>(null);

  return (
    <>
      <PageHeader title="Zones & tariffs" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'zones', label: 'Zones / DMAs' }, { id: 'tariffs', label: 'Tariffs' }]} />
      {tab === 'zones' && (
        <Card padded={false} actions={can('water.zone.manage') && <Button onClick={() => setZoneEdit('new')}>New zone</Button>}>
          {zones.isLoading ? (
            <Loading />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Within</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {zones.data?.map((z) => (
                  <tr key={z.id}>
                    <td className="font-medium">{z.code}</td>
                    <td>{z.name}</td>
                    <td>{z.type === 'DMA' ? 'DMA' : 'Zone'}</td>
                    <td>{zones.data?.find((p) => p.id === z.parentId)?.code ?? '—'}</td>
                    <td>{z.active ? <Badge value="ACTIVE" /> : <Badge tone="gray">Inactive</Badge>}</td>
                    <td className="text-right">{can('water.zone.manage') && <Button variant="ghost" onClick={() => setZoneEdit(z)}>Edit</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {tab === 'tariffs' && (
        <Card padded={false} actions={can('water.tariff.manage') && <Button onClick={() => setTariffEdit('new')}>New tariff</Button>}>
          {tariffs.isLoading ? (
            <Loading />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Bands</th>
                  <th className="num">Meter rent</th>
                  <th className="num">Sewer %</th>
                  <th>Effective</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tariffs.data?.map((t) => (
                  <tr key={t.id}>
                    <td className="font-medium">{t.code}</td>
                    <td>{t.name} {!t.active && <Badge tone="gray">Inactive</Badge>}</td>
                    <td>{label(t.category)}</td>
                    <td className="text-xs">
                      {t.blocks.map((b, i) => (
                        <div key={i}>
                          {i === 0 ? 0 : t.blocks[i - 1].upTo}–{b.upTo ?? '∞'} m³: {b.fixedAmount ? `KES ${fmtMoney(b.fixedAmount)} flat` : `KES ${fmtMoney(b.rate)}/m³`}
                        </div>
                      ))}
                    </td>
                    <td className="num">{fmtMoney(t.meterRent)}</td>
                    <td className="num">{Number(t.sewerPercent)}%</td>
                    <td>{fmtDate(t.effectiveFrom)}</td>
                    <td className="text-right"><Button variant="ghost" onClick={() => setTariffEdit(t)}>{can('water.tariff.manage') ? 'Edit' : 'View'}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {zoneEdit && <ZoneForm zone={zoneEdit === 'new' ? undefined : zoneEdit} zones={zones.data ?? []} onClose={() => setZoneEdit(null)} />}
      {tariffEdit && <TariffForm tariff={tariffEdit === 'new' ? undefined : tariffEdit} onClose={() => setTariffEdit(null)} />}
    </>
  );
}
