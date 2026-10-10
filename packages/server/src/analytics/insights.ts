import type { ActiveConfig } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { uuidv7 } from '@jmo/shared';
import { breakdown, type Range, topUsers, whatIf } from './queries';

// Rule-based "what should we optimize next?" (admin-panel.md §9.5). Deterministic; thresholds live in the
// `insights` config. Each finding stores its evidence; accepting creates a DRAFT config (still eval-gated).

export interface Finding {
  rule_id: string;
  severity: 'info' | 'warn' | 'critical';
  scope: Record<string, string>;
  evidence: Record<string, unknown>;
  estimated_monthly_impact_usd: number | null;
  title: string;
  action: string;
}

function lastDays(days: number): Range {
  const to = new Date();
  return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
}

export async function evaluateInsights(sql: Sql, cfg: ActiveConfig): Promise<Finding[]> {
  const th = cfg.insights.thresholds;
  const r = lastDays(7);
  const prev = { from: new Date(Date.parse(r.from) - 7 * 86_400_000).toISOString(), to: r.from };
  const monthly = 30 / 7;
  const byTask = await breakdown(sql, r, ['task']);
  const byTaskPrev = await breakdown(sql, prev, ['task']);
  const byModelTask = await breakdown(sql, r, ['model', 'task']);
  const findings: Finding[] = [];
  const routes = cfg.ai_routing.routes as Record<string, { max_output_tokens?: number; primary: { model: string } }>;

  for (const t of byTask) {
    const task = String(t.task);
    const route = routes[task];
    if (t.calls < 20) continue;
    // Expensive step with output+reasoning above its budget.
    const avgOut = (t.avg_tokens?.output ?? 0) + (t.avg_tokens?.reasoning ?? 0);
    const budget = route?.max_output_tokens ?? 4000;
    if (t.cost_share >= th.expensive_step_share && avgOut > budget * 0.8) {
      const w = route ? await whatIf(sql, r, [task], route.primary.model, { max_output_tokens_per_call: Math.round(budget * 0.75) }) : null;
      findings.push({
        rule_id: 'expensive_step',
        severity: 'warn',
        scope: { task },
        evidence: { cost_share: t.cost_share, avg_output_plus_reasoning: Math.round(avgOut), max_output_tokens: budget },
        estimated_monthly_impact_usd: w ? Math.round(-w.total_delta_monthly_usd * 100) / 100 : null,
        title: `${task} is ${Math.round(t.cost_share * 100)}% of AI cost and uses ${Math.round(avgOut)} output+reasoning tokens per call`,
        action: `Lower max_output_tokens to ${Math.round(budget * 0.75)} or reduce reasoning effort for ${task}`,
      });
    }
    // Low prompt-cache share on steps with large inputs.
    const cachedShare = t.tokens.input ? t.tokens.cached_input / t.tokens.input : 0;
    if ((t.avg_tokens?.input ?? 0) > 1500 && cachedShare < th.cached_share_min && t.cost_usd > 0) {
      findings.push({
        rule_id: 'low_prompt_cache',
        severity: 'info',
        scope: { task },
        evidence: { cached_share: cachedShare, avg_input: Math.round(t.avg_tokens?.input ?? 0) },
        estimated_monthly_impact_usd: Math.round(t.cost_usd * 0.08 * monthly * 100) / 100,
        title: `Only ${Math.round(cachedShare * 100)}% of ${task} input tokens are cached`,
        action: 'Move the static parts of the prompt first so provider prompt caching applies (≈ 8% saving on the strong step)',
      });
    }
    // Token drift week over week.
    const p = byTaskPrev.find((x) => x.task === task);
    if (p?.avg_tokens && t.avg_tokens && p.avg_tokens.input > 0) {
      const drift = t.avg_tokens.input / p.avg_tokens.input - 1;
      if (drift > th.token_drift) {
        findings.push({ rule_id: 'token_drift', severity: 'info', scope: { task }, evidence: { drift, prev_avg_input: Math.round(p.avg_tokens.input), avg_input: Math.round(t.avg_tokens.input) }, estimated_monthly_impact_usd: Math.round(t.cost_usd * (drift / (1 + drift)) * monthly * 100) / 100, title: `Input tokens per ${task} call grew ${Math.round(drift * 100)}% week over week`, action: 'Check payload growth (longer resumes/JDs) or a regression in trimming' });
      }
    }
    if (t.fallback_rate > th.fallback_rate) {
      findings.push({ rule_id: 'fallback_overuse', severity: 'warn', scope: { task }, evidence: { fallback_rate: t.fallback_rate }, estimated_monthly_impact_usd: null, title: `${Math.round(t.fallback_rate * 100)}% of ${task} calls used a fallback`, action: 'Check provider health and rate limits; consider reordering the chain or raising the provider tier' });
    }
  }
  for (const m of byModelTask) {
    if (m.calls >= 20 && m.schema_fail_rate > th.schema_fail_rate) {
      findings.push({ rule_id: 'schema_failures', severity: 'warn', scope: { task: String(m.task), model: String(m.model) }, evidence: { schema_fail_rate: m.schema_fail_rate, calls: m.calls }, estimated_monthly_impact_usd: Math.round(m.cost_usd * m.schema_fail_rate * monthly * 100) / 100, title: `${m.model} fails the output schema on ${(m.schema_fail_rate * 100).toFixed(1)}% of ${m.task} calls`, action: `Remove ${m.model} from ${m.task} (keep it for evals) or promote the fallback` });
    }
  }
  // Repair loop.
  const [rep] = await sql<Array<{ opts: string; repairs: string }>>`
    SELECT count(DISTINCT o.id) AS opts, count(a.*) FILTER (WHERE a.task = 'repair') AS repairs
    FROM optimizations o LEFT JOIN ai_requests a ON a.optimization_id = o.id WHERE o.created_at >= ${r.from}`;
  const repairRate = Number(rep?.opts ?? 0) ? Number(rep!.repairs) / Number(rep!.opts) : 0;
  if (Number(rep?.opts ?? 0) >= 20 && repairRate > th.repair_rate) {
    findings.push({ rule_id: 'repair_loop', severity: 'warn', scope: { task: 'optimize' }, evidence: { repair_rate: repairRate }, estimated_monthly_impact_usd: null, title: `${Math.round(repairRate * 100)}% of optimizations need a repair call`, action: 'Review which gates trip most; revise optimize@ prompt or canary another strong model' });
  }
  // Heavy tail + free-tier drag.
  const users = await topUsers(sql, r, 'cost', 1000);
  if (users.length >= 20) {
    const top = users.slice(0, Math.max(1, Math.ceil(users.length / 100)));
    const share = top.reduce((s, u) => s + u.share, 0);
    if (share > th.heavy_tail_share) findings.push({ rule_id: 'heavy_tail', severity: 'info', scope: {}, evidence: { top_1pct_share: share, users: top.map((u) => u.email_masked) }, estimated_monthly_impact_usd: null, title: `Top 1% of users drive ${Math.round(share * 100)}% of AI cost`, action: 'Review caps and check for abuse' });
    const free = users.filter((u) => u.plan === 'free').reduce((s, u) => s + u.share, 0);
    if (free > th.free_tier_share) findings.push({ rule_id: 'free_tier_drag', severity: 'warn', scope: {}, evidence: { free_share: free }, estimated_monthly_impact_usd: null, title: `Free users are ${Math.round(free * 100)}% of AI cost`, action: 'Lower the free quota or route free analyses to a cheaper model' });
  }
  // Cost target.
  const [cpo] = await sql<Array<{ c: string | null }>>`SELECT avg(cost_usd) AS c FROM optimizations WHERE created_at >= now() - interval '3 days' AND status IN ('succeeded','partial')`;
  if (cpo?.c && Number(cpo.c) > cfg.insights.cost_target_usd) {
    findings.push({ rule_id: 'cost_target', severity: 'critical', scope: {}, evidence: { cost_per_optimization: Number(cpo.c), target: cfg.insights.cost_target_usd }, estimated_monthly_impact_usd: null, title: `Cost per optimization $${Number(cpo.c).toFixed(3)} is above the $${cfg.insights.cost_target_usd} target`, action: 'Open the Steps page to see which step grew' });
  }
  // Key budgets.
  for (const [cred, budget] of Object.entries(cfg.ai_routing.credential_budgets_usd ?? {})) {
    const [s] = await sql<Array<{ c: string }>>`SELECT COALESCE(sum(cost_usd), 0) AS c FROM ai_requests WHERE credential_id = ${cred} AND created_at >= date_trunc('month', now())`;
    if (budget > 0 && Number(s?.c ?? 0) / budget >= th.key_budget_share) findings.push({ rule_id: 'key_budget', severity: 'warn', scope: { credential: cred }, evidence: { spent: Number(s?.c ?? 0), budget }, estimated_monthly_impact_usd: null, title: `Key ${cred} has used ${Math.round((Number(s?.c ?? 0) / budget) * 100)}% of its monthly budget`, action: 'Rotate, raise the soft budget, or shift traffic' });
  }
  return findings;
}

