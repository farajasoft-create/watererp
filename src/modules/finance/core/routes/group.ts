import { z } from 'zod';
import { hasPermission } from '../common/auth';
import { BadRequestException } from '../common/errors';
import { Decimal, toD128 } from '../common/money';
import { PERMISSIONS } from '../common/permissions';
import { parseId, zCurrency, zDate, zDecimal, zId } from '../common/validation';
import { RATE_TYPES } from '../database/schemas';
import { route } from '../http/router';

const P = PERMISSIONS;

// ---------------------------------------------------------------------------------------------
// FX revaluation & FX reports
// ---------------------------------------------------------------------------------------------

const RevalueQuery = z.object({ entityId: zId, date: zDate, rateType: z.enum(RATE_TYPES).default('CLOSING') });

const fx = [
  route({
    method: 'GET',
    path: '/fx/revaluations/preview',
    permissions: [P.REPORTS_VIEW],
    query: RevalueQuery,
    handler: async ({ s, user, query: q }) => {
      const { all: _all, ...result } = await s.revaluation.compute(user, q.entityId, q.date, q.rateType);
      return result;
    },
  }),
  route({
    method: 'POST',
    path: '/fx/revaluations',
    permissions: [P.FX_REVALUE],
    body: RevalueQuery,
    handler: ({ s, user, body }) => s.revaluation.post(user, body.entityId, body.date, body.rateType),
  }),
  route({
    method: 'GET',
    path: '/fx/revaluations',
    permissions: [P.REPORTS_VIEW],
    query: z.object({ entityId: zId }),
    handler: ({ s, user, query }) => s.revaluation.list(user, query.entityId),
  }),
  route({
    method: 'GET',
    path: '/fx/revaluations/:id',
    permissions: [P.REPORTS_VIEW],
    handler: ({ s, user, params }) => s.revaluation.get(user, parseId(params.id)),
  }),
  route({
    method: 'GET',
    path: '/reports/fx-exposure',
    permissions: [P.REPORTS_VIEW],
    query: z.object({ entityId: zId, asOf: zDate }),
    handler: ({ s, user, query }) => s.fxReports.exposure(user, query.entityId, query.asOf),
  }),
  route({
    method: 'GET',
    path: '/reports/fx-gains',
    permissions: [P.REPORTS_VIEW],
    query: z.object({ entityId: zId, from: zDate, to: zDate }),
    handler: ({ s, user, query }) => s.fxReports.gains(user, query.entityId, query.from, query.to),
  }),
  route({
    method: 'GET',
    path: '/reports/inter-branch',
    permissions: [P.REPORTS_VIEW],
    query: z.object({ entityId: zId, asOf: zDate }),
    handler: ({ s, user, query }) => s.fxReports.interBranch(user, query.entityId, query.asOf),
  }),
];

// ---------------------------------------------------------------------------------------------
// Exchange-rate tools: bulk import (feeds, files) and deriving monthly AVERAGE / CLOSING rates
// ---------------------------------------------------------------------------------------------

