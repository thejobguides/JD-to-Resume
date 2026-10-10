import type { ActiveConfig } from '@jmo/config';
import type { Db, Sql } from '@jmo/db';
import { ApiError, CODE_ALPHABET, type PlanId, randomCode, uuidv7 } from '@jmo/shared';
import { audit } from '../audit';
import { hasPriorPaidTransaction } from '../users';
import type { PaymentGateway } from './stripe';

// Coupon engine (admin-panel.md §7): codes live in our DB; each per-plan rule maps to one Stripe coupon that is
// applied to the Checkout Session by id after our rules pass (customers never see a Stripe promotion code).
// Reservations use a row lock on the coupon so the last use can never be taken twice.

export type Duration = 'first_period' | 'repeating' | 'forever';

export interface CouponRuleInput {
  plan_id: PlanId;
  percent_off: number;
  duration: Duration;
  duration_periods?: number | null;
  ai_budget_override_usd?: number | null;
}

export interface CreateCouponInput {
  name: string;
  campaign?: string | null;
  codes: { mode: 'single'; code?: string } | { mode: 'bulk'; count: number; prefix?: string };
  rules: CouponRuleInput[];
  max_redemptions?: number | null;
  max_per_user?: number;
  new_customers_only?: boolean;
  allowed_email_domains?: string[] | null;
  max_discount_total_usd?: number | null;
  restore_use_on_refund?: boolean;
  valid_from: string;
  valid_until: string;
}

export type RejectReason = 'invalid' | 'expired' | 'not_started' | 'not_for_plan' | 'already_used' | 'limit_reached' | 'new_customers_only' | 'domain_not_allowed' | 'budget_reached';

const MESSAGES: Record<RejectReason, string> = {
  invalid: "This code isn't valid.",
  expired: 'This code has expired.',
  not_started: "This code isn't active yet.",
  not_for_plan: "This code doesn't apply to this plan.",
  already_used: "You've already used this code.",
  limit_reached: 'This code is no longer available.',
  new_customers_only: 'This code is for new customers only.',
  domain_not_allowed: "This code isn't available for your email address.",
  budget_reached: 'This code is no longer available.',
};

function reject(reason: RejectReason, extra: Record<string, unknown> = {}): never {
  throw new ApiError('coupon_rejected', MESSAGES[reason], { reason, ...extra });
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

/** Validation used by the admin API before creating a coupon (bounds from coupons_policy; hard caps here). */
export function validateCouponInput(i: CreateCouponInput, cfg: ActiveConfig, role: string): string[] {
  const errs: string[] = [];
  const pol = cfg.coupons_policy;
  if (!i.name.trim()) errs.push('name is required');
  if (!i.rules.length) errs.push('select at least one plan');
  // Bulk batches (one use per code) and max_redemptions = 1 are single-use; everything else is shared.
  const singleUse = i.codes.mode === 'bulk' || i.max_redemptions === 1;
  for (const r of i.rules) {
    if (!(r.percent_off > 0 && r.percent_off <= 100)) errs.push(`${r.plan_id}: percent must be 1–100`);
    if (!singleUse && r.percent_off > pol.max_shared_percent) errs.push(`${r.plan_id}: shared codes are limited to ${pol.max_shared_percent}% off; use single-use codes for deeper discounts`);
    if (singleUse && r.percent_off > pol.max_shared_percent && role !== 'owner') errs.push(`${r.plan_id}: discounts above ${pol.max_shared_percent}% need the Owner role`);
    if (r.duration === 'forever' && role !== 'owner') errs.push(`${r.plan_id}: "forever" discounts need the Owner role`);
    if (r.duration === 'repeating' && !(r.duration_periods && r.duration_periods >= 2 && r.duration_periods <= 24)) errs.push(`${r.plan_id}: repeating discounts need 2–24 billing periods`);
    if (r.plan_id === 'free') errs.push('the free plan cannot be discounted');
  }
  const from = Date.parse(i.valid_from);
  const until = Date.parse(i.valid_until);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) errs.push('valid_until must be after valid_from');
  else if (until - from > pol.max_validity_days * 86_400_000) errs.push(`validity is limited to ${pol.max_validity_days} days`);
  if (i.codes.mode === 'single' && i.codes.code && !/^[A-Z0-9-]{4,32}$/.test(normalizeCode(i.codes.code))) errs.push('codes are 4–32 characters: letters, digits and dashes');
  if (i.codes.mode === 'bulk' && !(i.codes.count >= 1 && i.codes.count <= 5000)) errs.push('bulk batches are 1–5000 codes');
  return errs;
}

