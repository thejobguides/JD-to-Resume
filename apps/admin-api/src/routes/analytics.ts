import { breakdown, createDraft, proposalFor, refreshInsights, rollupHourly, summary, timeseries, topUsers, userUsage, waterfall, whatIf } from '@jmo/server';
import { ApiError } from '@jmo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from '../context';
import { auditRead, need, reasonOf } from '../guard';
import { parse, range, toCsv } from '../util';

// AI usage dashboard, insights, what-if and traces (admin-panel.md §9).

// A watermark at exactly "now" can pass AI-call rows whose INSERT is still in flight; they would never be counted.
const MANUAL_ROLLUP_LAG_S = 10;

export const analytics = new Hono<AdminEnv>();

const DIMS = ['task', 'model', 'provider', 'credential', 'plan', 'prompt_version'] as const;

analytics.post('/analytics/rollup', need('dashboards.view'), async (c) => c.json(await rollupHourly(c.get('deps').sql, { lagSeconds: MANUAL_ROLLUP_LAG_S })));

analytics.get('/analytics/ai/summary', need('dashboards.view'), async (c) => {
  const cfg = (await c.get('deps').config.get()).config;
  const budget = cfg.budgets.global_daily_ceiling_usd * 30;
  return c.json(await summary(c.get('deps').sql, range(c), { monthlyBudgetUsd: budget }));
});

analytics.get('/analytics/ai/timeseries', need('dashboards.view'), async (c) => {
  const metric = z.enum(['tokens', 'cost', 'calls', 'latency_p95', 'errors']).parse(c.req.query('metric') ?? 'cost');
  const group = c.req.query('group_by');
  const groupBy = group ? z.enum(DIMS).parse(group) : null;
  const interval = z.enum(['hour', 'day']).parse(c.req.query('interval') ?? 'day');
  return c.json({ data: await timeseries(c.get('deps').sql, range(c), metric, groupBy, interval) });
});

analytics.get('/analytics/ai/breakdown', need('dashboards.view'), async (c) => {
  const dims = (c.req.query('dims') ?? 'task').split(',').filter(Boolean).map((d) => z.enum(DIMS).parse(d));
  return c.json({ data: await breakdown(c.get('deps').sql, range(c), dims) });
});

analytics.get('/analytics/ai/users', need('analytics.users'), async (c) => {
  const sort = z.enum(['cost', 'tokens']).parse(c.req.query('sort') ?? 'cost');
  return c.json({ data: await topUsers(c.get('deps').sql, range(c), sort, Math.min(200, Number(c.req.query('limit') ?? 50))) });
});

analytics.get('/analytics/ai/users/:id', need('analytics.users'), async (c) => {
  await auditRead(c, 'user.view', 'user', c.req.param('id'));
  return c.json(await userUsage(c.get('deps').sql, c.req.param('id'), range(c)));
});

analytics.get('/analytics/ai/optimizations/:id/waterfall', need('traces.view'), async (c) => {
  const { sql } = c.get('deps');
  const [o] = await sql`SELECT id, user_id, status, config_snapshot_id, gates, meta, cost_usd, created_at, finished_at FROM optimizations WHERE id = ${c.req.param('id')}`;
  if (!o) throw new ApiError('not_found', 'Optimization not found.');
  const [snap] = o.config_snapshot_id ? await sql`SELECT s.id, s.version_ids, (SELECT json_agg(json_build_object('namespace', v.namespace, 'version', v.version)) FROM config_versions v WHERE v.id = ANY(s.version_ids)) AS versions FROM config_snapshots s WHERE s.id = ${o.config_snapshot_id}` : [];
  return c.json({ optimization: { ...o, user_id: undefined }, config_snapshot: snap ?? null, calls: await waterfall(sql, o.id) });
});

analytics.get('/traces/:request_id', need('traces.view'), async (c) =>
  c.json({ calls: await c.get('deps').sql`SELECT created_at, task, model_id, credential_id, attempt, fallback_used, input_tokens, output_tokens, cost_usd, latency_ms, outcome, optimization_id FROM ai_requests WHERE request_id = ${c.req.param('request_id')} ORDER BY created_at` }),
);

