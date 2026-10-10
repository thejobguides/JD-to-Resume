import { defineConfig } from '@playwright/test';

// End-to-end: the real extension (unpacked) in Chromium, against the local API with the mock AI provider and
// fake Stripe. Needs Docker Postgres (`pnpm db:up`). Run: pnpm --filter @jmo/extension e2e

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
