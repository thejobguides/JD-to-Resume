import type { ActiveConfig } from '@jmo/config';
import type { Db, Sql } from '@jmo/db';
import { ApiError, uuidv7 } from '@jmo/shared';
import { effectivePlan } from './users';

// Exact quota accounting (architecture.md §10.2). Postgres row locks give the same guarantees as the per-user
// Durable Object (single writer per user): reserve → settle (success) | release (failure: not charged).

export type UsageKind = 'analysis' | 'optimization' | 'resume_structure' | 'validation';

export interface Reservation {
  reservation_id: string;
  used_credit: boolean;
  plan: string;
}

function periods(now: Date) {
  const iso = now.toISOString();
  return { month: `m:${iso.slice(0, 7)}`, day: `d:${iso.slice(0, 10)}` };
}

export function periodBounds(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function lockCounters(tx: Db, userId: string, now: Date) {
  const p = periods(now);
  await tx`INSERT INTO usage_counters (user_id, period) VALUES (${userId}, ${p.month}), (${userId}, ${p.day}) ON CONFLICT DO NOTHING`;
  const rows = await tx<Array<{ period: string; optimizations: number; analyses: number; structures: number; ai_cost_usd: string; in_flight: number }>>`
    SELECT period, optimizations, analyses, structures, ai_cost_usd, in_flight FROM usage_counters
    WHERE user_id = ${userId} AND period IN (${p.month}, ${p.day}) FOR UPDATE`;
  const month = rows.find((r) => r.period === p.month)!;
  const day = rows.find((r) => r.period === p.day)!;
  return { p, month, day };
}

export async function reserve(sql: Sql, cfg: ActiveConfig, userId: string, kind: UsageKind, opts: { now?: Date; dailySpendUsd?: number } = {}): Promise<Reservation> {
  const now = opts.now ?? new Date();
  return sql.begin(async (tx) => {
    const ep = await effectivePlan(tx, userId, now);
    const limits = cfg.plans.limits[ep.plan] ?? cfg.plans.limits.free!;
    const { p, month, day } = await lockCounters(tx, userId, now);
    const details = (extra: Record<string, unknown>) => ({ plan: ep.plan, resets_at: periodBounds(now).end, ...extra });

    if (kind !== 'resume_structure' && (!limits.hosted_ai || cfg.kill_switches.hosted_ai)) {
      throw new ApiError(cfg.kill_switches.hosted_ai ? 'ai_unavailable' : 'quota_exceeded', cfg.kill_switches.hosted_ai ? 'AI features are temporarily paused.' : 'Your plan uses your own API key; hosted AI is not included.', details({}));
    }
    if (ep.plan === 'free' && (cfg.budgets.free_tier_pause || (opts.dailySpendUsd ?? 0) >= cfg.budgets.global_daily_ceiling_usd)) {
      throw new ApiError('ai_unavailable', 'Free AI features are paused due to high demand. Local scoring still works.', { retry_after_s: 3600 });
    }
    if (Number(month.ai_cost_usd) >= limits.monthly_ai_budget_usd && limits.monthly_ai_budget_usd > 0) {
      throw new ApiError('quota_exceeded', "You've reached this month's AI budget.", details({ ai_budget_usd: limits.monthly_ai_budget_usd }));
    }

    let usedCredit = false;
    let creditGrantId: string | null = null;
    const col = kind === 'optimization' ? 'optimizations' : kind === 'resume_structure' ? 'structures' : 'analyses';
    if (kind === 'optimization') {
      if (month.in_flight >= 1) throw new ApiError('concurrency_limit', 'An optimization is already running.', {});
      const overMonth = month.optimizations >= limits.monthly_optimizations;
      const overDay = day.optimizations >= limits.daily_optimizations;
      if (overMonth || overDay) {
        const creditCap = cfg.plans.limits.credit_pack?.daily_optimizations ?? 25;
        const [credit] = await tx<Array<{ id: string }>>`
          SELECT id FROM credit_grants WHERE user_id = ${userId} AND remaining > 0 AND (expires_at IS NULL OR expires_at > ${now})
          ORDER BY expires_at NULLS LAST, created_at LIMIT 1 FOR UPDATE`;
        if (!credit || day.optimizations >= creditCap) {
          throw new ApiError('quota_exceeded', overMonth ? `You've used all ${limits.monthly_optimizations} optimizations for this month.` : `You've reached today's limit of ${limits.daily_optimizations} optimizations.`, details({ limit: overMonth ? limits.monthly_optimizations : limits.daily_optimizations, used: overMonth ? month.optimizations : day.optimizations, upgrade: true }));
        }
        await tx`UPDATE credit_grants SET remaining = remaining - 1 WHERE id = ${credit.id}`;
        usedCredit = true;
        creditGrantId = credit.id;
      }
    } else if (kind === 'analysis' || kind === 'validation') {
      if (month.analyses >= limits.monthly_analyses) {
        throw new ApiError('quota_exceeded', `You've used all ${limits.monthly_analyses} AI analyses for this month. Local scoring still works.`, details({ limit: limits.monthly_analyses, used: month.analyses }));
      }
    } else if (kind === 'resume_structure') {
      if (day.structures >= 10) throw new ApiError('rate_limited', 'Resume structuring is limited to 10 per day.', { retry_after_s: 3600 });
    }

    await tx.unsafe(`UPDATE usage_counters SET ${col} = ${col} + 1${kind === 'optimization' ? ', in_flight = in_flight + 1' : ''} WHERE user_id = $1 AND period = $2`, [userId, p.month]);
    await tx.unsafe(`UPDATE usage_counters SET ${col} = ${col} + 1 WHERE user_id = $1 AND period = $2`, [userId, p.day]);
    const reservation_id = uuidv7();
    await tx`INSERT INTO usage_ledger (user_id, kind, reservation_id, status, used_credit, credit_grant_id) VALUES (${userId}, ${kind}, ${reservation_id}, 'reserved', ${usedCredit}, ${creditGrantId})`;
    return { reservation_id, used_credit: usedCredit, plan: ep.plan };
  });
}

/** Success: keep the charge, record actual cost. */
export async function settle(sql: Sql, reservationId: string, costUsd: number, optimizationId?: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [l] = await tx<Array<{ user_id: string; kind: UsageKind; status: string; occurred_at: Date }>>`
      SELECT user_id, kind, status, occurred_at FROM usage_ledger WHERE reservation_id = ${reservationId} FOR UPDATE`;
    if (!l || l.status !== 'reserved') return;
    const p = periods(l.occurred_at);
    await tx`UPDATE usage_ledger SET status = 'settled', outcome = 'success', cost_usd = ${costUsd}, optimization_id = ${optimizationId ?? null}, settled_at = now() WHERE reservation_id = ${reservationId}`;
    await tx`UPDATE usage_counters SET ai_cost_usd = ai_cost_usd + ${costUsd}, in_flight = GREATEST(0, in_flight - ${l.kind === 'optimization' ? 1 : 0}) WHERE user_id = ${l.user_id} AND period = ${p.month}`;
  });
}

