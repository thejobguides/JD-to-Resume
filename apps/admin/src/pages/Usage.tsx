import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Me } from '../App';
import { get, post } from '../api';
import { askReason, Badge, Button, Card, ErrorBox, Field, inputCls, Modal, num, pct, Stat, Table, usd } from '../components/ui';

// AI usage dashboard (admin-panel.md §9): tokens and cost by step, model, key and user; trends; drill-down;
// rule-based insights; what-if re-pricing. Numbers are metadata only — no prompt/response text exists.

interface Tokens {
  input: number;
  cached_input: number;
  output: number;
  reasoning: number;
}
interface Summary {
  current: { calls: number; error_rate: number; schema_fail_rate: number; fallback_rate: number; cache_hit_rate: number; tokens: Tokens; cached_share: number; cost_usd: number; shadow_cost_usd: number; estimated_share: number; optimizations: number; cost_per_optimization: number | null };
  previous: Summary['current'];
  spend: { today_usd: number; mtd_usd: number; forecast_month_usd: number; budget_month_usd: number | null };
}
interface Row {
  task?: string;
  model?: string;
  credential?: string;
  calls: number;
  tokens: Tokens;
  avg_tokens: { input: number; output: number; reasoning: number } | null;
  cost_usd: number;
  shadow_cost_usd: number;
  cost_share: number;
  latency_ms: { p50: number | null; p95: number | null };
  error_rate: number;
  schema_fail_rate: number;
  fallback_rate: number;
  tokens_estimated_share: number;
  quality?: { gate_trips_per_opt: number; not_true_rate: number; repair_rate: number };
}
interface Insight {
  id: string;
  rule_id: string;
  severity: 'info' | 'warn' | 'critical';
  scope: Record<string, string>;
  evidence: Record<string, unknown> & { title?: string; action?: string };
  estimated_monthly_impact_usd: string | null;
  status: string;
  decision_reason: string | null;
}

const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 } as const;
const STEP_ORDER = ['jd_extract', 'resume_extract', 'match_map', 'optimize', 'validate_entail', 'repair'];
const COLORS = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0d9488'];

function delta(cur: number, prev: number) {
  if (!prev) return null;
  const d = cur / prev - 1;
  return <span className={d > 0 ? 'text-rose-600' : 'text-emerald-600'}>{d > 0 ? '▲' : '▼'} {Math.abs(d * 100).toFixed(0)}%</span>;
}

