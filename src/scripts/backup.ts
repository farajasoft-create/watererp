import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { backupDatabase, restoreDatabase } from '../platform/backup';

/**
 * Backup and restore of the whole database (every module, uploaded documents included).
 *
 *   npm run db:backup                     → backups/gerp-YYYYMMDD-HHMM.jsonl.gz, keeping the newest BACKUP_KEEP (default 14)
 *   npm run db:restore -- <file>          → into an empty database (MONGODB_URI)
 *   npm run db:restore -- <file> --replace → drops and replaces the collections the backup holds
 *
 * Schedule the backup nightly (cron or Windows Task Scheduler), copy the folder off the server, and
 * restore one backup a month into a scratch database to prove it works.
 */
async function main() {
  const [command, file, flag] = process.argv.slice(2);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI');
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    if (command === 'backup') {
      const dir = process.env.BACKUP_DIR ?? 'backups';
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
      const out = join(dir, `gerp-${stamp}.jsonl.gz`);
      const header = await backupDatabase(conn.db!, out);
      const docs = Object.values(header.collections).reduce((t, c) => t + c.count, 0);
      console.log(`Backed up ${Object.keys(header.collections).length} collections, ${docs} documents, to ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
      const keep = Number(process.env.BACKUP_KEEP ?? 14);
      const old = readdirSync(dir).filter((f) => /^gerp-\d{8}-\d{4}\.jsonl\.gz$/.test(f)).sort().slice(0, -keep);
      for (const f of old) unlinkSync(join(dir, f));
      if (old.length) console.log(`Removed ${old.length} older backup(s)`);
    } else if (command === 'restore') {
      if (!file) throw new Error('Give the backup file');
      const { header, restored } = await restoreDatabase(conn.db!, file, { replace: flag === '--replace' });
      console.log(`Restored the backup of ${header.at}: ${Object.keys(header.collections).length} collections, ${Object.values(restored).reduce((t, n) => t + n, 0)} documents; counts and indexes checked`);
    } else {
      throw new Error('Use: backup | restore <file> [--replace]');
    }
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
