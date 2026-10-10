import { ApiError, uuidv7 } from '@jmo/shared';
import { hmacSha256Hex, timingSafeEqual } from '../crypto';

// Stripe adapter. Checkout and the customer portal are Stripe-hosted pages, so card data never touches our code.
// The fake gateway lets the whole checkout + webhook + coupon flow run locally. Field names follow Stripe's API
// reference for the pinned version below (docs.stripe.com/api, checked 2026-10-09); verify in test mode.

/**
 * Pinned so request and response shapes don't move when the account's default version does. Webhook payloads are
 * rendered in the webhook endpoint's own version, so the webhook handler accepts both subscription layouts.
 */
export const STRIPE_API_VERSION = '2025-08-27.basil';

export type PaymentMode = 'fake' | 'test' | 'live';

export interface DiscountInput {
  name: string;
  percent: number;
  duration: 'once' | 'repeating' | 'forever';
  /** repeating only */
  duration_in_months: number | null;
  max_redemptions: number | null;
  redeem_by: string;
}

export interface CheckoutInput {
  price_id: string;
  mode: 'subscription' | 'payment';
  email: string;
  /** Reuse the customer from an earlier subscription so the portal shows one history. */
  customer_id?: string;
  discount_id?: string;
  metadata: Record<string, string>;
  /** Stripe accepts 30 minutes to 24 hours. */
  expires_in_minutes: number;
}

export type PortalFlow = { kind: 'overview' } | { kind: 'cancel'; subscription_id: string } | { kind: 'update_payment' };

export interface PaymentGateway {
  readonly mode: PaymentMode;
  createDiscount(d: DiscountInput): Promise<{ id: string }>;
  /** Stops new redemptions; subscriptions that already carry the discount keep it. */
  archiveDiscount(id: string): Promise<void>;
  createCheckout(c: CheckoutInput): Promise<{ id: string; url: string }>;
  createPrice(p: { plan_id: string; plan_name: string; amount_minor: number; currency: string; interval: string | null; interval_count: number | null }): Promise<{ id: string }>;
  /** Stripe-hosted portal: invoices, payment method, cancellation. The URL is short-lived, so create it on click. */
  createPortalSession(customerId: string, flow: PortalFlow): Promise<{ url: string }>;
  /** Stops billing now (account deletion). Ordinary cancellations happen in the portal at period end. */
  cancelSubscriptionNow(subscriptionId: string): Promise<void>;
  /** The Checkout Session a one-time payment came from (used for refunds); null when there is none. */
  findCheckoutForPayment(paymentIntentId: string): Promise<string | null>;
}

/** Stripe takes form-encoded bodies with bracketed keys: line_items[0][price]=…, metadata[user_id]=… */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${key}[${k}]`);
    else out.push(`${encodeURIComponent(key).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return out.join('&');
}

