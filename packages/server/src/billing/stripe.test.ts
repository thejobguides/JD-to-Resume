import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../crypto';
import { formEncode, signStripePayload, STRIPE_API_VERSION, stripeClient, verifyStripeSignature } from './stripe';

// Request shapes for the real Stripe client, checked against a recording fetch (no network, no key).

function recorder(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: URLSearchParams }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: init.headers as Record<string, string>, body: new URLSearchParams(String(init.body ?? '')) });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('Stripe webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts its own signature and rejects tampering, stale timestamps and missing headers', async () => {
    const now = Date.now();
    const sig = await signStripePayload(raw, secret, now);
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await verifyStripeSignature(sig, raw, secret, now)).toBe(true);
    expect(await verifyStripeSignature(sig, `${raw} `, secret, now)).toBe(false);
    expect(await verifyStripeSignature(sig, raw, 'whsec_other', now)).toBe(false);
    expect(await verifyStripeSignature(sig, raw, secret, now + 301_000)).toBe(false);
    expect(await verifyStripeSignature(null, raw, secret, now)).toBe(false);
    expect(await verifyStripeSignature('t=1', raw, secret, now)).toBe(false);
  });

  it('accepts any matching v1 (secret rotation) and ignores v0', async () => {
    const t = Math.floor(Date.now() / 1000);
    const good = await hmacSha256Hex(secret, `${t}.${raw}`);
    expect(await verifyStripeSignature(`t=${t},v1=${'0'.repeat(64)},v1=${good},v0=abc`, raw, secret)).toBe(true);
    expect(await verifyStripeSignature(`t=${t},v0=${good}`, raw, secret)).toBe(false);
  });
});

