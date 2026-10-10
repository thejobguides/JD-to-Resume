import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createSql } from '@jmo/db';
import { AuthService, BillingService, ConfigStore, consoleMailer, fakeStripe, loadEnv, resendMailer, stripeClient } from '@jmo/server';
import { loadOrCreateDevKeys } from '@jmo/server/dev-keys';
import { createAdminApp } from './app';

// Admin API (Node). It receives only the vault PUBLIC key; the private key stays with the public API process.

const vars: Record<string, string | undefined> = { ...process.env };
if (vars.NODE_ENV !== 'production') {
  const keys = await loadOrCreateDevKeys(fileURLToPath(new URL('../../../.dev/keys.json', import.meta.url)));
  vars.VAULT_PUBLIC_KEY_JWK ||= JSON.stringify(keys.vault.publicJwk);
}
delete vars.VAULT_PRIVATE_KEY_JWK;
const env = loadEnv(vars);
const sql = createSql(env.DATABASE_URL);
const mailer = env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY, env.EMAIL_FROM) : consoleMailer();
const payments = env.STRIPE_SECRET_KEY ? stripeClient(env.STRIPE_SECRET_KEY, { webOrigin: env.WEB_ORIGIN }) : fakeStripe(env.WEB_ORIGIN);
const app = createAdminApp({
  sql,
  env,
  config: new ConfigStore(sql, 'production', 5_000),
  auth: new AuthService(sql, env.JWT_SECRET, mailer, { exposeDevCode: env.ENV !== 'production' }),
  billing: new BillingService(sql, payments, env.STRIPE_WEBHOOK_SECRET),
  payments,
  internal: async (path, body) => {
    const r = await fetch(`${env.PUBLIC_API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_TOKEN }, body: JSON.stringify(body ?? {}) });
    if (!r.ok) throw new Error(`internal ${path} failed: ${r.status}`);
    return r.json();
  },
});
const port = Number(vars.ADMIN_API_PORT ?? 8788);
serve({ fetch: app.fetch, port }, () => console.log(`Admin API listening on http://localhost:${port}`));