export function stripeClient(secretKey: string, opts: { webOrigin: string; fetchFn?: typeof fetch }): PaymentGateway {
  const fetchFn = opts.fetchFn ?? fetch;
  const request = async (method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>) => {
    const qs = params ? formEncode(params) : '';
    const res = await fetchFn(`https://api.stripe.com/v1${path}${method !== 'POST' && qs ? `?${qs}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, 'stripe-version': STRIPE_API_VERSION, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: qs } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
    return { ok: res.ok, status: res.status, json };
  };
  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>) => {
    const r = await request(method, path, params);
    if (!r.ok) throw new ApiError('internal', `Stripe ${method} ${path} failed: ${r.json.error?.message ?? r.status}`);
    return r.json;
  };
  // One product per plan with a predictable id, so new prices for a plan attach to the same product.
  const ensureProduct = async (planId: string, name: string) => {
    const id = `jmo_${planId}`;
    const r = await request('GET', `/products/${id}`);
    if (r.status === 404) await call('POST', '/products', { id, name });
    else if (!r.ok) throw new ApiError('internal', `Stripe GET /products/${id} failed: ${r.json.error?.message ?? r.status}`);
    return id;
  };
  return {
    mode: /^(sk|rk)_live_/.test(secretKey) ? 'live' : 'test',
    async createDiscount(d) {
      // Codes live in OUR database; the coupon is applied to a Checkout Session by id after our rules pass.
      const data = await call('POST', '/coupons', {
        name: d.name.slice(0, 40),
        percent_off: d.percent,
        duration: d.duration,
        ...(d.duration === 'repeating' ? { duration_in_months: d.duration_in_months } : {}),
        max_redemptions: d.max_redemptions,
        redeem_by: Math.floor(Date.parse(d.redeem_by) / 1000),
      });
      return { id: String(data.id) };
    },
    async archiveDiscount(id) {
      await call('DELETE', `/coupons/${encodeURIComponent(id)}`);
    },
    async createCheckout(c) {
      const minutes = Math.min(Math.max(c.expires_in_minutes, 30), 24 * 60);
      const data = await call('POST', '/checkout/sessions', {
        mode: c.mode,
        line_items: [{ price: c.price_id, quantity: 1 }],
        ...(c.customer_id ? { customer: c.customer_id } : { customer_email: c.email }),
        client_reference_id: c.metadata.user_id,
        metadata: c.metadata,
        // Metadata on the subscription (or payment) is what later webhooks carry back to us.
        ...(c.mode === 'subscription' ? { subscription_data: { metadata: c.metadata } } : { payment_intent_data: { metadata: c.metadata } }),
        ...(c.discount_id ? { discounts: [{ coupon: c.discount_id }] } : {}),
        success_url: `${opts.webOrigin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${opts.webOrigin}/checkout?cancelled=1`,
        expires_at: Math.floor(Date.now() / 1000) + minutes * 60,
      });
      return { id: String(data.id), url: String(data.url ?? '') };
    },
    async createPrice(p) {
      const product = await ensureProduct(p.plan_id, p.plan_name);
      const data = await call('POST', '/prices', {
        product,
        currency: p.currency.toLowerCase(),
        unit_amount: p.amount_minor,
        nickname: `${p.plan_id} ${p.currency} ${p.amount_minor}`,
        ...(p.interval ? { recurring: { interval: p.interval, interval_count: p.interval_count ?? 1 } } : {}),
      });
      return { id: String(data.id) };
    },
    async createPortalSession(customerId, flow) {
      const flowData =
        flow.kind === 'cancel' ? { type: 'subscription_cancel', subscription_cancel: { subscription: flow.subscription_id } } : flow.kind === 'update_payment' ? { type: 'payment_method_update' } : null;
      const data = await call('POST', '/billing_portal/sessions', { customer: customerId, return_url: `${opts.webOrigin}/account`, flow_data: flowData });
      return { url: String(data.url) };
    },
    async cancelSubscriptionNow(subscriptionId) {
      await call('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
    async findCheckoutForPayment(paymentIntentId) {
      const data = await call('GET', '/checkout/sessions', { payment_intent: paymentIntentId, limit: 1 });
      const first = ((data.data as Array<{ id?: string }> | undefined) ?? [])[0];
      return first?.id ?? null;
    },
  };
}

/** Local fake: deterministic ids; the checkout URL points at our dev checkout page, which simulates payment. */
export function fakeStripe(webOrigin: string): PaymentGateway {
  const id = (prefix: string) => `${prefix}_fake_${uuidv7().replace(/-/g, '').slice(0, 20)}`;
  return {
    mode: 'fake',
    async createDiscount() {
      return { id: id('coupon') };
    },
    async archiveDiscount() {},
    async createCheckout() {
      const session = id('cs');
      return { id: session, url: `${webOrigin}/checkout?session=${session}` };
    },
    async createPrice(p) {
      return { id: `price_fake_${p.plan_id}_${Date.now()}` };
    },
    async createPortalSession() {
      // The account page shows its own test controls in fake mode.
      return { url: `${webOrigin}/account?fake_portal=1` };
    },
    async cancelSubscriptionNow() {},
    async findCheckoutForPayment(paymentIntentId) {
      // The fake checkout names its payment intent after the session (BillingService.completeFakeCheckout).
      return paymentIntentId.startsWith('pi_fake_') ? `cs_fake_${paymentIntentId.slice('pi_fake_'.length)}` : null;
    },
  };
}

/** Stripe-Signature: "t=…,v1=…" (several v1 during secret rotation), HMAC-SHA256 over `${t}.${rawBody}`; rejects stale timestamps. */
export async function verifyStripeSignature(header: string | null | undefined, rawBody: string, secret: string, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  let t = '';
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    const [k, v] = [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  const ts = Number(t);
  if (!v1.length || !t || !Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return v1.some((s) => timingSafeEqual(expected, s));
}

export async function signStripePayload(rawBody: string, secret: string, now = Date.now()): Promise<string> {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}
