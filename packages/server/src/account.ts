import type { Sql } from '@jmo/db';
import { uuidv7 } from '@jmo/shared';
import { audit } from './audit';

// User rights (api-design.md §6.15) and the admin user timeline (admin-panel.md §8.4). Metadata only.

export async function exportAccount(sql: Sql, userId: string) {
  const [user] = await sql`SELECT id, email, display_name, locale, country_code, consent_version, telemetry_opt_in, history_opt_in, content_opt_in, content_opt_in_at, created_at FROM users WHERE id = ${userId}`;
  return {
    exported_at: new Date().toISOString(),
    note: 'This export contains the account data held on our servers. Your resumes and job descriptions live in your browser; if you turned on “save my data to improve the product”, the job posts, minimized resumes and results we saved are under saved_content.',
    user,
    subscription: (await sql`SELECT plan_id, status, current_period_start, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ${userId}`)[0] ?? null,
    usage: await sql`SELECT kind, units, cost_usd, outcome, occurred_at FROM usage_ledger WHERE user_id = ${userId} ORDER BY occurred_at DESC LIMIT 1000`,
    jobs: await sql`SELECT title, company, host, created_at FROM jobs WHERE user_id = ${userId} ORDER BY created_at DESC`,
    optimizations: await sql`SELECT id, status, before_score, after_score, ceiling_score, change_summary, created_at FROM optimizations WHERE user_id = ${userId} ORDER BY created_at DESC`,
    feedback: await sql`SELECT target, rating, reason_code, comment, created_at FROM feedback WHERE user_id = ${userId}`,
    credits: await sql`SELECT kind, optimizations, remaining, created_at FROM credit_grants WHERE user_id = ${userId}`,
  };
}

/** Deletion workflow (database-design.md §7). Stripe cancellation is requested by the caller when needed. */
export async function deleteAccount(
  sql: Sql,
  userId: string,
  requestedBy: 'user' | 'admin',
  actor?: { id: string; role: string; reason: string },
  opts: { cancelBilling?: (userId: string) => Promise<string> } = {},
) {
  const reqId = uuidv7();
  const steps: Record<string, string> = {};
  // Billing first: if the payment provider can't be reached this throws and nothing is deleted.
  if (opts.cancelBilling) steps.billing = await opts.cancelBilling(userId);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO deletion_requests (id, user_id, requested_by, steps) VALUES (${reqId}, ${userId}, ${requestedBy}, '{}')`;
    await tx`UPDATE users SET status = 'pending_deletion' WHERE id = ${userId}`;
    await tx`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
    steps.sessions = 'revoked';
    await audit(tx, { actor_type: actor ? 'admin' : 'user', actor_id: actor?.id ?? userId, actor_role: actor?.role ?? null, action: 'delete_requested', target_type: 'user', target_id: userId, reason: actor?.reason ?? null });
  });
  await sql.begin(async (tx) => {
    await tx`UPDATE ai_requests SET user_id = NULL WHERE user_id = ${userId}`;
    steps.ai_requests = 'anonymized';
    await tx`UPDATE coupon_redemptions SET user_id = NULL WHERE user_id = ${userId}`;
    await tx`DELETE FROM idempotency_keys WHERE user_id = ${userId}`;
    // Sign-in codes are keyed by email, not user id, so the FK cascade would miss them.
    await tx`DELETE FROM auth_verifications WHERE identifier = (SELECT email FROM users WHERE id = ${userId})`;
    await tx`DELETE FROM admin_members WHERE user_id = ${userId} AND role <> 'owner'`;
    const [isOwner] = await tx`SELECT 1 FROM admin_members WHERE user_id = ${userId}`;
    if (isOwner) {
      steps.db = 'skipped_owner';
    } else {
      await tx`DELETE FROM users WHERE id = ${userId}`; // FK cascades: auth, subscriptions, usage, resumes, jobs, optimizations, feedback, grants
      steps.db = 'done';
    }
    await tx`UPDATE deletion_requests SET steps = ${tx.json(steps)}, completed_at = now() WHERE id = ${reqId}`;
  });
  return { deletion_request_id: reqId, steps };
}

