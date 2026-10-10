import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// LIVE checks against real services — Stripe test mode, Resend, and the AI provider on the eval routing — through
// the running dev stack (pnpm dev:api, pnpm dev:admin-api, pnpm dev:web) plus a Stripe webhook forwarder
// (stripe listen --forward-to localhost:8787/v1/webhooks/stripe). Opt-in: pnpm e2e:live. Each test skips itself when
// a prerequisite is missing. Made-up data only (free AI models may keep prompts).

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../.env'));
} catch {
  /* no .env: tests skip */
}

export default defineConfig({
  testDir: './e2e-live',
  timeout: 300_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