/** Upserts open findings (one open insight per rule+scope). */
export async function refreshInsights(sql: Sql, cfg: ActiveConfig): Promise<number> {
  const findings = await evaluateInsights(sql, cfg);
  for (const f of findings) {
    await sql`
      INSERT INTO optimization_insights (id, rule_id, severity, scope, evidence, estimated_monthly_impact_usd, status)
      VALUES (${uuidv7()}, ${f.rule_id}, ${f.severity}, ${sql.json(f.scope)}, ${sql.json({ ...f.evidence, title: f.title, action: f.action } as never)}, ${f.estimated_monthly_impact_usd}, 'open')
      ON CONFLICT (rule_id, (scope::text)) WHERE status = 'open' DO UPDATE SET evidence = EXCLUDED.evidence, estimated_monthly_impact_usd = EXCLUDED.estimated_monthly_impact_usd, severity = EXCLUDED.severity, detected_at = now()`;
  }
  return findings.length;
}

/** Proposed config change for an accepted insight (becomes a draft; activation still needs validation + eval). */
export function proposalFor(rule: string, scope: Record<string, string>, cfg: ActiveConfig): { namespace: 'ai_routing'; data: unknown; note: string } | null {
  const routing = structuredClone(cfg.ai_routing) as ActiveConfig['ai_routing'];
  const routes = routing.routes as Record<string, { max_output_tokens?: number; primary: { model: string; credential: string }; fallbacks?: Array<{ model: string; credential: string }> }>;
  if (rule === 'expensive_step' && scope.task && routes[scope.task]) {
    const r = routes[scope.task]!;
    r.max_output_tokens = Math.max(200, Math.round((r.max_output_tokens ?? 4000) * 0.75));
    return { namespace: 'ai_routing', data: routing, note: `Insight: lower ${scope.task} max_output_tokens to ${r.max_output_tokens}` };
  }
  if (rule === 'schema_failures' && scope.task && scope.model && routes[scope.task]) {
    const r = routes[scope.task]!;
    if (r.primary.model === scope.model && r.fallbacks?.length) {
      const [next, ...rest] = r.fallbacks;
      routes[scope.task] = { ...r, primary: next!, fallbacks: rest };
      return { namespace: 'ai_routing', data: routing, note: `Insight: promote fallback for ${scope.task} (schema failures on ${scope.model})` };
    }
  }
  return null;
}
