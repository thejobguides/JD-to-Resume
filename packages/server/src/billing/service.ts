import type { ActiveConfig } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { ApiError, type PlanId, uuidv7 } from '@jmo/shared';
import { audit } from '../audit';
import { reserveCoupon } from './coupons';
import { type PaymentGateway, type PaymentMode, type PortalFlow, signStripePayload, verifyStripeSignature } from './stripe';

// Checkout + webhooks (api-design.md §6.16, §7) on Stripe. Webhooks are idempotent by Stripe event id.
// Events we act on: checkout.session.completed / async_payment_succeeded, customer.subscription.*, charge.refunded.

const CREDIT_PACK_SIZE = 25;

type StripeObject = Record<string, unknown>;

/**
 * Stripe subscription status → ours. "past_due" keeps access while Stripe retries the card; "unpaid" (retries
 * exhausted) doesn't. "incomplete" is missing on purpose: the first payment hasn't gone through yet, and a later
 * customer.subscription.updated brings the real status.
 */
const SUB_STATUS: Record<string, 'active' | 'trialing' | 'past_due' | 'canceled' | 'paused'> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'canceled',
  incomplete_expired: 'canceled',
  unpaid: 'paused',
  paused: 'paused',
};

const unix = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : null);
const iso = (s: unknown) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null);

export class BillingService {
  /** Fake mode only: remembers pending checkouts so the dev checkout page can simulate a payment. */
  private fakePending = new Map<string, { user_id: string; plan_id: PlanId; redemption_id: string | null; price_id: string; mode: 'subscription' | 'payment' }>();

  constructor(
    private sql: Sql,
    private payments: PaymentGateway,
    private webhookSecret: string,
  ) {}

  get mode(): PaymentMode {
    return this.payments.mode;
  }

