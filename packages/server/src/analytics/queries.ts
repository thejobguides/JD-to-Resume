import type { Sql } from '@jmo/db';
import { percentileFromHist } from './rollup';

// Dashboard queries (admin-panel.md §9.3). Aggregates come from rollups; per-call drill-downs read ai_requests.
// No prompt or response content exists anywhere to query.

export interface Range {
  from: string;
  to: string;
}

const DIMS = { task: 'task', model: 'model_id', provider: 'provider_id', credential: 'credential_id', plan: 'plan_id', prompt_version: 'prompt_version_id' } as const;
export type Dim = keyof typeof DIMS;

function addHist(a: number[], b: number[]): number[] {
  const out = [...a];
  b.forEach((x, i) => (out[i] = (out[i] ?? 0) + x));
  return out;
}

function previous(r: Range): Range {
  const f = Date.parse(r.from);
  const t = Date.parse(r.to);
  return { from: new Date(f - (t - f)).toISOString(), to: r.from };
}

async function totals(sql: Sql, r: Range) {
  const [t] = await sql<Array<Record<string, string | null>>>`
    SELECT COALESCE(sum(calls), 0) AS calls, COALESCE(sum(errors), 0) AS errors, COALESCE(sum(schema_fails), 0) AS schema_fails, COALESCE(sum(fallbacks), 0) AS fallbacks,
           COALESCE(sum(cache_hits), 0) AS cache_hits, COALESCE(sum(input_tokens), 0) AS input_tokens, COALESCE(sum(cached_input_tokens), 0) AS cached_input_tokens,
           COALESCE(sum(output_tokens), 0) AS output_tokens, COALESCE(sum(reasoning_tokens), 0) AS reasoning_tokens, COALESCE(sum(cost_usd), 0) AS cost_usd,
           COALESCE(sum(shadow_cost_usd), 0) AS shadow_cost_usd, COALESCE(sum(estimated_token_calls), 0) AS estimated
    FROM ai_usage_hourly WHERE hour >= ${r.from} AND hour < ${r.to}`;
  const [o] = await sql<Array<{ n: string; cost: string }>>`
    SELECT count(*) AS n, COALESCE(sum(cost_usd), 0) AS cost FROM optimizations WHERE created_at >= ${r.from} AND created_at < ${r.to} AND status IN ('succeeded','partial')`;
  const n = (k: string) => Number(t?.[k] ?? 0);
  const opts = Number(o?.n ?? 0);
  return {
    calls: n('calls'),
    error_rate: n('calls') ? n('errors') / n('calls') : 0,
    schema_fail_rate: n('calls') ? n('schema_fails') / n('calls') : 0,
    fallback_rate: n('calls') ? n('fallbacks') / n('calls') : 0,
    cache_hit_rate: n('calls') ? n('cache_hits') / n('calls') : 0,
    tokens: { input: n('input_tokens'), cached_input: n('cached_input_tokens'), output: n('output_tokens'), reasoning: n('reasoning_tokens') },
    cached_share: n('input_tokens') ? n('cached_input_tokens') / n('input_tokens') : 0,
    cost_usd: n('cost_usd'),
    shadow_cost_usd: n('shadow_cost_usd'),
    estimated_share: n('calls') ? n('estimated') / n('calls') : 0,
    optimizations: opts,
    cost_per_optimization: opts ? Number(o!.cost) / opts : null,
  };
}

export async function summary(sql: Sql, r: Range, opts: { monthlyBudgetUsd?: number } = {}) {
  const cur = await totals(sql, r);
  const prev = await totals(sql, previous(r));
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [mtd] = await sql<Array<{ c: string }>>`SELECT COALESCE(sum(cost_usd), 0) AS c FROM ai_requests WHERE created_at >= ${monthStart}`;
  const [today] = await sql<Array<{ c: string }>>`SELECT COALESCE(sum(cost_usd), 0) AS c FROM ai_requests WHERE created_at >= date_trunc('day', now())`;
  const daysIn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsed = Math.max(1 / 24, (now.getTime() - monthStart.getTime()) / 86_400_000);
  const mtdCost = Number(mtd?.c ?? 0);
  return {
    range: r,
    current: cur,
    previous: prev,
    spend: { today_usd: Number(today?.c ?? 0), mtd_usd: mtdCost, forecast_month_usd: (mtdCost / elapsed) * daysIn, budget_month_usd: opts.monthlyBudgetUsd ?? null },
  };
}