analytics.post('/analytics/ai/what-if', need('dashboards.view'), async (c) => {
  const b = await parse(c, z.object({ from: z.string().optional(), to: z.string().optional(), tasks: z.array(z.string()).min(1), model_id: z.string(), max_output_tokens_per_call: z.number().int().min(100).max(8000).optional() }));
  const to = b.to ? new Date(b.to) : new Date();
  const from = b.from ? new Date(b.from) : new Date(to.getTime() - 30 * 86_400_000);
  const r = await whatIf(c.get('deps').sql, { from: from.toISOString(), to: to.toISOString() }, b.tasks, b.model_id, b.max_output_tokens_per_call ? { max_output_tokens_per_call: b.max_output_tokens_per_call } : {});
  if (!r) throw new ApiError('not_found', 'Unknown model.');
  return c.json(r);
});

analytics.get('/analytics/ai/export.csv', need('analytics.users'), async (c) => {
  await auditRead(c, 'analytics.export', 'ai_usage', 'breakdown');
  const rows = await breakdown(c.get('deps').sql, range(c), ['task', 'model', 'credential']);
  const csv = toCsv(
    ['task', 'model', 'credential', 'calls', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'cost_usd', 'p95_ms', 'error_rate'],
    rows.map((r) => [r.task, r.model, r.credential, r.calls, r.tokens.input, r.tokens.cached_input, r.tokens.output, r.tokens.reasoning, Number(r.cost_usd.toFixed(6)), r.latency_ms.p95, Number(r.error_rate.toFixed(4))]),
  );
  return c.body(csv, 200, { 'content-type': 'text/csv' });
});

// ── Insights ──
analytics.get('/insights', need('dashboards.view'), async (c) =>
  c.json({ data: await c.get('deps').sql`SELECT id, rule_id, severity, scope, evidence, estimated_monthly_impact_usd, status, config_version_id, measured_effect, decision_reason, detected_at, decided_at FROM optimization_insights WHERE (${c.req.query('status') ?? null}::text IS NULL OR status = ${c.req.query('status') ?? null}) ORDER BY detected_at DESC LIMIT 200` }),
);
analytics.post('/insights/refresh', need('dashboards.view'), async (c) => {
  await rollupHourly(c.get('deps').sql, { lagSeconds: MANUAL_ROLLUP_LAG_S });
  return c.json({ findings: await refreshInsights(c.get('deps').sql, (await c.get('deps').config.get()).config) });
});
analytics.post('/insights/:id/accept', need('insights.decide'), async (c) => {
  const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
  const { sql, config } = c.get('deps');
  const [ins] = await sql<Array<{ id: string; rule_id: string; scope: Record<string, string>; status: string }>>`SELECT id, rule_id, scope, status FROM optimization_insights WHERE id = ${c.req.param('id')}`;
  if (!ins || ins.status !== 'open') throw new ApiError('not_found', 'Open insight not found.');
  const proposal = proposalFor(ins.rule_id, ins.scope, (await config.get()).config);
  const a = c.get('admin');
  let draft: { id: string; version: number } | null = null;
  if (proposal) draft = await createDraft(sql, proposal.namespace, 'production', proposal.data, `${proposal.note} — ${reason}`, { id: a.id, role: a.role, requestId: c.get('requestId') });
  await sql`UPDATE optimization_insights SET status = 'accepted', decided_by = ${a.id}, decided_at = now(), decision_reason = ${reason}, config_version_id = ${draft?.id ?? null} WHERE id = ${ins.id}`;
  return c.json({ draft_config_version: draft, note: draft ? 'A draft was created. It still needs validation, an eval run and activation.' : 'Marked as accepted; this finding needs a manual change.' });
});
analytics.post('/insights/:id/dismiss', need('insights.decide'), async (c) => {
  const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
  await c.get('deps').sql`UPDATE optimization_insights SET status = 'dismissed', decided_by = ${c.get('admin').id}, decided_at = now(), decision_reason = ${reason} WHERE id = ${c.req.param('id')} AND status = 'open'`;
  return c.body(null, 204);
});
