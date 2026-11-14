/**
 * Copies a farajasofterp company into the HR module of an organisation.
 *
 *   npm run import:farajasofterp                        dry run: reads everything, writes nothing, reports
 *   npm run import:farajasofterp -- --commit            writes (safe to repeat: records are matched on farajasofterp ids)
 *   npm run import:farajasofterp -- --commit --with-logins   also gives active staff self-service with their old password
 *
 * Environment (.env.local):
 *   SOURCE_MONGODB_URI            farajasofterp's database (read only)
 *   SOURCE_COMPANY_ID             the company to copy, when the database holds more than one
 *   SOURCE_FIELD_ENCRYPTION_KEY   farajasofterp's FIELD_ENCRYPTION_KEY, if ID, bank or M-Pesa numbers are encrypted
 *   IMPORT_ORG_CODE               the organisation here (defaults to SEED_ORG_CODE)
 */
import { writeFileSync } from 'node:fs';
import mongoose, { Types } from 'mongoose';
import { hrModule } from '@/modules/hr/module';
import type { HrServices } from '@/modules/hr/server/container';
import { FarajasofterpImporter } from '@/modules/hr/server/import/farajasofterp';
import { createPlatform } from '@/platform/container';
import { openConnection } from '@/platform/db';

async function main() {
  const commit = process.argv.includes('--commit');
  const withLogins = process.argv.includes('--with-logins');
  const sourceUri = process.env.SOURCE_MONGODB_URI;
  if (!sourceUri) throw new Error('Set SOURCE_MONGODB_URI to farajasofterp’s database');
  const code = process.env.IMPORT_ORG_CODE ?? process.env.SEED_ORG_CODE ?? 'TACHWASCO';
  const companyId = process.env.SOURCE_COMPANY_ID ? new Types.ObjectId(process.env.SOURCE_COMPANY_ID) : undefined;

  const source = await mongoose.createConnection(sourceUri, { readPreference: 'secondaryPreferred' }).asPromise();
  const conn = await openConnection();
  try {
    const platform = await createPlatform(conn);
    const hr = platform.modules.hr as HrServices | undefined;
    if (!hr) throw new Error('The HR module is not installed');
    const org = await platform.core.db.organisations.findOne({ code }).lean();
    if (!org) throw new Error(`No organisation with code ${code}; run npm run db:seed first or set IMPORT_ORG_CODE`);

    if (commit) {
      await platform.core.db.organisations.updateOne({ _id: org._id }, { $addToSet: { modules: 'hr' } });
      if (!(await hr.db.rateSets.exists({ organisationId: org._id }))) {
        await hrModule.seed!({ db: platform.core.db, core: platform.core, services: hr, organisationId: org._id, demo: false, demoPassword: '' });
      }
    }

    const importer = new FarajasofterpImporter(hr.db, hr.payroll, hr.leave);
    const report = await importer.run(source.db!, org._id, { companyId, commit, withLogins, encryptionKey: process.env.SOURCE_FIELD_ENCRYPTION_KEY });

    const file = `farajasofterp-import-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify(report, null, 2));
    const e = report.employees;
    console.log(`${commit ? 'Imported' : 'DRY RUN – nothing written. Would import'} from "${report.company.name}" into ${org.name}:`);
    console.log(`  employees ${e.found} found: ${e.created} new, ${e.updated} updated, ${e.skipped} skipped; ${report.departments} new departments; ${report.allowances} recurring allowances`);
    console.log(`  payroll history: ${report.payrolls.periods.join(', ') || 'none new'} (${report.payrolls.payslips} payslips)${report.payrolls.skipped.length ? `; skipped ${report.payrolls.skipped.join(', ')}` : ''}`);
    console.log(`  leave: ${report.leaveRequests} applications, ${report.openingBalances} opening balances, ${report.leaveTypes.created} new leave types`);
    if (withLogins) console.log(`  logins: ${report.logins.created} created, ${report.logins.linked} linked`);
    const c = report.comparison;
    if (c && 'error' in c) console.log(`  comparison for ${c.period}: ${c.error}`);
    else if (c) console.log(`  ${c.period} worked again here: net pay ${c.oldNet} in farajasofterp, ${c.newNet} here; ${c.differences.length} employees differ by KES 1 or more`);
    if (report.warnings.length) console.log(`  ${report.warnings.length} warnings, e.g.:\n    ${report.warnings.slice(0, 10).join('\n    ')}`);
    console.log(`Full report: ${file}`);
  } finally {
    await source.close();
    await conn.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
