/**
 * Creates an organisation with its first administrator, switches modules on and runs each module's seed.
 *
 *   npm run db:seed                 organisation + admin from the SEED_* variables, every installed module
 *   npm run db:seed -- --demo       also demo users and data in every module for testing by hand
 *                                   (password SEED_DEMO_PASSWORD, else the administrator's)
 *   SEED_MODULES=water npm run db:seed    only the listed modules
 */
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { getPlatform } from '@/platform/container';
import { seedTestingDemo } from './seed-demo';

async function main() {
  const demo = process.argv.includes('--demo');
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || password.length < 10) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (at least 10 characters) in .env.local');
  const name = process.env.SEED_ORG_NAME ?? 'Tachasis Water and Sanitation Company';
  const code = process.env.SEED_ORG_CODE ?? 'TACHWASCO';

  // The shared platform instance: finance, mounted on its own router, looks it up the same way.
  const platform = await getPlatform();
  const conn = platform.core.db.connection;
  const { db } = platform.core;
  const wanted = process.env.SEED_MODULES?.split(',').map((m) => m.trim()).filter(Boolean) ?? platform.installed.map((m) => m.manifest.key);

  let org = await db.organisations.findOne({ code }).lean();
  if (!org) {
    const [created] = await db.organisations.create([{ name, code, modules: wanted }]);
    org = created.toObject();
    console.log(`Created organisation ${name}`);
  } else {
    await db.organisations.updateOne({ _id: org._id }, { $addToSet: { modules: { $each: wanted } } });
  }
  const organisationId = org._id as Types.ObjectId;

  if (!(await db.users.exists({ email: email.toLowerCase() }))) {
    await db.users.create([{ organisationId, email, name: 'Administrator', isAdmin: true, passwordHash: await bcrypt.hash(password, 10) }]);
    console.log(`Created administrator ${email}`);
  }

  // Demo users get their own password, so testers never need the administrator's.
  const demoPassword = process.env.SEED_DEMO_PASSWORD || password;
  if (demo && demoPassword.length < 10) throw new Error('SEED_DEMO_PASSWORD must be at least 10 characters');
  for (const m of platform.installed) {
    if (!wanted.includes(m.manifest.key) || !m.seed) continue;
    await m.seed({ db, core: platform.core, services: platform.modules[m.manifest.key], organisationId, demo, demoPassword });
  }
  if (demo) await seedTestingDemo(platform, organisationId, demoPassword, wanted);
  console.log(`Modules on: ${wanted.join(', ')}`);
  await conn.close();
}

// Exits explicitly: timers started by the API (rate limiters, caches) would otherwise keep the process alive.
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
