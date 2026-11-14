import { z } from 'zod';
import { parseId, zDate, zDecimal, zId } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { route } from './route';
import { CATEGORIES, METHODS, RESERVATIONS, STATUSES } from './schemas';

const text = (max: number) => z.string().trim().max(max);
const Money = zDecimal.refine((v) => v.gte(0), 'Cannot be negative');
const Positive = zDecimal.refine((v) => v.gt(0), 'Must be more than zero');
const When = z.string().datetime({ offset: true }).transform((v) => new Date(v));
const Role = z.enum(['CHAIR', 'SECRETARY', 'MEMBER']);

const TenderBody = z.object({
  title: text(250).min(5),
  description: text(5000).optional(),
  method: z.enum(METHODS),
  category: z.enum(CATEGORIES),
  reservedFor: z.enum(RESERVATIONS).default('NONE'),
  estimate: Positive,
  planReference: text(80).optional(),
  budgetLine: text(80).optional(),
  justification: text(3000).optional(),
  bidSecurity: Money.default('0'),
  bidValidityDays: z.number().int().min(30).max(365).default(120),
  documentIds: z.array(zId).max(30).default([]),
  closingAt: When,
  openingAt: When,
  openingVenue: text(200).optional(),
  mandatory: z.array(text(300).min(2)).max(40).default([]),
  criteria: z.array(z.object({ name: text(150).min(2), weight: z.number().int().min(1).max(100) })).max(20).default([]),
  passMark: z.number().min(0).max(100).default(70),
  financialWeight: z.number().min(0).max(100).default(100),
});

const BidBody = z.object({
  name: text(200).min(2),
  kraPin: text(11).regex(/^[AP]\d{9}[A-Z]$/i, 'A KRA PIN like P051234567X'),
  email: z.string().trim().email().max(200).optional(),
  phone: text(20).min(9),
  agpo: z.enum(['NONE', 'YOUTH', 'WOMEN', 'PWD']).default('NONE'),
  agpoCertificate: text(60).optional(),
  local: z.boolean().default(false),
  amount: Positive,
  validityDays: z.number().int().min(1).max(730),
  bidSecurityReference: text(80).optional(),
  mandatory: z.array(z.object({ requirement: text(300), provided: z.boolean(), reference: text(200).optional() })).max(40).default([]),
  technicalProposal: text(20000).optional(),
});

