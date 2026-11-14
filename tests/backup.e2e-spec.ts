import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mongoose, { Connection, Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase, restoreDatabase } from '../src/platform/backup';

/** Backup and restore: every collection, exact types (ids, decimals, dates), uploaded files, indexes and counts. */

let replSet: MongoMemoryReplSet;
let source: Connection;
let target: Connection;
let dir: string;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  source = await mongoose.createConnection(replSet.getUri('backup_src')).asPromise();
  target = await mongoose.createConnection(replSet.getUri('backup_dst')).asPromise();
  dir = mkdtempSync(join(tmpdir(), 'gerp-backup-'));
});

afterAll(async () => {
  await source?.close();
  await target?.close();
  await replSet?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('backup and restore', () => {
  it('restores exactly what was backed up', async () => {
    const id = new Types.ObjectId();
    await source.db!.collection('water_accounts').insertMany(Array.from({ length: 1200 }, (_, i) => ({ _id: i === 0 ? id : new Types.ObjectId(), number: `A${i}`, balance: Types.Decimal128.fromString(`${i}.25`), opened: new Date(Date.UTC(2026, 0, 1 + (i % 28))) })));
    await source.db!.collection('water_accounts').createIndex({ number: 1 }, { unique: true });
    const bucket = new mongoose.mongo.GridFSBucket(source.db!, { bucketName: 'documents' });
    await new Promise<void>((resolve, reject) => bucket.openUploadStream('lease.pdf').on('finish', () => resolve()).on('error', reject).end(Buffer.from('%PDF-1.4 lease')));

    const file = join(dir, 'b.jsonl.gz');
    const header = await backupDatabase(source.db!, file);
    expect(header.collections.water_accounts.count).toBe(1200);
    expect(header.collections['documents.files'].count).toBe(1);

    const { restored } = await restoreDatabase(target.db!, file);
    expect(restored.water_accounts).toBe(1200);
    const back = await target.db!.collection('water_accounts').findOne({ _id: id });
    expect(back?.balance).toBeInstanceOf(Types.Decimal128);
    expect(back?.balance.toString()).toBe('0.25');
    expect(back?.opened).toBeInstanceOf(Date);
    const indexes = await target.db!.collection('water_accounts').indexes();
    expect(indexes.some((i) => i.unique && i.key.number === 1)).toBe(true);
    const chunks: Buffer[] = [];
    for await (const c of new mongoose.mongo.GridFSBucket(target.db!, { bucketName: 'documents' }).openDownloadStreamByName('lease.pdf')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.4 lease');

    await expect(restoreDatabase(target.db!, file)).rejects.toThrow(/already holds/);
    await target.db!.collection('water_accounts').deleteMany({ number: { $in: ['A1', 'A2'] } });
    expect((await restoreDatabase(target.db!, file, { replace: true })).restored.water_accounts).toBe(1200);
  });
});
