'use client';

import 'leaflet/dist/leaflet.css';
import type { GeoJSON as GeoJSONLayer, LatLngExpression, Map as LeafletMap } from 'leaflet';
import { useEffect, useRef } from 'react';

export interface MapFeature {
  type: 'Feature';
  id: string;
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown> & { layer: string };
}

const COLOURS: Record<string, string> = { network: '#0369a1', customers: '#059669', meters: '#7c3aed', facilities: '#b45309', tickets: '#dc2626' };

function popup(p: MapFeature['properties']): string {
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = Object.entries(p)
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !['layer', 'zoneId'].includes(k) && typeof v !== 'object')
    .slice(0, 10)
    .map(([k, v]) => `<tr><td style="color:#64748b;padding-right:8px">${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');
  return `<b>${esc(p.layer)}</b><table style="font-size:12px">${rows}</table>`;
}

/**
 * The network on OpenStreetMap: pipes and network features, customers and meters by their GPS,
 * facilities and open incidents, each layer in its own colour. Clicking the map reports the position
 * (for drawing new features).
 */
export function NetworkMap({ features, onPick, height = 560 }: { features: MapFeature[]; onPick?: (pos: { lat: number; lng: number }) => void; height?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layer = useRef<GeoJSONLayer | null>(null);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !holder.current) return;
      if (!map.current) {
        map.current = L.map(holder.current).setView([0.05, 35.3] as LatLngExpression, 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map.current);
        map.current.on('click', (e) => pick.current?.({ lat: Math.round(e.latlng.lat * 1e6) / 1e6, lng: Math.round(e.latlng.lng * 1e6) / 1e6 }));
      }
      layer.current?.remove();
      layer.current = L.geoJSON(features as unknown as GeoJSON.FeatureCollection['features'], {
        style: (f) => ({ color: COLOURS[(f?.properties as { layer: string })?.layer] ?? '#334155', weight: 4 }),
        pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 6, color: '#fff', weight: 1, fillColor: COLOURS[(f.properties as { layer: string }).layer] ?? '#334155', fillOpacity: 0.9 }),
        onEachFeature: (f, l) => l.bindPopup(popup(f.properties as MapFeature['properties'])),
      }).addTo(map.current);
      const bounds = layer.current.getBounds();
      if (bounds.isValid()) map.current.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
    })();
    return () => {
      cancelled = true;
    };
  }, [features]);

  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
    },
    [],
  );

  return <div ref={holder} style={{ height }} className="w-full overflow-hidden rounded-lg border border-line" />;
}

export const LAYER_COLOURS = COLOURS;
