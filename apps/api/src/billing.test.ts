import { generateSigningKeys } from '@jmo/config';
import type { Sql } from '@jmo/db';
import {
  activateVersion,
  BillingService,
  consoleMailer,
  createCoupon,
  createDraft,
  createServices,
  enforceCouponBudgets,
  fakeStripe,
  getActive,
  loadEnv,
  type PaymentGateway,
  type PaymentMode,
  type Services,
  signStripePayload,
  sweepReservations,
} from '@jmo/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAvailable, freshDatabase } from '../../../tests/setup/db';
import { createApp } from './app';
import { resetRateLimits } from './middleware';

// Billing on Stripe, scenario by scenario: checkout arguments, coupons and their limits, every webhook path and
// subscription status, the customer portal, and failure handling. A recording gateway wraps the fake one.

const up = await dbAvailable();

type Call = { method: keyof PaymentGateway; args: unknown[] };
function recordingGateway(mode: PaymentMode = 'fake') {
  const inner = fakeStripe('http://web');
  const calls: Call[] = [];
  const fail: Partial<Record<keyof PaymentGateway, Error>> = {};
  const wrap =
    <K extends keyof PaymentGateway>(m: K) =>
    async (...args: unknown[]) => {
      calls.push({ method: m, args });
      if (fail[m]) throw fail[m];
      return (inner[m] as (...a: unknown[]) => unknown)(...args);
    };
  const gw = {
    mode,
    createDiscount: wrap('createDiscount'),
    archiveDiscount: wrap('archiveDiscount'),
    createCheckout: wrap('createCheckout'),
    createPrice: wrap('createPrice'),
    createPortalSession: wrap('createPortalSession'),
    cancelSubscriptionNow: wrap('cancelSubscriptionNow'),
    findCheckoutForPayment: wrap('findCheckoutForPayment'),
  } as unknown as PaymentGateway;
  return { gw, calls, fail, last: (m: keyof PaymentGateway) => [...calls].reverse().find((c) => c.method === m)?.args };
}

