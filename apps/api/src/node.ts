import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { migrate, seed } from '@jmo/db';
import { applyRetention, createServices, enforceCouponBudgets, loadEnv, refreshInsights, rollupHourly, sweepReservations } from '@jmo/server';
import { loadOrCreateDevKeys } from '@jmo/server/dev-keys';
import { createApp } from './app';

// Node entry: local development and container hosting. The Cloudflare Workers entry reuses createApp().

const vars: Record<string, string | undefined> = { ...process.env };
if (vars.NODE_ENV !== 'production') {
  const keys = await loadOrCreateDevKeys(fileURLToPath(new URL('../../../.dev/keys.json', import.meta.url)));
  vars.VAULT_PUBLIC_KEY_JWK ||= JSON.stringify(keys.vault.publicJwk);
  vars.VAULT_PRIVATE_KEY_JWK ||= JSON.stringify(keys.vault.privateJwk);
  vars.CONFIG_SIGNING_PRIVATE_KEY_JWK ||= JSON.stringify(keys.signing.privateJwk);
}
const env = loadEnv(vars);
// The public API signs the extension's remote config; the admin API never holds this key.
if (env.ENV === 'production' && !vars.CONFIG_SIGNING_PRIVATE_KEY_JWK) throw new Error('CONFIG_SIGNING_PRIVATE_KEY_JWK must be set in production');
const services = createServices(env);

if (env.ENV !== 'production') {
  await migrate(services.sql, () => undefined);
  const [plans] = await services.sql`SELECT count(*)::int AS n FROM plans`;
  if (!plans || Number(plans.n) === 0) await seed(services.sql, { ownerEmail: vars.ADMIN_OWNER_EMAIL ?? 'owner@example.com', useMockAi: !env.OPENAI_API_KEY });
}

const app = createApp(services);
// PORT: hosts such as Render tell the service where to listen.
const port = Number(vars.API_PORT ?? vars.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`API listening on http://localhost:${port} (env=${env.ENV}, payments=${services.billing.mode}, ai=${env.OPENAI_API_KEY ? 'openai' : 'mock'})`);
});

// Background jobs (Workers: Cron Triggers).
const every = (ms: number, fn: () => Promise<unknown>) => {
  const run = () => fn().catch((e) => console.error('[job]', e));
  setTimeout(run, 5_000);
  return setInterval(run, ms);
};
every(5 * 60_000, async () => {
  const cfg = (await services.config.get()).config;
  const ref = await services.sql<Array<{ id: string; input_per_mtok: string; output_per_mtok: string }>>`SELECT id, input_per_mtok, output_per_mtok FROM ai_models WHERE id IN (${cfg.insights.reference_models.cheap}, ${cfg.insights.reference_models.strong})`;
  const price = (id: string) => ref.find((r) => r.id === id);
  const cheap = price(cfg.insights.reference_models.cheap);
  const strong = price(cfg.insights.reference_models.strong);
  await rollupHourly(services.sql, {
    ...(cheap && strong ? { referencePrices: { cheap: { in: Number(cheap.input_per_mtok), out: Number(cheap.output_per_mtok) }, strong: { in: Number(strong.input_per_mtok), out: Number(strong.output_per_mtok) } } } : {}),
  });
  await sweepReservations(services.sql);
  await enforceCouponBudgets(services.sql);
  await services.runner.purgeExpiredMailboxes();
});
every(60 * 60_000, async () => refreshInsights(services.sql, (await services.config.get()).config));
every(24 * 60 * 60_000, async () => {
  await services.sql`SELECT ensure_ai_requests_partition((now() + interval '1 month')::date)`;
  const purged = await applyRetention(services.sql, (await services.config.get()).config.retention);
  console.log(`[retention] ${JSON.stringify(purged)}`);
});
