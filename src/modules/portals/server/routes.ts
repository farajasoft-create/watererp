import { z } from 'zod';
import { parseId, zId } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { route } from './route';
import { LIBRARY_CATEGORIES, MSME_SECTORS, PORTAL_KEYS } from './schemas';

const text = (max: number) => z.string().trim().max(max);
const Item = z.object({ title: text(250).min(2), author: text(150).optional(), category: z.enum(LIBRARY_CATEGORIES).default('OTHER'), year: z.number().int().min(1900).max(2100).nullable().optional(), summary: text(3000).optional(), tags: z.array(text(40).min(1)).max(20).default([]), documentId: zId.nullable().optional(), url: text(500).optional(), audience: z.enum(['PUBLIC', 'STAFF']).default('STAFF'), active: z.boolean().optional() });
const Products = z.array(z.object({ name: text(150).min(2), description: text(1000).optional(), price: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'A price like 1500 or 1500.50').nullable().optional(), unit: text(30).optional() })).max(50);
const Msme = z.object({
  businessName: text(200).min(2),
  ownerName: text(150).min(2),
  phone: text(20).min(9),
  email: text(200).optional(),
  sector: z.enum(MSME_SECTORS).default('OTHER'),
  location: text(200).optional(),
  kraPin: text(20).optional(),
  registrationNo: text(40).optional(),
  agpo: z.enum(['NONE', 'YOUTH', 'WOMEN', 'PWD']).default('NONE'),
  agpoCertificate: text(60).optional(),
  description: text(2000).optional(),
  products: Products.default([]),
});
const Search = z.object({ search: text(100).optional(), category: text(30).optional(), sector: text(30).optional(), agpo: text(10).optional() });

export const portalsRoutes = [
  route({ method: 'GET', path: '/settings', permissions: [P.SETTINGS], handler: ({ s, user }) => s.portals.settings(user) }),
  route({
    method: 'PUT',
    path: '/settings/:portal',
    permissions: [P.SETTINGS],
    body: z.object({ enabled: z.boolean(), title: text(120).optional(), welcome: text(1000).optional(), accent: text(7).optional(), logoUrl: text(500).optional(), contactEmail: text(200).optional(), contactPhone: text(20).optional(), footer: text(500).optional() }),
    handler: ({ s, user, params, body }) => s.portals.saveSettings(user, z.enum(PORTAL_KEYS).parse(params.portal), body),
  }),
  route({ method: 'GET', path: '/public/:org/branding/:portal', public: true, rateLimit: 120, handler: ({ s, params }) => s.portals.publicBranding(params.org, z.enum(PORTAL_KEYS).parse(params.portal)) }),

  // The e-library: every signed-in member of staff can read it.
  route({ method: 'GET', path: '/library', query: Search, handler: ({ s, user, query }) => s.portals.library(user, query) }),
  route({ method: 'GET', path: '/library/:id/open', handler: ({ s, user, params }) => s.portals.open(user.organisationId, parseId(params.id), 'ANY') }),
  route({ method: 'POST', path: '/library', permissions: [P.MANAGE], body: Item, handler: ({ s, user, body }) => s.portals.saveItem(user, null, body) }),
  route({ method: 'PUT', path: '/library/:id', permissions: [P.MANAGE], body: Item, handler: ({ s, user, params, body }) => s.portals.saveItem(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/public/:org/library', public: true, rateLimit: 120, query: Search, handler: ({ s, params, query }) => s.portals.publicLibrary(params.org, query) }),
  route({ method: 'GET', path: '/public/:org/library/:id', public: true, rateLimit: 60, handler: ({ s, params }) => s.portals.publicOpen(params.org, parseId(params.id)) }),

  // MSMEs.
  route({ method: 'GET', path: '/msmes', permissions: [P.VIEW], query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional() }), handler: ({ s, user, query }) => s.portals.msmes(user, query.status) }),
  route({ method: 'POST', path: '/msmes/:id/decide', permissions: [P.MANAGE], status: 200, body: z.object({ status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']), reason: text(500).optional() }), handler: ({ s, user, params, body }) => s.portals.decide(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/public/:org/msmes', public: true, rateLimit: 5, body: Msme, handler: ({ s, params, body }) => s.portals.register(params.org, body) }),
  route({ method: 'GET', path: '/public/:org/msmes', public: true, rateLimit: 120, query: Search, handler: ({ s, params, query }) => s.portals.catalogue(params.org, query) }),
  route({ method: 'GET', path: '/msme-account/:token', public: true, rateLimit: 60, handler: ({ s, params }) => s.portals.account(params.token) }),
  route({ method: 'PUT', path: '/msme-account/:token', public: true, rateLimit: 20, body: z.object({ description: text(2000).optional(), products: Products }), handler: ({ s, params, body }) => s.portals.saveProducts(params.token, body) }),
];