describe.skipIf(!up)('Billing on Stripe (Postgres)', () => {
  let sql: Sql;
  let services: Services;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  const rec = recordingGateway();

  beforeAll(async () => {
    ({ sql } = await freshDatabase('jmo_test_billing'));
    const signing = await generateSigningKeys();
    services = createServices(loadEnv({ ENV: 'test', DATABASE_URL: 'unused', CONFIG_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(signing.privateJwk) }), { sql, mailer: consoleMailer(() => undefined) });
    services.billing = new BillingService(sql, rec.gw, services.env.STRIPE_WEBHOOK_SECRET);
    app = createApp(services);
    ownerId = (await sql<Array<{ id: string }>>`SELECT user_id AS id FROM admin_members WHERE role = 'owner'`)[0]!.id;
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
  });

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, a = app) =>
    a.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const auth = (t: string, key?: string) => ({ authorization: `Bearer ${t}`, ...(key ? { 'idempotency-key': key } : {}) });
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  async function login(email: string) {
    resetRateLimits();
    const r1 = await json('POST', '/v1/auth/otp/request', { email });
    const { dev_code } = (await r1.json()) as { dev_code: string };
    const r2 = await json('POST', '/v1/auth/otp/verify', { email, code: dev_code });
    return (await r2.json()) as { access_token: string; user: { id: string } };
  }
  async function setConfig(ns: Parameters<typeof getActive>[1], change: (d: Record<string, any>) => void) {
    const data = structuredClone((await getActive(sql, ns, 'production'))!.data) as Record<string, any>;
    change(data);
    const d = await createDraft(sql, ns, 'production', data, 'integration test config change', { id: ownerId, role: 'owner' });
    await activateVersion(sql, d.id, { id: ownerId, role: 'owner' }, { reason: 'integration test config change' });
    services.config.invalidate();
  }
  const event = async (id: string, type: string, object: Record<string, unknown>, a = app) => {
    const raw = JSON.stringify({ id, object: 'event', type, data: { object } });
    return a.request('/v1/webhooks/stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': await signStripePayload(raw, services.env.STRIPE_WEBHOOK_SECRET) } });
  };
  async function checkout(t: string, plan: string, key: string, coupon?: string) {
    resetRateLimits();
    return json('POST', '/v1/billing/checkout', { plan_id: plan, ...(coupon ? { coupon_code: coupon } : {}) }, auth(t, key));
  }
  async function subscribe(email: string, plan = 'pro_monthly') {
    const u = await login(email);
    const co = (await (await checkout(u.access_token, plan, `co-${email.replace(/[^\w-]/g, '-')}`)).json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${co.transaction_id}/complete`);
    const [s] = await sql<Array<{ provider_subscription_id: string; provider_customer_id: string }>>`SELECT provider_subscription_id, provider_customer_id FROM subscriptions WHERE user_id = ${u.user.id}`;
    return { ...u, sub: s!.provider_subscription_id, customer: s!.provider_customer_id };
  }
  const me = async (t: string) => (await (await app.request('/v1/me', { headers: auth(t) })).json()) as { plan: string; subscription: { status: string; cancel_at_period_end: boolean; current_period_end: string | null } | null };
  const coupon = async (code: string, extra: Partial<Parameters<typeof createCoupon>[2]> = {}) =>
    createCoupon(sql, rec.gw, {
      name: `Coupon ${code}`,
      codes: { mode: 'single', code },
      rules: [{ plan_id: 'pro_quarterly', percent_off: 20, duration: 'first_period' }],
      valid_from: new Date(Date.now() - 60_000).toISOString(),
      valid_until: new Date(Date.now() + 86_400_000).toISOString(),
      ...extra,
    }, { id: ownerId, role: 'owner', reason: 'integration test coupon' });
  const preview = async (t: string, code: string, plan = 'pro_quarterly') => {
    resetRateLimits();
    return json('POST', '/v1/billing/coupons/preview', { code, plan_id: plan }, auth(t));
  };

  // ── Checkout ──

  it('checkout sends the right session to Stripe: subscription vs one-time, metadata, coupon, expiry', async () => {
    const u = await login('args@example.org');
    expect((await errorOf(await json('POST', '/v1/billing/checkout', { plan_id: 'pro_monthly' }, auth(u.access_token)))).message).toMatch(/Idempotency-Key/);
    expect((await errorOf(await checkout(u.access_token, 'free', 'co-args-free'))).message).toMatch(/free plan needs no checkout/);

    await checkout(u.access_token, 'pro_monthly', 'co-args-sub1');
    expect(rec.last('createCheckout')![0]).toMatchObject({ mode: 'subscription', price_id: 'pri_dev_pro_monthly', email: 'args@example.org', metadata: { user_id: u.user.id, plan_id: 'pro_monthly' }, expires_in_minutes: 60 });
    await checkout(u.access_token, 'credit_pack', 'co-args-pack1');
    expect(rec.last('createCheckout')![0]).toMatchObject({ mode: 'payment', price_id: 'pri_dev_credit_pack' });

    await coupon('ARGS20');
    const r = await checkout(u.access_token, 'pro_quarterly', 'co-args-cpn1', 'ARGS20');
    const body = (await r.json()) as { coupon_redemption_id: string };
    const [rule] = await sql`SELECT provider_discount_id FROM coupon_plan_rules r JOIN coupon_codes c ON c.coupon_id = r.coupon_id WHERE c.code = 'ARGS20'`;
    expect(rec.last('createCheckout')![0]).toMatchObject({ discount_id: rule!.provider_discount_id, metadata: { redemption_id: body.coupon_redemption_id } });
  });

  it('an unsold plan, checkout and coupon kill switches', async () => {
    const u = await login('switches@example.org');
    await sql`UPDATE plan_prices SET status = 'archived' WHERE plan_id = 'byok_annual'`;
    expect((await checkout(u.access_token, 'byok_annual', 'co-sw-byok')).status).toBe(404);
    await sql`UPDATE plan_prices SET status = 'active' WHERE plan_id = 'byok_annual'`;

    await setConfig('kill_switches', (d) => (d.checkout = true));
    try {
      const r = await checkout(u.access_token, 'pro_monthly', 'co-sw-kill');
      expect(r.status).toBe(503);
      expect((await errorOf(r)).code).toBe('maintenance');
    } finally {
      await setConfig('kill_switches', (d) => (d.checkout = false));
    }
    await coupon('SWITCH20');
    await setConfig('kill_switches', (d) => (d.coupons = true));
    try {
      expect((await errorOf(await preview(u.access_token, 'SWITCH20'))).details?.reason).toBe('invalid');
      expect((await errorOf(await checkout(u.access_token, 'pro_quarterly', 'co-sw-cpn', 'SWITCH20'))).code).toBe('coupon_rejected');
    } finally {
      await setConfig('kill_switches', (d) => (d.coupons = false));
    }
  });

  it('a Stripe failure at checkout releases the coupon reservation', async () => {
    const u = await login('stripe-down@example.org');
    await coupon('DOWN20');
    rec.fail.createCheckout = new Error('Stripe is down');
    try {
      expect((await checkout(u.access_token, 'pro_quarterly', 'co-down-1', 'DOWN20')).status).toBe(500);
    } finally {
      delete rec.fail.createCheckout;
    }
    expect((await sql`SELECT r.status FROM coupon_redemptions r JOIN coupon_codes c ON c.id = r.code_id WHERE c.code = 'DOWN20'`)[0]!.status).toBe('released');
    expect((await preview(u.access_token, 'DOWN20')).status).toBe(200); // the use is available again
  });

  it('expired reservations are swept; budgets auto-pause coupons', async () => {
    const u = await login('sweep@example.org');
    await coupon('SWEEP20');
    await checkout(u.access_token, 'pro_quarterly', 'co-sweep-1', 'SWEEP20');
    await sql`UPDATE coupon_redemptions SET reserved_until = now() - interval '1 minute' WHERE status = 'reserved'`;
    expect(await sweepReservations(sql)).toBeGreaterThan(0);
    expect((await sql`SELECT r.status FROM coupon_redemptions r JOIN coupon_codes c ON c.id = r.code_id WHERE c.code = 'SWEEP20'`)[0]!.status).toBe('released');

    const c = await coupon('BUDGET20', { max_discount_total_usd: 5 });
    const b = await login('budget@example.org');
    const co = (await (await checkout(b.access_token, 'pro_quarterly', 'co-budget-1', 'BUDGET20')).json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${co.transaction_id}/complete`); // $9.00 off → budget $5 used up
    expect(await enforceCouponBudgets(sql)).toContain(c.id);
    expect((await sql`SELECT status FROM coupons WHERE id = ${c.id}`)[0]!.status).toBe('paused');
  });

  // ── Coupon rules ──

  it('coupon preview reasons: not started, expired, wrong domain, limit, budget, new customers only', async () => {
    const u = await login('reasons@example.org');
    const reason = async (code: string) => (await errorOf(await preview(u.access_token, code))).details?.reason;
    await coupon('LATER20', { valid_from: new Date(Date.now() + 86_400_000).toISOString(), valid_until: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    expect(await reason('LATER20')).toBe('not_started');
    await coupon('OLD20', { valid_from: new Date(Date.now() - 2 * 86_400_000).toISOString(), valid_until: new Date(Date.now() - 86_400_000).toISOString() });
    expect(await reason('OLD20')).toBe('expired');
    await coupon('ACME20', { allowed_email_domains: ['acme.com'] });
    expect(await reason('ACME20')).toBe('domain_not_allowed');

    await coupon('ONE20', { max_redemptions: 1 });
    const first = await login('first-buyer@example.org');
    const co = (await (await checkout(first.access_token, 'pro_quarterly', 'co-one-1', 'ONE20')).json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${co.transaction_id}/complete`);
    expect(await reason('ONE20')).toBe('limit_reached');

    await coupon('TINY20', { max_discount_total_usd: 1 });
    const spender = await login('spender@example.org');
    const co2 = (await (await checkout(spender.access_token, 'pro_quarterly', 'co-tiny-1', 'TINY20')).json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${co2.transaction_id}/complete`);
    expect(await reason('TINY20')).toBe('budget_reached');

    await coupon('NEWBIE20', { new_customers_only: true });
    expect((await preview(u.access_token, 'NEWBIE20')).status).toBe(200);
    expect((await errorOf(await preview(first.access_token, 'NEWBIE20'))).details?.reason).toBe('new_customers_only');
  });

  it('coupon durations are translated to Stripe months; a failed save archives the Stripe coupons', async () => {
    const created = rec.calls.length;
    await createCoupon(sql, rec.gw, {
      name: 'Durations',
      codes: { mode: 'single', code: 'DURATIONS' },
      rules: [
        { plan_id: 'pro_monthly', percent_off: 10, duration: 'first_period' },
        { plan_id: 'pro_quarterly', percent_off: 20, duration: 'repeating', duration_periods: 2 },
        { plan_id: 'byok_annual', percent_off: 30, duration: 'forever' },
        { plan_id: 'credit_pack', percent_off: 40, duration: 'forever' },
      ],
      max_redemptions: 7,
      valid_from: new Date(Date.now() - 60_000).toISOString(),
      valid_until: '2027-01-01T00:00:00.000Z',
    }, { id: ownerId, role: 'owner', reason: 'integration test coupon' });
    const discounts = rec.calls.slice(created).filter((c) => c.method === 'createDiscount').map((c) => c.args[0] as Record<string, unknown>);
    expect(discounts.map((d) => [d.percent, d.duration, d.duration_in_months])).toEqual([
      [10, 'once', null],
      [20, 'repeating', 6],
      [30, 'forever', null],
      [40, 'once', null], // one-time purchases are discounted once
    ]);
    expect(discounts[0]).toMatchObject({ name: 'Durations', max_redemptions: 7, redeem_by: '2027-01-01T02:00:00.000Z' });

    const before = rec.calls.length;
    await expect(coupon('DURATIONS')).rejects.toThrow(); // duplicate code: the DB insert fails
    const after = rec.calls.slice(before);
    const madeId = after.filter((c) => c.method === 'createDiscount').length;
    expect(madeId).toBe(1);
    expect(after.filter((c) => c.method === 'archiveDiscount').length).toBe(1);
  });

  // ── Webhooks ──

  it('webhook signatures: missing, wrong secret, stale, tampered; malformed JSON; unknown events are recorded', async () => {
    const raw = JSON.stringify({ id: 'evt_sig_1', type: 'checkout.session.completed', data: { object: { id: 'cs_x', metadata: {} } } });
    const post = (body: string, sig?: string) => app.request('/v1/webhooks/stripe', { method: 'POST', body, headers: sig ? { 'stripe-signature': sig } : {} });
    expect((await post(raw)).status).toBe(401);
    expect((await post(raw, await signStripePayload(raw, 'whsec_other'))).status).toBe(401);
    expect((await post(raw, await signStripePayload(raw, services.env.STRIPE_WEBHOOK_SECRET, Date.now() - 10 * 60_000))).status).toBe(401);
    expect((await post(`${raw} `, await signStripePayload(raw, services.env.STRIPE_WEBHOOK_SECRET))).status).toBe(401);
    expect((await post('{nope', await signStripePayload('{nope', services.env.STRIPE_WEBHOOK_SECRET))).status).toBe(400);
    const unknown = await event('evt_unknown_1', 'invoice.finalized', { id: 'in_1' });
    expect(await unknown.json()).toEqual({ ok: true, processed: true });
    expect((await sql`SELECT processed_at FROM subscription_events WHERE provider_event_id = 'evt_unknown_1'`)[0]!.processed_at).not.toBeNull();
  });

  it('delayed payments: an unpaid completed checkout grants nothing until the async payment succeeds (once)', async () => {
    const u = await login('async@example.org');
    const meta = { user_id: u.user.id, plan_id: 'credit_pack' };
    await event('evt_async_1', 'checkout.session.completed', { id: 'cs_async_1', mode: 'payment', payment_status: 'unpaid', metadata: meta, amount_subtotal: 1200, amount_total: 1200, total_details: { amount_discount: 0 } });
    expect((await sql`SELECT count(*)::int AS n FROM credit_grants WHERE provider_transaction_id = 'cs_async_1'`)[0]!.n).toBe(0);
    await event('evt_async_2', 'checkout.session.async_payment_succeeded', { id: 'cs_async_1', mode: 'payment', payment_status: 'paid', metadata: meta, amount_subtotal: 1200, amount_total: 1200, total_details: { amount_discount: 0 } });
    await event('evt_async_3', 'checkout.session.async_payment_succeeded', { id: 'cs_async_1', mode: 'payment', payment_status: 'paid', metadata: meta, amount_subtotal: 1200, amount_total: 1200, total_details: { amount_discount: 0 } });
    expect((await sql`SELECT count(*)::int AS n, sum(remaining)::int AS left FROM credit_grants WHERE provider_transaction_id = 'cs_async_1'`)[0]).toMatchObject({ n: 1, left: 25 });
  });

  it('a 100% coupon (no payment required) still completes the redemption', async () => {
    await coupon('FREE100', { rules: [{ plan_id: 'pro_quarterly', percent_off: 100, duration: 'first_period' }], max_redemptions: 1 });
    const u = await login('free100@example.org');
    const co = (await (await checkout(u.access_token, 'pro_quarterly', 'co-free100', 'FREE100')).json()) as { transaction_id: string; coupon_redemption_id: string };
    await json('POST', `/v1/dev/fake-checkout/${co.transaction_id}/complete`);
    expect((await sql`SELECT status, discount_amount_minor FROM coupon_redemptions WHERE id = ${co.coupon_redemption_id}`)[0]).toMatchObject({ status: 'completed', discount_amount_minor: 4500 });
    expect((await me(u.access_token)).plan).toBe('pro_quarterly');
  });

  it('subscription statuses: past_due keeps access, unpaid and expired remove it, incomplete is ignored, deleted ends it', async () => {
    const s = await subscribe('statuses@example.org');
    const send = (id: string, status: string, extra: Record<string, unknown> = {}, type = 'customer.subscription.updated') =>
      event(id, type, { id: s.sub, status, customer: s.customer, metadata: { user_id: s.user.id, plan_id: 'pro_monthly' }, items: { data: [{ price: { id: 'pri_dev_pro_monthly' }, current_period_start: Math.floor(Date.now() / 1000), current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400 }] }, ...extra }, app);
    const state = async () => {
      const m = await me(s.access_token);
      return [m.plan, m.subscription?.status];
    };
    expect(await state()).toEqual(['pro_monthly', 'active']);
    await send('evt_st_1', 'past_due');
    expect(await state()).toEqual(['pro_monthly', 'past_due']);
    await send('evt_st_2', 'unpaid');
    expect(await state()).toEqual(['free', 'paused']);
    await send('evt_st_3', 'active');
    await send('evt_st_4', 'incomplete');
    expect(await state()).toEqual(['pro_monthly', 'active']);
    await send('evt_st_5', 'trialing');
    expect(await state()).toEqual(['pro_monthly', 'trialing']);
    await send('evt_st_6', 'incomplete_expired');
    expect(await state()).toEqual(['free', 'canceled']);
    await send('evt_st_7', 'active');
    await send('evt_st_8', 'canceled', {}, 'customer.subscription.deleted');
    expect(await state()).toEqual(['free', 'canceled']);
  });

  it('subscription details: legacy period fields, plan switch by price, cancel_at, events without a user', async () => {
    const s = await subscribe('details@example.org');
    const end = Math.floor(Date.UTC(2027, 0, 15) / 1000);
    // Older API versions put the period on the subscription instead of the item.
    await event('evt_dt_1', 'customer.subscription.updated', { id: s.sub, status: 'active', customer: s.customer, metadata: { user_id: s.user.id, plan_id: 'pro_monthly' }, items: { data: [{ price: { id: 'pri_dev_pro_monthly' } }] }, current_period_start: end - 30 * 86_400, current_period_end: end });
    expect((await me(s.access_token)).subscription?.current_period_end).toBe(new Date(end * 1000).toISOString());
    // Switching price in the portal switches the plan, whatever the metadata says.
    await event('evt_dt_2', 'customer.subscription.updated', { id: s.sub, status: 'active', customer: s.customer, metadata: { user_id: s.user.id, plan_id: 'pro_monthly' }, items: { data: [{ price: { id: 'pri_dev_pro_quarterly' } }] } });
    expect((await me(s.access_token)).plan).toBe('pro_quarterly');
    // Newer cancellations set cancel_at instead of cancel_at_period_end.
    await event('evt_dt_3', 'customer.subscription.updated', { id: s.sub, status: 'active', customer: s.customer, metadata: { user_id: s.user.id }, items: { data: [{ price: { id: 'pri_dev_pro_quarterly' } }] }, cancel_at_period_end: false, cancel_at: end });
    expect((await me(s.access_token)).subscription?.cancel_at_period_end).toBe(true);
    // A subscription event without our metadata is recorded and changes nothing.
    await event('evt_dt_4', 'customer.subscription.updated', { id: 'sub_foreign', status: 'canceled', metadata: {} });
    expect((await sql`SELECT user_id FROM subscription_events WHERE provider_event_id = 'evt_dt_4'`)[0]!.user_id).toBeNull();
    expect((await me(s.access_token)).plan).toBe('pro_quarterly');
  });

  it('re-subscribing reuses the Stripe customer; a fake customer id is never sent to real Stripe', async () => {
    const s = await subscribe('returning@example.org');
    await checkout(s.access_token, 'credit_pack', 'co-returning-2');
    expect(rec.last('createCheckout')![0]).toMatchObject({ customer_id: s.customer });
    expect(s.customer).toMatch(/^cus_fake_/);

    const live = recordingGateway('test');
    const liveServices = { ...services, billing: new BillingService(sql, live.gw, services.env.STRIPE_WEBHOOK_SECRET) };
    const liveApp = createApp(liveServices);
    resetRateLimits();
    const r = await json('POST', '/v1/billing/checkout', { plan_id: 'credit_pack' }, auth(s.access_token, 'co-returning-3'), liveApp);
    expect(r.status).toBe(200);
    expect(live.last('createCheckout')![0]).not.toHaveProperty('customer_id');
    // Dev-only endpoints disappear when payments are real.
    expect((await json('POST', '/v1/dev/fake-checkout/cs_fake_x/complete', undefined, {}, liveApp)).status).toBe(404);
    expect((await json('POST', '/v1/dev/fake-subscription/cancel', { cancel: true }, auth(s.access_token), liveApp)).status).toBe(404);
    expect(((await (await liveApp.request('/v1/health')).json()) as { payments: string }).payments).toBe('test');
  });

  // ── Portal, refunds, deletion ──

  it('customer portal: nothing to manage, deep links per flow, cancel falls back once canceled', async () => {
    const free = await login('portal-free@example.org');
    expect(await (await app.request('/v1/billing/portal', { headers: auth(free.access_token) })).json()).toEqual({ mode: 'fake', manageable: false });
    expect((await json('POST', '/v1/billing/portal', { flow: 'overview' }, auth(free.access_token))).status).toBe(404);

    const s = await subscribe('portal@example.org');
    const flow = async (body: unknown) => {
      resetRateLimits();
      expect((await json('POST', '/v1/billing/portal', body, auth(s.access_token))).status).toBe(200);
      return rec.last('createPortalSession')!;
    };
    expect(await flow({ flow: 'cancel' })).toEqual([s.customer, { kind: 'cancel', subscription_id: s.sub }]);
    expect(await flow({ flow: 'update_payment' })).toEqual([s.customer, { kind: 'update_payment' }]);
    expect(await flow({})).toEqual([s.customer, { kind: 'overview' }]);
    expect((await json('POST', '/v1/billing/portal', { flow: 'hack' }, auth(s.access_token))).status).toBe(400);
    await event('evt_portal_del', 'customer.subscription.deleted', { id: s.sub, status: 'canceled', metadata: { user_id: s.user.id } });
    expect(await flow({ flow: 'cancel' })).toEqual([s.customer, { kind: 'overview' }]);
  });

  it('refunds: a full refund of a one-time payment zeroes its credits; a subscription refund without a checkout is ignored', async () => {
    const u = await login('refund@example.org');
    const co = (await (await checkout(u.access_token, 'credit_pack', 'co-refund-1')).json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${co.transaction_id}/complete`);
    await event('evt_rf_1', 'charge.refunded', { id: 'ch_1', refunded: true, payment_intent: `pi_fake_${co.transaction_id.slice('cs_fake_'.length)}` });
    expect((await sql`SELECT remaining FROM credit_grants WHERE provider_transaction_id = ${co.transaction_id}`)[0]!.remaining).toBe(0);
    const r = await event('evt_rf_2', 'charge.refunded', { id: 'ch_2', refunded: true, payment_intent: 'pi_unrelated' });
    expect(await r.json()).toEqual({ ok: true, processed: true });
  });

  it('account deletion stops if Stripe cannot cancel the subscription, and succeeds once it can', async () => {
    const s = await subscribe('delete-me@example.org');
    rec.fail.cancelSubscriptionNow = new Error('Stripe is down');
    try {
      const r = await app.request('/v1/account', { method: 'DELETE', headers: auth(s.access_token) });
      expect(r.status).toBe(422);
      expect((await errorOf(r)).code).toBe('processing_failed');
      expect((await sql`SELECT status FROM users WHERE id = ${s.user.id}`)[0]!.status).toBe('active');
    } finally {
      delete rec.fail.cancelSubscriptionNow;
    }
    const ok = await app.request('/v1/account', { method: 'DELETE', headers: auth(s.access_token) });
    expect(ok.status).toBe(202);
    expect(rec.last('cancelSubscriptionNow')).toEqual([s.sub]);
    expect((await sql`SELECT count(*)::int AS n FROM users WHERE id = ${s.user.id}`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM auth_verifications WHERE identifier = 'delete-me@example.org'`)[0]!.n).toBe(0);
  });
});
