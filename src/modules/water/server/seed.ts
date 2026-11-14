/**
 * Water starter data for a new organisation: supply zones, example tariffs and default settings; with
 * --demo also role users, metered customers, bulk meters and an open reading cycle.
 *
 * The tariff rates are examples to start from; replace them with the utility's WASREB-approved tariff.
 */
import bcrypt from 'bcryptjs';
import { toD128 } from '@/platform/common/money';
import { SeedContext } from '@/platform/module';
import type { WaterServices } from './container';
import { accountNumber } from './customers/customers.service';

const ZONES = [
  ['KML', 'Kamelil'],
  ['KPS', 'Kapsoen'],
  ['NGT', "Ng'atipkong"],
  ['MTT', 'Meteitei'],
  ['KPL', 'Kaplamaiywo'],
  ['TCH', 'Tachasis'],
  ['AIN', 'Ainapngetuny'],
  ['KPY', 'Kipyaor'],
  ['CHP', 'Chepkemel'],
  ['KBL', 'Kabolebo'],
  ['KBR', 'Kabirer'],
];

const TARIFFS = [
  { code: 'DOM', name: 'Domestic', category: 'DOMESTIC', blocks: [{ upTo: '6', rate: '0', fixedAmount: '600' }, { upTo: '20', rate: '110' }, { upTo: '50', rate: '130' }, { upTo: null, rate: '150' }], meterRent: '50', sewerPercent: '75', defaultEstimate: '8' },
  { code: 'COM', name: 'Commercial', category: 'COMMERCIAL', blocks: [{ upTo: '10', rate: '0', fixedAmount: '1300' }, { upTo: '100', rate: '140' }, { upTo: null, rate: '160' }], meterRent: '100', sewerPercent: '75', defaultEstimate: '15' },
  { code: 'INS', name: 'Institutional (schools, health)', category: 'INSTITUTIONAL', blocks: [{ upTo: '10', rate: '0', fixedAmount: '1100' }, { upTo: null, rate: '120' }], meterRent: '100', sewerPercent: '75', defaultEstimate: '30' },
  { code: 'KSK', name: 'Water kiosk', category: 'KIOSK', blocks: [{ upTo: null, rate: '50' }], meterRent: '0', sewerPercent: '0', minimumCharge: '300', defaultEstimate: '20' },
  { code: 'IND', name: 'Industrial', category: 'INDUSTRIAL', blocks: [{ upTo: '100', rate: '150' }, { upTo: null, rate: '170' }], meterRent: '200', sewerPercent: '75', defaultEstimate: '100' },
  { code: 'BLK', name: 'Bulk supply', category: 'BULK', blocks: [{ upTo: null, rate: '90' }], meterRent: '500', sewerPercent: '0', defaultEstimate: '500' },
];

export async function seedWater({ services, organisationId, demo, demoPassword }: SeedContext<WaterServices>) {
  const db = services.db;
  await db.waterSettings.updateOne(
    { organisationId },
    {
      $setOnInsert: {
        organisationId,
        licenceArea: 'Tindiret sub-county, Nandi County',
        billing: { dueDays: 14, penaltyPercent: toD128('2'), reconnectionFee: toD128('1000'), disconnectionMinArrears: toD128('1000'), disconnectionGraceDays: 30, highFactor: 2, lowFactor: 0.3, sendBillSms: false },
      },
    },
    { upsert: true },
  );
  for (const [zc, zn] of ZONES) {
    await db.zones.updateOne({ organisationId, code: zc }, { $setOnInsert: { organisationId, code: zc, name: zn, type: 'ZONE', active: true } }, { upsert: true });
  }
  for (const t of TARIFFS) {
    await db.tariffs.updateOne(
      { organisationId, code: t.code },
      {
        $setOnInsert: {
          organisationId,
          code: t.code,
          name: t.name,
          category: t.category,
          effectiveFrom: new Date('2026-07-01T00:00:00Z'),
          approvalReference: 'EXAMPLE – replace with the approved tariff',
          blocks: t.blocks.map((b) => ({ upTo: b.upTo === null ? null : toD128(b.upTo), rate: toD128(b.rate), fixedAmount: 'fixedAmount' in b && b.fixedAmount ? toD128(b.fixedAmount) : null })),
          meterRent: toD128(t.meterRent),
          sewerPercent: toD128(t.sewerPercent),
          minimumCharge: toD128(t.minimumCharge ?? '0'),
          defaultEstimate: toD128(t.defaultEstimate),
          active: true,
        },
      },
      { upsert: true },
    );
  }
  console.log(`Water: zones (${ZONES.length}) and example tariffs (${TARIFFS.length}) ready`);
  if (demo) await seedDemo(services, organisationId, demoPassword);
}

