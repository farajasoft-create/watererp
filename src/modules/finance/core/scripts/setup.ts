/**
 * Prepares the database: collections, indexes, reference currencies and tenant migrations.
 * Run once per deployment (e.g. as part of the Vercel build) and set DB_SETUP_ON_START=false.
 *
 *   npm run db:setup
 */
import { createServices } from '../container';
import { connect, Db } from '../database/db.service';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const db = new Db(await connect(uri));
  await db.ensureSchema();
  const services = createServices(db);
  await services.provisioning.ensureReferenceData();
  await services.migrations.run((m) => console.log(m));
  console.log('Database ready');
  await db.connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
