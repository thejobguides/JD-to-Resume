import type { Sql } from '@jmo/db';

// ai_requests → ai_usage_hourly every 5 minutes (admin-panel.md §9.2). Idempotent: a watermark moves forward
// in the same transaction; rows newer than now − 2 min wait for the next run.

export const LATENCY_BOUNDS_MS = [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

export function percentileFromHist(hist: number[], p: number): number | null {
  const total = hist.reduce((s, x) => s + x, 0);
  if (!total) return null;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= target) return i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i]! : LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]! * 2;
  }
  return null;
}

export async function rollupHourly(sql: Sql, opts: { lagSeconds?: number; referencePrices?: { cheap: { in: number; out: number }; strong: { in: number; out: number } } } = {}): Promise<{ from: string; to: string; rows: number }> {
  const lag = opts.lagSeconds ?? 120;
  const ref = opts.referencePrices ?? { cheap: { in: 0.1, out: 0.5 }, strong: { in: 2, out: 10 } };
  const buckets = LATENCY_BOUNDS_MS.map((b, i) => (i === 0 ? `count(*) FILTER (WHERE latency_ms < ${b})` : `count(*) FILTER (WHERE latency_ms >= ${LATENCY_BOUNDS_MS[i - 1]} AND latency_ms < ${b})`));
  buckets.push(`count(*) FILTER (WHERE latency_ms >= ${LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]} OR latency_ms IS NULL)`);
  return sql.begin(async (tx) => {
    await tx`INSERT INTO rollup_watermarks (name, processed_until) VALUES ('ai_usage_hourly', now() - interval '90 days') ON CONFLICT DO NOTHING`;
    const [w] = await tx<Array<{ processed_until: Date }>>`SELECT processed_until FROM rollup_watermarks WHERE name = 'ai_usage_hourly' FOR UPDATE`;
    const from = w!.processed_until;
    const to = (await tx<Array<{ to: Date }>>`SELECT now() - make_interval(secs => ${lag}) AS to`)[0]!.to;
    if (to <= from) return { from: from.toISOString(), to: from.toISOString(), rows: 0 };
    const res = await tx.unsafe(
      `INSERT INTO ai_usage_hourly (hour, task, provider_id, model_id, credential_id, plan_id, prompt_version_id, calls, errors, schema_fails, fallbacks, cache_hits,
         input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, estimated_token_calls, cost_usd, shadow_cost_usd, latency_hist)
       SELECT date_trunc('hour', created_at), task, provider_id, model_id, COALESCE(credential_id, ''), COALESCE(plan_id, ''), prompt_version_id,
         count(*), count(*) FILTER (WHERE outcome <> 'ok'), count(*) FILTER (WHERE outcome = 'schema_fail'), count(*) FILTER (WHERE fallback_used), count(*) FILTER (WHERE cache_hit),
         sum(input_tokens), sum(cached_input_tokens), sum(output_tokens), sum(reasoning_tokens), count(*) FILTER (WHERE tokens_estimated), sum(cost_usd),
         sum(CASE WHEN cost_usd = 0 THEN
               (input_tokens * (CASE WHEN task IN ('optimize','repair') THEN $3::numeric ELSE $5::numeric END) + output_tokens * (CASE WHEN task IN ('optimize','repair') THEN $4::numeric ELSE $6::numeric END)) / 1000000.0
             ELSE 0 END),
         ARRAY[${buckets.join(', ')}]::int[]
       FROM ai_requests WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
       GROUP BY 1, 2, 3, 4, 5, 6, 7
       ON CONFLICT (hour, task, provider_id, model_id, credential_id, plan_id, prompt_version_id) DO UPDATE SET
         calls = ai_usage_hourly.calls + EXCLUDED.calls, errors = ai_usage_hourly.errors + EXCLUDED.errors, schema_fails = ai_usage_hourly.schema_fails + EXCLUDED.schema_fails,
         fallbacks = ai_usage_hourly.fallbacks + EXCLUDED.fallbacks, cache_hits = ai_usage_hourly.cache_hits + EXCLUDED.cache_hits,
         input_tokens = ai_usage_hourly.input_tokens + EXCLUDED.input_tokens, cached_input_tokens = ai_usage_hourly.cached_input_tokens + EXCLUDED.cached_input_tokens,
         output_tokens = ai_usage_hourly.output_tokens + EXCLUDED.output_tokens, reasoning_tokens = ai_usage_hourly.reasoning_tokens + EXCLUDED.reasoning_tokens,
         estimated_token_calls = ai_usage_hourly.estimated_token_calls + EXCLUDED.estimated_token_calls,
         cost_usd = ai_usage_hourly.cost_usd + EXCLUDED.cost_usd, shadow_cost_usd = ai_usage_hourly.shadow_cost_usd + EXCLUDED.shadow_cost_usd,
         latency_hist = ARRAY(SELECT a + b FROM unnest(ai_usage_hourly.latency_hist, EXCLUDED.latency_hist) AS t(a, b))`,
      [from, to, ref.strong.in, ref.strong.out, ref.cheap.in, ref.cheap.out],
    );
    await tx`UPDATE rollup_watermarks SET processed_until = ${to} WHERE name = 'ai_usage_hourly'`;
    return { from: from.toISOString(), to: to.toISOString(), rows: res.count };
  });
}

export async function rollupLagMinutes(sql: Sql): Promise<number | null> {
  const [w] = await sql<Array<{ m: number }>>`SELECT extract(epoch FROM now() - processed_until) / 60 AS m FROM rollup_watermarks WHERE name = 'ai_usage_hourly'`;
  return w ? Math.round(Number(w.m)) : null;
}