describe('Stripe client', () => {
  it('form-encodes nested params with bracketed keys and skips nulls', () => {
    expect(formEncode({ a: 1, line_items: [{ price: 'p 1', quantity: 1 }], metadata: { user_id: 'u' }, gone: null, flow_data: undefined })).toBe(
      'a=1&line_items[0][price]=p%201&line_items[0][quantity]=1&metadata[user_id]=u',
    );
  });

  it('creates a subscription Checkout Session with the coupon, metadata and return URLs', async () => {
    const { calls, fetchFn } = recorder([{ body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } }]);
    const s = stripeClient('sk_test_123', { webOrigin: 'https://site.test', fetchFn });
    expect(s.mode).toBe('test');
    const meta = { user_id: 'u1', plan_id: 'pro_quarterly', redemption_id: 'r1' };
    const r = await s.createCheckout({ price_id: 'price_q', mode: 'subscription', email: 'a@b.co', discount_id: 'coup_1', metadata: meta, expires_in_minutes: 10 });
    expect(r).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(c.headers).toMatchObject({ authorization: 'Bearer sk_test_123', 'stripe-version': STRIPE_API_VERSION, 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(c.body)).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': 'price_q',
      'line_items[0][quantity]': '1',
      customer_email: 'a@b.co',
      client_reference_id: 'u1',
      'metadata[redemption_id]': 'r1',
      'subscription_data[metadata][user_id]': 'u1',
      'discounts[0][coupon]': 'coup_1',
      success_url: 'https://site.test/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://site.test/checkout?cancelled=1',
    });
    // Stripe's minimum expiry is 30 minutes.
    const expires = Number(c.body.get('expires_at'));
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60 - 5);
  });

  it('uses payment mode metadata and an existing customer for one-time purchases', async () => {
    const { calls, fetchFn } = recorder([{ body: { id: 'cs_2', url: 'u' } }]);
    await stripeClient('sk_live_x', { webOrigin: 'https://site.test', fetchFn }).createCheckout({ price_id: 'price_pack', mode: 'payment', email: 'a@b.co', customer_id: 'cus_1', metadata: { user_id: 'u1', plan_id: 'credit_pack' }, expires_in_minutes: 60 });
    const body = Object.fromEntries(calls[0]!.body);
    expect(body).toMatchObject({ mode: 'payment', customer: 'cus_1', 'payment_intent_data[metadata][plan_id]': 'credit_pack' });
    expect(body.customer_email).toBeUndefined();
    expect(body['subscription_data[metadata][user_id]']).toBeUndefined();
  });

  it('creates the plan product once, then a recurring price on it', async () => {
    const { calls, fetchFn } = recorder([{ status: 404, body: { error: { message: 'No such product' } } }, { body: { id: 'jmo_pro_quarterly' } }, { body: { id: 'price_1' } }]);
    const r = await stripeClient('sk_test_1', { webOrigin: 'w', fetchFn }).createPrice({ plan_id: 'pro_quarterly', plan_name: 'Pro (quarterly)', amount_minor: 4500, currency: 'USD', interval: 'month', interval_count: 3 });
    expect(r.id).toBe('price_1');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.stripe.com/v1', '')}`)).toEqual(['GET /products/jmo_pro_quarterly', 'POST /products', 'POST /prices']);
    expect(Object.fromEntries(calls[2]!.body)).toMatchObject({ product: 'jmo_pro_quarterly', currency: 'usd', unit_amount: '4500', 'recurring[interval]': 'month', 'recurring[interval_count]': '3' });
  });

  it('creates coupons with Stripe durations and a 40-character name', async () => {
    const { calls, fetchFn } = recorder([{ body: { id: 'coup_1' } }]);
    await stripeClient('sk_test_1', { webOrigin: 'w', fetchFn }).createDiscount({ name: 'A very long internal campaign name for launch week 2026', percent: 30, duration: 'repeating', duration_in_months: 6, max_redemptions: null, redeem_by: '2026-12-31T00:00:00Z' });
    const body = Object.fromEntries(calls[0]!.body);
    expect(body).toMatchObject({ percent_off: '30', duration: 'repeating', duration_in_months: '6', redeem_by: String(Date.parse('2026-12-31T00:00:00Z') / 1000) });
    expect(body.name).toHaveLength(40);
    expect(body.max_redemptions).toBeUndefined();
  });

  it('deep-links the portal, cancels immediately, and maps refunds back to their checkout', async () => {
    const { calls, fetchFn } = recorder([{ body: { url: 'https://billing.stripe.com/p/session/x' } }, { body: { id: 'sub_1', status: 'canceled' } }, { body: { data: [{ id: 'cs_9' }] } }, { body: { data: [] } }]);
    const s = stripeClient('sk_test_1', { webOrigin: 'https://site.test', fetchFn });
    expect((await s.createPortalSession('cus_1', { kind: 'cancel', subscription_id: 'sub_1' })).url).toContain('billing.stripe.com');
    expect(Object.fromEntries(calls[0]!.body)).toMatchObject({ customer: 'cus_1', return_url: 'https://site.test/account', 'flow_data[type]': 'subscription_cancel', 'flow_data[subscription_cancel][subscription]': 'sub_1' });
    await s.cancelSubscriptionNow('sub_1');
    expect(`${calls[1]!.method} ${calls[1]!.url}`).toBe('DELETE https://api.stripe.com/v1/subscriptions/sub_1');
    expect(await s.findCheckoutForPayment('pi_1')).toBe('cs_9');
    expect(calls[2]!.url).toBe('https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_1&limit=1');
    expect(await s.findCheckoutForPayment('pi_2')).toBeNull();
  });

  it('surfaces Stripe error messages', async () => {
    const { fetchFn } = recorder([{ status: 400, body: { error: { message: 'No such price: price_x' } } }]);
    await expect(stripeClient('sk_test_1', { webOrigin: 'w', fetchFn }).createCheckout({ price_id: 'price_x', mode: 'subscription', email: 'a@b.co', metadata: { user_id: 'u' }, expires_in_minutes: 60 })).rejects.toThrow(/No such price: price_x/);
  });
});
