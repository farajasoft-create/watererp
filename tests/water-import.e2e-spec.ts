import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedWater, startApp, TestApp } from './helpers';

/** Migrating customers from the legacy billing system: dry run with every problem listed, then a clean load with opening balances. */

let app: TestApp;

beforeAll(async () => {
  app = await startApp('water_import_e2e', { modules: ['water'], users: [{ who: 'admin', isAdmin: true }] });
  await seedWater(app, []);
});

afterAll(async () => {
  await app?.stop();
});

const HEAD = 'legacy_account,name,category,phone,email,id_number,kra_pin,zone_code,tariff_code,plot_no,location,opening_balance,status';

describe('customer import', () => {
  it('checks the whole file first and loads only a clean one', async () => {
    const bad = [HEAD, 'L-001,Jane Wanjiku,DOMESTIC,0722000001,,12345678,,KML,DOM,Plot 1,Kamelil,1250.50,ACTIVE', 'L-002,"Kiprop, John",domestic,0722000002,,,,XYZ,DOM,,,0,', 'L-001,Duplicate,DOMESTIC,,,,,KML,DOM,,,abc,', 'L-009,Shop,COMMERCIAL,,,,,KML,DOM,,,0,'].join('\n');
    const dry = await app.call<{ rows: number; valid: number; errors: { row: number; message: string }[]; committed: boolean }>('admin', 'POST', '/water/customers/import', { csv: bad, commit: true }, 200);
    expect(dry).toMatchObject({ rows: 4, valid: 1, committed: false });
    expect(dry.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(dry.errors[2].message).toContain('tariff DOM is for domestic customers');
    expect(dry.errors[0].message).toContain('unknown zone XYZ');
    expect(dry.errors[1].message).toContain('opening_balance');

    const good = [HEAD, 'L-001,Jane Wanjiku,DOMESTIC,0722000001,,12345678,,KML,DOM,Plot 1,Kamelil,1250.50,ACTIVE', 'L-002,"Kiprop, John",domestic,0722000002,,,,kml,dom,,,0,'].join('\r\n');
    const check = await app.call<{ valid: number; errors: unknown[]; openingBalances: string; committed: boolean }>('admin', 'POST', '/water/customers/import', { csv: good }, 200);
    expect(check).toMatchObject({ valid: 2, errors: [], openingBalances: '1250.50', committed: false });
    const done = await app.call<{ committed: boolean; created: { legacy: string; accountNo: string }[] }>('admin', 'POST', '/water/customers/import', { csv: good, commit: true }, 200);
    expect(done.committed).toBe(true);
    expect(done.created.map((c) => c.legacy)).toEqual(['L-001', 'L-002']);
    const page = await app.call<{ items: { accountNo: string; name: string; balance: string; category: string }[] }>('admin', 'GET', '/water/customers?search=Wanjiku');
    expect(page.items[0]).toMatchObject({ accountNo: done.created[0].accountNo, balance: '1250.5' });

    const again = await app.call<{ errors: { message: string }[] }>('admin', 'POST', '/water/customers/import', { csv: good }, 200);
    expect(again.errors.map((e) => e.message)).toEqual(['already imported', 'already imported']);
    expect((await app.raw('admin', 'GET', '/water/customers/import/template')).status).toBe(200);
  });
});
