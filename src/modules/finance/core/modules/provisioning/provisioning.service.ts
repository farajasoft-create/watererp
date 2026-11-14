import { ConflictException } from '../../common/errors';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { SYSTEM_ROLES } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { AuditService } from '../audit/audit.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { PeriodsService } from '../periods/periods.service';
import { toD128 } from '../../common/money';
import { ASSET_ACCOUNTS, ASSET_CATEGORIES, CHART_OF_ACCOUNTS, CURRENCIES, DEFAULT_DEPARTMENTS, EXPENSE_CATEGORIES, SUBLEDGER_ACCOUNTS, taxTemplatesFor } from './templates';

export const PASSWORD_ROUNDS = 11;
/** Bumped when tenants need a data migration (see MigrationsService). */
export const CURRENT_SCHEMA_VERSION = 11;

export interface ProvisionInput {
  organisationName: string;
  adminName: string;
  email: string;
  password: string;
  entityCode: string;
  entityName: string;
  country?: string;
  functionalCurrency: string;
  fiscalYearStart: Date;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

/** Creates a ready-to-use tenant: roles, owner, first entity and branch, chart of accounts and fiscal year. */
export class ProvisioningService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly currencies: CurrenciesService,
    private readonly periods: PeriodsService,
  ) {}

  async ensureReferenceData() {
    await this.db.currencies.bulkWrite(
      CURRENCIES.map((c) => ({ updateOne: { filter: { code: c.code }, update: { $set: c }, upsert: true } })),
    );
    this.currencies.invalidateCache();
  }

  async provision(input: ProvisionInput) {
    await this.ensureReferenceData();
    const email = input.email.toLowerCase().trim();
    if (await this.db.users.exists({ email })) throw new ConflictException('An account with this email already exists');
    const passwordHash = await bcrypt.hash(input.password, PASSWORD_ROUNDS);

    return this.db.transaction(async (session) => {
      const functional = input.functionalCurrency;
      const [org] = await this.db.organisations.create(
        [
          {
            name: input.organisationName,
            slug: slugify(input.organisationName),
            reportingCurrency: functional,
            activeCurrencies: [...new Set([functional, 'USD', 'EUR', 'GBP'])],
          },
        ],
        { session },
      );
      const organisationId = org._id;
      const system = { organisationId, name: 'system' };

      const roles = await this.db.roles.insertMany(
        SYSTEM_ROLES.map((r) => ({ ...r, organisationId, isSystem: true })),
        { session },
      );
      const ownerRoles = roles.filter((r) => r.name === 'Administrator' || r.name === 'Finance Director').map((r) => r._id);
      const [user] = await this.db.users.create(
        [{ organisationId, email, name: input.adminName, passwordHash, roleIds: ownerRoles }],
        { session },
      );

      const [entity] = await this.db.entities.create(
        [
          {
            organisationId,
            code: input.entityCode,
            name: input.entityName,
            legalName: input.entityName,
            country: input.country ?? '',
            functionalCurrency: functional,
          },
        ],
        { session },
      );
      await this.db.branches.create(
        [{ organisationId, entityId: entity._id, code: 'HQ', name: 'Head Office', currency: functional, country: input.country ?? '' }],
        { session },
      );
      await this.db.dimensions.insertMany(
        DEFAULT_DEPARTMENTS.map((d) => ({ ...d, organisationId, type: 'DEPARTMENT' })),
        { session },
      );

      const accountIds = await this.createChartOfAccounts(organisationId, functional, session);
      await this.db.organisations.updateOne(
        { _id: organisationId },
        { 'settings.retainedEarningsAccountId': accountIds.get('3200'), ...this.subledgerSettings(accountIds), schemaVersion: CURRENT_SCHEMA_VERSION },
        { session },
      );
      await this.createTaxCodes(organisationId, input.country, accountIds, session);
      await this.createOperationalDefaults(organisationId, accountIds, session);
      await this.periods.createFiscalYear(system, entity._id, input.fiscalYearStart, session);

      await this.audit.log(
        { ...system, name: input.adminName },
        { action: 'organisation.create', recordType: 'Organisation', recordId: organisationId, summary: `Organisation ${org.name} created` },
        session,
      );
      return { organisation: org.toObject(), user: user.toObject(), entity: entity.toObject() };
    });
  }

  /**
   * Sets finance up for an organisation of the platform: the same _id, system roles, the first entity
   * and branch, chart of accounts, tax codes and the fiscal year. No owner user is created; platform
   * users get finance profiles when they first open finance.
   */
  async provisionPlatformOrganisation(input: { organisationId: Types.ObjectId; organisationName: string; entityCode: string; entityName: string; country?: string; functionalCurrency: string; fiscalYearStart: Date }) {
    await this.ensureReferenceData();
    return this.db.transaction(async (session) => {
      const functional = input.functionalCurrency;
      const organisationId = input.organisationId;
      await this.db.organisations.create(
        [{ _id: organisationId, name: input.organisationName, slug: slugify(input.organisationName), reportingCurrency: functional, activeCurrencies: [...new Set([functional, 'USD', 'EUR', 'GBP'])] }],
        { session },
      );
      const system = { organisationId, name: 'system' };
      await this.db.roles.insertMany(SYSTEM_ROLES.map((r) => ({ ...r, organisationId, isSystem: true })), { session });
      const [entity] = await this.db.entities.create(
        [{ organisationId, code: input.entityCode, name: input.entityName, legalName: input.entityName, country: input.country ?? '', functionalCurrency: functional }],
        { session },
      );
      await this.db.branches.create([{ organisationId, entityId: entity._id, code: 'HQ', name: 'Head Office', currency: functional, country: input.country ?? '' }], { session });
      await this.db.dimensions.insertMany(DEFAULT_DEPARTMENTS.map((d) => ({ ...d, organisationId, type: 'DEPARTMENT' })), { session });
      const accountIds = await this.createChartOfAccounts(organisationId, functional, session);
      await this.db.organisations.updateOne(
        { _id: organisationId },
        { 'settings.retainedEarningsAccountId': accountIds.get('3200'), ...this.subledgerSettings(accountIds), schemaVersion: CURRENT_SCHEMA_VERSION },
        { session },
      );
      await this.createTaxCodes(organisationId, input.country, accountIds, session);
      await this.createOperationalDefaults(organisationId, accountIds, session);
      await this.periods.createFiscalYear(system, entity._id, input.fiscalYearStart, session);
      await this.audit.log(system, { action: 'organisation.create', recordType: 'Organisation', recordId: organisationId, summary: `Finance set up for ${input.organisationName}` }, session);
      return { entityId: entity._id };
    });
  }

  /** Organisation settings pointing the subledgers at their control and FX accounts. */
  subledgerSettings(accountIds: Map<string, Types.ObjectId>) {
    return {
      'settings.receivablesAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.receivables) ?? null,
      'settings.payablesAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.payables) ?? null,
      'settings.fxGainAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.fxGain) ?? null,
      'settings.fxLossAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.fxLoss) ?? null,
      'settings.unrealisedFxGainAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.unrealisedFxGain) ?? null,
      'settings.unrealisedFxLossAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.unrealisedFxLoss) ?? null,
      'settings.interBranchAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.interBranch) ?? null,
      'settings.employeeClaimsAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.employeeClaims) ?? null,
      'settings.grniAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.grni) ?? null,
      'settings.landedCostAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.landedCosts) ?? null,
      'settings.salariesPayableAccountId': accountIds.get(SUBLEDGER_ACCOUNTS.salariesPayable) ?? null,
    };
  }

  /** Starter tax codes for the country; codes that already exist are left alone. */
  async createTaxCodes(organisationId: Types.ObjectId, country: string | undefined, accountIds: Map<string, Types.ObjectId>, session?: ClientSession) {
    const templates = taxTemplatesFor(country);
    for (const t of templates.codes) {
      const output = accountIds.get(t.output);
      if (!output) continue;
      await this.db.taxCodes.updateOne(
        { organisationId, code: t.code },
        {
          $setOnInsert: {
            organisationId,
            code: t.code,
            name: t.name,
            description: t.description ?? '',
            kind: t.kind,
            country: templates.country,
            rates: [{ rate: toD128(t.rate), effectiveFrom: new Date('2000-01-01T00:00:00.000Z') }],
            outputAccountId: output,
            inputAccountId: t.input ? (accountIds.get(t.input) ?? null) : null,
            etimsTaxType: t.etims ?? null,
            isActive: true,
          },
        },
        { upsert: true, session },
      );
    }
  }

  /** Starter asset and expense categories, and a main warehouse at each entity's first branch. */
  async createOperationalDefaults(organisationId: Types.ObjectId, accountIds: Map<string, Types.ObjectId>, session?: ClientSession) {
    const a = (code: string) => accountIds.get(code);
    if (a(ASSET_ACCOUNTS.asset) && a(ASSET_ACCOUNTS.accumulated) && a(ASSET_ACCOUNTS.expense) && a(ASSET_ACCOUNTS.disposal)) {
      for (const c of ASSET_CATEGORIES) {
        await this.db.assetCategories.updateOne(
          { organisationId, code: c.code },
          {
            $setOnInsert: {
              organisationId,
              code: c.code,
              name: c.name,
              method: c.method,
              usefulLifeMonths: c.usefulLifeMonths,
              annualRatePercent: 'annualRatePercent' in c ? toD128(c.annualRatePercent) : null,
              residualPercent: toD128(c.residualPercent),
              assetAccountId: a(ASSET_ACCOUNTS.asset),
              accumulatedDepreciationAccountId: a(ASSET_ACCOUNTS.accumulated),
              depreciationExpenseAccountId: a(ASSET_ACCOUNTS.expense),
              disposalAccountId: a(ASSET_ACCOUNTS.disposal),
            },
          },
          { upsert: true, session },
        );
      }
    }
    for (const c of EXPENSE_CATEGORIES) {
      if (!a(c.account)) continue;
      await this.db.expenseCategories.updateOne(
        { organisationId, code: c.code },
        { $setOnInsert: { organisationId, code: c.code, name: c.name, accountId: a(c.account), limitPerLine: c.limit ? toD128(c.limit) : null } },
        { upsert: true, session },
      );
    }
    const entities = await this.db.entities.find({ organisationId }).session(session ?? null).lean();
    for (const e of entities) {
      if (await this.db.warehouses.exists({ organisationId, entityId: e._id }).session(session ?? null)) continue;
      const branch = await this.db.branches.findOne({ organisationId, entityId: e._id }).sort({ createdAt: 1 }).session(session ?? null).lean();
      if (branch) await this.db.warehouses.create([{ organisationId, entityId: e._id, branchId: branch._id, code: `${e.code}-MAIN`, name: `${e.name} main store` }], { session });
    }
  }

  private async createChartOfAccounts(organisationId: Types.ObjectId, functional: string, session: ClientSession) {
    const ids = new Map<string, Types.ObjectId>();
    for (const t of CHART_OF_ACCOUNTS) {
      const currency = t.currency && t.currency !== functional ? t.currency : null;
      const [account] = await this.db.accounts.create(
        [
          {
            organisationId,
            code: t.code,
            name: currency || !t.currency ? t.name : 'Bank - Secondary Account',
            accountClass: t.accountClass,
            accountType: t.accountType,
            parentId: t.parent ? ids.get(t.parent) : null,
            isPostable: !t.header,
            isControl: !!t.control,
            allowManualPosting: !t.control,
            requiresDepartment: !!t.requiresDepartment,
            currency,
          },
        ],
        { session },
      );
      ids.set(t.code, account._id);
    }
    return ids;
  }
}
