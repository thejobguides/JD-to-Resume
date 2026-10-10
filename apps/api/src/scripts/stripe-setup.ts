// Stripe test mode in one step: `pnpm stripe:setup`, after STRIPE_SECRET_KEY (sk_test_…) is in .env.
//
// 1. Refuses live keys and production: live prices go through Admin → Plans & pricing (step-up, audited).
// 2. Every plan whose active price is still a seeded or fake id gets a real Stripe product + price at the same
//    amount, which becomes the plan's active price (the old row is archived), exactly like Admin → New price.
// 3. Warns about coupons created with the fake gateway (their Stripe coupon doesn't exist) and prints the
//    webhook and customer-portal steps.

import { createSql } from '@jmo/db';
import { audit, loadEnv, stripeClient } from '@jmo/server';
import { uuidv7 } from '@jmo/shared';

const env = loadEnv(process.env);
if (env.ENV === 'production') throw new Error('stripe:setup is for local testing only.');
if (!env.STRIPE_SECRET_KEY) {
  console.error('\n  STRIPE_SECRET_KEY is empty. Copy your test secret key (sk_test_…) from dashboard.stripe.com → Developers → API keys into .env.\n');
  process.exit(1);
}
const payments = stripeClient(env.STRIPE_SECRET_KEY, { webOrigin: env.WEB_ORIGIN });
if (payments.mode === 'live') {
  console.error('\n  That is a LIVE key. stripe:setup only runs in test mode; create live prices in Admin → Plans & pricing.\n');
  process.exit(1);
}

const sql = createSql(env.DATABASE_URL, { max: 2 });
const [owner] = await sql<Array<{ id: string }>>`SELECT user_id AS id FROM admin_members WHERE role = 'owner' AND revoked_at IS NULL LIMIT 1`;
if (!owner) throw new Error('No owner admin in the database: run the API once (it seeds the database) or `pnpm db:reset`.');

const rows = await sql<Array<{ id: string; plan_id: string; name: string; provider_price_id: string; currency: string; unit_amount_minor: number; billing_interval: string | null; billing_frequency: number | null }>>`
  SELECT pp.id, pp.plan_id, p.name, pp.provider_price_id, pp.currency, pp.unit_amount_minor, p.billing_interval, p.billing_frequency
  FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id WHERE pp.status = 'active' ORDER BY p.display_order`;

console.log('\nCreating Stripe test-mode prices…');
for (const r of rows) {
  const label = `${r.plan_id.padEnd(14)} ${r.currency} ${(r.unit_amount_minor / 100).toFixed(2).padStart(7)}`;
  if (r.provider_price_id.startsWith('price_') && !r.provider_price_id.startsWith('price_fake_')) {
    console.log(`  ${label}  already on Stripe (${r.provider_price_id})`);
    continue;
  }
  const created = await payments.createPrice({ plan_id: r.plan_id, plan_name: r.name, amount_minor: r.unit_amount_minor, currency: r.currency, interval: r.billing_interval, interval_count: r.billing_frequency });
  await sql.begin(async (tx) => {
    await tx`UPDATE plan_prices SET status = 'archived', archived_at = now() WHERE id = ${r.id}`;
    await tx`INSERT INTO plan_prices (id, plan_id, provider_price_id, currency, unit_amount_minor, status, created_by) VALUES (${uuidv7()}, ${r.plan_id}, ${created.id}, ${r.currency}, ${r.unit_amount_minor}, 'active', ${owner.id})`;
    await audit(tx, { actor_type: 'admin', actor_id: owner.id, actor_role: 'owner', action: 'price.create', target_type: 'plan', target_id: r.plan_id, before: { provider_price_id: r.provider_price_id }, after: { unit_amount_minor: r.unit_amount_minor, provider_price_id: created.id }, reason: 'stripe:setup (test mode)' });
  });
  console.log(`  ${label}  ✓ ${created.id}`);
}

const [stale] = await sql<Array<{ n: number }>>`
  SELECT count(DISTINCT c.id)::int AS n FROM coupons c JOIN coupon_plan_rules r ON r.coupon_id = c.id
  WHERE c.status = 'active' AND (r.provider_discount_id IS NULL OR r.provider_discount_id LIKE '%fake%')`;
if (stale!.n) console.log(`\n  ⚠ ${stale!.n} active coupon(s) were created without Stripe; their codes will fail at checkout. Create them again in Admin → Coupons.`);

console.log(`
Next:
  1. Webhooks (no tunnel needed): install the Stripe CLI (brew install stripe/stripe-cli/stripe), then run
       stripe login
       stripe listen --forward-to localhost:${new URL(env.PUBLIC_API_URL).port || '8787'}/v1/webhooks/stripe
     Put the whsec_… it prints into .env as STRIPE_WEBHOOK_SECRET and restart the API (pnpm dev:api).
  2. Customer portal: dashboard.stripe.com/test/settings/billing/portal → check that cancellation (at period end) and
     payment-method updates are on and plan switching is off. Stripe creates the default on first use.
  3. Pay with test card 4242 4242 4242 4242, any future date, any CVC.
`);
await sql.end({ timeout: 2 });
process.exit(0);
