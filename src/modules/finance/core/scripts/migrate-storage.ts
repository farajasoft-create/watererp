/**
 * Moves attachment files from MongoDB (GridFS) to Cloudflare R2. Run once after configuring R2:
 *   npm run storage:migrate            (copies, verifies, then deletes the GridFS copy)
 *   npm run storage:migrate -- --keep  (copies and verifies, keeps the GridFS copy)
 * Safe to re-run: files already in R2 are skipped.
 */
import { createHash } from 'node:crypto';
import { connect, Db } from '../database/db.service';
import { createFileStore } from '../modules/documents/file-store';

async function main() {
  const keep = process.argv.includes('--keep');
  const db = new Db(await connect(process.env.MONGODB_URI!));
  const r2 = createFileStore(db.connection);
  if (r2.driver !== 'r2') throw new Error('Configure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET first');
  const gridfs = createFileStore(db.connection, 'gridfs');
  const pending = await db.attachments.find({ storage: { $ne: 'r2' }, status: { $ne: 'PENDING' } }).lean();
  let moved = 0;
  let failed = 0;
  for (const a of pending) {
    const oldKey = a.storageKey ?? `${a.organisationId.toHexString()}/${a.fileId!.toHexString()}`;
    try {
      const data = await gridfs.get(oldKey);
      if (!data) throw new Error('missing from GridFS');
      const created = (a as { createdAt?: Date }).createdAt ?? new Date();
      const key = `${a.organisationId.toHexString()}/attachments/${created.getUTCFullYear()}/${String(created.getUTCMonth() + 1).padStart(2, '0')}/${a._id.toHexString()}/${encodeURIComponent(a.name)}`;
      await r2.put(key, data, a.mimeType);
      const check = await r2.get(key);
      if (!check || createHash('sha256').update(check).digest('hex') !== createHash('sha256').update(data).digest('hex')) throw new Error('verification failed');
      await db.attachments.updateOne({ _id: a._id }, { storage: 'r2', storageKey: key });
      if (!keep) await gridfs.delete(oldKey);
      moved++;
      console.log(`moved ${a.name} (${data.length} bytes)`);
    } catch (err) {
      failed++;
      console.error(`could not move ${a._id} ${a.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Done: ${moved} moved, ${failed} failed, ${pending.length - moved - failed} skipped.`);
  await db.connection.close();
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
