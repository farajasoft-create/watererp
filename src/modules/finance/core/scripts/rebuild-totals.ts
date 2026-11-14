/**
 * Rebuilds the monthly ledger totals from the ledger, for every organisation or one (--org <id>). Reports
 * read these totals; run this after restoring a database from backup. Safe while the app is in use.
 *
 *   npm run db:rebuild-totals [-- --org <organisationId>]
 */
import { Types } from 'mongoose';
import { createServices } from '../container';
import { connect, Db } from '../database/db.service';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const db = new Db(await connect(uri));
  const s = createServices(db);
  const i = process.argv.indexOf('--org');
  const orgs = i > -1 ? [{ _id: new Types.ObjectId(process.argv[i + 1]), name: process.argv[i + 1] }] : await db.organisations.find({}, { name: 1 }).lean();
  for (const org of orgs) {
    const state = await s.warehouse.rebuild(org._id);
    console.log(`${org.name}: ${state?.facts ?? 0} monthly totals over ${state?.monthsRefreshed ?? 0} months in ${((state?.lastDurationMs ?? 0) / 1000).toFixed(1)} s`);
  }
  await db.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