export interface TimelineItem {
  at: string;
  kind: 'account' | 'billing' | 'coupon' | 'grant' | 'usage' | 'optimization' | 'ai' | 'admin' | 'security' | 'feedback';
  title: string;
  detail: Record<string, unknown>;
}

export async function userTimeline(sql: Sql, userId: string, limit = 200): Promise<TimelineItem[]> {
  const items: TimelineItem[] = [];
  const push = (at: Date | string, kind: TimelineItem['kind'], title: string, detail: Record<string, unknown> = {}) => items.push({ at: new Date(at).toISOString(), kind, title, detail });
  for (const u of await sql`SELECT created_at FROM users WHERE id = ${userId}`) push(u.created_at, 'account', 'Signed up');
  for (const s of await sql`SELECT event_type, received_at, payload_min FROM subscription_events WHERE user_id = ${userId} ORDER BY received_at DESC LIMIT 100`) push(s.received_at, 'billing', s.event_type, s.payload_min);
  for (const r of await sql`SELECT r.status, r.created_at, r.completed_at, r.plan_id, r.discount_amount_minor, c.name FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id WHERE r.user_id = ${userId} ORDER BY r.created_at DESC LIMIT 50`) {
    push(r.completed_at ?? r.created_at, 'coupon', `Coupon "${r.name}" ${r.status}`, { plan: r.plan_id, discount: r.discount_amount_minor });
  }
  for (const g of await sql`SELECT plan_id, starts_at, ends_at, source, reason, revoked_at FROM entitlement_grants WHERE user_id = ${userId}`) push(g.starts_at, 'grant', `Complimentary ${g.plan_id} (${g.source})`, { ends_at: g.ends_at, reason: g.reason, revoked: !!g.revoked_at });
  for (const c of await sql`SELECT kind, optimizations, reason, created_at FROM credit_grants WHERE user_id = ${userId}`) push(c.created_at, 'grant', `${c.optimizations} credits (${c.kind})`, { reason: c.reason });
  for (const o of await sql`SELECT id, status, before_score, after_score, ceiling_score, cost_usd, gates, config_snapshot_id, meta, created_at FROM optimizations WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100`) {
    push(o.created_at, 'optimization', `Optimization ${o.status}`, { id: o.id, scores: [o.before_score, o.after_score, o.ceiling_score], cost_usd: Number(o.cost_usd), gates: o.gates, config_snapshot_id: o.config_snapshot_id, models: (o.meta as { models?: string[] } | null)?.models ?? [] });
  }
  for (const a of await sql`SELECT task, model_id, count(*) AS n, sum(cost_usd) AS usd, max(created_at) AS at FROM ai_requests WHERE user_id = ${userId} AND optimization_id IS NULL AND created_at > now() - interval '30 days' GROUP BY task, model_id, date_trunc('day', created_at)`) {
    push(a.at, 'ai', `${a.n}× ${a.task} (${a.model_id})`, { cost_usd: Number(a.usd) });
  }
  for (const f of await sql`SELECT target, rating, reason_code, created_at FROM feedback WHERE user_id = ${userId}`) push(f.created_at, 'feedback', `Feedback on ${f.target}`, { rating: f.rating, reason: f.reason_code });
  for (const a of await sql`SELECT id, action, actor_type, actor_role, reason, occurred_at FROM audit_log WHERE target_type = 'user' AND target_id = ${userId} ORDER BY id DESC LIMIT 100`) {
    push(a.occurred_at, a.actor_type === 'admin' ? 'admin' : 'security', a.action, { audit_id: Number(a.id), by: a.actor_role ?? a.actor_type, reason: a.reason });
  }
  return items.sort((x, y) => y.at.localeCompare(x.at)).slice(0, limit);
}