export async function timeseries(sql: Sql, r: Range, metric: 'tokens' | 'cost' | 'calls' | 'latency_p95' | 'errors', groupBy: Dim | null, interval: 'hour' | 'day') {
  const col = groupBy ? DIMS[groupBy] : null;
  const rows = await sql.unsafe(
    `SELECT date_trunc('${interval}', hour) AS t, ${col ? `${col} AS g` : `'all' AS g`}, sum(calls) AS calls, sum(errors) AS errors, sum(cost_usd) AS cost,
            sum(input_tokens) AS input, sum(cached_input_tokens) AS cached, sum(output_tokens) AS output, sum(reasoning_tokens) AS reasoning,
            array_agg(latency_hist) AS hists
     FROM ai_usage_hourly WHERE hour >= $1 AND hour < $2 GROUP BY 1, 2 ORDER BY 1`,
    [r.from, r.to],
  );
  return rows.map((x) => {
    const hist = (x.hists as number[][]).reduce(addHist, []);
    const value =
      metric === 'cost'
        ? Number(x.cost)
        : metric === 'calls'
          ? Number(x.calls)
          : metric === 'errors'
            ? Number(x.errors)
            : metric === 'latency_p95'
              ? percentileFromHist(hist, 0.95)
              : { input: Number(x.input), cached_input: Number(x.cached), output: Number(x.output), reasoning: Number(x.reasoning) };
    return { t: (x.t as Date).toISOString(), group: String(x.g), value };
  });
}

export interface BreakdownRow {
  task?: string;
  model?: string;
  provider?: string;
  credential?: string;
  plan?: string;
  prompt_version?: string;
  calls: number;
  tokens: { input: number; cached_input: number; output: number; reasoning: number };
  avg_tokens: { input: number; output: number; reasoning: number } | null;
  cost_usd: number;
  shadow_cost_usd: number;
  cost_share: number;
  latency_ms: { p50: number | null; p95: number | null };
  error_rate: number;
  schema_fail_rate: number;
  fallback_rate: number;
  cache_hit_rate: number;
  tokens_estimated_share: number;
  quality?: { gate_trips_per_opt: number; not_true_rate: number; repair_rate: number };
}

export async function breakdown(sql: Sql, r: Range, dims: Dim[]): Promise<BreakdownRow[]> {
  const cols = dims.map((d) => DIMS[d]);
  const sel = cols.length ? cols.map((c) => `${c}`).join(', ') : `'all' AS all_rows`;
  const rows = await sql.unsafe(
    `SELECT ${sel}, sum(calls) AS calls, sum(errors) AS errors, sum(schema_fails) AS schema_fails, sum(fallbacks) AS fallbacks, sum(cache_hits) AS cache_hits,
            sum(input_tokens) AS input, sum(cached_input_tokens) AS cached, sum(output_tokens) AS output, sum(reasoning_tokens) AS reasoning,
            sum(cost_usd) AS cost, sum(shadow_cost_usd) AS shadow, sum(estimated_token_calls) AS estimated, array_agg(latency_hist) AS hists
     FROM ai_usage_hourly WHERE hour >= $1 AND hour < $2 ${cols.length ? `GROUP BY ${cols.join(', ')}` : ''} ORDER BY sum(cost_usd) DESC, sum(calls) DESC`,
    [r.from, r.to],
  );
  const totalCost = rows.reduce((s, x) => s + Number(x.cost), 0);
  const quality = dims.includes('model') ? await modelQuality(sql, r) : new Map<string, { gate_trips_per_opt: number; not_true_rate: number; repair_rate: number }>();
  return rows.map((x) => {
    const calls = Number(x.calls);
    const hist = (x.hists as number[][]).reduce(addHist, []);
    const key: Record<string, string> = {};
    for (const d of dims) key[d] = String(x[DIMS[d]] ?? '');
    const q = key.model ? quality.get(key.model) : undefined;
    return {
      ...key,
      calls,
      tokens: { input: Number(x.input), cached_input: Number(x.cached), output: Number(x.output), reasoning: Number(x.reasoning) },
      avg_tokens: calls ? { input: Number(x.input) / calls, output: Number(x.output) / calls, reasoning: Number(x.reasoning) / calls } : null,
      cost_usd: Number(x.cost),
      shadow_cost_usd: Number(x.shadow),
      cost_share: totalCost ? Number(x.cost) / totalCost : 0,
      latency_ms: { p50: percentileFromHist(hist, 0.5), p95: percentileFromHist(hist, 0.95) },
      error_rate: calls ? Number(x.errors) / calls : 0,
      schema_fail_rate: calls ? Number(x.schema_fails) / calls : 0,
      fallback_rate: calls ? Number(x.fallbacks) / calls : 0,
      cache_hit_rate: calls ? Number(x.cache_hits) / calls : 0,
      tokens_estimated_share: calls ? Number(x.estimated) / calls : 0,
      ...(q ? { quality: q } : {}),
    };
  });
}

