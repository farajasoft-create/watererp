import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId, Decimal128 } = Schema.Types;
const D128 = { type: Decimal128, default: () => Types.Decimal128.fromString('0') };
const opts = { timestamps: true } as const;
const point = { lat: Number, lng: Number };

// ---------------------------------------------------------------------------------------------
// Facilities: where water is taken, treated, pumped, stored and sold
// ---------------------------------------------------------------------------------------------

export const FACILITY_TYPES = ['INTAKE', 'BOREHOLE', 'SPRING', 'TREATMENT_WORKS', 'PUMP_STATION', 'RESERVOIR', 'TANK', 'KIOSK', 'BOWSER_POINT', 'OFFICE', 'OTHER'] as const;

export const facilitySchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: FACILITY_TYPES, required: true },
    zoneId: { type: ObjectId, default: null },
    gps: point,
    /** m³ for reservoirs and tanks; m³/day for intakes, boreholes and works. */
    capacity: { ...D128 },
    /** Kiosks: the operator, and the account the kiosk's bulk water is billed to. */
    operator: { name: String, phone: String },
    customerId: { type: ObjectId, default: null },
    /** Kiosks: the price per 20-litre jerrican, KES. */
    pricePerJerrican: { ...D128 },
    commissionedOn: Date,
    active: { type: Boolean, default: true },
    notes: String,
  },
  opts,
);
facilitySchema.index({ organisationId: 1, code: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Production and treatment
// ---------------------------------------------------------------------------------------------

export const productionLogSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    facilityId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    abstracted: { ...D128 },
    treated: { ...D128 },
    supplied: { ...D128 },
    pumpHours: { ...D128 },
    powerKwh: { ...D128 },
    /** Chemicals dosed this day; each reduces the chemical's stock. */
    chemicals: [{ chemicalId: ObjectId, quantity: Decimal128, _id: false }],
    downtimeHours: { ...D128 },
    note: String,
    recordedBy: ObjectId,
  },
  opts,
);
productionLogSchema.index({ organisationId: 1, facilityId: 1, date: 1 }, { unique: true });
productionLogSchema.index({ organisationId: 1, date: 1 });

export const chemicalSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    unit: { type: String, default: 'kg' },
    stock: { ...D128 },
    reorderLevel: { ...D128 },
    unitCost: { ...D128 },
    active: { type: Boolean, default: true },
  },
  opts,
);
chemicalSchema.index({ organisationId: 1, code: 1 }, { unique: true });

export const CHEMICAL_MOVEMENTS = ['RECEIPT', 'USAGE', 'ADJUSTMENT'] as const;

export const chemicalMovementSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    chemicalId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    type: { type: String, enum: CHEMICAL_MOVEMENTS, required: true },
    /** Positive in, negative out. */
    quantity: { ...D128 },
    balance: { ...D128 },
    facilityId: { type: ObjectId, default: null },
    reference: String,
    sourceId: ObjectId,
    by: ObjectId,
  },
  opts,
);
chemicalMovementSchema.index({ organisationId: 1, chemicalId: 1, createdAt: 1 });

export const SAMPLE_POINTS = ['RAW', 'TREATED', 'RESERVOIR', 'NETWORK', 'CONSUMER_TAP', 'KIOSK'] as const;

export const qualityTestSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    sampledAt: { type: Date, required: true },
    point: { type: String, enum: SAMPLE_POINTS, required: true },
    facilityId: { type: ObjectId, default: null },
    zoneId: { type: ObjectId, default: null },
    location: String,
    /** Parameters measured; any left out were not tested. */
    residualChlorine: Decimal128,
    turbidity: Decimal128,
    ph: Decimal128,
    eColi: Decimal128,
    totalColiforms: Decimal128,
    colour: Decimal128,
    conductivity: Decimal128,
    /** Computed against KS EAS 12 / WASREB limits when saved. */
    passed: { type: Boolean, default: true },
    failures: [String],
    lab: String,
    sampledBy: String,
    note: String,
    recordedBy: ObjectId,
  },
  opts,
);
qualityTestSchema.index({ organisationId: 1, sampledAt: -1 });

export const reservoirLevelSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    facilityId: { type: ObjectId, required: true },
    at: { type: Date, required: true },
    levelPercent: { type: Number, min: 0, max: 100 },
    volume: Decimal128,
    note: String,
    recordedBy: ObjectId,
  },
  opts,
);
reservoirLevelSchema.index({ organisationId: 1, facilityId: 1, at: -1 });

/** When each zone gets water (rationing timetables); feeds the hours-of-supply indicator. */
export const supplyScheduleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    zoneId: { type: ObjectId, required: true },
    /** 0 = Sunday … 6 = Saturday. */
    days: [{ type: Number, min: 0, max: 6 }],
    from: { type: String, required: true },
    to: { type: String, required: true },
    note: String,
    active: { type: Boolean, default: true },
  },
  opts,
);
supplyScheduleSchema.index({ organisationId: 1, zoneId: 1 });

// ---------------------------------------------------------------------------------------------
// The distribution network (GIS)
// ---------------------------------------------------------------------------------------------

export const FEATURE_TYPES = ['PIPE', 'VALVE', 'HYDRANT', 'WASHOUT', 'AIR_VALVE', 'CHAMBER', 'BULK_METER', 'SEWER', 'MANHOLE', 'OTHER'] as const;

