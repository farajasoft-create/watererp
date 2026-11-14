import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { mongo } from 'mongoose';

const { EJSON } = mongo.BSON;

type Database = mongo.Db;

export interface BackupHeader {
  format: 'gerp-backup';
  version: 1;
  database: string;
  at: string;
  collections: Record<string, { count: number; indexes: Record<string, unknown>[] }>;
}

/**
 * Writes every collection (uploaded files too: GridFS lives in ordinary collections) to one gzip file of
 * JSON lines: a header with each collection's document count and index definitions, then one line per
 * document in extended JSON so ids, decimals and dates come back exactly.
 */
export async function backupDatabase(db: Database, file: string): Promise<BackupHeader> {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
  const header: BackupHeader = { format: 'gerp-backup', version: 1, database: db.databaseName, at: new Date().toISOString(), collections: {} };
  for (const name of names) {
    const indexes = (await db.collection(name).listIndexes().toArray()).filter((i) => i.name !== '_id_').map(({ v: _v, ns: _ns, ...rest }) => rest);
    header.collections[name] = { count: await db.collection(name).countDocuments(), indexes };
  }
  async function* lines() {
    yield `${JSON.stringify(header)}\n`;
    for (const name of names) {
      for await (const doc of db.collection(name).find({}, { sort: { _id: 1 } })) yield `${EJSON.stringify({ c: name, d: doc }, { relaxed: false })}\n`;
    }
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(file));
  return header;
}

/**
 * Restores a backup into an empty database (or, with `replace`, after dropping the collections the backup
 * holds), rebuilds the indexes and checks every collection's count against the header.
 */
export async function restoreDatabase(db: Database, file: string, opts: { replace?: boolean } = {}): Promise<{ header: BackupHeader; restored: Record<string, number> }> {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let header: BackupHeader | null = null;
  const restored: Record<string, number> = {};
  let batch: { c: string; d: Record<string, unknown> }[] = [];
  const flush = async () => {
    const byCollection = new Map<string, Record<string, unknown>[]>();
    for (const x of batch) byCollection.set(x.c, [...(byCollection.get(x.c) ?? []), x.d]);
    for (const [c, docs] of byCollection) {
      await db.collection(c).insertMany(docs, { ordered: false });
      restored[c] = (restored[c] ?? 0) + docs.length;
    }
    batch = [];
  };
  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = JSON.parse(line) as BackupHeader;
      if (header.format !== 'gerp-backup' || header.version !== 1) throw new Error('This is not a gERP backup file');
      const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
      const clash = existing.filter((n) => header!.collections[n]);
      if (clash.length && !opts.replace) throw new Error(`The database already holds ${clash.length} of the backup's collections; restore into an empty database or pass --replace`);
      for (const n of clash) await db.collection(n).drop();
      continue;
    }
    batch.push(EJSON.parse(line, { relaxed: false }) as { c: string; d: Record<string, unknown> });
    if (batch.length >= 500) await flush();
  }
  await flush();
  if (!header) throw new Error('The backup file is empty');
  for (const [name, info] of Object.entries(header.collections)) {
    if (!restored[name]) await db.createCollection(name).catch(() => undefined);
    if (info.indexes.length) await db.collection(name).createIndexes(info.indexes as never);
    const count = await db.collection(name).countDocuments();
    if (count !== info.count) throw new Error(`${name}: restored ${count} documents, the backup holds ${info.count}`);
  }
  return { header, restored };
}