/** Quality per strong model: gate trips and "not true" feedback per optimization (admin-panel.md §9.3 page 3). */
async function modelQuality(sql: Sql, r: Range) {
  const rows = await sql<Array<{ model_id: string; opts: string; trips: string; repairs: string; not_true: string }>>`
    WITH om AS (
      SELECT DISTINCT ON (o.id) o.id, o.gates, a.model_id
      FROM optimizations o JOIN ai_requests a ON a.optimization_id = o.id AND a.task = 'optimize' AND a.outcome = 'ok'
      WHERE o.created_at >= ${r.from} AND o.created_at < ${r.to}
      ORDER BY o.id, a.created_at DESC)
    SELECT om.model_id, count(*) AS opts,
           COALESCE(sum(COALESCE((om.gates->>'G2')::int,0) + COALESCE((om.gates->>'G3')::int,0) + COALESCE((om.gates->>'G4')::int,0) + COALESCE((om.gates->>'G5')::int,0) + COALESCE((om.gates->>'G6')::int,0)), 0) AS trips,
           COALESCE(sum(COALESCE((om.gates->>'reverted')::int,0)), 0) AS repairs,
           (SELECT count(*) FROM feedback f WHERE f.optimization_id IN (SELECT id FROM om om2 WHERE om2.model_id = om.model_id) AND f.reason_code = 'not_true') AS not_true
    FROM om GROUP BY om.model_id`;
  return new Map(rows.map((x) => [x.model_id, { gate_trips_per_opt: Number(x.trips) / Number(x.opts), not_true_rate: Number(x.not_true) / Number(x.opts), repair_rate: Number(x.repairs) / Number(x.opts) }]));
}

export async function topUsers(sql: Sql, r: Range, sort: 'cost' | 'tokens', limit = 50) {
  const rows = await sql<Array<{ user_id: string; email: string; cost: string; tokens: string; optimizations: string; days: string; plan: string | null }>>`
    SELECT d.user_id, u.email, sum(d.cost_usd) AS cost, sum(d.input_tokens + d.output_tokens) AS tokens, sum(d.optimizations) AS optimizations, count(*) AS days,
           (SELECT plan_id FROM subscriptions s WHERE s.user_id = d.user_id AND s.status IN ('active','trialing','past_due')) AS plan
    FROM ai_usage_daily d JOIN users u ON u.id = d.user_id
    WHERE d.day >= ${r.from}::date AND d.day < ${r.to}::date + 1
    GROUP BY d.user_id, u.email ORDER BY ${sort === 'cost' ? sql`sum(d.cost_usd)` : sql`sum(d.input_tokens + d.output_tokens)`} DESC LIMIT ${limit}`;
  const total = rows.reduce((s, x) => s + Number(x.cost), 0);
  return rows.map((x) => ({ user_id: x.user_id, email_masked: maskEmail(x.email), plan: x.plan ?? 'free', cost_usd: Number(x.cost), tokens: Number(x.tokens), active_days: Number(x.days), share: total ? Number(x.cost) / total : 0 }));
}