  async listPlans(cfg: ActiveConfig) {
    const prices = await this.sql<Array<{ plan_id: string; unit_amount_minor: number; currency: string; billing_interval: string | null; billing_frequency: number | null }>>`
      SELECT pp.plan_id, pp.unit_amount_minor, pp.currency, p.billing_interval, p.billing_frequency
      FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id WHERE pp.status = 'active' AND p.active`;
    return Object.entries(cfg.plans.display)
      .filter(([, d]) => d.visible)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([plan_id, d]) => {
        const pr = prices.find((x) => x.plan_id === plan_id);
        return {
          plan_id: plan_id as PlanId,
          name: d.name,
          price: pr ? { currency: pr.currency, amount: (pr.unit_amount_minor / 100).toFixed(2), interval: pr.billing_interval ? `${pr.billing_frequency ?? 1} ${pr.billing_interval}` : null } : null,
          features: d.features,
          badge: d.badge,
        };
      });
  }

  async checkout(cfg: ActiveConfig, user: { id: string; email: string }, planId: PlanId, couponCode?: string) {
    if (cfg.kill_switches.checkout) throw new ApiError('maintenance', 'Checkout is temporarily unavailable.');
    if (planId === 'free') throw new ApiError('invalid_request', 'The free plan needs no checkout.');
    let reservation: { redemption_id: string; discount_id: string | null; price_id: string } | null = null;
    if (couponCode) {
      if (cfg.kill_switches.coupons) throw new ApiError('coupon_rejected', "This code isn't valid.", { reason: 'invalid' });
      reservation = await this.sql.begin((tx) => reserveCoupon(tx, cfg, couponCode, planId, user));
    }
    const [price] = await this.sql<Array<{ provider_price_id: string; kind: string }>>`
      SELECT pp.provider_price_id, p.kind FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
      WHERE pp.plan_id = ${planId} AND pp.status = 'active' ORDER BY pp.created_at DESC LIMIT 1`;
    if (!price) throw new ApiError('not_found', 'This plan is not for sale right now.');
    // Reuse the customer from an earlier subscription (never a fake id against real Stripe, or the reverse).
    const [prev] = await this.sql<Array<{ provider_customer_id: string | null }>>`SELECT provider_customer_id FROM subscriptions WHERE user_id = ${user.id}`;
    const prevCustomer = prev?.provider_customer_id;
    const reuse = prevCustomer?.startsWith('cus_') && prevCustomer.startsWith('cus_fake_') === (this.payments.mode === 'fake');
    const mode = price.kind === 'one_time' ? 'payment' : 'subscription';
    const priceId = reservation?.price_id ?? price.provider_price_id;
    try {
      const session = await this.payments.createCheckout({
        price_id: priceId,
        mode,
        email: user.email,
        ...(reuse ? { customer_id: prevCustomer! } : {}),
        ...(reservation?.discount_id ? { discount_id: reservation.discount_id } : {}),
        metadata: { user_id: user.id, plan_id: planId, ...(reservation ? { redemption_id: reservation.redemption_id } : {}) },
        // An abandoned checkout expires about when its coupon reservation is released.
        expires_in_minutes: cfg.coupons_policy.reservation_minutes,
      });
      if (reservation) await this.sql`UPDATE coupon_redemptions SET provider_transaction_id = ${session.id} WHERE id = ${reservation.redemption_id}`;
      if (this.payments.mode === 'fake') {
        this.fakePending.set(session.id, { user_id: user.id, plan_id: planId, redemption_id: reservation?.redemption_id ?? null, price_id: priceId, mode });
      }
      return { checkout_url: session.url, transaction_id: session.id, coupon_redemption_id: reservation?.redemption_id ?? null };
    } catch (e) {
      if (reservation) await this.sql`UPDATE coupon_redemptions SET status = 'released' WHERE id = ${reservation.redemption_id}`;
      throw e;
    }
  }

  /** Verifies and applies a Stripe webhook. Returns false for duplicates. */
  async handleWebhook(rawBody: string, signature: string | null): Promise<{ processed: boolean }> {
    if (!(await verifyStripeSignature(signature, rawBody, this.webhookSecret))) throw new ApiError('unauthenticated', 'Invalid webhook signature.');
    const evt = JSON.parse(rawBody) as { id: string; type: string; data: { object: StripeObject } };
    const o = evt.data.object;
    const meta = { ...((o.metadata ?? {}) as Record<string, string>) };
    // A refund names a payment, not our checkout; look the checkout up before opening the transaction (network call).
    const refunded = evt.type === 'charge.refunded' && o.refunded === true && typeof o.payment_intent === 'string' ? await this.payments.findCheckoutForPayment(o.payment_intent) : null;
    const totals = evt.type.startsWith('checkout.session.')
      ? { subtotal: (o.amount_subtotal as number | undefined) ?? null, discount: ((o.total_details as StripeObject | undefined)?.amount_discount as number | undefined) ?? null, total: (o.amount_total as number | undefined) ?? null, currency: (o.currency as string | undefined) ?? null }
      : null;
    return this.sql.begin(async (tx) => {
      // Events can arrive after the account was deleted (e.g. the cancellation we sent during deletion).
      if (meta.user_id && !(await tx`SELECT 1 FROM users WHERE id = ${meta.user_id}`).length) delete meta.user_id;
      const inserted = await tx`
        INSERT INTO subscription_events (id, user_id, provider_event_id, event_type, payload_min)
        VALUES (${uuidv7()}, ${meta.user_id ?? null}, ${evt.id}, ${evt.type}, ${tx.json({ id: o.id ?? null, status: o.status ?? null, metadata: meta, totals } as never)})
        ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`;
      if (!inserted.length) return { processed: false };

      const paid = o.payment_status === 'paid' || o.payment_status === 'no_payment_required';
      if ((evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') && paid && totals) {
        if (meta.redemption_id) {
          await tx`UPDATE coupon_redemptions SET status = 'completed', completed_at = now(), provider_subscription_id = ${(o.subscription as string | null) ?? null},
                   discount_amount_minor = COALESCE(${totals.discount}, discount_amount_minor),
                   list_amount_minor = COALESCE(${totals.subtotal}, list_amount_minor)
                   WHERE id = ${meta.redemption_id}`;
          await audit(tx, { actor_type: 'webhook', action: 'coupon.redeemed', target_type: 'coupon_redemption', target_id: meta.redemption_id, after: { transaction_id: o.id, totals }, request_id: evt.id });
        }
        if (meta.plan_id === 'credit_pack' && meta.user_id) {
          await tx`INSERT INTO credit_grants (id, user_id, kind, optimizations, remaining, provider_transaction_id) VALUES (${uuidv7()}, ${meta.user_id}, 'pack', ${CREDIT_PACK_SIZE}, ${CREDIT_PACK_SIZE}, ${String(o.id)}) ON CONFLICT (provider_transaction_id) DO NOTHING`;
        }
      }

      const status = evt.type === 'customer.subscription.deleted' ? 'canceled' : SUB_STATUS[String(o.status)];
      if (evt.type.startsWith('customer.subscription.') && meta.user_id && status) {
        const item = ((o.items as { data?: StripeObject[] } | undefined)?.data ?? [])[0] ?? {};
        const priceId = ((item.price as StripeObject | undefined)?.id as string | undefined) ?? null;
        // The price decides the plan, so a plan switch made in the portal is picked up; metadata covers unknown prices.
        const [byPrice] = priceId ? await tx<Array<{ plan_id: string }>>`SELECT plan_id FROM plan_prices WHERE provider_price_id = ${priceId}` : [];
        const planId = byPrice?.plan_id ?? meta.plan_id ?? 'pro_monthly';
        // Basil and later put the billing period on the item; older webhook versions put it on the subscription.
        const start = iso(item.current_period_start ?? o.current_period_start);
        const end = iso(item.current_period_end ?? o.current_period_end);
        const cancelScheduled = o.cancel_at_period_end === true || (o.cancel_at != null && status !== 'canceled');
        // The WHERE keeps a late "canceled" for an older subscription from overwriting the user's newer one.
        await tx`
          INSERT INTO subscriptions (id, user_id, plan_id, provider_price_id, coupon_redemption_id, status, provider_customer_id, provider_subscription_id, current_period_start, current_period_end, cancel_at_period_end)
          VALUES (${uuidv7()}, ${meta.user_id}, ${planId}, ${priceId}, ${meta.redemption_id ?? null}, ${status}, ${(o.customer as string | null) ?? null}, ${String(o.id)}, ${start}, ${end}, ${cancelScheduled})
          ON CONFLICT (user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, provider_price_id = COALESCE(EXCLUDED.provider_price_id, subscriptions.provider_price_id), status = EXCLUDED.status,
            provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id), provider_subscription_id = EXCLUDED.provider_subscription_id,
            current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start), current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
            cancel_at_period_end = EXCLUDED.cancel_at_period_end, coupon_redemption_id = COALESCE(subscriptions.coupon_redemption_id, EXCLUDED.coupon_redemption_id), updated_at = now()
          WHERE subscriptions.provider_subscription_id IS NULL OR subscriptions.provider_subscription_id = EXCLUDED.provider_subscription_id OR EXCLUDED.status <> 'canceled'`;
        await audit(tx, { actor_type: 'webhook', action: `subscription.${status}`, target_type: 'user', target_id: meta.user_id, after: { plan_id: planId, status }, request_id: evt.id });
      }

      if (refunded) {
        await tx`UPDATE coupon_redemptions SET status = 'refunded' WHERE provider_transaction_id = ${refunded}`;
        await tx`UPDATE credit_grants SET remaining = 0 WHERE provider_transaction_id = ${refunded}`;
        await audit(tx, { actor_type: 'webhook', action: 'transaction.refunded', target_type: 'transaction', target_id: refunded, request_id: evt.id });
      }
      await tx`UPDATE subscription_events SET processed_at = now() WHERE provider_event_id = ${evt.id}`;
      return { processed: true };
    });
  }

  /**
   * Account deletion: stop billing at Stripe first. Throws (and nothing is deleted) if Stripe can't be reached, so a
   * deleted account can never keep being charged. Returns the step outcome recorded on the deletion request.
   */
  async cancelForDeletion(userId: string): Promise<string> {
    const [s] = await this.sql<Array<{ provider_subscription_id: string | null; status: string }>>`
      SELECT provider_subscription_id, status FROM subscriptions WHERE user_id = ${userId}`;
    if (!s?.provider_subscription_id || s.status === 'canceled') return 'none';
    try {
      await this.payments.cancelSubscriptionNow(s.provider_subscription_id);
    } catch {
      throw new ApiError('processing_failed', 'We could not cancel your subscription with our payment provider, so nothing was deleted. Please try again in a few minutes.');
    }
    return `canceled:${s.provider_subscription_id}`;
  }

  /** What the account page needs to show its billing buttons; the portal URL itself is created on click. */
  async portal(userId: string): Promise<{ mode: PaymentMode; manageable: boolean }> {
    const [s] = await this.sql<Array<{ provider_customer_id: string | null }>>`SELECT provider_customer_id FROM subscriptions WHERE user_id = ${userId}`;
    return { mode: this.payments.mode, manageable: !!s?.provider_customer_id };
  }

  /** A fresh Stripe customer-portal URL (they expire within minutes), optionally deep-linked to one task. */
  async portalSession(userId: string, flow: 'overview' | 'cancel' | 'update_payment'): Promise<{ url: string }> {
    const [s] = await this.sql<Array<{ provider_customer_id: string | null; provider_subscription_id: string | null; status: string }>>`
      SELECT provider_customer_id, provider_subscription_id, status FROM subscriptions WHERE user_id = ${userId}`;
    if (!s?.provider_customer_id) throw new ApiError('not_found', 'There is no subscription to manage.');
    const f: PortalFlow =
      flow === 'cancel' && s.provider_subscription_id && s.status !== 'canceled' ? { kind: 'cancel', subscription_id: s.provider_subscription_id } : flow === 'update_payment' ? { kind: 'update_payment' } : { kind: 'overview' };
    return this.payments.createPortalSession(s.provider_customer_id, f);
  }

  /** Development only: what Stripe sends when a customer cancels (at period end) or resumes in the portal. */
  async fakeSetCancel(userId: string, cancel: boolean): Promise<void> {
    if (this.payments.mode !== 'fake') throw new ApiError('forbidden', 'Only available with the fake payment gateway.');
    const [s] = await this.sql<Array<{ plan_id: string; provider_price_id: string | null; provider_customer_id: string | null; provider_subscription_id: string | null; current_period_start: Date | null; current_period_end: Date | null; coupon_redemption_id: string | null }>>`
      SELECT plan_id, provider_price_id, provider_customer_id, provider_subscription_id, current_period_start, current_period_end, coupon_redemption_id FROM subscriptions WHERE user_id = ${userId} AND status IN ('active','trialing')`;
    if (!s?.provider_subscription_id) throw new ApiError('not_found', 'No active subscription.');
    const metadata = { user_id: userId, plan_id: s.plan_id, ...(s.coupon_redemption_id ? { redemption_id: s.coupon_redemption_id } : {}) };
    await this.sendFakeEvent('customer.subscription.updated', {
      id: s.provider_subscription_id,
      object: 'subscription',
      status: 'active',
      customer: s.provider_customer_id,
      metadata,
      items: { data: [{ price: { id: s.provider_price_id }, current_period_start: unix(s.current_period_start), current_period_end: unix(s.current_period_end) }] },
      cancel_at_period_end: cancel,
      cancel_at: cancel ? unix(s.current_period_end) : null,
    });
  }

  /** Development only: simulate the payment for a fake checkout by emitting the signed webhooks Stripe would send. */
  async completeFakeCheckout(sessionId: string): Promise<void> {
    if (this.payments.mode !== 'fake') throw new ApiError('forbidden', 'Only available with the fake payment gateway.');
    const p = this.fakePending.get(sessionId);
    if (!p) throw new ApiError('not_found', 'Unknown test checkout.');
    const [price] = await this.sql<Array<{ unit_amount_minor: number }>>`SELECT unit_amount_minor FROM plan_prices WHERE provider_price_id = ${p.price_id}`;
    let discount = 0;
    if (p.redemption_id) {
      const [r] = await this.sql<Array<{ discount_amount_minor: number }>>`SELECT discount_amount_minor FROM coupon_redemptions WHERE id = ${p.redemption_id}`;
      discount = r?.discount_amount_minor ?? 0;
    }
    const list = price?.unit_amount_minor ?? 0;
    const metadata = { user_id: p.user_id, plan_id: p.plan_id, ...(p.redemption_id ? { redemption_id: p.redemption_id } : {}) };
    const now = new Date();
    const months = p.plan_id === 'pro_quarterly' ? 3 : p.plan_id === 'byok_annual' ? 12 : 1;
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, now.getUTCDate()));
    const key = sessionId.slice('cs_fake_'.length);
    const subscription = p.mode === 'subscription' ? `sub_fake_${key}` : null;
    const customer = `cus_fake_${p.user_id.replace(/-/g, '').slice(0, 16)}`;
    await this.sendFakeEvent('checkout.session.completed', {
      id: sessionId,
      object: 'checkout.session',
      mode: p.mode,
      status: 'complete',
      payment_status: list - discount > 0 ? 'paid' : 'no_payment_required',
      client_reference_id: p.user_id,
      customer,
      subscription,
      // findCheckoutForPayment in the fake gateway maps this back to the session (refund tests).
      payment_intent: p.mode === 'payment' ? `pi_fake_${key}` : null,
      metadata,
      amount_subtotal: list,
      amount_total: list - discount,
      total_details: { amount_discount: discount },
      currency: 'usd',
    });
    if (subscription) {
      await this.sendFakeEvent('customer.subscription.created', {
        id: subscription,
        object: 'subscription',
        status: 'active',
        customer,
        metadata,
        items: { data: [{ price: { id: p.price_id }, current_period_start: unix(now), current_period_end: unix(end) }] },
        cancel_at_period_end: false,
        cancel_at: null,
      });
    }
    this.fakePending.delete(sessionId);
  }

  private async sendFakeEvent(type: string, object: StripeObject): Promise<void> {
    const raw = JSON.stringify({ id: `evt_fake_${uuidv7().replace(/-/g, '')}`, object: 'event', type, created: unix(new Date()), data: { object } });
    await this.handleWebhook(raw, await signStripePayload(raw, this.webhookSecret));
  }
}
