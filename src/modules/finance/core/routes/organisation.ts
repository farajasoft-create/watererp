import { Types } from 'mongoose';
import { z } from 'zod';
import { BadRequestException } from '../common/errors';
import { toD128 } from '../common/money';
import { PERMISSIONS } from '../common/permissions';
import { zCurrency, zDecimal, zId } from '../common/validation';
import { Db } from '../database/db.service';
import { route } from '../http/router';
import { forgetMfaPolicy } from '../common/auth';

const OrgBody = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  reportingCurrency: zCurrency.optional(),
  settings: z
    .object({
      retainedEarningsAccountId: zId.nullable().optional(),
      requireJournalApproval: z.boolean().optional(),
      supplierOnboardingApproval: z.boolean().optional(),
      requireProcurementPlan: z.boolean().optional(),
      requireGoodsInspection: z.boolean().optional(),
      stockInTransitAccountId: zId.nullable().optional(),
      receivablesAccountId: zId.nullable().optional(),
      payablesAccountId: zId.nullable().optional(),
      fxGainAccountId: zId.nullable().optional(),
      fxLossAccountId: zId.nullable().optional(),
      unrealisedFxGainAccountId: zId.nullable().optional(),
      unrealisedFxLossAccountId: zId.nullable().optional(),
      interBranchAccountId: zId.nullable().optional(),
      employeeClaimsAccountId: zId.nullable().optional(),
      budgetControl: z.enum(['OFF', 'WARN', 'BLOCK']).optional(),
      budgetAlertPercent: z.number().int().min(1).max(100).nullable().optional(),
      documentRetentionYears: z.number().int().min(1).max(30).optional(),
      requireMfa: z.boolean().optional(),
      aiEnabled: z.boolean().optional(),
      matchTolerancePercent: zDecimal.refine((d) => d.gte(0) && d.lte(100), 'Must be between 0 and 100').nullable().optional(),
    })
    .optional(),
});

/** Which accounts may be used for each setting: [class, account types or null for any]. */
const ACCOUNT_RULES: Record<string, { label: string; classes: string[]; types?: string[]; control?: boolean }> = {
  retainedEarningsAccountId: { label: 'Retained earnings', classes: ['EQUITY'] },
  receivablesAccountId: { label: 'The receivables control account', classes: ['ASSET'], types: ['RECEIVABLE'], control: true },
  payablesAccountId: { label: 'The payables control account', classes: ['LIABILITY'], types: ['PAYABLE'], control: true },
  fxGainAccountId: { label: 'The FX gain account', classes: ['REVENUE'] },
  fxLossAccountId: { label: 'The FX loss account', classes: ['EXPENSE'] },
  unrealisedFxGainAccountId: { label: 'The unrealised FX gain account', classes: ['REVENUE'] },
  unrealisedFxLossAccountId: { label: 'The unrealised FX loss account', classes: ['EXPENSE'] },
  interBranchAccountId: { label: 'The inter-branch clearing account', classes: ['ASSET', 'LIABILITY'], types: ['INTER_BRANCH', 'CURRENT_ASSET', 'CURRENT_LIABILITY'], control: true },
  employeeClaimsAccountId: { label: 'The employee claims account', classes: ['LIABILITY'], control: true },
};

async function checkAccount(db: Db, organisationId: Types.ObjectId, key: string, id: Types.ObjectId) {
  const rule = ACCOUNT_RULES[key];
  const account = await db.accounts.findOne({ _id: id, organisationId }).lean();
  if (!account || !account.isPostable || !rule.classes.includes(account.accountClass) || (rule.types && !rule.types.includes(account.accountType))) {
    throw new BadRequestException(`${rule.label} must be a postable ${rule.types?.join('/').toLowerCase() ?? rule.classes.join('/').toLowerCase()} account`);
  }
  if (rule.control && account.allowManualPosting) {
    throw new BadRequestException(`${rule.label} must be a control account (no manual postings) so it only moves through the subledger`);
  }
}

export const organisationRoutes = [
  route({
    method: 'GET',
    path: '/organisation',
    handler: ({ s, user }) => s.db.organisations.findById(user.organisationId, { 'settings.sso.clientSecret': 0, 'settings.sso.saml.idpCert': 0, 'settings.scim.tokenHash': 0 }).lean(),
  }),

  route({
    method: 'PATCH',
    path: '/organisation',
    permissions: [PERMISSIONS.ORG_MANAGE],
    body: OrgBody,
    handler: async ({ s, user, body }) => {
      const before = await s.db.organisations.findById(user.organisationId, { 'settings.sso.clientSecret': 0, 'settings.sso.saml.idpCert': 0, 'settings.scim.tokenHash': 0 }).lean();
      const update: Record<string, unknown> = {};
      if (body.name) update.name = body.name;
      if (body.reportingCurrency) {
        await s.currencies.ensureActive(user, body.reportingCurrency);
        update.reportingCurrency = body.reportingCurrency;
      }
      const settings = body.settings ?? {};
      for (const key of Object.keys(ACCOUNT_RULES) as (keyof typeof settings)[]) {
        const value = settings[key] as Types.ObjectId | null | undefined;
        if (value === undefined) continue;
        if (value) await checkAccount(s.db, user.organisationId, key, value);
        update[`settings.${key}`] = value;
      }
      if (settings.requireJournalApproval !== undefined) update['settings.requireJournalApproval'] = settings.requireJournalApproval;
      if (settings.supplierOnboardingApproval !== undefined) update['settings.supplierOnboardingApproval'] = settings.supplierOnboardingApproval;
      if (settings.requireProcurementPlan !== undefined) update['settings.requireProcurementPlan'] = settings.requireProcurementPlan;
      if (settings.requireGoodsInspection !== undefined) update['settings.requireGoodsInspection'] = settings.requireGoodsInspection;
      if (settings.stockInTransitAccountId !== undefined) update['settings.stockInTransitAccountId'] = settings.stockInTransitAccountId;
      if (settings.budgetControl !== undefined) update['settings.budgetControl'] = settings.budgetControl;
      if (settings.budgetAlertPercent !== undefined) update['settings.budgetAlertPercent'] = settings.budgetAlertPercent;
      if (settings.documentRetentionYears !== undefined) update['settings.documentRetentionYears'] = settings.documentRetentionYears;
      if (settings.aiEnabled !== undefined) update['settings.aiEnabled'] = settings.aiEnabled;
      if (settings.requireMfa !== undefined) {
        update['settings.requireMfa'] = settings.requireMfa;
        forgetMfaPolicy(user.organisationId);
      }
      if (settings.matchTolerancePercent !== undefined) {
        update['settings.matchTolerancePercent'] = settings.matchTolerancePercent ? toD128(settings.matchTolerancePercent) : null;
      }
      const after = await s.db.organisations.findByIdAndUpdate(user.organisationId, update, { new: true, projection: { 'settings.sso.clientSecret': 0, 'settings.sso.saml.idpCert': 0, 'settings.scim.tokenHash': 0 } }).lean();
      await s.audit.log(user, { action: 'organisation.update', recordType: 'Organisation', recordId: user.organisationId, summary: 'Updated organisation settings', before, after });
      return after;
    },
  }),
];