const rates = [
  route({
    method: 'POST',
    path: '/exchange-rates/import',
    permissions: [P.RATES_MANAGE],
    body: z.object({
      source: z.string().trim().min(1).max(100),
      rates: z
        .array(
          z.object({
            fromCurrency: zCurrency,
            toCurrency: zCurrency,
            rateType: z.enum(RATE_TYPES).default('SPOT'),
            rate: zDecimal.refine((d) => d.gt(0), 'Rate must be positive'),
            effectiveDate: zDate,
          }),
        )
        .min(1)
        .max(5000),
    }),
    handler: async ({ s, user, body }) => {
      const known = new Set((await s.db.currencies.find({}, { code: 1 }).lean()).map((c) => c.code));
      const bad = body.rates.find((r) => !known.has(r.fromCurrency) || !known.has(r.toCurrency) || r.fromCurrency === r.toCurrency);
      if (bad) throw new BadRequestException(`Invalid currency pair ${bad.fromCurrency}/${bad.toCurrency}`);
      // Skip rates already captured for the same pair, type and date (unless rejected).
      const existing = await s.db.exchangeRates
        .find({ organisationId: user.organisationId, status: { $ne: 'REJECTED' }, effectiveDate: { $in: [...new Set(body.rates.map((r) => r.effectiveDate.getTime()))].map((t) => new Date(t)) } }, { fromCurrency: 1, toCurrency: 1, rateType: 1, effectiveDate: 1 })
        .lean();
      const key = (r: { fromCurrency: string; toCurrency: string; rateType: string; effectiveDate: Date }) => `${r.fromCurrency}${r.toCurrency}${r.rateType}${r.effectiveDate.getTime()}`;
      const seen = new Set(existing.map(key));
      const fresh = body.rates.filter((r) => !seen.has(key(r)) && (seen.add(key(r)), true));
      const approve = hasPermission(user, P.RATES_APPROVE);
      if (fresh.length) {
        await s.db.exchangeRates.insertMany(
          fresh.map((r) => ({
            ...r,
            rate: toD128(r.rate),
            organisationId: user.organisationId,
            source: body.source,
            status: approve ? 'APPROVED' : 'PENDING',
            createdBy: user.id,
            approvedBy: approve ? user.id : null,
            approvedAt: approve ? new Date() : null,
          })),
        );
      }
      await s.audit.log(user, { action: 'fx.rate.import', recordType: 'ExchangeRate', summary: `Imported ${fresh.length} rate(s) from ${body.source}; skipped ${body.rates.length - fresh.length} already captured` });
      return { imported: fresh.length, skipped: body.rates.length - fresh.length, status: approve ? 'APPROVED' : 'PENDING' };
    },
  }),

  /** Monthly AVERAGE (mean of approved SPOT rates in the month) and CLOSING (last SPOT) rates for a pair. */
  route({
    method: 'POST',
    path: '/exchange-rates/derive',
    permissions: [P.RATES_MANAGE],
    body: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM'), fromCurrency: zCurrency, toCurrency: zCurrency }),
    handler: async ({ s, user, body }) => {
      const [y, m] = body.month.split('-').map(Number);
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0));
      const base = { organisationId: user.organisationId, fromCurrency: body.fromCurrency, toCurrency: body.toCurrency, rateType: 'SPOT', status: 'APPROVED' };
      const inMonth = await s.db.exchangeRates.find({ ...base, effectiveDate: { $gte: start, $lte: end } }).sort({ effectiveDate: 1 }).lean();
      const closing = await s.currencies.findRate(user.organisationId, body.fromCurrency, body.toCurrency, end, 'SPOT');
      if (!closing) throw new BadRequestException(`No approved SPOT ${body.fromCurrency}/${body.toCurrency} rate on or before ${end.toISOString().slice(0, 10)}`);
      const averageOf = inMonth.length ? inMonth.map((r) => new Decimal(r.rate.toString())) : [closing.rate];
      const average = averageOf.reduce((a, r) => a.plus(r), new Decimal(0)).div(averageOf.length).toDecimalPlaces(6);
      const approve = hasPermission(user, P.RATES_APPROVE);
      const docs = [
        { rateType: 'AVERAGE', rate: average, effectiveDate: start, source: `Derived: mean of ${averageOf.length} SPOT rate(s) in ${body.month}` },
        { rateType: 'CLOSING', rate: closing.rate.toDecimalPlaces(6), effectiveDate: end, source: `Derived: last SPOT on or before ${end.toISOString().slice(0, 10)}` },
      ];
      for (const d of docs) {
        await s.db.exchangeRates.updateMany(
          { organisationId: user.organisationId, fromCurrency: body.fromCurrency, toCurrency: body.toCurrency, rateType: d.rateType, effectiveDate: d.effectiveDate, status: { $ne: 'REJECTED' } },
          { status: 'REJECTED' },
        );
        await s.db.exchangeRates.create({
          ...d,
          rate: toD128(d.rate),
          organisationId: user.organisationId,
          fromCurrency: body.fromCurrency,
          toCurrency: body.toCurrency,
          status: approve ? 'APPROVED' : 'PENDING',
          createdBy: user.id,
          approvedBy: approve ? user.id : null,
          approvedAt: approve ? new Date() : null,
        });
      }
      await s.audit.log(user, {
        action: 'fx.rate.derive',
        recordType: 'ExchangeRate',
        summary: `${body.fromCurrency}/${body.toCurrency} ${body.month}: AVERAGE ${average.toFixed()}, CLOSING ${closing.rate.toDecimalPlaces(6).toFixed()}`,
      });
      return { month: body.month, average: average.toFixed(), closing: closing.rate.toDecimalPlaces(6).toFixed(), basedOn: averageOf.length, status: approve ? 'APPROVED' : 'PENDING' };
    },
  }),
];