export async function createCoupon(sql: Sql, payments: PaymentGateway, i: CreateCouponInput, actor: { id: string; role: string; reason: string; requestId?: string }) {
  const plans = await sql<Array<{ id: string; billing_interval: string | null; billing_frequency: number | null }>>`SELECT id, billing_interval, billing_frequency FROM plans`;
  const couponId = uuidv7();
  // Stripe coupons are created first (outside the DB transaction); on DB failure they are archived.
  const discounts: Array<{ plan_id: string; id: string }> = [];
  try {
    for (const r of i.rules) {
      const plan = plans.find((p) => p.id === r.plan_id);
      // Stripe counts repeating discounts in months, ours in billing periods. One-time purchases are discounted once.
      const months = plan?.billing_interval ? (plan.billing_interval === 'year' ? 12 : 1) * (plan.billing_frequency ?? 1) : null;
      const duration = months === null || r.duration === 'first_period' ? 'once' : r.duration;
      const d = await payments.createDiscount({
        name: i.name,
        percent: r.percent_off,
        duration,
        duration_in_months: duration === 'repeating' && months !== null ? (r.duration_periods ?? 2) * months : null,
        max_redemptions: i.max_redemptions ?? null,
        redeem_by: new Date(Date.parse(i.valid_until) + 2 * 3600_000).toISOString(),
      });
      discounts.push({ plan_id: r.plan_id, id: d.id });
    }
    const codes: string[] = i.codes.mode === 'single' ? [normalizeCode(i.codes.code || randomCode(10, CODE_ALPHABET))] : Array.from({ length: i.codes.count }, () => `${normalizeCode(i.codes.mode === 'bulk' ? (i.codes.prefix ?? '') : '')}${randomCode(10)}`);
    const batchId = i.codes.mode === 'bulk' ? uuidv7() : null;
    return await sql.begin(async (tx) => {
      await tx`INSERT INTO coupons (id, name, campaign, status, max_redemptions, max_per_user, new_customers_only, allowed_email_domains, max_discount_total_usd, restore_use_on_refund, valid_from, valid_until, created_by)
               VALUES (${couponId}, ${i.name}, ${i.campaign ?? null}, 'active', ${i.max_redemptions ?? null}, ${i.max_per_user ?? 1}, ${i.new_customers_only ?? false},
                       ${i.allowed_email_domains?.length ? i.allowed_email_domains.map((d) => d.toLowerCase()) : null}, ${i.max_discount_total_usd ?? null}, ${i.restore_use_on_refund ?? false},
                       ${i.valid_from}, ${i.valid_until}, ${actor.id})`;
      for (const r of i.rules) {
        await tx`INSERT INTO coupon_plan_rules (coupon_id, plan_id, percent_off, duration, duration_periods, ai_budget_override_usd, provider_discount_id)
                 VALUES (${couponId}, ${r.plan_id}, ${r.percent_off}, ${r.duration}, ${r.duration === 'repeating' ? (r.duration_periods ?? null) : null}, ${r.ai_budget_override_usd ?? null}, ${discounts.find((d) => d.plan_id === r.plan_id)!.id})`;
      }
      for (const code of codes) {
        await tx`INSERT INTO coupon_codes (id, coupon_id, code, max_uses, batch_id, status) VALUES (${uuidv7()}, ${couponId}, ${code}, ${batchId ? 1 : null}, ${batchId}, 'active')`;
      }
      const auditId = await audit(tx, {
        actor_type: 'admin',
        actor_id: actor.id,
        actor_role: actor.role,
        action: 'coupon.create',
        target_type: 'coupon',
        target_id: couponId,
        after: { ...i, codes: i.codes.mode === 'single' ? { mode: 'single', code: codes[0] } : { mode: 'bulk', count: codes.length }, provider_discount_ids: Object.fromEntries(discounts.map((d) => [d.plan_id, d.id])) },
        reason: actor.reason,
        request_id: actor.requestId ?? null,
      });
      return { id: couponId, codes: i.codes.mode === 'single' ? codes : [], batch_id: batchId, provider_discount_ids: Object.fromEntries(discounts.map((d) => [d.plan_id, d.id])), audit_id: auditId };
    });
  } catch (e) {
    for (const d of discounts) await payments.archiveDiscount(d.id).catch(() => undefined);
    throw e;
  }
}

