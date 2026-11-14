import path from 'node:path';
import { defineConfig } from 'vitest/config';

const resolve = { alias: { '@': path.resolve(__dirname, 'src') } };

export default defineConfig({
  test: {
    projects: [
      { resolve, test: { name: 'unit', include: ['src/**/*.spec.ts'], environment: 'node' } },
      // Runs the API against an in-memory MongoDB replica set (downloaded on first run).
      { resolve, test: { name: 'e2e', include: ['tests/*.e2e-spec.ts'], environment: 'node', testTimeout: 120_000, hookTimeout: 300_000 } },
      // Finance's own suites, run stand-alone (its router at /api/v1 and its own sign-in) one file at a time.
      {
        resolve,
        test: {
          name: 'finance',
          include: ['tests/finance/**/*.e2e-spec.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 300_000,
          globalSetup: ['tests/finance/global-setup.ts'],
          fileParallelism: false,
          env: { FINANCE_STANDALONE: 'true', JWT_SECRET: 'e2e-test-secret-that-is-at-least-32-characters', DB_SETUP_ON_START: 'true' },
        },
      },
    ],
  },
});
