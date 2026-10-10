import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Me } from '../App';
import { get, post } from '../api';
import { askReason, Badge, Button, Card, ErrorBox, inputCls, Table } from '../components/ui';

// Model + key per step (admin-panel.md §6.5.3, §6.5.4): edit → validate (data-policy rule) → run eval → activate.

const STEPS = ['jd_extract', 'resume_extract', 'match_map', 'optimize', 'validate_entail', 'repair'] as const;
type Target = { model: string; credential: string };
type Route = { primary: Target; fallbacks?: Target[]; max_output_tokens?: number; reasoning?: string; timeout_ms?: number };
type Routing = { routes: Record<string, Route>; canary?: Record<string, Target & { pct: number }>; credential_budgets_usd?: Record<string, number> };

export function RoutingPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [env, setEnv] = useState<'production' | 'eval'>('production');
  const cfg = useQuery({ queryKey: ['routing', env], queryFn: () => get<{ active: { id: string; version: number; data: Routing } | null; versions: Array<{ id: string; version: number; status: string; change_note: string; eval_run_id: string | null }> }>(`/config/ai_routing?env=${env}`) });
  const models = useQuery({ queryKey: ['models'], queryFn: () => get<{ data: Array<{ id: string; status: string; approved_tasks: string[] }> }>('/ai/models') });
  const creds = useQuery({ queryKey: ['creds'], queryFn: () => get<{ data: Array<{ id: string; provider_id: string; scope: string; status: string }> }>('/ai/credentials'), enabled: me.permissions.includes('keys.test') });
  const [draft, setDraft] = useState<Routing | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ valid: boolean; errors: Array<{ path: string; message: string }>; diff: Array<{ path: string; before: unknown; after: unknown }> } | null>(null);
  const [evalRun, setEvalRun] = useState<{ eval_run_id: string; passed: boolean; failures: string[]; metrics: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (cfg.data?.active) setDraft(structuredClone(cfg.data.active.data));
    setDraftId(null);
    setValidation(null);
    setEvalRun(null);
  }, [cfg.data]);

  const credOptions = ['none', 'env:OPENAI_API_KEY', 'env:ANTHROPIC_API_KEY', 'env:GOOGLE_API_KEY', 'env:NVIDIA_API_KEY', 'env:OPENROUTER_API_KEY', ...(creds.data?.data ?? []).filter((c) => c.status !== 'revoked').map((c) => c.id)];
  const editable = me.permissions.includes('config.ai');
  const setTarget = (step: string, idx: number, t: Partial<Target>) => {
    if (!draft) return;
    const d = structuredClone(draft);
    const r = d.routes[step]!;
    if (idx === 0) r.primary = { ...r.primary, ...t };
    else {
      r.fallbacks = r.fallbacks ?? [];
      r.fallbacks[idx - 1] = { ...(r.fallbacks[idx - 1] ?? { model: 'mock:deterministic', credential: 'none' }), ...t };
    }
    setDraft(d);
    setDraftId(null);
    setValidation(null);
  };

  const saveAndValidate = async () => {
    const note = await askReason('Describe this routing change');
    if (!note || !draft) return;
    setBusy(true);
    try {
      setError(null);
      const d = await post<{ id: string }>('/config/ai_routing/versions', { env, data: draft, change_note: note });
      setDraftId(d.id);
      setValidation(await post(`/config/versions/${d.id}/validate`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button small kind={env === 'production' ? 'primary' : 'secondary'} onClick={() => setEnv('production')}>Production routing</Button>
        <Button small kind={env === 'eval' ? 'primary' : 'secondary'} onClick={() => setEnv('eval')}>Eval routing (trial keys allowed)</Button>
        {cfg.data?.active && <span className="text-xs text-slate-500">active v{cfg.data.active.version}</span>}
      </div>
      <ErrorBox error={error ?? cfg.error} />
      <Card title="Model and key for each step">
        {draft && (
          <Table
            rows={[...STEPS]}
            cols={[
              { h: 'Step', r: (s) => <code>{s}</code> },
              ...[0, 1].map((idx) => ({
                h: idx === 0 ? 'Primary' : 'Fallback',
                r: (s: string) => {
                  const r = draft.routes[s];
                  const t = idx === 0 ? r?.primary : r?.fallbacks?.[idx - 1];
                  return (
                    <div className="flex flex-col gap-1">
                      <select aria-label={`${s} ${idx === 0 ? 'primary' : 'fallback'} model`} className={`${inputCls} text-xs`} disabled={!editable} value={t?.model ?? ''} onChange={(e) => setTarget(s, idx, { model: e.target.value })}>
                        {idx > 0 && <option value="">— none —</option>}
                        {(models.data?.data ?? []).filter((m) => m.status !== 'retired').map((m) => (
                          <option key={m.id} value={m.id}>{m.id}{m.approved_tasks.includes(s) ? '' : ' (no eval for this step)'}</option>
                        ))}
                      </select>
                      <select aria-label={`${s} ${idx === 0 ? 'primary' : 'fallback'} key`} className={`${inputCls} text-xs`} disabled={!editable || !t} value={t?.credential ?? ''} onChange={(e) => setTarget(s, idx, { credential: e.target.value })}>
                        {credOptions.map((c) => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                  );
                },
              })),
              {
                h: 'Max output tokens',
                r: (s) => (
                  <input aria-label={`${s} max output tokens`} className={`${inputCls} w-24 text-xs`} disabled={!editable} value={draft.routes[s]?.max_output_tokens ?? ''} onChange={(e) => { const d = structuredClone(draft); d.routes[s]!.max_output_tokens = Number(e.target.value.replace(/\D/g, '')) || undefined; setDraft(d); setDraftId(null); setValidation(null); }} />
                ),
              },
            ]}
          />
        )}
        {editable && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={saveAndValidate}>Save draft & validate</Button>
            {draftId && validation?.valid && (
              <Button kind="secondary" disabled={busy} onClick={async () => { setBusy(true); try { setEvalRun(await post('/evals/run', { version_id: draftId })); } catch (e) { setError(e); } finally { setBusy(false); } }}>Run smoke eval</Button>
            )}
            {draftId && validation?.valid && (env === 'eval' || evalRun?.passed) && (
              <Button kind="danger" disabled={busy} onClick={async () => { const reason = await askReason('Activate routing'); if (!reason) return; try { await post(`/config/versions/${draftId}/activate`, { reason, ...(evalRun ? { eval_run_id: evalRun.eval_run_id } : {}) }); await qc.invalidateQueries(); } catch (e) { setError(e); } }}>Activate</Button>
            )}
            <Button kind="ghost" onClick={async () => { const reason = await askReason('Roll back routing to the previous version'); if (!reason) return; try { await post('/config/ai_routing/rollback', { env, reason }); await qc.invalidateQueries(); } catch (e) { setError(e); } }}>Roll back</Button>
          </div>
        )}
        {validation && (
          <div className="mt-3 text-sm">
            {validation.valid ? <Badge tone="green">valid</Badge> : <Badge tone="red">blocked</Badge>}
            {validation.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-rose-700">{validation.errors.map((e, i) => <li key={i}><code className="text-xs">{e.path}</code>: {e.message}</li>)}</ul>}
            {validation.diff.length > 0 && <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-50 p-2 text-xs">{validation.diff.map((d) => `${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join('\n')}</pre>}
          </div>
        )}
        {evalRun && (
          <div className="mt-2 text-sm">
            Eval {evalRun.passed ? <Badge tone="green">passed</Badge> : <Badge tone="red">failed</Badge>} {evalRun.failures.length > 0 && <ul className="list-disc pl-5 text-rose-700">{evalRun.failures.map((f) => <li key={f}>{f}</li>)}</ul>}
            <pre className="mt-1 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(evalRun.metrics, null, 1)}</pre>
          </div>
        )}
      </Card>
      <Card title="Version history">
        <Table rows={cfg.data?.versions ?? []} cols={[{ h: 'v', r: (v) => v.version }, { h: 'Status', r: (v) => v.status }, { h: 'Note', r: (v) => v.change_note }, { h: 'Eval', r: (v) => (v.eval_run_id ? <Badge tone="green">run</Badge> : '—') }]} />
      </Card>
    </div>
  );
}
