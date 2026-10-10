import { audit, createCoupon, validateCouponInput } from '@jmo/server';
import { ApiError, CODE_ALPHABET, PlanId, randomCode, uuidv7 } from '@jmo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from '../context';
import { auditRead, need, reasonOf, stepUp } from '../guard';
import { parse, toCsv } from '../util';

// Coupons & campaigns + plans & prices (admin-panel.md §7, §5 modules 4–5).

export const coupons = new Hono<AdminEnv>();

const Rule = z.object({
  plan_id: PlanId,
  percent_off: z.number().min(0.01).max(100),
  duration: z.enum(['first_period', 'repeating', 'forever']),
  duration_periods: z.number().int().nullable().optional(),
  ai_budget_override_usd: z.number().min(0).max(20).nullable().optional(),
});
const CreateCoupon = z.object({
  name: z.string().min(1).max(120),
  campaign: z.string().max(80).nullable().optional(),
  codes: z.union([z.object({ mode: z.literal('single'), code: z.string().max(32).optional() }), z.object({ mode: z.literal('bulk'), count: z.number().int().min(1).max(5000), prefix: z.string().max(12).optional() })]),
  rules: z.array(Rule).min(1).max(5),
  max_redemptions: z.number().int().min(1).nullable().optional(),
  max_per_user: z.number().int().min(1).max(5).optional(),
  new_customers_only: z.boolean().optional(),
  allowed_email_domains: z.array(z.string().max(100)).max(50).nullable().optional(),
  max_discount_total_usd: z.number().min(1).max(1_000_000).nullable().optional(),
  restore_use_on_refund: z.boolean().optional(),
  valid_from: z.string(),
  valid_until: z.string(),
  reason: z.string(),
});

coupons.get('/coupons', need('coupons.view'), async (c) => {
  const rows = await c.get('deps').sql`
    SELECT c.id, c.name, c.campaign, c.status, c.max_redemptions, c.max_per_user, c.valid_from, c.valid_until, c.first_redeemed_at, c.max_discount_total_usd,
           (SELECT json_agg(json_build_object('plan_id', r.plan_id, 'percent_off', r.percent_off, 'duration', r.duration, 'duration_periods', r.duration_periods)) FROM coupon_plan_rules r WHERE r.coupon_id = c.id) AS rules,
           (SELECT count(*) FROM coupon_codes cc WHERE cc.coupon_id = c.id)::int AS codes,
           (SELECT CASE WHEN count(*) = 1 THEN min(code) END FROM coupon_codes cc WHERE cc.coupon_id = c.id) AS code,
           (SELECT count(*) FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.status = 'completed')::int AS redeemed,
           (SELECT COALESCE(sum(discount_amount_minor), 0) FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.status = 'completed')::int AS discount_minor
    FROM coupons c WHERE (${c.req.query('status') ?? null}::text IS NULL OR c.status = ${c.req.query('status') ?? null}) ORDER BY c.created_at DESC LIMIT 200`;
  return c.json({ data: rows });
});

coupons.post('/coupons', need('coupons.edit'), async (c) => {
  const b = await parse(c, CreateCoupon);
  const reason = reasonOf(b);
  const a = c.get('admin');
  const { sql, config, payments } = c.get('deps');
  const cfg = (await config.get()).config;
  const input = { ...b, rules: b.rules.map((r) => ({ ...r, duration_periods: r.duration_periods ?? null, ai_budget_override_usd: r.ai_budget_override_usd ?? null })) };
  const errors = validateCouponInput(input, cfg, a.role);
  if (errors.length) throw new ApiError('invalid_request', errors[0]!, { errors });
  if (b.codes.mode === 'single' && b.codes.code) {
    const [dup] = await sql`SELECT 1 FROM coupon_codes WHERE code = ${b.codes.code.trim().toUpperCase()}`;
    if (dup) throw new ApiError('conflict', 'That code already exists.');
  }
  const res = await createCoupon(sql, payments, input, { id: a.id, role: a.role, reason, requestId: c.get('requestId') });
  return c.json(res, 201);
});

coupons.get('/coupons/:id', need('coupons.view'), async (c) => {
  const { sql } = c.get('deps');
  const [row] = await sql`SELECT * FROM coupons WHERE id = ${c.req.param('id')}`;
  if (!row) throw new ApiError('not_found', 'Coupon not found.');
  const rules = await sql`SELECT plan_id, percent_off, duration, duration_periods, ai_budget_override_usd, provider_discount_id FROM coupon_plan_rules WHERE coupon_id = ${row.id}`;
  const codes = await sql`SELECT code, status, max_uses, batch_id FROM coupon_codes WHERE coupon_id = ${row.id} ORDER BY created_at LIMIT 20`;
  const [counts] = await sql`SELECT count(*)::int AS codes FROM coupon_codes WHERE coupon_id = ${row.id}`;
  return c.json({ ...row, rules, codes: counts!.codes <= 20 ? codes : codes.slice(0, 5).map((x) => ({ ...x, code: `${String(x.code).slice(0, 4)}…` })), code_count: counts!.codes, editable_terms: !row.first_redeemed_at });
});