// ---------------------------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------------------------

const AdjustmentBody = z.object({
  date: zDate,
  description: z.string().trim().min(1).max(500),
  entityId: zId.nullable().optional(),
  lines: z
    .array(z.object({ accountId: zId, description: z.string().trim().max(500).optional(), debit: zDecimal.nullable().optional(), credit: zDecimal.nullable().optional() }))
    .min(2)
    .max(200),
});

const consolidation = [
  route({
    method: 'GET',
    path: '/consolidation',
    permissions: [P.CONSOLIDATION_VIEW],
    query: z.object({
      from: zDate,
      asOf: zDate,
      entityIds: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : v.split(',')).filter(Boolean)))
        .pipe(z.array(zId)),
    }),
    handler: ({ s, user, query }) => s.consolidation.report(user, query),
  }),
  route({ method: 'GET', path: '/consolidation/adjustments', permissions: [P.CONSOLIDATION_VIEW], handler: ({ s, user }) => s.consolidation.list(user) }),
  route({ method: 'GET', path: '/consolidation/adjustments/:id', permissions: [P.CONSOLIDATION_VIEW], handler: ({ s, user, params }) => s.consolidation.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/consolidation/adjustments', permissions: [P.CONSOLIDATION_MANAGE], body: AdjustmentBody, handler: ({ s, user, body }) => s.consolidation.create(user, body) }),
  route({
    method: 'PATCH',
    path: '/consolidation/adjustments/:id',
    permissions: [P.CONSOLIDATION_MANAGE],
    body: AdjustmentBody,
    handler: ({ s, user, params, body }) => s.consolidation.update(user, parseId(params.id), body),
  }),
  ...(['submit', 'approve', 'reject', 'void'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/consolidation/adjustments/:id/${action}`,
      permissions: [action === 'submit' ? P.CONSOLIDATION_MANAGE : P.CONSOLIDATION_APPROVE],
      body: z.object({ reason: z.string().trim().max(500).optional() }),
      handler: ({ s, user, params, body }) => s.consolidation.act(user, parseId(params.id), action, body.reason),
    }),
  ),
];

const InvestmentBody = z.object({
  parentEntityId: zId,
  subsidiaryEntityId: zId,
  acquisitionDate: zDate,
  investmentAccountId: zId,
  cost: zDecimal,
  ownershipPercent: zDecimal,
  goodwillAccountId: zId,
  notes: z.string().trim().max(1000).optional(),
});

const investments = [
  route({ method: 'GET', path: '/consolidation/investments', permissions: [P.CONSOLIDATION_VIEW], handler: ({ s, user }) => s.consolidation.investments(user) }),
  route({ method: 'POST', path: '/consolidation/investments', permissions: [P.CONSOLIDATION_APPROVE], body: InvestmentBody, handler: ({ s, user, body }) => s.consolidation.createInvestment(user, body) }),
  route({
    method: 'PATCH',
    path: '/consolidation/investments/:id',
    permissions: [P.CONSOLIDATION_APPROVE],
    body: InvestmentBody.extend({ isActive: z.boolean().optional() }),
    handler: ({ s, user, params, body }) => s.consolidation.updateInvestment(user, parseId(params.id), body),
  }),
];

export const groupRoutes = [...fx, ...rates, ...consolidation, ...investments];
