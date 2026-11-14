import { Schema } from 'mongoose';

const { ObjectId, Decimal128 } = Schema.Types;
const opts = { timestamps: true } as const;

/** The public portals an organisation runs; each can be opened, closed and branded on its own. */
export const PORTAL_KEYS = ['jobs', 'customers', 'vendors', 'tenants', 'donors', 'library', 'msme', 'tenders'] as const;
export type PortalKey = (typeof PORTAL_KEYS)[number];

export const portalSettingsSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    portal: { type: String, enum: PORTAL_KEYS, required: true },
    enabled: { type: Boolean, default: true },
    title: { type: String, default: '' },
    welcome: { type: String, default: '' },
    /** A hex colour for the portal's header and buttons. */
    accent: { type: String, default: '#1d4ed8' },
    logoUrl: { type: String, default: '' },
    contactEmail: { type: String, default: '' },
    contactPhone: { type: String, default: '' },
    footer: { type: String, default: '' },
  },
  opts,
);
portalSettingsSchema.index({ organisationId: 1, portal: 1 }, { unique: true });

export const LIBRARY_CATEGORIES = ['POLICY', 'REPORT', 'STRATEGIC_PLAN', 'TARIFF', 'TENDER', 'MANUAL', 'PUBLICATION', 'FORM', 'RESEARCH', 'OTHER'] as const;

/** An e-library item: a document from the document store or a link, for the public or for staff. */
export const libraryItemSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    title: { type: String, required: true },
    author: String,
    category: { type: String, enum: LIBRARY_CATEGORIES, default: 'OTHER' },
    year: Number,
    summary: String,
    tags: [String],
    documentId: { type: ObjectId, default: null },
    url: { type: String, default: '' },
    audience: { type: String, enum: ['PUBLIC', 'STAFF'], default: 'STAFF' },
    downloads: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    addedBy: ObjectId,
  },
  opts,
);
libraryItemSchema.index({ organisationId: 1, audience: 1, active: 1 });
libraryItemSchema.index({ title: 'text', summary: 'text', tags: 'text', author: 'text' });

export const MSME_SECTORS = ['AGRICULTURE', 'MANUFACTURING', 'CONSTRUCTION', 'TRADE', 'SERVICES', 'ICT', 'TRANSPORT', 'HOSPITALITY', 'OTHER'] as const;

/** A micro, small or medium enterprise listed on the MSME products portal once approved. */
export const msmeSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    reference: { type: String, required: true },
    businessName: { type: String, required: true },
    ownerName: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: '' },
    sector: { type: String, enum: MSME_SECTORS, default: 'OTHER' },
    location: { type: String, default: '' },
    kraPin: { type: String, default: '' },
    registrationNo: { type: String, default: '' },
    /** Access to Government Procurement Opportunities group and certificate. */
    agpo: { type: String, enum: ['NONE', 'YOUTH', 'WOMEN', 'PWD'], default: 'NONE' },
    agpoCertificate: { type: String, default: '' },
    description: { type: String, default: '' },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'], default: 'PENDING' },
    decidedBy: { type: ObjectId, default: null },
    decidedAt: Date,
    reason: { type: String, default: '' },
    /** The business's own link to keep its products up to date (hashed). */
    tokenHash: { type: String, default: null },
    products: [new Schema({ name: { type: String, required: true }, description: String, price: { type: Decimal128, default: null }, unit: String, active: { type: Boolean, default: true } })],
  },
  opts,
);
msmeSchema.index({ organisationId: 1, reference: 1 }, { unique: true });
msmeSchema.index({ organisationId: 1, phone: 1 }, { unique: true });