export const networkFeatureSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    type: { type: String, enum: FEATURE_TYPES, required: true },
    code: String,
    name: String,
    zoneId: { type: ObjectId, default: null },
    /** GeoJSON: Point for valves and hydrants, LineString for pipes. Coordinates are [lng, lat]. */
    geometry: {
      type: { type: String, enum: ['Point', 'LineString', 'Polygon'], required: true },
      coordinates: { type: Schema.Types.Mixed, required: true },
    },
    material: String,
    diameterMm: Number,
    lengthM: Number,
    installedYear: Number,
    condition: { type: String, enum: ['GOOD', 'FAIR', 'POOR', 'CRITICAL', 'UNKNOWN'], default: 'UNKNOWN' },
    status: { type: String, enum: ['IN_SERVICE', 'ABANDONED', 'PLANNED'], default: 'IN_SERVICE' },
    attributes: { type: Schema.Types.Mixed, default: {} },
  },
  opts,
);
networkFeatureSchema.index({ organisationId: 1, type: 1 });
networkFeatureSchema.index({ geometry: '2dsphere' });

// ---------------------------------------------------------------------------------------------
// Field jobs (job cards) and preventive maintenance
// ---------------------------------------------------------------------------------------------

export const WORK_TYPES = ['LEAK_REPAIR', 'BURST_REPAIR', 'NEW_CONNECTION', 'METER_INSTALLATION', 'METER_REPLACEMENT', 'DISCONNECTION', 'RECONNECTION', 'PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'SEWER_UNBLOCKING', 'OTHER'] as const;
export const WORK_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'DONE', 'CLOSED', 'CANCELLED'] as const;
export const WORK_PRIORITIES = ['LOW', 'NORMAL', 'URGENT', 'EMERGENCY'] as const;

export const workOrderSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    type: { type: String, enum: WORK_TYPES, required: true },
    priority: { type: String, enum: WORK_PRIORITIES, default: 'NORMAL' },
    status: { type: String, enum: WORK_STATUSES, default: 'OPEN' },
    title: { type: String, required: true },
    description: String,
    ticketId: { type: ObjectId, default: null },
    customerId: { type: ObjectId, default: null },
    facilityId: { type: ObjectId, default: null },
    featureId: { type: ObjectId, default: null },
    planId: { type: ObjectId, default: null },
    /** Plant, machinery, vehicles and other assets outside the water network (fixed asset tag or fleet number). */
    assetRef: String,
    zoneId: { type: ObjectId, default: null },
    location: String,
    gps: point,
    assignedTo: [{ type: ObjectId }],
    dueAt: Date,
    startedAt: Date,
    completedAt: Date,
    closedAt: Date,
    findings: String,
    labourHours: { ...D128 },
    /** Spare parts and materials used; stores are told through the water.work-order.completed event. */
    materials: [{ itemCode: String, description: String, quantity: Decimal128, unitCost: Decimal128, _id: false }],
    materialsCost: { ...D128 },
    checklist: [{ item: String, done: Boolean, _id: false }],
    completionGps: point,
    createdBy: ObjectId,
    history: [{ at: Date, by: ObjectId, action: String, note: String, status: String, _id: false }],
  },
  opts,
);
workOrderSchema.index({ organisationId: 1, number: 1 }, { unique: true });
workOrderSchema.index({ organisationId: 1, status: 1, dueAt: 1 });
workOrderSchema.index({ organisationId: 1, assignedTo: 1, status: 1 });

export const maintenancePlanSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    facilityId: { type: ObjectId, default: null },
    featureId: { type: ObjectId, default: null },
    assetRef: String,
    /** Days between services; the next job is raised this many days before it is due. */
    frequencyDays: { type: Number, required: true },
    leadDays: { type: Number, default: 7 },
    nextDue: { type: Date, required: true },
    checklist: [String],
    assignedTo: [{ type: ObjectId }],
    estimatedHours: { ...D128 },
    active: { type: Boolean, default: true },
  },
  opts,
);
maintenancePlanSchema.index({ organisationId: 1, active: 1, nextDue: 1 });

// ---------------------------------------------------------------------------------------------
// Kiosks and water bowsers
// ---------------------------------------------------------------------------------------------

export const kioskSaleSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    facilityId: { type: ObjectId, required: true },
    date: { type: Date, required: true },
    jerricans: { type: Number, default: 0 },
    volume: { ...D128 },
    amount: { ...D128 },
    meterReading: Decimal128,
    note: String,
    recordedBy: ObjectId,
  },
  opts,
);
kioskSaleSchema.index({ organisationId: 1, facilityId: 1, date: 1 }, { unique: true });

export const bowserTripSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true },
    vehicleReg: { type: String, required: true },
    driver: String,
    sourceFacilityId: { type: ObjectId, default: null },
    destination: { type: String, required: true },
    customerId: { type: ObjectId, default: null },
    volume: { ...D128 },
    rate: { ...D128 },
    amount: { ...D128 },
    /** Free deliveries (emergencies, institutions under the licence) are not charged. */
    chargeable: { type: Boolean, default: true },
    /** The supplementary bill raised for a customer delivery. */
    billRunId: { type: ObjectId, default: null },
    note: String,
    recordedBy: ObjectId,
  },
  opts,
);
bowserTripSchema.index({ organisationId: 1, number: 1 }, { unique: true });
bowserTripSchema.index({ organisationId: 1, date: -1 });

export type FacilityDoc = InferSchemaType<typeof facilitySchema> & { _id: Types.ObjectId };
export type WorkOrderDoc = InferSchemaType<typeof workOrderSchema> & { _id: Types.ObjectId };