coupons.patch('/coupons/:id', need('coupons.edit'), async (c) => {
  const b = await parse(c, z.object({ name: z.string().max(120).optional(), valid_until: z.string().optional(), max_redemptions: z.number().int().min(1).nullable().optional(), max_discount_total_usd: z.number().min(1).nullable().optional(), rules: z.array(Rule).optional(), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  const { sql } = c.get('deps');
  const res = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM coupons WHERE id = ${c.req.param('id')} FOR UPDATE`;
    if (!before) throw new ApiError('not_found', 'Coupon not found.');
    if (b.rules && before.first_redeemed_at) throw new ApiError('conflict', 'This coupon has been redeemed; % off, plans and duration are frozen. Create a new coupon for different terms.');
    if (b.max_redemptions !== undefined && b.max_redemptions !== null) {
      const [used] = await tx`SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = ${before.id} AND status IN ('completed','refunded','reserved')`;
      if (b.max_redemptions < used!.n) throw new ApiError('invalid_request', `Already used ${used!.n} times.`);
    }
    await tx`UPDATE coupons SET name = COALESCE(${b.name ?? null}, name), valid_until = COALESCE(${b.valid_until ?? null}, valid_until),
             max_redemptions = ${b.max_redemptions === undefined ? before.max_redemptions : b.max_redemptions},
             max_discount_total_usd = ${b.max_discount_total_usd === undefined ? before.max_discount_total_usd : b.max_discount_total_usd}, updated_at = now() WHERE id = ${before.id}`;
    const auditId = await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'coupon.update', target_type: 'coupon', target_id: before.id, before: { name: before.name, valid_until: before.valid_until, max_redemptions: before.max_redemptions }, after: { name: b.name, valid_until: b.valid_until, max_redemptions: b.max_redemptions }, reason, request_id: c.get('requestId') });
    return { audit_id: auditId };
  });
  return c.json(res);
});

for (const [verb, status, perm] of [['pause', 'paused', 'coupons.pause'], ['resume', 'active', 'coupons.edit'], ['archive', 'archived', 'coupons.edit']] as const) {
  coupons.post(`/coupons/:id/${verb}`, need(perm), async (c) => {
    const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
    const a = c.get('admin');
    const { sql, payments } = c.get('deps');
    const discounts = await sql<Array<{ provider_discount_id: string | null }>>`SELECT provider_discount_id FROM coupon_plan_rules WHERE coupon_id = ${c.req.param('id')}`;
    if (verb === 'archive') for (const d of discounts) if (d.provider_discount_id) await payments.archiveDiscount(d.provider_discount_id);
    const res = await sql.begin(async (tx) => {
      const [before] = await tx`SELECT status FROM coupons WHERE id = ${c.req.param('id')} FOR UPDATE`;
      if (!before) throw new ApiError('not_found', 'Coupon not found.');
      if (before.status === 'archived') throw new ApiError('conflict', 'Archived coupons cannot change.');
      await tx`UPDATE coupons SET status = ${status}, updated_at = now() WHERE id = ${c.req.param('id')}`;
      return { audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: `coupon.${verb}`, target_type: 'coupon', target_id: c.req.param('id'), before: { status: before.status }, after: { status }, reason, request_id: c.get('requestId') }) };
    });
    return c.json(res);
  });
}

coupons.post('/coupons/:id/codes/bulk', need('coupons.edit'), async (c) => {
  const b = await parse(c, z.object({ count: z.number().int().min(1).max(5000), prefix: z.string().max(12).optional(), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  const res = await c.get('deps').sql.begin(async (tx) => {
    const [cp] = await tx`SELECT id, status FROM coupons WHERE id = ${c.req.param('id')}`;
    if (!cp || cp.status === 'archived') throw new ApiError('not_found', 'Coupon not found.');
    const batch = uuidv7();
    for (let i = 0; i < b.count; i++) await tx`INSERT INTO coupon_codes (id, coupon_id, code, max_uses, batch_id, status) VALUES (${uuidv7()}, ${cp.id}, ${`${(b.prefix ?? '').toUpperCase()}${randomCode(10, CODE_ALPHABET)}`}, 1, ${batch}, 'active')`;
    return { batch_id: batch, audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'coupon.codes_bulk', target_type: 'coupon', target_id: cp.id, after: { count: b.count, batch_id: batch }, reason, request_id: c.get('requestId') }) };
  });
  return c.json(res, 201);
});

coupons.get('/coupons/:id/codes/export', need('coupons.edit'), stepUp, async (c) => {
  await auditRead(c, 'coupon.codes_export', 'coupon', c.req.param('id'));
  const rows = await c.get('deps').sql`SELECT code, status, max_uses, batch_id FROM coupon_codes WHERE coupon_id = ${c.req.param('id')} ORDER BY created_at`;
  return c.body(toCsv(['code', 'status', 'max_uses', 'batch_id'], rows.map((r) => [r.code, r.status, r.max_uses, r.batch_id])), 200, { 'content-type': 'text/csv' });
});

coupons.get('/coupons/:id/redemptions', need('coupons.view'), async (c) =>
  c.json({ data: await c.get('deps').sql`SELECT r.id, r.status, r.plan_id, r.list_amount_minor, r.discount_amount_minor, r.currency, r.created_at, r.completed_at, cc.code FROM coupon_redemptions r JOIN coupon_codes cc ON cc.id = r.code_id WHERE r.coupon_id = ${c.req.param('id')} ORDER BY r.created_at DESC LIMIT 500` }),
);

coupons.get('/coupons/:id/stats', need('coupons.view'), async (c) => {
  const { sql } = c.get('deps');
  const id = c.req.param('id');
  const [s] = await sql`
    SELECT count(*) FILTER (WHERE status = 'completed')::int AS redemptions, count(*) FILTER (WHERE status = 'reserved' AND reserved_until > now())::int AS reserved,
           count(*) FILTER (WHERE status = 'refunded')::int AS refunded, COALESCE(sum(discount_amount_minor) FILTER (WHERE status = 'completed'), 0)::int AS discount_minor,
           COALESCE(sum(list_amount_minor - discount_amount_minor) FILTER (WHERE status = 'completed'), 0)::int AS net_minor
    FROM coupon_redemptions WHERE coupon_id = ${id}`;
  const [renew] = await sql`
    SELECT count(*) FILTER (WHERE s.current_period_start > r.completed_at + interval '20 days')::int AS renewed, count(*)::int AS subs
    FROM coupon_redemptions r JOIN subscriptions s ON s.coupon_redemption_id = r.id WHERE r.coupon_id = ${id} AND r.status = 'completed'`;
  const [ai] = await sql`SELECT COALESCE(sum(a.cost_usd), 0) AS usd FROM ai_requests a WHERE a.user_id IN (SELECT user_id FROM coupon_redemptions WHERE coupon_id = ${id} AND status = 'completed')`;
  return c.json({ ...s, full_price_renewals: renew!.renewed, subscriptions: renew!.subs, ai_cost_usd: Number(ai!.usd) });
});

// ── Plans & prices ──
coupons.get('/plans', need('dashboards.view'), async (c) => {
  const { sql, config } = c.get('deps');
  const plans = await sql`SELECT id, name, kind, billing_interval, billing_frequency, active, display_order FROM plans ORDER BY display_order`;
  const prices = await sql`SELECT id, plan_id, provider_price_id, currency, unit_amount_minor, status, created_at, archived_at FROM plan_prices ORDER BY created_at DESC`;
  const cfg = (await config.get()).config;
  return c.json({ plans: plans.map((p) => ({ ...p, limits: cfg.plans.limits[p.id], display: cfg.plans.display[p.id], prices: prices.filter((x) => x.plan_id === p.id) })) });
});

coupons.post('/plans/:id/prices', need('plans.prices'), stepUp, async (c) => {
  const b = await parse(c, z.object({ currency: z.string().length(3), unit_amount_minor: z.number().int().min(100).max(1_000_000), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  const { sql, payments } = c.get('deps');
  const [plan] = await sql`SELECT id, name, billing_interval, billing_frequency FROM plans WHERE id = ${c.req.param('id')}`;
  if (!plan || plan.id === 'free') throw new ApiError('not_found', 'Plan not found.');
  const created = await payments.createPrice({ plan_id: plan.id, plan_name: plan.name, amount_minor: b.unit_amount_minor, currency: b.currency.toUpperCase(), interval: plan.billing_interval, interval_count: plan.billing_frequency });
  const res = await sql.begin(async (tx) => {
    const [old] = await tx`SELECT id, provider_price_id, unit_amount_minor FROM plan_prices WHERE plan_id = ${plan.id} AND currency = ${b.currency.toUpperCase()} AND status = 'active' FOR UPDATE`;
    if (old) await tx`UPDATE plan_prices SET status = 'archived', archived_at = now() WHERE id = ${old.id}`;
    const id = uuidv7();
    await tx`INSERT INTO plan_prices (id, plan_id, provider_price_id, currency, unit_amount_minor, status, created_by) VALUES (${id}, ${plan.id}, ${created.id}, ${b.currency.toUpperCase()}, ${b.unit_amount_minor}, 'active', ${a.id})`;
    const auditId = await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'price.create', target_type: 'plan', target_id: plan.id, before: old ? { unit_amount_minor: old.unit_amount_minor } : null, after: { unit_amount_minor: b.unit_amount_minor, provider_price_id: created.id, note: 'Existing subscribers keep their current price' }, reason, request_id: c.get('requestId') });
    return { id, provider_price_id: created.id, archived_previous: old?.provider_price_id ?? null, audit_id: auditId };
  });
  return c.json(res, 201);
});
