import { Types } from 'mongoose';
import { PHASE2_PERMISSIONS, PHASE3_PERMISSIONS, PHASE4_PERMISSIONS, PHASE5_PERMISSIONS, PHASE7_PERMISSIONS, PHASE10_PERMISSIONS, SYSTEM_ROLES } from '../../common/permissions';
import { Db } from '../../database/db.service';
import { WarehouseService } from '../analytics/warehouse.service';
import { WorkflowService } from '../workflow/workflow.service';
import { CURRENT_SCHEMA_VERSION, ProvisioningService } from './provisioning.service';

/**
 * Brings tenants created by earlier releases up to date. Runs when a server instance starts and in
 * `npm run db:setup`; each step runs once per organisation and is recorded in organisation.schemaVersion.
 */
export class MigrationsService {
  constructor(
    private readonly db: Db,
    private readonly provisioning: ProvisioningService,
    private readonly workflow: WorkflowService,
    private readonly warehouse: WarehouseService,
  ) {}

  async run(log: (message: string) => void = () => {}) {
    const pending = await this.db.organisations.find({ $or: [{ schemaVersion: { $lt: CURRENT_SCHEMA_VERSION } }, { schemaVersion: { $exists: false } }] }).lean();
    for (const org of pending) {
      if ((org.schemaVersion ?? 1) < 2) await this.toVersion2(org._id);
      if ((org.schemaVersion ?? 1) < 3) await this.toVersion3(org._id);
      if ((org.schemaVersion ?? 1) < 4) await this.toVersion4(org._id);
      if ((org.schemaVersion ?? 1) < 5) await this.toVersion5(org._id);
      if ((org.schemaVersion ?? 1) < 6) await this.toVersion6(org._id);
      if ((org.schemaVersion ?? 1) < 7) await this.toVersion7(org._id);
      if ((org.schemaVersion ?? 1) < 8) await this.toVersion8(org._id);
      if ((org.schemaVersion ?? 1) < 9) await this.toVersion9(org._id);
      if ((org.schemaVersion ?? 1) < 10) await this.toVersion10(org._id);
      if ((org.schemaVersion ?? 1) < 11) await this.toVersion11(org._id);
      log(`Migrated organisation ${org.name} to schema version ${CURRENT_SCHEMA_VERSION}`);
    }
  }

