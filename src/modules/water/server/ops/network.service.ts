import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { BadRequestException, NotFoundException } from '@/platform/common/errors';
import { dec } from '@/platform/common/money';
import { AuditService } from '@/platform/services/audit.service';
import { WaterDb as Db } from '../db';
import { FEATURE_TYPES } from '../ops-schemas';

type FeatureType = (typeof FEATURE_TYPES)[number];
type Geometry = { type: 'Point' | 'LineString' | 'Polygon'; coordinates?: unknown };

export interface FeatureInput {
  type: FeatureType;
  code?: string;
  name?: string;
  zoneId?: Types.ObjectId | null;
  geometry: Geometry;
  material?: string;
  diameterMm?: number;
  installedYear?: number;
  condition?: 'GOOD' | 'FAIR' | 'POOR' | 'CRITICAL' | 'UNKNOWN';
  status?: 'IN_SERVICE' | 'ABANDONED' | 'PLANNED';
  attributes?: Record<string, unknown>;
}

const isPos = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/** Rejects geometry MongoDB's 2dsphere index would refuse, with a message a GIS officer understands. */
export function checkGeometry(g: Geometry) {
  if (g.type === 'Point' && isPos(g.coordinates)) return;
  if (g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2 && g.coordinates.every(isPos)) return;
  if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPos))) return;
  throw new BadRequestException(`Invalid ${g.type} geometry: coordinates must be [longitude, latitude] in WGS84`);
}

/** Length of a line in metres (haversine), for pipes drawn or imported without one. */
export function lineLength(coords: [number, number][]): number {
  const R = 6_371_000;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1].map((x) => (x * Math.PI) / 180);
    const [lng2, lat2] = coords[i].map((x) => (x * Math.PI) / 180);
    const a = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(a));
  }
  return Math.round(total * 10) / 10;
}

/**
 * The network on a map: pipes, valves, hydrants and other features, with customers, meters and
 * facilities placed by their GPS. Exchanged with QGIS or ArcGIS as GeoJSON (EPSG:4326).
 */