export async function userUsage(sql: Sql, userId: string, r: Range) {
  const days = await sql<Array<{ day: Date; cost_usd: string; by_step: Record<string, { calls: number; in: number; cached: number; out: number; reasoning: number; usd: number }> }>>`
    SELECT day, cost_usd, by_step FROM ai_usage_daily WHERE user_id = ${userId} AND day >= ${r.from}::date AND day < ${r.to}::date + 1 ORDER BY day`;
  const steps: Record<string, { calls: number; input: number; cached_input: number; output: number; reasoning: number; cost_usd: number }> = {};
  for (const d of days) {
    for (const [task, v] of Object.entries(d.by_step)) {
      const s = (steps[task] ??= { calls: 0, input: 0, cached_input: 0, output: 0, reasoning: 0, cost_usd: 0 });
      s.calls += Number(v.calls);
      s.input += Number(v.in);
      s.cached_input += Number(v.cached);
      s.output += Number(v.out);
      s.reasoning += Number(v.reasoning);
      s.cost_usd += Number(v.usd);
    }
  }
  const optimizations = await sql`SELECT id, status, cost_usd, before_score, after_score, created_at FROM optimizations WHERE user_id = ${userId} AND created_at >= ${r.from} AND created_at < ${r.to} ORDER BY created_at DESC LIMIT 50`;
  return { daily: days.map((d) => ({ day: d.day.toISOString().slice(0, 10), cost_usd: Number(d.cost_usd) })), steps, optimizations };
}

export async function waterfall(sql: Sql, optimizationId: string) {
  return sql`
    SELECT created_at, task, model_id, provider_id, credential_id, prompt_version_id, attempt, fallback_used, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
           tokens_estimated, cost_usd, latency_ms, outcome, config_snapshot_id
    FROM ai_requests WHERE optimization_id = ${optimizationId} ORDER BY created_at`;
}

/**
 * What-if (admin-panel.md §9.6): re-price recorded token counts on another model. Output tokens can be capped.
 * [ESTIMATE] — other models produce different output/reasoning lengths; quality is known only from evals.
 */
export async function whatIf(sql: Sql, r: Range, tasks: string[], replaceModelId: string, caps: { max_output_tokens_per_call?: number } = {}) {
  const [target] = await sql<Array<{ id: string; input_per_mtok: string; cached_input_per_mtok: string | null; output_per_mtok: string; token_factor: string }>>`SELECT * FROM ai_models WHERE id = ${replaceModelId}`;
  if (!target) return null;
  const rows = await sql<Array<{ task: string; model_id: string; calls: string; input: string; cached: string; output: string; cost: string; token_factor: string }>>`
    SELECT h.task, h.model_id, sum(h.calls) AS calls, sum(h.input_tokens) AS input, sum(h.cached_input_tokens) AS cached, sum(h.output_tokens) AS output, sum(h.cost_usd) AS cost,
           COALESCE(max(m.token_factor), 1) AS token_factor
    FROM ai_usage_hourly h LEFT JOIN ai_models m ON m.id = h.model_id
    WHERE h.hour >= ${r.from} AND h.hour < ${r.to} AND h.task = ANY(${tasks}) GROUP BY h.task, h.model_id`;
  const days = Math.max(1 / 24, (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000);
  const scale = 30 / days;
  const perTask = new Map<string, { current: number; projected: number; calls: number }>();
  for (const x of rows) {
    const factor = Number(target.token_factor) / Number(x.token_factor || 1);
    const calls = Number(x.calls);
    let out = Number(x.output) * factor;
    if (caps.max_output_tokens_per_call) out = Math.min(out, calls * caps.max_output_tokens_per_call);
    const input = Number(x.input) * factor;
    const cached = Number(x.cached) * factor;
    const projected = ((input - cached) * Number(target.input_per_mtok) + cached * Number(target.cached_input_per_mtok ?? target.input_per_mtok) + out * Number(target.output_per_mtok)) / 1e6;
    const t = perTask.get(x.task) ?? { current: 0, projected: 0, calls: 0 };
    t.current += Number(x.cost);
    t.projected += projected;
    t.calls += calls;
    perTask.set(x.task, t);
  }
  const steps = [...perTask.entries()].map(([task, v]) => ({ task, calls: v.calls, current_monthly_usd: v.current * scale, projected_monthly_usd: v.projected * scale, delta_monthly_usd: (v.projected - v.current) * scale }));
  const evalRow = await sql<Array<{ metrics: unknown; passed: boolean; created_at: Date }>>`SELECT metrics, passed, created_at FROM eval_runs WHERE models ? ${replaceModelId} ORDER BY created_at DESC LIMIT 1`;
  return {
    model: replaceModelId,
    label: 'ESTIMATE',
    caveats: ['Other models produce different output and reasoning lengths.', 'Quality is known only from evals; switch only through the eval gate and a canary.'],
    steps,
    total_delta_monthly_usd: steps.reduce((s, x) => s + x.delta_monthly_usd, 0),
    latest_eval: evalRow[0] ?? null,
  };
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local[0]}***@${domain}`;
}
