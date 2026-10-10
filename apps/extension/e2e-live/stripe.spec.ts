import { createCoupon, formEncode, stripeClient } from '@jmo/server';
import { expect, type Page, test } from '@playwright/test';
import { api, db, health, login, RUN, waitFor } from './live';

// Payments against Stripe TEST mode through the running API: a coupon becomes a real Stripe coupon, Stripe's hosted
// Checkout is paid with test card 4242, webhooks (via `stripe listen`) upgrade the plan with Stripe's real totals,
// the portal opens, cancel/resume sync back, a one-time purchase is refunded, and account deletion cancels billing.

const KEY = process.env.STRIPE_SECRET_KEY ?? '';
const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

async function stripe<T = any>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>): Promise<T> {
  const qs = params ? formEncode(params) : '';
  const r = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && qs ? `?${qs}` : ''}`, { method, headers: { authorization: `Bearer ${KEY}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(method === 'POST' ? { body: qs } : {}) });
  const j = (await r.json()) as T & { error?: { message: string } };
  if (!r.ok) throw new Error(`Stripe ${method} ${path}: ${j.error?.message}`);
  return j;
}

async function pay(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cardNumber, [data-testid="card-accordion-item-button"]', { timeout: 45_000 });
  const accordion = page.locator('[data-testid="card-accordion-item-button"]');
  if (await accordion.isVisible().catch(() => false)) await accordion.click();
  await page.locator('#cardNumber').fill('4242424242424242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  if (await page.locator('#billingName').isVisible().catch(() => false)) await page.locator('#billingName').fill('Test Buyer');
  if (await page.locator('#billingCountry').isVisible().catch(() => false)) await page.locator('#billingCountry').selectOption('US');
  if (await page.locator('#billingPostalCode').isVisible().catch(() => false)) await page.locator('#billingPostalCode').fill('10001');
  const save = page.locator('#enableStripePass');
  if ((await save.isVisible().catch(() => false)) && (await save.isChecked())) await save.uncheck();
  await page.locator('[data-testid="hosted-payment-submit-button"], button.SubmitButton').first().click();
  await page.waitForURL(new RegExp(`^${WEB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/checkout/success`), { timeout: 90_000 });
}

test.describe.serial('live: Stripe test mode', () => {
  const sql = db();
  let sub: { token: string; userId: string; email: string };
  let subId = '';

  test.beforeAll(async () => {
    const h = await health();
    test.skip(!KEY.startsWith('sk_test_'), 'needs a Stripe TEST key (sk_test_…) in .env');
    test.skip(h?.payments !== 'test', 'needs the dev API running with STRIPE_SECRET_KEY (pnpm dev:api)');
    const [p] = await sql`SELECT provider_price_id FROM plan_prices WHERE plan_id = 'pro_quarterly' AND status = 'active'`;
    test.skip(!String(p?.provider_price_id).startsWith('price_') || String(p?.provider_price_id).startsWith('price_fake_'), 'run pnpm stripe:setup first');
  });
  test.afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  test('coupon → Stripe Checkout (4242) → webhooks upgrade the plan with Stripe’s totals', async ({ page }) => {
    sub = await login('stripe-sub');
    const code = `LIVE25${RUN.toUpperCase()}`.slice(0, 20);
    const [owner] = await sql<Array<{ id: string }>>`SELECT user_id AS id FROM admin_members WHERE role = 'owner' LIMIT 1`;
    const c = await createCoupon(sql, stripeClient(KEY, { webOrigin: WEB }), {
      name: `Live e2e 25% ${RUN}`,
      codes: { mode: 'single', code },
      rules: [{ plan_id: 'pro_quarterly', percent_off: 25, duration: 'first_period' }],
      max_redemptions: 2,
      valid_from: new Date(Date.now() - 60_000).toISOString(),
      valid_until: new Date(Date.now() + 86_400_000).toISOString(),
    }, { id: owner!.id, role: 'owner', reason: 'live e2e coupon' });
    expect(await stripe('GET', `/coupons/${c.provider_discount_ids.pro_quarterly}`)).toMatchObject({ percent_off: 25, duration: 'once', valid: true });
    expect((await api('POST', '/v1/billing/coupons/preview', sub.token, { code, plan_id: 'pro_quarterly' })).json.price).toMatchObject({ list: '45.00', discounted: '33.75' });

    const co = await api<{ checkout_url: string; transaction_id: string }>('POST', '/v1/billing/checkout', sub.token, { plan_id: 'pro_quarterly', coupon_code: code }, { 'idempotency-key': `live-sub-${RUN}` });
    expect(co.json.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    await pay(page, co.json.checkout_url);
    const me = await waitFor('plan upgrade (is `stripe listen` forwarding webhooks?)', async () => {
      const r = await api<{ plan: string; subscription: { current_period_end: string } | null }>('GET', '/v1/me', sub.token);
      return r.json.plan === 'pro_quarterly' && r.json.subscription ? r.json : null;
    });
    const days = (Date.parse(me.subscription!.current_period_end) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(85);
    expect(days).toBeLessThan(95);
    const red = await waitFor('redemption', async () => (await sql`SELECT status, list_amount_minor, discount_amount_minor FROM coupon_redemptions WHERE provider_transaction_id = ${co.json.transaction_id}`).find((r) => r.status === 'completed'));
    expect(red).toMatchObject({ list_amount_minor: 4500, discount_amount_minor: 1125 });
    const [s] = await sql`SELECT provider_subscription_id, provider_customer_id FROM subscriptions WHERE user_id = ${sub.userId}`;
    expect(String(s!.provider_subscription_id)).toMatch(/^sub_/);
    expect(String(s!.provider_customer_id)).toMatch(/^cus_/);
    subId = String(s!.provider_subscription_id);
  });

  test('portal link, cancel at period end and resume sync back through webhooks', async ({ page }) => {
    const portal = await api<{ url: string }>('POST', '/v1/billing/portal', sub.token, { flow: 'cancel' });
    expect(portal.status).toBe(200);
    expect(portal.json.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    await page.goto(portal.json.url);
    await expect(page.locator('body')).toContainText(/cancel/i);
    await stripe('POST', `/subscriptions/${subId}`, { cancel_at_period_end: true });
    await waitFor('cancel flag', async () => (await api('GET', '/v1/me', sub.token)).json.subscription?.cancel_at_period_end === true);
    expect((await api('GET', '/v1/me', sub.token)).json.plan).toBe('pro_quarterly');
    await stripe('POST', `/subscriptions/${subId}`, { cancel_at_period_end: false });
    await waitFor('resume', async () => (await api('GET', '/v1/me', sub.token)).json.subscription?.cancel_at_period_end === false);
  });

  test('a one-time purchase grants credits; a full refund in Stripe removes them', async ({ page }) => {
    const buyer = await login('stripe-pack');
    const co = await api<{ checkout_url: string; transaction_id: string }>('POST', '/v1/billing/checkout', buyer.token, { plan_id: 'credit_pack' }, { 'idempotency-key': `live-pack-${RUN}` });
    await pay(page, co.json.checkout_url);
    await waitFor('credits', async () => (await api('GET', '/v1/usage', buyer.token)).json.optimizations?.credits_remaining === 25);
    const session = await stripe<{ payment_intent: string }>('GET', `/checkout/sessions/${co.json.transaction_id}`);
    await stripe('POST', '/refunds', { payment_intent: session.payment_intent });
    await waitFor('refund', async () => (await sql`SELECT remaining FROM credit_grants WHERE provider_transaction_id = ${co.json.transaction_id}`)[0]?.remaining === 0);
  });

  test('account deletion cancels the Stripe subscription first; the later webhook is accepted', async () => {
    const d = await api<{ steps: Record<string, string> }>('DELETE', '/v1/account', sub.token);
    expect(d.status).toBe(202);
    expect(d.json.steps.billing).toBe(`canceled:${subId}`);
    expect((await stripe<{ status: string }>('GET', `/subscriptions/${subId}`)).status).toBe('canceled');
    const evt = await waitFor('deleted webhook', async () => (await sql`SELECT user_id, processed_at FROM subscription_events WHERE event_type = 'customer.subscription.deleted' AND payload_min->>'id' = ${subId}`)[0]);
    expect(evt).toMatchObject({ user_id: null });
    expect(evt.processed_at).not.toBeNull();
    const pending = await sql`SELECT count(*)::int AS n FROM subscription_events WHERE processed_at IS NULL AND received_at > now() - interval '1 hour'`;
    expect(pending[0]!.n).toBe(0);
  });
});