  /** Group: goodwill and investments in subsidiaries accounts. */
  private async toVersion11(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      const parent = await this.db.accounts.findOne({ organisationId, code: '1600' }).session(session).lean();
      for (const a of [
        { code: '1630', name: 'Goodwill' },
        { code: '1640', name: 'Investments in Subsidiaries' },
      ]) {
        if (await this.db.accounts.exists({ organisationId, code: a.code }).session(session)) continue;
        await this.db.accounts.create([{ organisationId, code: a.code, name: a.name, accountClass: 'ASSET', accountType: 'NON_CURRENT_ASSET', parentId: parent?._id ?? null }], { session });
      }
      await this.db.organisations.updateOne({ _id: organisationId }, { schemaVersion: 11 }, { session });
    });
  }

  /** Payments: a net salaries payable account, linked in settings. */
  private async toVersion10(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      if (!(await this.db.accounts.exists({ organisationId, code: '2145' }).session(session))) {
        const parent = await this.db.accounts.findOne({ organisationId, code: '2100' }).session(session).lean();
        await this.db.accounts.create([{ organisationId, code: '2145', name: 'Net Salaries Payable', accountClass: 'LIABILITY', accountType: 'ACCRUAL', parentId: parent?._id ?? null }], { session });
      }
      const account = await this.db.accounts.findOne({ organisationId, code: '2145' }).session(session).lean();
      const org = await this.db.organisations.findById(organisationId).session(session).lean();
      await this.db.organisations.updateOne({ _id: organisationId }, { schemaVersion: 10, ...(!org?.settings?.salariesPayableAccountId && { 'settings.salariesPayableAccountId': account!._id }) }, { session });
    });
  }

  /** Procurement: goods received not invoiced and landed-cost clearing accounts, linked in settings. */
  private async toVersion9(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      const parents = new Map((await this.db.accounts.find({ organisationId, code: { $in: ['1100', '2100'] } }).session(session).lean()).map((a) => [a.code, a._id]));
      const wanted = [
        { code: '2180', name: 'Goods Received Not Invoiced', accountClass: 'LIABILITY', accountType: 'ACCRUAL', parent: '2100', isControl: true, allowManualPosting: false },
        { code: '1320', name: 'Landed Costs Clearing', accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parent: '1100', isControl: false, allowManualPosting: true },
      ];
      for (const a of wanted) {
        if (await this.db.accounts.exists({ organisationId, code: a.code }).session(session)) continue;
        await this.db.accounts.create([{ organisationId, code: a.code, name: a.name, accountClass: a.accountClass, accountType: a.accountType, parentId: parents.get(a.parent) ?? null, isControl: a.isControl, allowManualPosting: a.allowManualPosting }], { session });
      }
      const ids = new Map((await this.db.accounts.find({ organisationId, code: { $in: ['2180', '1320'] } }).session(session).lean()).map((a) => [a.code, a._id]));
      const org = await this.db.organisations.findById(organisationId).session(session).lean();
      const update: Record<string, unknown> = { schemaVersion: 9 };
      if (!org?.settings?.grniAccountId) update['settings.grniAccountId'] = ids.get('2180');
      if (!org?.settings?.landedCostAccountId) update['settings.landedCostAccountId'] = ids.get('1320');
      await this.db.organisations.updateOne({ _id: organisationId }, update, { session });
    });
  }

  /**
   * Monthly ledger totals become exact and maintained with every posting: rebuild them once from the
   * ledger so reports can read whole months from them.
   */
  private async toVersion8(organisationId: Types.ObjectId) {
    await this.warehouse.rebuild(organisationId);
    // Earlier audit snapshots could hold credential fields; they are removed from the trail.
    const paths = ['passwordHash', 'mfa.secret', 'mfa.pendingSecret', 'mfa.recoveryCodes', 'tokenHash', 'hash', 'settings.sso.clientSecret', 'mpesa.consumerKey', 'mpesa.consumerSecret', 'mpesa.passkey', 'mpesa.callbackSecret', 'mpesa.payouts.securityCredential', 'cmcKey'];
    const unset = Object.fromEntries(paths.flatMap((p) => [[`before.${p}`, ''], [`after.${p}`, '']]));
    await this.db.auditEvents.updateMany({ organisationId }, { $unset: unset });
    await this.db.organisations.updateOne({ _id: organisationId }, { schemaVersion: 8 });
  }

  /**
   * Phase 10: accounts for tax customers withhold from receipts (linked to the withholding codes), eTIMS
   * tax types on Kenyan VAT codes, and the eTIMS and SMS permissions.
   */
  private async toVersion7(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      for (const template of SYSTEM_ROLES) {
        const added = template.permissions.filter((p) => PHASE10_PERMISSIONS.includes(p));
        if (added.length) {
          await this.db.roles.updateOne({ organisationId, isSystem: true, name: template.name }, { $addToSet: { permissions: { $each: added } } }, { session });
        }
      }
      const parent = await this.db.accounts.findOne({ organisationId, code: '1100' }).session(session).lean();
      for (const [code, name] of [
        ['1460', 'Withholding Tax Recoverable'],
        ['1465', 'VAT Withheld by Customers'],
      ]) {
        if (await this.db.accounts.exists({ organisationId, code }).session(session)) continue;
        await this.db.accounts.create([{ organisationId, code, name, accountClass: 'ASSET', accountType: 'CURRENT_ASSET', parentId: parent?._id ?? null }], { session });
      }
      const ids = new Map((await this.db.accounts.find({ organisationId, code: { $in: ['1460', '1465'] } }, { code: 1 }).session(session).lean()).map((a) => [a.code, a._id]));
      for (const code of await this.db.taxCodes.find({ organisationId, kind: 'WITHHOLDING', inputAccountId: null }).session(session).lean()) {
        await this.db.taxCodes.updateOne({ _id: code._id }, { inputAccountId: ids.get(/VAT/i.test(code.code) ? '1465' : '1460') }, { session });
      }
      const etims: Record<string, string> = { VAT16: 'B', VAT8: 'E', ZERO: 'C', EXEMPT: 'A' };
      for (const [code, type] of Object.entries(etims)) {
        await this.db.taxCodes.updateOne({ organisationId, code, kind: 'VAT', country: /^kenya$/i, etimsTaxType: null }, { etimsTaxType: type }, { session });
      }
      await this.db.organisations.updateOne({ _id: organisationId }, { schemaVersion: 7 }, { session });
    });
  }

  /** Phase 7: the AI-assistance permission (AI stays off until the organisation enables it). */
  private async toVersion6(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      for (const template of SYSTEM_ROLES) {
        const added = template.permissions.filter((p) => PHASE7_PERMISSIONS.includes(p));
        if (added.length) {
          await this.db.roles.updateOne({ organisationId, isSystem: true, name: template.name }, { $addToSet: { permissions: { $each: added } } }, { session });
        }
      }
      await this.db.organisations.updateOne({ _id: organisationId }, { schemaVersion: 6 }, { session });
    });
  }

  /**
   * Phase 5: integration, import/export, workflow and analytics permissions; approval requests for
   * documents already awaiting approval, so they appear in the approvals inbox.
   */
  private async toVersion5(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      for (const template of SYSTEM_ROLES) {
        const added = template.permissions.filter((p) => PHASE5_PERMISSIONS.includes(p));
        if (added.length) {
          await this.db.roles.updateOne({ organisationId, isSystem: true, name: template.name }, { $addToSet: { permissions: { $each: added } } }, { session });
        }
      }
    });
    await this.workflow.backfill(organisationId);
    await this.db.organisations.updateOne({ _id: organisationId }, { schemaVersion: 5 });
  }

  /**
   * Phase 4: inventory, asset, expense and budget permissions; an employee claims payable account and
   * setting; starter asset and expense categories; a main warehouse per entity.
   */
  private async toVersion4(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      for (const template of SYSTEM_ROLES) {
        const added = template.permissions.filter((p) => PHASE4_PERMISSIONS.includes(p));
        if (added.length) {
          await this.db.roles.updateOne({ organisationId, isSystem: true, name: template.name }, { $addToSet: { permissions: { $each: added } } }, { session });
        }
      }
      if (!(await this.db.accounts.exists({ organisationId, code: '2170' }).session(session))) {
        const parent = await this.db.accounts.findOne({ organisationId, code: '2100' }).session(session).lean();
        await this.db.accounts.create(
          [{ organisationId, code: '2170', name: 'Employee Claims Payable', accountClass: 'LIABILITY', accountType: 'CURRENT_LIABILITY', parentId: parent?._id ?? null, isControl: true, allowManualPosting: false }],
          { session },
        );
      }
      const accounts = await this.db.accounts.find({ organisationId }, { code: 1 }).session(session).lean();
      const ids = new Map(accounts.map((a) => [a.code, a._id]));
      const org = await this.db.organisations.findById(organisationId).session(session).lean();
      const update: Record<string, unknown> = { schemaVersion: 4 };
      if (!org?.settings?.employeeClaimsAccountId) update['settings.employeeClaimsAccountId'] = ids.get('2170');
      if (!org?.settings?.budgetControl) update['settings.budgetControl'] = 'WARN';
      await this.db.organisations.updateOne({ _id: organisationId }, update, { session });
      await this.provisioning.createOperationalDefaults(organisationId, ids, session);
    });
  }

  /**
   * Phase 3: revaluation and consolidation permissions, unrealised FX and inter-branch settings. The
   * inter-branch clearing account becomes a control account (only the system posts to it).
   */
  private async toVersion3(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      for (const template of SYSTEM_ROLES) {
        const added = template.permissions.filter((p) => PHASE3_PERMISSIONS.includes(p));
        if (added.length) {
          await this.db.roles.updateOne({ organisationId, isSystem: true, name: template.name }, { $addToSet: { permissions: { $each: added } } }, { session });
        }
      }
      const accounts = await this.db.accounts.find({ organisationId }, { code: 1, accountType: 1 }).session(session).lean();
      const ids = new Map(accounts.map((a) => [a.code, a._id]));
      const org = await this.db.organisations.findById(organisationId).session(session).lean();
      const settings = Object.fromEntries(
        Object.entries(this.provisioning.subledgerSettings(ids)).filter(([key]) => !org?.settings?.[key.split('.')[1] as keyof typeof org.settings]),
      );
      const clearing = org?.settings?.interBranchAccountId ?? (settings['settings.interBranchAccountId'] as Types.ObjectId | null | undefined);
      if (clearing) await this.db.accounts.updateOne({ _id: clearing, accountType: 'INTER_BRANCH' }, { isControl: true, allowManualPosting: false }, { session });
      await this.db.organisations.updateOne({ _id: organisationId }, { ...settings, schemaVersion: 3 }, { session });
    });
  }

  /** Phase 2: commercial-finance permissions on system roles, subledger accounts and starter tax codes. */
  private async toVersion2(organisationId: Types.ObjectId) {
    await this.db.transaction(async (session) => {
      for (const template of SYSTEM_ROLES) {
        const added = template.permissions.filter((p) => PHASE2_PERMISSIONS.includes(p));
        if (added.length) {
          await this.db.roles.updateOne({ organisationId, isSystem: true, name: template.name }, { $addToSet: { permissions: { $each: added } } }, { session });
        }
      }
      const accounts = await this.db.accounts.find({ organisationId }, { code: 1 }).session(session).lean();
      const ids = new Map(accounts.map((a) => [a.code, a._id]));
      const org = await this.db.organisations.findById(organisationId).session(session).lean();
      const settings = Object.fromEntries(
        Object.entries(this.provisioning.subledgerSettings(ids)).filter(([key]) => !org?.settings?.[key.split('.')[1] as keyof typeof org.settings]),
      );
      await this.db.organisations.updateOne({ _id: organisationId }, { ...settings, schemaVersion: 2 }, { session });
      const hasTaxCodes = await this.db.taxCodes.exists({ organisationId }).session(session);
      if (!hasTaxCodes) {
        const entity = await this.db.entities.findOne({ organisationId }).sort({ createdAt: 1 }).session(session).lean();
        await this.provisioning.createTaxCodes(organisationId, entity?.country, ids, session);
      }
    });
  }
}
