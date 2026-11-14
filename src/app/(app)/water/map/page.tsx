'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Modal, Notice, PageHeader, Select } from '@/components/ui';
import { label } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/water/ui/api';
import { useZones } from '@/modules/water/ui/hooks';
import { LAYER_COLOURS, MapFeature, NetworkMap } from '@/modules/water/ui/network-map';

const LAYERS = ['network', 'customers', 'meters', 'facilities', 'tickets'];
const FEATURE_TYPES = ['PIPE', 'VALVE', 'HYDRANT', 'WASHOUT', 'AIR_VALVE', 'CHAMBER', 'BULK_METER', 'SEWER', 'MANHOLE', 'OTHER'];

interface Summary {
  pipes: { material: string; diameterMm: number | null; lengthKm: number; segments: number }[];
  counts: { type: string; count: number }[];
}

export default function MapPage() {
  const qc = useQueryClient();
  const can = useCan();
  const { data: zones } = useZones();
  const [layers, setLayers] = useState<string[]>(LAYERS);
  const [drawing, setDrawing] = useState<{ type: string; points: { lat: number; lng: number }[]; code: string; material: string; diameterMm: string; zoneId: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [geojson, setGeojson] = useState('');
  const { data, error } = useQuery({ queryKey: ['network-geojson'], queryFn: () => api.get<{ features: MapFeature[] }>('/network/geojson') });
  const { data: summary } = useQuery({ queryKey: ['network-summary'], queryFn: () => api.get<Summary>('/network/summary') });
  const shown = useMemo(() => [...(data?.features ?? []).filter((f) => layers.includes(f.properties.layer)), ...(drawing?.points.length ? [{ type: 'Feature' as const, id: 'draft', geometry: drawing.type === 'PIPE' && drawing.points.length > 1 ? { type: 'LineString', coordinates: drawing.points.map((p) => [p.lng, p.lat]) } : { type: 'Point', coordinates: [drawing.points[0].lng, drawing.points[0].lat] }, properties: { layer: 'draft' } }] : [])], [data, layers, drawing]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['network-geojson'] });
    qc.invalidateQueries({ queryKey: ['network-summary'] });
  };
  const save = useMutation({
    mutationFn: () => {
      const d = drawing!;
      const geometry = d.type === 'PIPE' ? { type: 'LineString', coordinates: d.points.map((p) => [p.lng, p.lat]) } : { type: 'Point', coordinates: [d.points[0].lng, d.points[0].lat] };
      return api.post('/network', { type: d.type, code: d.code || undefined, material: d.material || undefined, diameterMm: d.diameterMm ? Number(d.diameterMm) : undefined, zoneId: d.zoneId || null, geometry });
    },
    onSuccess: () => {
      setDrawing(null);
      refresh();
    },
  });
  const doImport = useMutation({
    mutationFn: () => api.post<{ created: number; updated: number; errors: string[] }>('/network/import', { collection: JSON.parse(geojson), defaultType: 'PIPE' }),
    onSuccess: refresh,
  });
  return (
    <>
      <PageHeader
        title="Network map"
        subtitle="Pipes, valves, hydrants and other network features with customers, meters, facilities and open incidents"
        actions={
          <>
            <Link prefetch={false} className="inline-flex items-center rounded-md border border-line bg-white px-3 py-1.5 text-sm font-medium" href="/api/v1/water/network/geojson?download=true">Export GeoJSON (QGIS / ArcGIS)</Link>
            {can('water.network.manage') && (
              <>
                <Button variant="secondary" onClick={() => setImporting(true)}>Import GeoJSON</Button>
                <Button onClick={() => setDrawing({ type: 'PIPE', points: [], code: '', material: '', diameterMm: '', zoneId: '' })}>Draw feature</Button>
              </>
            )}
          </>
        }
      />
      <ErrorBox error={error} />
      <div className="mb-3 flex flex-wrap gap-3 text-sm">
        {LAYERS.map((l) => (
          <label key={l} className="flex items-center gap-1">
            <input type="checkbox" checked={layers.includes(l)} onChange={(e) => setLayers(e.target.checked ? [...layers, l] : layers.filter((x) => x !== l))} />
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: LAYER_COLOURS[l] }} />
            {label(l)}
          </label>
        ))}
      </div>
      {drawing && (
        <Card className="mb-3" title={`Drawing a ${label(drawing.type).toLowerCase()}`} actions={<><Button variant="ghost" onClick={() => setDrawing(null)}>Cancel</Button><Button onClick={() => save.mutate()} disabled={save.isPending || !drawing.points.length || (drawing.type === 'PIPE' && drawing.points.length < 2)}>Save</Button></>}>
          <ErrorBox error={save.error} />
          <p className="mb-2 text-sm text-muted">{drawing.type === 'PIPE' ? 'Click the map along the pipe route; each click adds a point.' : 'Click the map where it is.'} {drawing.points.length} point(s).</p>
          <div className="grid gap-3 sm:grid-cols-5">
            <Field label="Type"><Select value={drawing.type} onChange={(e) => setDrawing({ ...drawing, type: e.target.value, points: [] })}>{FEATURE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
            <Field label="Code"><Input value={drawing.code} onChange={(e) => setDrawing({ ...drawing, code: e.target.value })} /></Field>
            <Field label="Material"><Input value={drawing.material} onChange={(e) => setDrawing({ ...drawing, material: e.target.value })} placeholder="uPVC, HDPE, GI" /></Field>
            <Field label="Diameter (mm)"><Input inputMode="numeric" value={drawing.diameterMm} onChange={(e) => setDrawing({ ...drawing, diameterMm: e.target.value })} /></Field>
            <Field label="Zone"><Select value={drawing.zoneId} onChange={(e) => setDrawing({ ...drawing, zoneId: e.target.value })}><option value="">—</option>{zones?.map((z) => <option key={z.id} value={z.id}>{z.code}</option>)}</Select></Field>
          </div>
        </Card>
      )}
      <NetworkMap features={shown} onPick={drawing ? (p) => setDrawing((d) => (d ? { ...d, points: d.type === 'PIPE' ? [...d.points, p] : [p] } : d)) : undefined} />
      {summary && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card padded={false} title="Pipes in service">
            <table className="table-base">
              <thead><tr><th>Material</th><th className="num">Diameter (mm)</th><th className="num">Length (km)</th><th className="num">Segments</th></tr></thead>
              <tbody>{summary.pipes.map((p, i) => <tr key={i}><td>{p.material}</td><td className="num">{p.diameterMm ?? '—'}</td><td className="num">{p.lengthKm}</td><td className="num">{p.segments}</td></tr>)}</tbody>
            </table>
          </Card>
          <Card padded={false} title="Network features">
            <table className="table-base">
              <thead><tr><th>Type</th><th className="num">Count</th></tr></thead>
              <tbody>{summary.counts.map((c) => <tr key={c.type}><td>{label(c.type)}</td><td className="num">{c.count}</td></tr>)}</tbody>
            </table>
          </Card>
        </div>
      )}
      {importing && (
        <Modal open wide onClose={() => setImporting(false)} title="Import network features" footer={<Button onClick={() => doImport.mutate()} disabled={doImport.isPending || !geojson}>Import</Button>}>
          <ErrorBox error={doImport.error} />
          <p className="text-sm text-muted">A GeoJSON FeatureCollection exported from QGIS or ArcGIS in WGS84 (EPSG:4326). A <code>type</code> property (PIPE, VALVE…) sets the feature type, otherwise it is a pipe; features with a <code>code</code> already here are updated.</p>
          <Input type="file" accept=".geojson,.json,application/geo+json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setGeojson(await f.text()); }} />
          {doImport.data && <Notice tone={doImport.data.errors.length ? 'amber' : 'green'}>{doImport.data.created} added, {doImport.data.updated} updated{doImport.data.errors.length ? `; ${doImport.data.errors.length} skipped: ${doImport.data.errors.slice(0, 3).join('; ')}` : ''}.</Notice>}
        </Modal>
      )}
    </>
  );
}