export function UsagePage({ me }: { me: Me }) {
  const [rk, setRk] = useState<keyof typeof RANGES>('30d');
  const qs = `from=${new Date(Date.now() - RANGES[rk] * 86_400_000).toISOString()}&to=${new Date().toISOString()}`;
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['summary', rk], queryFn: () => get<Summary>(`/analytics/ai/summary?${qs}`) });
  const steps = useQuery({ queryKey: ['steps', rk], queryFn: () => get<{ data: Row[] }>(`/analytics/ai/breakdown?dims=task&${qs}`) });
  const models = useQuery({ queryKey: ['models', rk], queryFn: () => get<{ data: Row[] }>(`/analytics/ai/breakdown?dims=model,credential&${qs}`) });
  const tokensTs = useQuery({ queryKey: ['tokts', rk], queryFn: () => get<{ data: Array<{ t: string; value: Tokens }> }>(`/analytics/ai/timeseries?metric=tokens&interval=${rk === '24h' ? 'hour' : 'day'}&${qs}`) });
  const costTs = useQuery({ queryKey: ['costts', rk], queryFn: () => get<{ data: Array<{ t: string; group: string; value: number }> }>(`/analytics/ai/timeseries?metric=cost&group_by=model&interval=${rk === '24h' ? 'hour' : 'day'}&${qs}`) });
  const users = useQuery({ queryKey: ['users', rk], queryFn: () => get<{ data: Array<{ user_id: string; email_masked: string; plan: string; cost_usd: number; tokens: number; share: number; active_days: number }> }>(`/analytics/ai/users?${qs}`), enabled: me.permissions.includes('analytics.users') });
  const insights = useQuery({ queryKey: ['insights'], queryFn: () => get<{ data: Insight[] }>('/insights?status=open') });
  const [userId, setUserId] = useState<string | null>(null);
  const [optId, setOptId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
  };

  const cur = s.data?.current;
  const prev = s.data?.previous;
  const stepRows = [...(steps.data?.data ?? [])].sort((a, b) => STEP_ORDER.indexOf(a.task ?? '') - STEP_ORDER.indexOf(b.task ?? ''));
  const tokenSeries = (tokensTs.data?.data ?? []).reduce<Record<string, Record<string, number | string>>>((acc, p) => {
    const k = p.t.slice(0, rk === '24h' ? 13 : 10);
    const r = (acc[k] ??= { t: k, input: 0, cached: 0, output: 0, reasoning: 0 });
    r.input = Number(r.input) + p.value.input - p.value.cached_input;
    r.cached = Number(r.cached) + p.value.cached_input;
    r.output = Number(r.output) + p.value.output - p.value.reasoning;
    r.reasoning = Number(r.reasoning) + p.value.reasoning;
    return acc;
  }, {});
  const costGroups = [...new Set((costTs.data?.data ?? []).map((p) => p.group))];
  const costSeries = Object.values(
    (costTs.data?.data ?? []).reduce<Record<string, Record<string, number | string>>>((acc, p) => {
      const k = p.t.slice(0, rk === '24h' ? 13 : 10);
      (acc[k] ??= { t: k })[p.group] = p.value;
      return acc;
    }, {}),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {Object.keys(RANGES).map((r) => (
          <Button key={r} small kind={r === rk ? 'primary' : 'secondary'} onClick={() => setRk(r as keyof typeof RANGES)}>{r}</Button>
        ))}
        <Button small kind="ghost" onClick={() => void attempt(async () => { await post('/analytics/rollup'); await qc.invalidateQueries(); })}>Refresh data</Button>
        <span className="text-xs text-slate-500">Rollups update every 5 minutes. Free/trial models show a “shadow cost” priced at the reference model.</span>
      </div>
      <ErrorBox error={error ?? s.error} />
      {notice && <p role="status" className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}

      {cur && prev && s.data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Spend (range)" value={usd(cur.cost_usd, 4)} sub={<>vs previous {delta(cur.cost_usd, prev.cost_usd)} · shadow {usd(cur.shadow_cost_usd, 4)}</>} />
          <Stat label="Month to date" value={usd(s.data.spend.mtd_usd, 2)} sub={`forecast ${usd(s.data.spend.forecast_month_usd)}${s.data.spend.budget_month_usd ? ` of ${usd(s.data.spend.budget_month_usd, 0)}` : ''}`} />
          <Stat label="Cost per optimization" value={usd(cur.cost_per_optimization, 4)} sub={`${cur.optimizations} optimizations`} />
          <Stat label="AI calls" value={num(cur.calls)} sub={<>errors {pct(cur.error_rate)} · fallbacks {pct(cur.fallback_rate)}</>} />
          <Stat label="Input tokens" value={num(cur.tokens.input)} sub={`cached ${pct(cur.cached_share)}`} />
          <Stat label="Output tokens" value={num(cur.tokens.output)} sub={`reasoning ${num(cur.tokens.reasoning)}`} />
          <Stat label="Schema failures" value={pct(cur.schema_fail_rate, 2)} sub="model output not matching the schema" />
          <Stat label="Estimated tokens" value={pct(cur.estimated_share)} sub="calls where the provider sent no usage" />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Where the money goes (cost by step)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stepRows.map((r) => ({ step: r.task, cost: Number(r.cost_usd.toFixed(6)), shadow: Number(r.shadow_cost_usd.toFixed(6)) }))} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" tickFormatter={(v) => `$${v}`} />
              <YAxis type="category" dataKey="step" width={110} />
              <Tooltip formatter={(v) => usd(Number(v), 5)} />
              <Legend />
              <Bar dataKey="cost" name="Cost" fill="#4f46e5" />
              <Bar dataKey="shadow" name="Shadow cost" fill="#a5b4fc" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Tokens over time (by type)">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={Object.values(tokenSeries)}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t" />
              <YAxis />
              <Tooltip formatter={(v) => num(Number(v))} />
              <Legend />
              <Area type="monotone" dataKey="input" name="Input (uncached)" stackId="1" stroke="#4f46e5" fill="#c7d2fe" />
              <Area type="monotone" dataKey="cached" name="Cached input" stackId="1" stroke="#0891b2" fill="#a5f3fc" />
              <Area type="monotone" dataKey="output" name="Output" stackId="1" stroke="#16a34a" fill="#bbf7d0" />
              <Area type="monotone" dataKey="reasoning" name="Reasoning" stackId="1" stroke="#d97706" fill="#fde68a" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Steps: tokens, cost, latency, reliability">
        <Table
          rows={stepRows}
          cols={[
            { h: 'Step', r: (r) => <code>{r.task}</code> },
            { h: 'Calls', r: (r) => num(r.calls), right: true },
            { h: 'Avg in / out / reasoning', r: (r) => (r.avg_tokens ? `${num(r.avg_tokens.input)} / ${num(r.avg_tokens.output)} / ${num(r.avg_tokens.reasoning)}` : '—'), right: true },
            { h: 'Cost', r: (r) => usd(r.cost_usd, 4), right: true },
            { h: 'Share', r: (r) => pct(r.cost_share, 0), right: true },
            { h: 'p50 / p95', r: (r) => `${num(r.latency_ms.p50)} / ${num(r.latency_ms.p95)} ms`, right: true },
            { h: 'Errors', r: (r) => pct(r.error_rate), right: true },
            { h: 'Schema fail', r: (r) => pct(r.schema_fail_rate), right: true },
            { h: 'Fallback', r: (r) => pct(r.fallback_rate), right: true },
          ]}
        />
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Cost over time by model">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={costSeries}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t" />
              <YAxis tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v) => usd(Number(v), 5)} />
              <Legend />
              {costGroups.map((g, i) => (
                <Line key={g} type="monotone" dataKey={g} stroke={COLORS[i % COLORS.length]} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Models and keys (cost vs quality)">
          <Table
            rows={models.data?.data ?? []}
            cols={[
              { h: 'Model', r: (r) => <code className="text-xs">{r.model}</code> },
              { h: 'Key', r: (r) => <span className="text-xs">{r.credential || 'env'}</span> },
              { h: 'Calls', r: (r) => num(r.calls), right: true },
              { h: 'Cost', r: (r) => usd(r.cost_usd, 4), right: true },
              { h: 'p95', r: (r) => `${num(r.latency_ms.p95)} ms`, right: true },
              { h: 'Gate trips/opt', r: (r) => (r.quality ? r.quality.gate_trips_per_opt.toFixed(2) : '—'), right: true },
              { h: 'Not true', r: (r) => (r.quality ? pct(r.quality.not_true_rate) : '—'), right: true },
            ]}
          />
        </Card>
      </div>

      <Card title="What should we optimize next?" actions={<Button small kind="secondary" onClick={() => void attempt(async () => { await post('/insights/refresh'); await qc.invalidateQueries({ queryKey: ['insights'] }); })}>Re-evaluate</Button>}>
        <Table
          rows={insights.data?.data ?? []}
          empty="No open findings. Rules run hourly over the last 7 days."
          cols={[
            { h: '', r: (r) => <Badge tone={r.severity === 'critical' ? 'red' : r.severity === 'warn' ? 'amber' : 'indigo'}>{r.severity}</Badge> },
            { h: 'Finding', r: (r) => <div><div className="font-medium">{String(r.evidence.title ?? r.rule_id)}</div><div className="text-xs text-slate-500">{String(r.evidence.action ?? '')}</div></div> },
            { h: 'Est. monthly impact', r: (r) => (r.estimated_monthly_impact_usd ? usd(Number(r.estimated_monthly_impact_usd)) : '—'), right: true },
            {
              h: '',
              r: (r) =>
                me.permissions.includes('insights.decide') && (
                  <div className="flex gap-1">
                    <Button small onClick={async () => { const reason = await askReason('Accept this finding'); if (!reason) return; try { const res = await post<{ note: string }>(`/insights/${r.id}/accept`, { reason }); setNotice(res.note); await qc.invalidateQueries({ queryKey: ['insights'] }); } catch (e) { setError(e); } }}>Accept</Button>
                    <Button small kind="secondary" onClick={async () => { const reason = await askReason('Dismiss this finding'); if (!reason) return; await attempt(async () => { await post(`/insights/${r.id}/dismiss`, { reason }); await qc.invalidateQueries({ queryKey: ['insights'] }); }); }}>Dismiss</Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>

      <WhatIf models={[...new Set((models.data?.data ?? []).map((m) => m.model ?? ''))]} />

      {me.permissions.includes('analytics.users') && (
        <Card title="Top users by AI cost (masked; opening a user is audited)">
          <Table
            rows={users.data?.data ?? []}
            onRow={(u) => setUserId(u.user_id)}
            cols={[
              { h: 'User', r: (u) => u.email_masked },
              { h: 'Plan', r: (u) => u.plan },
              { h: 'Cost', r: (u) => usd(u.cost_usd, 4), right: true },
              { h: 'Share', r: (u) => pct(u.share), right: true },
              { h: 'Tokens', r: (u) => num(u.tokens), right: true },
              { h: 'Active days', r: (u) => u.active_days, right: true },
            ]}
          />
        </Card>
      )}
      {userId && <UserUsage id={userId} qs={qs} onClose={() => setUserId(null)} onOpt={setOptId} />}
      {optId && <Waterfall id={optId} onClose={() => setOptId(null)} />}
    </div>
  );
}

function UserUsage({ id, qs, onClose, onOpt }: { id: string; qs: string; onClose: () => void; onOpt: (id: string) => void }) {
  const q = useQuery({ queryKey: ['uu', id, qs], queryFn: () => get<{ steps: Record<string, { calls: number; input: number; output: number; reasoning: number; cost_usd: number }>; optimizations: Array<{ id: string; status: string; cost_usd: string; before_score: number | null; after_score: number | null; created_at: string }> }>(`/analytics/ai/users/${id}?${qs}`) });
  return (
    <Modal open title="User AI usage by step" onClose={onClose}>
      <Table rows={Object.entries(q.data?.steps ?? {})} cols={[{ h: 'Step', r: ([k]) => <code>{k}</code> }, { h: 'Calls', r: ([, v]) => v.calls, right: true }, { h: 'In / out', r: ([, v]) => `${num(v.input)} / ${num(v.output)}`, right: true }, { h: 'Cost', r: ([, v]) => usd(v.cost_usd, 4), right: true }]} />
      <h4 className="mt-3 mb-1 text-xs font-semibold uppercase text-slate-500">Optimizations</h4>
      <Table rows={q.data?.optimizations ?? []} onRow={(o) => onOpt(o.id)} cols={[{ h: 'When', r: (o) => new Date(o.created_at).toLocaleString() }, { h: 'Status', r: (o) => o.status }, { h: 'Score', r: (o) => `${o.before_score ?? '—'} → ${o.after_score ?? '—'}` }, { h: 'Cost', r: (o) => usd(Number(o.cost_usd), 4), right: true }]} />
    </Modal>
  );
}

function Waterfall({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['wf', id], queryFn: () => get<{ optimization: { status: string; gates: Record<string, number> | null; cost_usd: string }; config_snapshot: { id: string; versions: Array<{ namespace: string; version: number }> } | null; calls: Array<{ task: string; model_id: string; credential_id: string | null; attempt: number; fallback_used: boolean; input_tokens: number; output_tokens: number; reasoning_tokens: number; cost_usd: string; latency_ms: number; outcome: string }> }>(`/analytics/ai/optimizations/${id}/waterfall`) });
  const d = q.data;
  return (
    <Modal open title="Optimization trace (per call)" onClose={onClose}>
      {d && (
        <>
          <p className="mb-2 text-xs text-slate-600">
            Status {d.optimization.status} · total {usd(Number(d.optimization.cost_usd), 5)} · gates {JSON.stringify(d.optimization.gates ?? {})}
            <br />
            Config {d.config_snapshot?.id ?? '—'}: {d.config_snapshot?.versions?.map((v) => `${v.namespace}@v${v.version}`).join(', ')}
          </p>
          <Table rows={d.calls} cols={[{ h: 'Step', r: (c) => <code>{c.task}</code> }, { h: 'Model', r: (c) => <span className="text-xs">{c.model_id}{c.fallback_used ? ' (fallback)' : ''}</span> }, { h: 'Tokens', r: (c) => `${c.input_tokens}/${c.output_tokens}`, right: true }, { h: 'Cost', r: (c) => usd(Number(c.cost_usd), 5), right: true }, { h: 'ms', r: (c) => c.latency_ms, right: true }, { h: 'Outcome', r: (c) => <Badge tone={c.outcome === 'ok' ? 'green' : 'red'}>{c.outcome}</Badge> }]} />
        </>
      )}
    </Modal>
  );
}

function WhatIf({ models }: { models: string[] }) {
  const all = useQuery({ queryKey: ['allmodels'], queryFn: () => get<{ data: Array<{ id: string; status: string }> }>('/ai/models') });
  const [model, setModel] = useState('openai:gpt-6-luna');
  const [tasks, setTasks] = useState<string[]>(['optimize']);
  const [cap, setCap] = useState('');
  const [res, setRes] = useState<{ steps: Array<{ task: string; current_monthly_usd: number; projected_monthly_usd: number; delta_monthly_usd: number }>; total_delta_monthly_usd: number; caveats: string[]; latest_eval: { passed: boolean } | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  void models;
  return (
    <Card title="What-if: re-price recent traffic on another model (estimate)">
      <ErrorBox error={error} />
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Model">
          <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
            {(all.data?.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.id} ({m.status})</option>
            ))}
          </select>
        </Field>
        <Field label="Steps">
          <select multiple className={`${inputCls} h-24`} value={tasks} onChange={(e) => setTasks([...e.target.selectedOptions].map((o) => o.value))}>
            {STEP_ORDER.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Cap output tokens per call (optional)">
          <input className={inputCls} value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 3000" />
        </Field>
        <div className="flex items-end pb-3">
          <Button onClick={async () => { try { setError(null); setRes(await post('/analytics/ai/what-if', { tasks, model_id: model, ...(cap ? { max_output_tokens_per_call: Number(cap) } : {}) })); } catch (e) { setError(e); } }}>Simulate</Button>
        </div>
      </div>
      {res && (
        <>
          <Table rows={res.steps} cols={[{ h: 'Step', r: (r) => r.task }, { h: 'Now / month', r: (r) => usd(r.current_monthly_usd, 2), right: true }, { h: 'Projected / month', r: (r) => usd(r.projected_monthly_usd, 2), right: true }, { h: 'Δ', r: (r) => <span className={r.delta_monthly_usd > 0 ? 'text-rose-600' : 'text-emerald-600'}>{usd(r.delta_monthly_usd, 2)}</span>, right: true }]} />
          <p className="mt-2 text-sm">
            Total monthly change: <b>{usd(res.total_delta_monthly_usd)}</b> · latest eval for this model: {res.latest_eval ? (res.latest_eval.passed ? <Badge tone="green">passed</Badge> : <Badge tone="red">failed</Badge>) : <Badge>none — run one before switching</Badge>}
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs text-slate-500">{res.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </>
      )}
    </Card>
  );
}