async function seedDemo(services: WaterServices, organisationId: SeedContext<WaterServices>['organisationId'], password: string) {
  const db = services.db;
  const hash = await bcrypt.hash(password, 10);
  const zones = await db.zones.find({ organisationId }).sort({ code: 1 }).lean();
  const tariffs = new Map((await db.tariffs.find({ organisationId }).lean()).map((t) => [t.category, t]));
  for (const [role, label] of [
    ['MANAGER', 'manager'],
    ['BILLING', 'billing'],
    ['CASHIER', 'cashier'],
    ['TECHNICAL', 'technical'],
    ['METER_READER', 'reader'],
  ] as const) {
    const email = `${label}@demo.water`;
    const scope = role === 'METER_READER' ? zones.slice(0, 2).map((z) => z._id) : [];
    if (!(await db.users.exists({ email }))) await db.users.create([{ organisationId, email, name: `Demo ${label}`, access: [{ module: 'water', role, scope }], passwordHash: hash }]);
  }

  const names = ['Kiprono Kirui', 'Chebet Jepkosgei', 'Kibet Rotich', 'Jerotich Too', 'Kimutai Langat', 'Cherono Sang', 'Kiplagat Bett', 'Jeptoo Kosgei', 'Tachasis Primary School', 'Meteitei Health Centre'];
  let n = 0;
  for (const zone of zones.slice(0, 3)) {
    await db.meters.updateOne(
      { organisationId, serialNo: `BULK-${zone.code}` },
      { $setOnInsert: { organisationId, serialNo: `BULK-${zone.code}`, type: 'BULK', status: 'INSTALLED', zoneId: zone._id, sizeMm: 80, dials: 7, installedAt: new Date(), initialReading: toD128(10000), lastReading: toD128(10000), lastReadingDate: new Date() } },
      { upsert: true },
    );
    for (let i = 0; i < 10; i++) {
      n++;
      const name = names[(n - 1) % names.length];
      const category = name.includes('School') || name.includes('Health') ? 'INSTITUTIONAL' : 'DOMESTIC';
      const seq = await db.next(organisationId, `account:${zone.code}`);
      const accountNo = accountNumber(zone.code, seq);
      const serialNo = `DEMO${String(n).padStart(5, '0')}`;
      if (await db.meters.exists({ organisationId, serialNo })) continue;
      const start = toD128(100 + n * 7);
      const [customer] = await db.customers.create([
        { organisationId, accountNo, name, category, zoneId: zone._id, tariffId: tariffs.get(category)!._id, phone: `2547${String(10000000 + n).slice(-8)}`, plotNo: `${zone.code}/${100 + i}`, status: 'ACTIVE', connectionDate: new Date(), statusHistory: [{ status: 'ACTIVE', at: new Date() }] },
      ]);
      const [meter] = await db.meters.create([{ organisationId, serialNo, make: 'Demo', type: 'CUSTOMER', status: 'INSTALLED', customerId: customer._id, zoneId: zone._id, installedAt: new Date(), initialReading: start, lastReading: start, lastReadingDate: new Date() }]);
      await db.customers.updateOne({ _id: customer._id }, { meterId: meter._id });
    }
  }
  const period = new Date().toISOString().slice(0, 7);
  await db.cycles.updateOne({ organisationId, period }, { $setOnInsert: { organisationId, period, status: 'OPEN' } }, { upsert: true });
  console.log(`Water demo data ready: ${n} customers in ${Math.min(3, zones.length)} zones, cycle ${period} open. Demo users: manager@, billing@, cashier@, technical@, reader@demo.water (the demo password).`);
}