export class NetworkService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, q: { type?: FeatureType; bbox?: [number, number, number, number] }) {
    const filter: Record<string, unknown> = { organisationId: user.organisationId };
    if (q.type) filter.type = q.type;
    if (q.bbox) {
      const [w, s, e, n] = q.bbox;
      filter.geometry = { $geoIntersects: { $geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } } };
    }
    return this.db.networkFeatures.find(filter).limit(5000).lean();
  }

  async save(user: AuthUser, input: FeatureInput, id?: Types.ObjectId) {
    checkGeometry(input.geometry);
    const lengthM = input.geometry.type === 'LineString' ? lineLength(input.geometry.coordinates as [number, number][]) : undefined;
    const doc = { ...input, ...(lengthM !== undefined && { lengthM }) };
    const saved = id ? await this.db.networkFeatures.findOneAndUpdate({ _id: id, organisationId: user.organisationId }, doc, { new: true }).lean() : (await this.db.networkFeatures.create([{ ...doc, organisationId: user.organisationId }]))[0].toObject();
    if (!saved) throw new NotFoundException('Feature not found');
    await this.audit.record(user, id ? 'water.network.update' : 'water.network.create', 'networkFeature', saved._id, { type: input.type, code: input.code });
    return saved;
  }

  async remove(user: AuthUser, id: Types.ObjectId) {
    const r = await this.db.networkFeatures.deleteOne({ _id: id, organisationId: user.organisationId });
    if (!r.deletedCount) throw new NotFoundException('Feature not found');
    await this.audit.record(user, 'water.network.delete', 'networkFeature', id, {});
    return { ok: true };
  }

  /** Everything with a position, as one GeoJSON FeatureCollection per layer asked for. */
  async geojson(user: AuthUser, layers: string[]) {
    const features: unknown[] = [];
    const orgId = user.organisationId;
    if (layers.includes('network')) {
      for (const f of await this.db.networkFeatures.find({ organisationId: orgId }).lean()) {
        features.push({ type: 'Feature', id: f._id.toHexString(), geometry: f.geometry, properties: { layer: 'network', featureType: f.type, code: f.code, name: f.name, material: f.material, diameterMm: f.diameterMm, lengthM: f.lengthM, installedYear: f.installedYear, condition: f.condition, status: f.status, zoneId: f.zoneId?.toHexString() ?? null, ...(f.attributes ?? {}) } });
      }
    }
    if (layers.includes('customers') || layers.includes('meters')) {
      const customers = await this.db.customers.find({ organisationId: orgId, 'gps.lat': { $type: 'number' } }, { accountNo: 1, name: 1, category: 1, status: 1, balance: 1, gps: 1, meterId: 1, zoneId: 1 }).lean();
      const meters = layers.includes('meters') ? await this.db.meters.find({ organisationId: orgId, customerId: { $in: customers.map((c) => c._id) } }, { serialNo: 1, status: 1, customerId: 1, sizeMm: 1, lastReading: 1 }).lean() : [];
      const meterBy = new Map(meters.map((m) => [m.customerId!.toHexString(), m]));
      for (const c of customers) {
        const position = [c.gps!.lng!, c.gps!.lat!];
        if (layers.includes('customers')) features.push({ type: 'Feature', id: c._id.toHexString(), geometry: { type: 'Point', coordinates: position }, properties: { layer: 'customers', accountNo: c.accountNo, name: c.name, category: c.category, status: c.status, balance: dec(c.balance).toFixed(2), zoneId: c.zoneId?.toHexString() } });
        const m = meterBy.get(c._id.toHexString());
        if (m) features.push({ type: 'Feature', id: m._id.toHexString(), geometry: { type: 'Point', coordinates: position }, properties: { layer: 'meters', serialNo: m.serialNo, status: m.status, sizeMm: m.sizeMm, lastReading: dec(m.lastReading).toFixed(), accountNo: c.accountNo } });
      }
    }
    if (layers.includes('facilities')) {
      for (const f of await this.db.facilities.find({ organisationId: orgId, 'gps.lat': { $type: 'number' } }).lean()) {
        features.push({ type: 'Feature', id: f._id.toHexString(), geometry: { type: 'Point', coordinates: [f.gps!.lng!, f.gps!.lat!] }, properties: { layer: 'facilities', facilityType: f.type, code: f.code, name: f.name, capacity: dec(f.capacity).toFixed() } });
      }
    }
    if (layers.includes('tickets')) {
      for (const t of await this.db.tickets.find({ organisationId: orgId, status: { $in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'] }, 'gps.lat': { $type: 'number' } }, { number: 1, category: 1, subject: 1, gps: 1, status: 1 }).lean()) {
        features.push({ type: 'Feature', id: t._id.toHexString(), geometry: { type: 'Point', coordinates: [t.gps!.lng!, t.gps!.lat!] }, properties: { layer: 'tickets', number: t.number, category: t.category, subject: t.subject, status: t.status } });
      }
    }
    return { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features };
  }

  /**
   * Imports network features from a QGIS or ArcGIS GeoJSON export. The feature type comes from a
   * `type`/`featureType` property or the default given; features with the same `code` are updated.
   */
  async importGeojson(user: AuthUser, input: { collection: { features: { geometry: Geometry; properties?: Record<string, unknown> }[] }; defaultType: FeatureType; zoneId?: Types.ObjectId | null }) {
    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (const [i, f] of input.collection.features.entries()) {
      try {
        checkGeometry(f.geometry);
        const p = f.properties ?? {};
        const rawType = String(p.featureType ?? p.type ?? p.TYPE ?? '').toUpperCase();
        const type = (FEATURE_TYPES as readonly string[]).includes(rawType) ? (rawType as FeatureType) : input.defaultType;
        const code = p.code ?? p.CODE ?? p.id ?? p.ID;
        const doc: FeatureInput = {
          type,
          code: code === undefined ? undefined : String(code),
          name: p.name ? String(p.name) : undefined,
          zoneId: input.zoneId ?? null,
          geometry: f.geometry,
          material: p.material ? String(p.material) : undefined,
          diameterMm: Number(p.diameterMm ?? p.diameter ?? p.DIAMETER) || undefined,
          installedYear: Number(p.installedYear ?? p.year) || undefined,
          attributes: p,
        };
        const existing = doc.code ? await this.db.networkFeatures.findOne({ organisationId: user.organisationId, code: doc.code }, { _id: 1 }).lean() : null;
        await this.save(user, doc, existing?._id);
        if (existing) updated++;
        else created++;
      } catch (err) {
        errors.push(`Feature ${i + 1}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    return { created, updated, errors };
  }

  /** Pipe lengths by material and diameter, and feature counts, for the asset register and WASREB returns. */
  async summary(user: AuthUser) {
    const [pipes, counts] = await Promise.all([
      this.db.networkFeatures.aggregate<{ _id: { material: string; diameterMm: number }; lengthM: number; n: number }>([
        { $match: { organisationId: user.organisationId, type: 'PIPE', status: 'IN_SERVICE' } },
        { $group: { _id: { material: '$material', diameterMm: '$diameterMm' }, lengthM: { $sum: '$lengthM' }, n: { $sum: 1 } } },
        { $sort: { '_id.diameterMm': -1 } },
      ]),
      this.db.networkFeatures.aggregate<{ _id: string; n: number }>([{ $match: { organisationId: user.organisationId } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    ]);
    return { pipes: pipes.map((p) => ({ material: p._id.material ?? 'Unknown', diameterMm: p._id.diameterMm ?? null, lengthKm: Math.round(p.lengthM / 10) / 100, segments: p.n })), counts: counts.map((c) => ({ type: c._id, count: c.n })) };
  }
}