interface CouponRow {
  id: string;
  status: string;
  max_redemptions: number | null;
  max_per_user: number;
  new_customers_only: boolean;
  allowed_email_domains: string[] | null;
  max_discount_total_usd: string | null;
  restore_use_on_refund: boolean;
  valid_from: Date;
  valid_until: Date;
  code_id: string;
  code_status: string;
  code_max_uses: number | null;
}

async function loadByCode(db: Db, code: string, lock: boolean) {
  const rows = lock
    ? await db<CouponRow[]>`SELECT c.*, cc.id AS code_id, cc.status AS code_status, cc.max_uses AS code_max_uses FROM coupon_codes cc JOIN coupons c ON c.id = cc.coupon_id WHERE cc.code = ${normalizeCode(code)} FOR UPDATE OF c`
    : await db<CouponRow[]>`SELECT c.*, cc.id AS code_id, cc.status AS code_status, cc.max_uses AS code_max_uses FROM coupon_codes cc JOIN coupons c ON c.id = cc.coupon_id WHERE cc.code = ${normalizeCode(code)}`;
  return rows[0];
}

export interface Evaluated {
  coupon: CouponRow;
  rule: { plan_id: string; percent_off: string; duration: Duration; duration_periods: number | null; provider_discount_id: string | null };
  price: { provider_price_id: string; unit_amount_minor: number; currency: string };
}

