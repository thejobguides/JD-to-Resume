import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'apps/admin-api/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests that need Postgres are skipped unless DATABASE_URL is set (see README).
    pool: 'forks',
    setupFiles: ['./tests/setup/node-polyfills.ts'],
  },
});
