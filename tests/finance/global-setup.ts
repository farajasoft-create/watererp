import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Finance's own end-to-end suites (moved in from FarajaSoft Accounting) run finance stand-alone on an
 * in-memory replica set: its own router at /api/v1, its own sign-in, the finance_ collections.
 */
let replSet: MongoMemoryReplSet | undefined;

export async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = replSet.getUri('farajasoft_e2e');
}

export async function teardown() {
  await replSet?.stop();
}