/** Failure: not charged (architecture.md §10.2). The actual provider cost is still recorded for accounting. */
export async function release(sql: Sql, reservationId: string, costUsd = 0): Promise<void> {
  await sql.begin(async (tx) => {
    const [l] = await tx<Array<{ user_id: string; kind: UsageKind; status: string; occurred_at: Date; used_credit: boolean; credit_grant_id: string | null }>>`
      SELECT user_id, kind, status, occurred_at, used_credit, credit_grant_id FROM usage_ledger WHERE reservation_id = ${reservationId} FOR UPDATE`;
    if (!l || l.status !== 'reserved') return;
    const p = periods(l.occurred_at);
    const col = l.kind === 'optimization' ? 'optimizations' : l.kind === 'resume_structure' ? 'structures' : 'analyses';
    await tx`UPDATE usage_ledger SET status = 'released', outcome = 'failed_uncharged', cost_usd = ${costUsd}, settled_at = now() WHERE reservation_id = ${reservationId}`;
    await tx.unsafe(`UPDATE usage_counters SET ${col} = GREATEST(0, ${col} - 1), ai_cost_usd = ai_cost_usd + $3${l.kind === 'optimization' ? ', in_flight = GREATEST(0, in_flight - 1)' : ''} WHERE user_id = $1 AND period = $2`, [l.user_id, p.month, costUsd]);
    await tx.unsafe(`UPDATE usage_counters SET ${col} = GREATEST(0, ${col} - 1) WHERE user_id = $1 AND period = $2`, [l.user_id, p.day]);
    if (l.used_credit && l.credit_grant_id) {
      await tx`UPDATE credit_grants SET remaining = remaining + 1 WHERE id = ${l.credit_grant_id}`;
    }
  });
}

export async function usageSummary(db: Db, cfg: ActiveConfig, userId: string, now = new Date()) {
  const ep = await effectivePlan(db, userId, now);
  const limits = cfg.plans.limits[ep.plan] ?? cfg.plans.limits.free!;
  const p = periods(now);
  const rows = await db<Array<{ period: string; optimizations: number; analyses: number; ai_cost_usd: string }>>`
    SELECT period, optimizations, analyses, ai_cost_usd FROM usage_counters WHERE user_id = ${userId} AND period IN (${p.month}, ${p.day})`;
  const month = rows.find((r) => r.period === p.month);
  const day = rows.find((r) => r.period === p.day);
  const [credits] = await db<Array<{ n: number }>>`SELECT COALESCE(sum(remaining), 0)::int AS n FROM credit_grants WHERE user_id = ${userId} AND (expires_at IS NULL OR expires_at > ${now})`;
  return {
    period: periodBounds(now),
    optimizations: { used: month?.optimizations ?? 0, limit: limits.monthly_optimizations, daily_used: day?.optimizations ?? 0, daily_limit: limits.daily_optimizations, credits_remaining: credits?.n ?? 0 },
    analyses: { used: month?.analyses ?? 0, limit: limits.monthly_analyses },
    ai_budget: { used_usd: Math.round(Number(month?.ai_cost_usd ?? 0) * 10000) / 10000, limit_usd: limits.monthly_ai_budget_usd },
  };
}
