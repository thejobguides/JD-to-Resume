import { audit, deleteAccount, effectivePlan, maskEmail, rollupLagMinutes, usageSummary, userTimeline, verifyAuditChain } from '@jmo/server';
import { ApiError, PlanId, uuidv7 } from '@jmo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from '../context';
import { actor, auditRead, need, reasonOf, stepUp } from '../guard';
import { parse, toCsv } from '../util';

// Overview, users & support, admins, privacy queue, feedback, audit, system (admin-panel.md §5).

export const core = new Hono<AdminEnv>();

core.get('/overview', need('dashboards.view'), async (c) => {
  const { sql } = c.get('deps');
  const [u] = await sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d FROM users WHERE status <> 'pending_deletion'`;
  const [mau] = await sql`SELECT count(DISTINCT user_id)::int AS n FROM ai_requests WHERE created_at > now() - interval '30 days' AND user_id IS NOT NULL`;
  const paid = await sql`SELECT plan_id, count(*)::int AS n FROM subscriptions WHERE status IN ('active','trialing','past_due') GROUP BY plan_id`;
  const [mrr] = await sql`
    SELECT COALESCE(sum(pp.unit_amount_minor::numeric / CASE WHEN p.billing_interval = 'year' THEN 12 ELSE COALESCE(p.billing_frequency, 1) END), 0) / 100 AS usd
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN plan_prices pp ON pp.plan_id = s.plan_id AND pp.status = 'active'
    WHERE s.status IN ('active','trialing','past_due')`;
  const [cost] = await sql`SELECT COALESCE(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('day', now())), 0) AS today, COALESCE(sum(cost_usd) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS mtd,
                                  count(*) FILTER (WHERE created_at > now() - interval '1 day') AS calls_24h, count(*) FILTER (WHERE created_at > now() - interval '1 day' AND outcome <> 'ok') AS errors_24h
                           FROM ai_requests`;
  const [opt] = await sql`SELECT count(*)::int AS n, COALESCE(avg(cost_usd), 0) AS avg_cost,
                                 COALESCE(sum(COALESCE((gates->>'reverted')::int, 0)), 0)::int AS reverted, COALESCE(sum(COALESCE((change_summary->>'bullets_changed')::int, 0)), 0)::int AS changed
                          FROM optimizations WHERE created_at > now() - interval '7 days' AND status IN ('succeeded','partial')`;
  const [coupons] = await sql`SELECT count(*)::int AS n FROM coupons WHERE status = 'active' AND valid_until > now()`;
  const [ins] = await sql`SELECT count(*)::int AS n FROM optimization_insights WHERE status = 'open'`;
  const cfg = (await c.get('deps').config.get()).config;
  return c.json({
    users: { total: u!.total, new_7d: u!.new_7d, mau: mau!.n },
    paid: Object.fromEntries(paid.map((p) => [p.plan_id, p.n])),
    mrr_usd: Math.round(Number(mrr!.usd) * 100) / 100,
    ai: { today_usd: Number(cost!.today), mtd_usd: Number(cost!.mtd), daily_ceiling_usd: cfg.budgets.global_daily_ceiling_usd, calls_24h: Number(cost!.calls_24h), error_rate_24h: Number(cost!.calls_24h) ? Number(cost!.errors_24h) / Number(cost!.calls_24h) : 0 },
    optimizations_7d: { count: opt!.n, avg_cost_usd: Number(opt!.avg_cost), revert_rate: opt!.changed + opt!.reverted ? opt!.reverted / (opt!.changed + opt!.reverted) : 0 },
    active_coupons: coupons!.n,
    open_insights: ins!.n,
    kill_switches: cfg.kill_switches,
  });
});

// ── Users & support ──
core.get('/users', need('users.view'), async (c) => {
  const q = (c.req.query('query') ?? '').trim().toLowerCase();
  const { sql } = c.get('deps');
  const rows = q
    ? await sql`SELECT u.id, u.email, u.status, u.created_at, s.plan_id, s.provider_customer_id FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
                WHERE u.email ILIKE ${`%${q}%`} OR u.id::text = ${q} OR s.provider_customer_id = ${q} ORDER BY u.created_at DESC LIMIT 50`
    : await sql`SELECT u.id, u.email, u.status, u.created_at, s.plan_id FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id ORDER BY u.created_at DESC LIMIT 50`;
  return c.json({ data: rows.map((r) => ({ id: r.id, email_masked: maskEmail(r.email), status: r.status, plan: r.plan_id ?? 'free', created_at: r.created_at })) });
});

core.get('/users/:id', need('users.view'), async (c) => {
  const id = c.req.param('id');
  const { sql, config } = c.get('deps');
  const [u] = await sql`SELECT id, email, status, created_at, country_code, consent_version, telemetry_opt_in, history_opt_in, content_opt_in, content_opt_in_at, (SELECT count(*)::int FROM stored_content s WHERE s.user_id = users.id) AS saved_items FROM users WHERE id = ${id}`;
  if (!u) throw new ApiError('not_found', 'User not found.');
  await auditRead(c, 'user.view', 'user', id);
  const cfg = (await config.get()).config;
  return c.json({
    id: u.id,
    email_masked: maskEmail(u.email),
    status: u.status,
    created_at: u.created_at,
    country_code: u.country_code,
    consent_version: u.consent_version,
    saved_content: { opted_in: u.content_opt_in, since: u.content_opt_in_at, items: u.saved_items },
    plan: await effectivePlan(sql, id),
    usage: await usageSummary(sql, cfg, id),
    grants: await sql`SELECT id, plan_id, starts_at, ends_at, source, reason, revoked_at FROM entitlement_grants WHERE user_id = ${id} ORDER BY created_at DESC`,
    credits: await sql`SELECT id, kind, optimizations, remaining, reason, created_at FROM credit_grants WHERE user_id = ${id} ORDER BY created_at DESC`,
    sessions: await sql`SELECT id, device_label, created_at, last_used_at, expires_at, revoked_at FROM auth_sessions WHERE user_id = ${id} AND kind = 'user' ORDER BY created_at DESC LIMIT 20`,
  });
});

core.post('/users/:id/reveal-email', need('users.view'), async (c) => {
  const id = c.req.param('id');
  const [u] = await c.get('deps').sql`SELECT email FROM users WHERE id = ${id}`;
  if (!u) throw new ApiError('not_found', 'User not found.');
  await auditRead(c, 'user.email_reveal', 'user', id);
  return c.json({ email: u.email });
});

core.get('/users/:id/timeline', need('users.view'), async (c) => {
  await auditRead(c, 'user.timeline_view', 'user', c.req.param('id'));
  return c.json({ data: await userTimeline(c.get('deps').sql, c.req.param('id')) });
});

core.post('/users/:id/credits', need('users.grant'), async (c) => {
  const b = await parse(c, z.object({ optimizations: z.number().int().min(1).max(500), expires_at: z.string().optional(), reason: z.string() }));
  const a = c.get('admin');
  if (a.role === 'support' && b.optimizations > 10) throw new ApiError('forbidden', 'Support can grant up to 10 credits.');
  const reason = reasonOf(b);
  const { sql } = c.get('deps');
  const res = await sql.begin(async (tx) => {
    const id = uuidv7();
    await tx`INSERT INTO credit_grants (id, user_id, kind, optimizations, remaining, expires_at, granted_by, reason) VALUES (${id}, ${c.req.param('id')}, 'admin_grant', ${b.optimizations}, ${b.optimizations}, ${b.expires_at ?? null}, ${a.id}, ${reason})`;
    const auditId = await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'credits.grant', target_type: 'user', target_id: c.req.param('id'), after: { optimizations: b.optimizations }, reason, request_id: c.get('requestId') });
    return { id, audit_id: auditId };
  });
  return c.json(res, 201);
});

core.post('/users/:id/grants', need('users.grant'), async (c) => {
  const b = await parse(c, z.object({ plan_id: PlanId, days: z.number().int().min(1).max(90), source: z.enum(['comp', 'beta', 'support', 'partner']), reason: z.string() }));
  const a = c.get('admin');
  if (a.role === 'support' && b.days > 14) throw new ApiError('forbidden', 'Support can grant up to 14 days.');
  if (b.plan_id === 'free' || b.plan_id === 'credit_pack') throw new ApiError('invalid_request', 'Grant a paid plan (Pro or BYOK).');
  const reason = reasonOf(b);
  const res = await c.get('deps').sql.begin(async (tx) => {
    const id = uuidv7();
    const starts = new Date();
    const ends = new Date(starts.getTime() + b.days * 86_400_000);
    await tx`INSERT INTO entitlement_grants (id, user_id, plan_id, starts_at, ends_at, source, reason, granted_by) VALUES (${id}, ${c.req.param('id')}, ${b.plan_id}, ${starts}, ${ends}, ${b.source}, ${reason}, ${a.id})`;
    const auditId = await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'grant.create', target_type: 'user', target_id: c.req.param('id'), after: { plan_id: b.plan_id, days: b.days, source: b.source }, reason, request_id: c.get('requestId') });
    return { id, ends_at: ends.toISOString(), audit_id: auditId };
  });
  return c.json(res, 201);
});

core.delete('/users/:id/grants/:gid', need('users.grant'), async (c) => {
  const b = await parse(c, z.object({ reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  await c.get('deps').sql.begin(async (tx) => {
    await tx`UPDATE entitlement_grants SET revoked_at = now(), revoked_by = ${a.id} WHERE id = ${c.req.param('gid')} AND user_id = ${c.req.param('id')}`;
    await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'grant.revoke', target_type: 'user', target_id: c.req.param('id'), after: { grant_id: c.req.param('gid') }, reason, request_id: c.get('requestId') });
  });
  return c.body(null, 204);
});

core.post('/users/:id/quota/reset', need('users.grant'), async (c) => {
  const b = await parse(c, z.object({ kind: z.enum(['optimizations', 'analyses']), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  await c.get('deps').sql.begin(async (tx) => {
    const month = `m:${new Date().toISOString().slice(0, 7)}`;
    const day = `d:${new Date().toISOString().slice(0, 10)}`;
    const [before] = await tx`SELECT optimizations, analyses FROM usage_counters WHERE user_id = ${c.req.param('id')} AND period = ${month}`;
    await tx.unsafe(`UPDATE usage_counters SET ${b.kind} = 0 WHERE user_id = $1 AND period IN ($2, $3)`, [c.req.param('id'), month, day]);
    await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'quota.reset', target_type: 'user', target_id: c.req.param('id'), before: before ?? null, after: { [b.kind]: 0 }, reason, request_id: c.get('requestId') });
  });
  return c.body(null, 204);
});

for (const [path, status, action] of [['suspend', 'suspended', 'user.suspend'], ['unsuspend', 'active', 'user.unsuspend']] as const) {
  core.post(`/users/:id/${path}`, need('users.suspend'), async (c) => {
    const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
    const a = c.get('admin');
    await c.get('deps').sql.begin(async (tx) => {
      await tx`UPDATE users SET status = ${status} WHERE id = ${c.req.param('id')} AND status <> 'pending_deletion'`;
      if (status === 'suspended') await tx`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${c.req.param('id')} AND revoked_at IS NULL`;
      await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action, target_type: 'user', target_id: c.req.param('id'), after: { status }, reason, request_id: c.get('requestId') });
    });
    return c.body(null, 204);
  });
}

core.post('/users/:id/sessions/revoke', need('users.suspend'), async (c) => {
  const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
  const a = c.get('admin');
  await c.get('deps').sql.begin(async (tx) => {
    await tx`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${c.req.param('id')} AND revoked_at IS NULL`;
    await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'user.sessions_revoke', target_type: 'user', target_id: c.req.param('id'), reason, request_id: c.get('requestId') });
  });
  return c.body(null, 204);
});

core.post('/users/:id/deletion', need('users.delete'), stepUp, async (c) => {
  const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
  const a = c.get('admin');
  return c.json(await deleteAccount(c.get('deps').sql, c.req.param('id'), 'admin', { id: a.id, role: a.role, reason }, { cancelBilling: (id) => c.get('deps').billing.cancelForDeletion(id) }), 202);
});

// ── Admins (Owner only) ──
core.get('/admins', need('admins.manage'), async (c) =>
  c.json({ data: await c.get('deps').sql`SELECT a.user_id, u.email, a.role, a.granted_at, a.revoked_at, (SELECT max(created_at) FROM auth_sessions s WHERE s.user_id = a.user_id AND s.kind = 'admin') AS last_sign_in FROM admin_members a JOIN users u ON u.id = a.user_id ORDER BY a.granted_at` }),
);
core.post('/admins', need('admins.manage'), stepUp, async (c) => {
  const b = await parse(c, z.object({ email: z.string().email(), role: z.enum(['admin', 'support', 'finance', 'analyst']), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  const res = await c.get('deps').sql.begin(async (tx) => {
    const [u] = await tx<Array<{ id: string }>>`INSERT INTO users (id, email, email_verified) VALUES (${uuidv7()}, ${b.email.toLowerCase()}, false) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`;
    await tx`INSERT INTO admin_members (user_id, role, granted_by) VALUES (${u!.id}, ${b.role}, ${a.id}) ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, revoked_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = now()`;
    const auditId = await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'admin.grant', target_type: 'user', target_id: u!.id, after: { role: b.role }, reason, request_id: c.get('requestId') });
    return { user_id: u!.id, audit_id: auditId };
  });
  return c.json(res, 201);
});
core.delete('/admins/:user_id', need('admins.manage'), stepUp, async (c) => {
  const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
  const a = c.get('admin');
  if (c.req.param('user_id') === a.id) throw new ApiError('invalid_request', 'You cannot revoke your own access.');
  await c.get('deps').sql.begin(async (tx) => {
    await tx`UPDATE admin_members SET revoked_at = now() WHERE user_id = ${c.req.param('user_id')} AND role <> 'owner'`;
    await tx`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${c.req.param('user_id')} AND kind = 'admin' AND revoked_at IS NULL`;
    await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'admin.revoke', target_type: 'user', target_id: c.req.param('user_id'), reason, request_id: c.get('requestId') });
  });
  return c.body(null, 204);
});

// ── Privacy queue, feedback ──
core.get('/privacy/requests', need('privacy.view'), async (c) => c.json({ data: await c.get('deps').sql`SELECT id, user_id, requested_at, completed_at, requested_by, steps FROM deletion_requests ORDER BY requested_at DESC LIMIT 200` }));
core.get('/feedback', need('feedback.view'), async (c) => {
  const rows = await c.get('deps').sql`SELECT id, optimization_id, target, target_ref, rating, reason_code, comment, content_shared, status, created_at FROM feedback ORDER BY created_at DESC LIMIT 200`;
  return c.json({ data: rows });
});

// ── Audit log ──
core.get('/audit', need('audit.view'), async (c) => {
  const q = c.req.query();
  const a = c.get('admin');
  const { sql } = c.get('deps');
  const rows = await sql`
    SELECT l.id, l.occurred_at, l.actor_type, l.actor_role, l.action, l.target_type, l.target_id, l.before, l.after, l.reason, l.request_id, u.email AS actor_email
    FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
    WHERE (${q.action ?? null}::text IS NULL OR l.action LIKE ${`${q.action ?? ''}%`})
      AND (${q.target_type ?? null}::text IS NULL OR l.target_type = ${q.target_type ?? null})
      AND (${q.target_id ?? null}::text IS NULL OR l.target_id = ${q.target_id ?? null})
      AND (${q.actor ?? null}::text IS NULL OR u.email ILIKE ${`%${q.actor ?? ''}%`})
      AND (${a.role === 'support'} = false OR l.actor_id = ${a.id} OR l.target_type = 'user')
      AND (${a.role === 'finance'} = false OR l.action LIKE 'coupon%' OR l.action LIKE 'price%' OR l.action LIKE 'subscription%' OR l.action LIKE 'transaction%')
    ORDER BY l.id DESC LIMIT ${Math.min(500, Number(q.limit ?? 100))}`;
  return c.json({ data: rows.map((r) => ({ ...r, id: Number(r.id), actor_email: r.actor_email ? maskEmail(r.actor_email) : null })) });
});
core.get('/audit/verify', need('audit.view'), async (c) => c.json(await verifyAuditChain(c.get('deps').sql)));
core.get('/audit/export', need('audit.export'), async (c) => {
  await auditRead(c, 'audit.export', 'audit_log', 'all');
  const rows = await c.get('deps').sql`SELECT id, occurred_at, actor_type, actor_role, action, target_type, target_id, reason, request_id FROM audit_log ORDER BY id DESC LIMIT 10000`;
  const csv = toCsv(['id', 'occurred_at', 'actor_type', 'actor_role', 'action', 'target_type', 'target_id', 'reason', 'request_id'], rows.map((r) => [Number(r.id), r.occurred_at.toISOString(), r.actor_type, r.actor_role, r.action, r.target_type, r.target_id, r.reason, r.request_id]));
  return c.body(csv, 200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="audit.csv"' });
});

// ── System ──
core.get('/system/health', need('system.view'), async (c) => {
  const { sql, config } = c.get('deps');
  const failed = await sql`SELECT provider_event_id, event_type, received_at, error FROM subscription_events WHERE processed_at IS NULL ORDER BY received_at DESC LIMIT 50`;
  const cfg = await config.get();
  return c.json({ rollup_lag_minutes: await rollupLagMinutes(sql), failed_webhooks: failed, config_snapshot: cfg.snapshot, config_versions: cfg.versions, actor: actor(c) });
});
