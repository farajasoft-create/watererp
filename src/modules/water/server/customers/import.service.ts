import { z } from 'zod';
import { AuthUser } from '@/platform/auth';
import { csvRecords } from '@/platform/common/csv';
import { BadRequestException } from '@/platform/common/errors';
import { zDecimal, zPhone } from '@/platform/common/validation';
import { AuditService } from '@/platform/services/audit.service';
import { WaterDb as Db } from '../db';
import { CUSTOMER_CATEGORIES } from '../schemas';
import { CustomersService } from './customers.service';

/** The columns of the customer migration file (a template is downloadable from the import screen). */
export const IMPORT_COLUMNS = ['legacy_account', 'name', 'category', 'phone', 'email', 'id_number', 'kra_pin', 'zone_code', 'tariff_code', 'plot_no', 'location', 'opening_balance', 'status'];

const Row = z.object({
  legacy_account: z.string().min(1, 'legacy_account is required').max(40),
  name: z.string().min(1, 'name is required').max(150),
  category: z.string().transform((v) => (v || 'DOMESTIC').toUpperCase()).pipe(z.enum(CUSTOMER_CATEGORIES)),
  phone: zPhone.optional().or(z.literal('').transform(() => undefined)),
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  id_number: z.string().max(30).optional(),
  kra_pin: z.string().regex(/^([AP]\d{9}[A-Z])?$/i, 'KRA PIN looks like A012345678Z').optional(),
  zone_code: z.string().min(1, 'zone_code is required'),
  tariff_code: z.string().min(1, 'tariff_code is required'),
  plot_no: z.string().max(50).optional(),
  location: z.string().max(200).optional(),
  opening_balance: z.string().transform((v) => v || '0').pipe(zDecimal),
  status: z.string().transform((v) => (v || 'ACTIVE').toUpperCase()).pipe(z.enum(['ACTIVE', 'APPLIED'])),
});

/**
 * Migration of customers from the legacy billing system: a CSV of accounts with their zone, tariff and
 * opening balance is checked row by row first (a dry run lists every problem and writes nothing); only a
 * clean file is loaded. Each new account keeps its legacy number in its notes, the opening balance goes on
 * the statement, and the result maps every legacy number to its new account number.
 */
export class CustomerImportService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
  ) {}

  async run(user: AuthUser, csv: string, commit: boolean) {
    const records = csvRecords(csv);
    if (!records.length) throw new BadRequestException('The file has no rows');
    if (records.length > 20_000) throw new BadRequestException('Load at most 20,000 rows at a time');
    const missing = IMPORT_COLUMNS.filter((c) => !(c in records[0]));
    if (missing.length) throw new BadRequestException(`Missing column(s): ${missing.join(', ')}`);
    const [zones, tariffs, already] = await Promise.all([
      this.db.zones.find({ organisationId: user.organisationId }, { code: 1 }).lean(),
      this.db.tariffs.find({ organisationId: user.organisationId }, { code: 1, category: 1 }).lean(),
      this.db.customers.find({ organisationId: user.organisationId, notes: /^Legacy account: / }, { notes: 1 }).lean(),
    ]);
    const imported = new Set(already.map((c) => c.notes!.replace('Legacy account: ', '').split('\n')[0]));
    const seen = new Set<string>();
    const errors: { row: number; legacy: string; message: string }[] = [];
    const good: { row: number; data: z.infer<typeof Row>; zoneId: unknown; tariffId: unknown }[] = [];
    records.forEach((r, i) => {
      const row = i + 2; // the heading is row 1
      const parsed = Row.safeParse(r);
      if (!parsed.success) return void errors.push({ row, legacy: r.legacy_account ?? '', message: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') });
      const d = parsed.data;
      const zone = zones.find((z) => z.code.toUpperCase() === d.zone_code.toUpperCase());
      const tariff = tariffs.find((t) => t.code.toUpperCase() === d.tariff_code.toUpperCase());
      const problems = [!zone && `unknown zone ${d.zone_code}`, !tariff && `unknown tariff ${d.tariff_code}`, tariff?.category && tariff.category !== d.category && `tariff ${tariff.code} is for ${tariff.category.toLowerCase()} customers`, seen.has(d.legacy_account) && 'legacy account repeated in the file', imported.has(d.legacy_account) && 'already imported'].filter(Boolean);
      seen.add(d.legacy_account);
      if (problems.length) errors.push({ row, legacy: d.legacy_account, message: problems.join('; ') });
      else good.push({ row, data: d, zoneId: zone!._id, tariffId: tariff!._id });
    });
    const totalBalance = good.reduce((t, g) => t.plus(g.data.opening_balance), zDecimal.parse('0'));
    const summary = { rows: records.length, valid: good.length, errors, openingBalances: totalBalance.toFixed(2) };
    if (!commit || errors.length) return { ...summary, committed: false, created: [] as { legacy: string; accountNo: string }[] };
    const created: { legacy: string; accountNo: string }[] = [];
    for (const g of good) {
      const d = g.data;
      const c = await this.customers.create(user, {
        name: d.name,
        category: d.category,
        phone: d.phone,
        email: d.email,
        idNumber: d.id_number || undefined,
        kraPin: d.kra_pin ? d.kra_pin.toUpperCase() : undefined,
        zoneId: g.zoneId,
        tariffId: g.tariffId,
        plotNo: d.plot_no || undefined,
        location: d.location || undefined,
        notes: `Legacy account: ${d.legacy_account}`,
        openingBalance: d.opening_balance,
        status: d.status,
      } as never);
      created.push({ legacy: d.legacy_account, accountNo: (c as { accountNo: string }).accountNo });
    }
    await this.audit.record(user, 'water.customers.import', 'organisation', user.organisationId, { rows: created.length, openingBalances: summary.openingBalances });
    return { ...summary, committed: true, created };
  }
}