export const tendersRoutes = [
  route({ method: 'GET', path: '/settings', permissions: [P.VIEW], handler: ({ s, user }) => s.tenders.settings(user) }),
  route({
    method: 'PUT',
    path: '/settings',
    permissions: [P.SETTINGS],
    body: z.object({ thresholds: z.array(z.object({ method: z.enum(METHODS), max: Positive.nullable() })), minNoticeDays: z.number().int().min(0).max(60), standstillDays: z.number().int().min(0).max(60) }),
    handler: ({ s, user, body }) => s.tenders.saveSettings(user, body),
  }),

  route({ method: 'GET', path: '/tenders', permissions: [P.VIEW], query: z.object({ status: z.enum(STATUSES).optional(), search: text(100).optional() }), handler: ({ s, user, query }) => s.tenders.list(user, query) }),
  route({ method: 'GET', path: '/tenders/register.csv', permissions: [P.VIEW], handler: ({ s, user }) => s.tenders.registerCsv(user) }),
  route({ method: 'GET', path: '/tenders/ppip.csv', permissions: [P.VIEW], query: z.object({ from: zDate.optional(), to: zDate.optional() }), handler: ({ s, user, query }) => s.tenders.ppipCsv(user, query) }),
  route({ method: 'POST', path: '/tenders', permissions: [P.MANAGE], body: TenderBody, handler: ({ s, user, body }) => s.tenders.create(user, body) }),
  // Committee members need not hold any tenders role to see the tender they sit on.
  route({ method: 'GET', path: '/tenders/:id', handler: ({ s, user, params }) => s.tenders.get(user, parseId(params.id)) }),
  route({ method: 'PUT', path: '/tenders/:id', permissions: [P.MANAGE], body: TenderBody, handler: ({ s, user, params, body }) => s.tenders.update(user, parseId(params.id), body) }),
  route({
    method: 'PUT',
    path: '/tenders/:id/committees',
    permissions: [P.AWARD],
    body: z.object({ opening: z.array(z.object({ userId: zId, role: Role })).max(15), evaluation: z.array(z.object({ userId: zId, role: Role })).max(15) }),
    handler: ({ s, user, params, body }) => s.tenders.appoint(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/tenders/:id/publish', permissions: [P.MANAGE], status: 200, handler: ({ s, user, params }) => s.tenders.publish(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/tenders/:id/addenda', permissions: [P.MANAGE], status: 200, body: z.object({ text: text(5000).min(5), closingAt: When.optional(), openingAt: When.optional() }), handler: ({ s, user, params, body }) => s.tenders.addendum(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenders/:id/clarifications/:cid', permissions: [P.MANAGE], status: 200, body: z.object({ answer: text(5000).min(2) }), handler: ({ s, user, params, body }) => s.tenders.answer(user, parseId(params.id), parseId(params.cid), body.answer) }),

  // Opening and evaluation: committee membership is checked by the service.
  route({ method: 'POST', path: '/tenders/:id/open', status: 200, body: z.object({ attendees: z.array(zId).max(15), bidderRepresentatives: text(2000).optional(), minutes: text(5000).optional() }), handler: ({ s, user, params, body }) => s.tenders.open(user, parseId(params.id), body) }),
  route({ method: 'GET', path: '/tenders/:id/opening-register', handler: ({ s, user, params }) => s.tenders.register(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/tenders/:id/preliminary', status: 200, body: z.object({ results: z.array(z.object({ bidId: zId, responsive: z.boolean(), reason: text(1000).optional() })).min(1).max(200) }), handler: ({ s, user, params, body }) => s.tenders.preliminary(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenders/:id/scores', status: 200, body: z.object({ bidId: zId, scores: z.array(z.object({ criterion: text(150), score: z.number().min(0).max(100) })).max(20) }), handler: ({ s, user, params, body }) => s.tenders.score(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenders/:id/complete', status: 200, body: z.object({ report: text(20000).min(10) }), handler: ({ s, user, params, body }) => s.tenders.complete(user, parseId(params.id), body) }),

  route({ method: 'POST', path: '/tenders/:id/opinion', permissions: [P.OPINION], status: 200, body: z.object({ text: text(20000).min(10), concurs: z.boolean() }), handler: ({ s, user, params, body }) => s.tenders.opinion(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenders/:id/award', permissions: [P.AWARD], status: 200, body: z.object({ bidId: zId.optional(), reason: text(3000).optional() }), handler: ({ s, user, params, body }) => s.tenders.award(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenders/:id/cancel', permissions: [P.AWARD], status: 200, body: z.object({ reason: text(3000).min(5) }), handler: ({ s, user, params, body }) => s.tenders.cancel(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenders/:id/appeals', permissions: [P.MANAGE], status: 200, body: z.object({ applicant: text(200).min(2), filedAt: zDate, grounds: text(5000).min(5) }), handler: ({ s, user, params, body }) => s.tenders.appeal(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/tenders/:id/appeals/:aid', permissions: [P.MANAGE], status: 200, body: z.object({ status: z.enum(['DISMISSED', 'UPHELD', 'WITHDRAWN']), decision: text(5000).optional() }), handler: ({ s, user, params, body }) => s.tenders.decideAppeal(user, parseId(params.id), parseId(params.aid), body) }),
  route({
    method: 'POST',
    path: '/tenders/:id/contract',
    permissions: [P.MANAGE],
    status: 200,
    body: z.object({ number: text(60).min(2), signedAt: zDate, value: Positive, startDate: zDate, endDate: zDate, performanceSecurity: Money.default('0') }),
    handler: ({ s, user, params, body }) => s.tenders.contract(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/contracts', permissions: [P.VIEW], query: z.object({ format: z.enum(['json', 'csv']).default('json') }), handler: ({ s, user, query }) => (query.format === 'csv' ? s.tenders.contractsCsv(user) : s.tenders.contracts(user)) }),

  // The public tenders portal and the bidder's own link.
  route({ method: 'GET', path: '/public/:org', public: true, rateLimit: 120, handler: ({ s, params }) => s.tenders.notices(params.org) }),
  route({ method: 'GET', path: '/public/:org/:id', public: true, rateLimit: 120, handler: ({ s, params }) => s.tenders.notice(params.org, parseId(params.id)) }),
  route({ method: 'GET', path: '/public/:org/:id/documents/:doc', public: true, rateLimit: 60, handler: ({ s, params }) => s.tenders.document(params.org, parseId(params.id), parseId(params.doc)) }),
  route({ method: 'POST', path: '/public/:org/:id/questions', public: true, rateLimit: 10, status: 200, body: z.object({ question: text(3000).min(5), askedBy: text(200).optional() }), handler: ({ s, params, body }) => s.tenders.ask(params.org, parseId(params.id), body) }),
  route({ method: 'POST', path: '/public/:org/:id/bids', public: true, rateLimit: 10, body: BidBody, handler: ({ s, params, body }) => s.tenders.submitBid(params.org, parseId(params.id), body) }),
  route({ method: 'GET', path: '/bid/:token', public: true, rateLimit: 60, handler: ({ s, params }) => s.tenders.bid(params.token) }),
  route({ method: 'PUT', path: '/bid/:token', public: true, rateLimit: 20, body: BidBody, handler: ({ s, params, body }) => s.tenders.changeBid(params.token, body) }),
  route({ method: 'POST', path: '/bid/:token/withdraw', public: true, rateLimit: 10, status: 200, handler: ({ s, params }) => s.tenders.withdrawBid(params.token) }),
];