/** Fixed validation order (admin-panel.md §7.4). "Not found", "paused" and "archived" share one reason. */
export async function evaluateCoupon(db: Db, code: string, planId: string, user: { id: string; email: string }, opts: { lock: boolean; now?: Date }): Promise<Evaluated> {
  const now = opts.now ?? new Date();
  const c = await loadByCode(db, code, opts.lock);
  if (!c || c.status !== 'active' || c.code_status !== 'active') reject('invalid');
  if (c.valid_from > now) reject('not_started');
  if (c.valid_until < now) reject('expired');
  const rules = await db<Evaluated['rule'][]>`SELECT plan_id, percent_off, duration, duration_periods, provider_discount_id FROM coupon_plan_rules WHERE coupon_id = ${c.id}`;
  const rule = rules.find((r) => r.plan_id === planId);
  if (!rule) reject('not_for_plan', { eligible_plans: rules.map((r) => r.plan_id) });
  const domain = user.email.split('@')[1]?.toLowerCase() ?? '';
  if (c.allowed_email_domains?.length && !c.allowed_email_domains.includes(domain)) reject('domain_not_allowed');
  if (c.new_customers_only && (await hasPriorPaidTransaction(db, user.id))) reject('new_customers_only');
  const counted = c.restore_use_on_refund ? ['completed'] : ['completed', 'refunded'];
  const [mine] = await db<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = ${c.id} AND user_id = ${user.id}
      AND (status = ANY(${counted}) OR (status = 'reserved' AND reserved_until > ${now}))`;
  if ((mine?.n ?? 0) >= c.max_per_user) reject('already_used');
  const [all] = await db<Array<{ n: number; code_n: number; discount_minor: number }>>`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE code_id = ${c.code_id})::int AS code_n,
           COALESCE(sum(discount_amount_minor) FILTER (WHERE status = 'completed'), 0)::int AS discount_minor
    FROM coupon_redemptions WHERE coupon_id = ${c.id} AND (status = ANY(${counted}) OR (status = 'reserved' AND reserved_until > ${now}))`;
  if (c.max_redemptions !== null && (all?.n ?? 0) >= c.max_redemptions) reject('limit_reached');
  if (c.code_max_uses !== null && (all?.code_n ?? 0) >= c.code_max_uses) reject('limit_reached');
  if (c.max_discount_total_usd !== null && (all?.discount_minor ?? 0) / 100 >= Number(c.max_discount_total_usd)) reject('budget_reached');
  const [price] = await db<Evaluated['price'][]>`SELECT provider_price_id, unit_amount_minor, currency FROM plan_prices WHERE plan_id = ${planId} AND status = 'active' ORDER BY created_at DESC LIMIT 1`;
  if (!price) throw new ApiError('not_found', 'This plan is not for sale right now.');
  return { coupon: c, rule: rule!, price };
}

const PERIOD_WORD: Record<string, [string, string]> = { pro_monthly: ['month', 'months'], pro_quarterly: ['quarter', 'quarters'], byok_annual: ['year', 'years'], credit_pack: ['purchase', 'purchases'] };
const EVERY: Record<string, string> = { pro_monthly: 'every month', pro_quarterly: 'every 3 months', byok_annual: 'every year', credit_pack: '' };

export function describeDiscount(planId: string, percent: number, duration: Duration, periods: number | null, listMinor: number, currency: string) {
  const money = (m: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(m / 100);
  const discounted = Math.round(listMinor * (1 - percent / 100));
  const [one, many] = PERIOD_WORD[planId] ?? ['period', 'periods'];
  const p = Number(percent.toFixed(2));
  let summary: string;
  if (planId === 'credit_pack') summary = `${p}% off: ${money(listMinor)} → ${money(discounted)}.`;
  else if (duration === 'forever') summary = `${p}% off for as long as you stay subscribed: ${money(discounted)} ${EVERY[planId]}.`;
  else if (duration === 'first_period') summary = `${p}% off your first ${one}, then ${money(listMinor)} ${EVERY[planId]}.`;
  else summary = `${p}% off your first ${periods} ${many}, then ${money(listMinor)} ${EVERY[planId]}.`;
  return { list: (listMinor / 100).toFixed(2), discounted: (discounted / 100).toFixed(2), discountedMinor: discounted, summary };
}

/** POST /v1/billing/coupons/preview — read-only. */
export async function previewCoupon(sql: Sql, cfg: ActiveConfig, code: string, planId: PlanId, user: { id: string; email: string }) {
  if (cfg.kill_switches.coupons) reject('invalid');
  const ev = await evaluateCoupon(sql, code, planId, user, { lock: false });
  const pct = Number(ev.rule.percent_off);
  const d = describeDiscount(planId, pct, ev.rule.duration, ev.rule.duration_periods, ev.price.unit_amount_minor, ev.price.currency);
  return {
    valid: true as const,
    plan_id: planId,
    percent_off: pct,
    duration: ev.rule.duration,
    duration_periods: ev.rule.duration_periods,
    price: { currency: ev.price.currency, list: d.list, discounted: d.discounted },
    summary: `${d.summary} Tax is calculated at checkout.`,
  };
}

/** Reserves one use (60 min) inside the checkout transaction; returns the Stripe coupon to apply. */
export async function reserveCoupon(tx: Db, cfg: ActiveConfig, code: string, planId: PlanId, user: { id: string; email: string }) {
  const ev = await evaluateCoupon(tx, code, planId, user, { lock: true });
  const id = uuidv7();
  const minutes = cfg.coupons_policy.reservation_minutes;
  const d = describeDiscount(planId, Number(ev.rule.percent_off), ev.rule.duration, ev.rule.duration_periods, ev.price.unit_amount_minor, ev.price.currency);
  await tx`INSERT INTO coupon_redemptions (id, coupon_id, code_id, user_id, plan_id, status, reserved_until, list_amount_minor, discount_amount_minor, currency)
           VALUES (${id}, ${ev.coupon.id}, ${ev.coupon.code_id}, ${user.id}, ${planId}, 'reserved', ${new Date(Date.now() + minutes * 60_000)},
                   ${ev.price.unit_amount_minor}, ${ev.price.unit_amount_minor - d.discountedMinor}, ${ev.price.currency})`;
  await tx`UPDATE coupons SET first_redeemed_at = COALESCE(first_redeemed_at, now()) WHERE id = ${ev.coupon.id}`;
  return { redemption_id: id, discount_id: ev.rule.provider_discount_id, price_id: ev.price.provider_price_id };
}

/** Releases expired reservations so the use becomes available again (runs every few minutes). */
export async function sweepReservations(sql: Sql): Promise<number> {
  const rows = await sql`UPDATE coupon_redemptions SET status = 'released' WHERE status = 'reserved' AND reserved_until < now() RETURNING id`;
  return rows.length;
}

/** Auto-pause coupons that reached their discount budget; audited as a system action. */
export async function enforceCouponBudgets(sql: Sql): Promise<string[]> {
  const over = await sql<Array<{ id: string }>>`
    SELECT c.id FROM coupons c JOIN coupon_redemptions r ON r.coupon_id = c.id AND r.status = 'completed'
    WHERE c.status = 'active' AND c.max_discount_total_usd IS NOT NULL
    GROUP BY c.id, c.max_discount_total_usd HAVING sum(r.discount_amount_minor) / 100.0 >= c.max_discount_total_usd`;
  for (const o of over) {
    await sql.begin(async (tx) => {
      await tx`UPDATE coupons SET status = 'paused', updated_at = now() WHERE id = ${o.id}`;
      await audit(tx, { actor_type: 'system', action: 'coupon.auto_pause', target_type: 'coupon', target_id: o.id, after: { status: 'paused' }, reason: 'discount budget reached' });
    });
  }
  return over.map((o) => o.id);
}
