import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId, Mixed } = Schema.Types;
const opts = { timestamps: true } as const;

export const CHARTS = ['table', 'bar', 'line', 'pie', 'kpi', 'heatmap'] as const;
export const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

const versionSchema = new Schema({ version: Number, name: String, spec: Mixed, chart: String, savedBy: ObjectId, savedByName: String, at: Date, note: String }, { _id: false });

/** A saved report: its query, how it is shown, who it is shared with, every earlier version and its schedule. */
export const reportSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    description: String,
    folder: { type: String, default: 'General' },
    spec: { type: Mixed, required: true },
    chart: { type: String, enum: CHARTS, default: 'table' },
    ownerId: { type: ObjectId, required: true },
    ownerName: String,
    /** Everyone with access to reports, or only the people listed. */
    everyone: { type: Boolean, default: false },
    sharedWith: [ObjectId],
    version: { type: Number, default: 1 },
    versions: [versionSchema],
    schedule: {
      frequency: { type: String, enum: [...FREQUENCIES, null], default: null },
      /** Hour of the day (East Africa time) it goes out. */
      hour: { type: Number, default: 7 },
      recipients: [ObjectId],
      emails: [String],
      nextRunAt: { type: Date, default: null },
      lastRunAt: Date,
      lastStatus: String,
    },
    archived: { type: Boolean, default: false },
  },
  opts,
);
reportSchema.index({ organisationId: 1, ownerId: 1 });
reportSchema.index({ organisationId: 1, 'schedule.nextRunAt': 1 });

/** A dashboard: saved reports laid out as tiles, refreshed on a timer. */
export const dashboardSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    description: String,
    /** Shown first on the dashboards page (an executive or departmental dashboard). */
    featured: { type: Boolean, default: false },
    tiles: [new Schema({ reportId: { type: ObjectId, required: true }, title: String, chart: { type: String, enum: [...CHARTS, null], default: null }, width: { type: Number, min: 1, max: 3, default: 1 } })],
    refreshSeconds: { type: Number, default: 300 },
    ownerId: { type: ObjectId, required: true },
    ownerName: String,
    everyone: { type: Boolean, default: false },
    sharedWith: [ObjectId],
  },
  opts,
);

export type ReportDoc = InferSchemaType<typeof reportSchema> & { _id: Types.ObjectId };
export type DashboardDoc = InferSchemaType<typeof dashboardSchema> & { _id: Types.ObjectId };
