import { encryptSecret } from '@jmo/vault';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Me } from '../App';
import { get, patch, post } from '../api';
import { askReason, Badge, Button, Card, dt, ErrorBox, Field, inputCls, Modal, Table, usd } from '../components/ui';

// Providers (with data-policy flags), write-only key vault, model registry (admin-panel.md §6.5).

interface Provider {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  production_allowed: boolean;
  personal_data_allowed: boolean;
  trains_on_inputs: string;
  retention_note: string | null;
  terms_url: string | null;
  active: boolean;
}
interface Credential {
  id: string;
  provider_id: string;
  label: string;
  env: string;
  scope: string;
  last4: string;
  status: string;
  monthly_soft_budget_usd: string | null;
  spend_mtd_usd: number;
  last_used_at: string | null;
  last_test_result: string | null;
}
interface Model {
  id: string;
  provider_id: string;
  status: string;
  approved_tasks: string[];
  input_per_mtok: string;
  output_per_mtok: string;
  capabilities: { structured?: string };
}

export function AiPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => get<{ data: Provider[] }>('/ai/providers') });
  const creds = useQuery({ queryKey: ['creds'], queryFn: () => get<{ data: Credential[] }>('/ai/credentials'), enabled: me.permissions.includes('keys.test') });
  const models = useQuery({ queryKey: ['models'], queryFn: () => get<{ data: Model[] }>('/ai/models') });
  const [adding, setAdding] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [approving, setApproving] = useState<Model | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries();

  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      <Card title="Providers and data policy">
        <p className="mb-2 text-xs text-slate-500">A rule in code blocks production routes to providers whose terms don't allow production use, and blocks resume-carrying steps unless personal data is allowed and inputs are not used for training.</p>
        <Table
          rows={providers.data?.data ?? []}
          cols={[
            { h: 'Provider', r: (p) => <div>{p.name}<div className="text-xs text-slate-500">{p.id} · {p.kind}{p.base_url ? ` · ${p.base_url}` : ''}</div></div> },
            { h: 'Production', r: (p) => <Badge tone={p.production_allowed ? 'green' : 'red'}>{p.production_allowed ? 'allowed' : 'not allowed'}</Badge> },
            { h: 'Personal data', r: (p) => <Badge tone={p.personal_data_allowed ? 'green' : 'red'}>{p.personal_data_allowed ? 'allowed' : 'not allowed'}</Badge> },
            { h: 'Trains on inputs', r: (p) => <Badge tone={p.trains_on_inputs === 'no' ? 'green' : 'amber'}>{p.trains_on_inputs}</Badge> },
            { h: 'Notes', r: (p) => <div className="max-w-xs text-xs text-slate-600">{p.retention_note}{p.terms_url && <> · <a className="text-indigo-700 underline" href={p.terms_url} target="_blank" rel="noreferrer">terms</a></>}</div> },
            {
              h: '',
              r: (p) =>
                me.permissions.includes('providers.policy') && (
                  <Button small kind="ghost" onClick={async () => {
                    const reason = await askReason(`${p.active ? 'Disable' : 'Enable'} provider ${p.id}`);
                    if (!reason) return;
                    try { await patch(`/ai/providers/${p.id}`, { active: !p.active, reason }); await refresh(); } catch (e) { setError(e); }
                  }}>{p.active ? 'Disable' : 'Enable'}</Button>
                ),
            },
          ]}
        />
      </Card>

      {me.permissions.includes('keys.test') && (
        <Card title="API keys (write-only vault)" actions={me.permissions.includes('keys.manage') && <Button onClick={() => setAdding(true)}>Add key</Button>}>
          <p className="mb-2 text-xs text-slate-500">Keys are encrypted in this browser with the vault public key. Only the API server can decrypt them; nobody (including the Owner) can view a key again. Also revoke keys at the provider.</p>
          {testResult && <p className="mb-2 rounded bg-slate-50 p-2 text-xs">{testResult}</p>}
          <Table
            rows={creds.data?.data ?? []}
            cols={[
              { h: 'Key', r: (k) => <div><code className="text-xs">{k.id}</code><div className="text-xs text-slate-500">{k.label} · ••••{k.last4}</div></div> },
              { h: 'Scope', r: (k) => <Badge tone={k.scope === 'production' ? 'indigo' : 'amber'}>{k.scope}</Badge> },
              { h: 'Env', r: (k) => k.env },
              { h: 'Spend MTD', r: (k) => `${usd(k.spend_mtd_usd, 3)}${k.monthly_soft_budget_usd ? ` / ${usd(Number(k.monthly_soft_budget_usd), 0)}` : ''}`, right: true },
              { h: 'Last used', r: (k) => dt(k.last_used_at) },
              { h: 'Test', r: (k) => <span className="text-xs">{k.last_test_result ?? '—'}</span> },
              { h: 'Status', r: (k) => <Badge tone={k.status === 'active' ? 'green' : k.status === 'revoked' ? 'red' : 'slate'}>{k.status}</Badge> },
              {
                h: '',
                r: (k) => (
                  <div className="flex gap-1">
                    <Button small kind="secondary" onClick={async () => { try { const r = await post<{ ok: boolean; latency_ms: number; error_class?: string }>(`/ai/credentials/${k.id}/test`); setTestResult(`${k.id}: ${r.ok ? `ok in ${r.latency_ms} ms` : `failed (${r.error_class})`}`); await refresh(); } catch (e) { setError(e); } }}>Test</Button>
                    {me.permissions.includes('keys.manage') && k.status !== 'revoked' && (
                      <Button small kind="danger" onClick={async () => { const reason = await askReason(`Revoke ${k.id}`); if (!reason) return; try { await post(`/ai/credentials/${k.id}/revoke`, { reason }); await refresh(); } catch (e) { setError(e); } }}>Revoke</Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Card title="Models and price book" actions={me.permissions.includes('models.edit') && <Button kind="secondary" onClick={() => setAddingModel(true)}>Add model</Button>}>
        <Table
          rows={models.data?.data ?? []}
          cols={[
            { h: 'Model', r: (m) => <code className="text-xs">{m.id}</code> },
            { h: 'Status', r: (m) => <Badge tone={m.status === 'approved' ? 'green' : 'amber'}>{m.status}</Badge> },
            { h: 'Approved for', r: (m) => <span className="text-xs">{m.approved_tasks.join(', ') || '—'}</span> },
            { h: 'In / out per 1M', r: (m) => `$${Number(m.input_per_mtok)} / $${Number(m.output_per_mtok)}`, right: true },
            { h: 'Output mode', r: (m) => m.capabilities.structured ?? '—' },
            {
              h: '',
              r: (m) =>
                me.permissions.includes('models.edit') && (
                  <div className="flex gap-1">
                    {m.status !== 'retired' && <Button small kind="secondary" onClick={() => setApproving(m)}>Approve…</Button>}
                    {m.status !== 'retired' && !m.id.startsWith('mock:') && (
                      <Button small kind="ghost" onClick={async () => { const reason = await askReason(`Retire ${m.id}`); if (!reason) return; try { await patch(`/ai/models/${encodeURIComponent(m.id)}`, { status: 'retired', reason }); await refresh(); } catch (e) { setError(e); } }}>Retire</Button>
                    )}
                  </div>
                ),
            },
          ]}
        />
        <p className="mt-2 text-xs text-slate-500">Approving a model for a step needs a passing eval run (Model per step → Run eval).</p>
      </Card>

      {adding && <AddKey providers={providers.data?.data ?? []} onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await refresh(); }} />}
      {approving && <ApproveModel model={approving} onClose={() => setApproving(null)} onDone={async () => { setApproving(null); await refresh(); }} />}
      {addingModel && <AddModel providers={providers.data?.data ?? []} onClose={() => setAddingModel(false)} onDone={async () => { setAddingModel(false); await refresh(); }} />}
    </div>
  );
}

function AddKey({ providers, onClose, onDone }: { providers: Provider[]; onClose: () => void; onDone: () => void }) {
  const [provider, setProvider] = useState(providers.find((p) => p.id === 'openai')?.id ?? providers[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState('production');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<unknown>(null);
  const p = providers.find((x) => x.id === provider);
  const scope = p?.production_allowed ? (env === 'production' ? 'production' : 'non_production') : 'non_production';
  return (
    <Modal open title="Add an API key" onClose={onClose}>
      <ErrorBox error={error} />
      <Field label="Provider">
        <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.filter((x) => x.kind !== 'mock').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Field>
      {p && !p.production_allowed && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{p.name}: its terms don't allow production use (and may use inputs for training). This key will be <b>evals-only with synthetic data</b>.</p>}
      <Field label="Label"><input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="OpenAI production" /></Field>
      <Field label="Environment"><select className={inputCls} value={env} onChange={(e) => setEnv(e.target.value)}><option>production</option><option>staging</option><option>eval</option></select></Field>
      <Field label="API key" hint="Encrypted in this browser before it is sent. It will never be shown again.">
        <input type="password" autoComplete="off" className={inputCls} value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      <Field label="Monthly soft budget (USD, optional)" hint="The router stops using the key at this spend and moves to the fallback."><input className={inputCls} value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <div className="flex justify-end">
        <Button
          disabled={!label || secret.length < 8}
          onClick={async () => {
            try {
              setError(null);
              const reason = await askReason('Add API key');
              if (!reason) return;
              const { public_jwk, vault_key_version } = await get<{ public_jwk: JsonWebKey; vault_key_version: number }>('/ai/vault/public-key');
              const enc = await encryptSecret(secret, public_jwk, vault_key_version);
              setSecret('');
              await post('/ai/credentials', { provider_id: provider, label, env, scope, ...enc, monthly_soft_budget_usd: budget ? Number(budget) : null, reason });
              onDone();
            } catch (e) {
              setError(e);
            }
          }}
        >
          Encrypt & save
        </Button>
      </div>
    </Modal>
  );
}

function AddModel({ providers, onClose, onDone }: { providers: Provider[]; onClose: () => void; onDone: () => void }) {
  const [provider, setProvider] = useState('nvidia_trial');
  const [modelId, setModelId] = useState('');
  const [tier, setTier] = useState('cheap');
  const [structured, setStructured] = useState('json_mode');
  const [inP, setInP] = useState('0');
  const [outP, setOutP] = useState('0');
  const [source, setSource] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal open title="Register a model (starts as a candidate)" onClose={onClose}>
      <ErrorBox error={error} />
      <Field label="Provider"><select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Provider model ID"><input className={inputCls} value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="meta/llama-…" /></Field>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Tier"><select className={inputCls} value={tier} onChange={(e) => setTier(e.target.value)}><option>cheap</option><option>strong</option></select></Field>
        <Field label="Structured output"><select className={inputCls} value={structured} onChange={(e) => setStructured(e.target.value)}><option>json_schema_strict</option><option>json_mode</option><option>none</option></select></Field>
        <Field label="$ per 1M input"><input className={inputCls} value={inP} onChange={(e) => setInP(e.target.value)} /></Field>
        <Field label="$ per 1M output"><input className={inputCls} value={outP} onChange={(e) => setOutP(e.target.value)} /></Field>
      </div>
      <Field label="Price source URL"><input className={inputCls} value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      <div className="flex justify-end">
        <Button disabled={!modelId || !source} onClick={async () => { const reason = await askReason('Register model'); if (!reason) return; try { await post('/ai/models', { provider_id: provider, provider_model_id: modelId, tier, structured, input_per_mtok: Number(inP), output_per_mtok: Number(outP), source_url: source, reason }); onDone(); } catch (e) { setError(e); } }}>Register</Button>
      </div>
    </Modal>
  );
}

const TASKS = ['jd_extract', 'resume_extract', 'match_map', 'optimize', 'validate_entail', 'repair'] as const;

function ApproveModel({ model, onClose, onDone }: { model: Model; onClose: () => void; onDone: () => void }) {
  const evals = useQuery({ queryKey: ['evals'], queryFn: () => get<{ data: Array<{ id: string; suite: string; models: string[]; passed: boolean; created_at: string }> }>('/evals') });
  const runs = (evals.data?.data ?? []).filter((e) => e.passed && e.models.includes(model.id));
  const [tasks, setTasks] = useState<string[]>(model.approved_tasks);
  const [run, setRun] = useState('');
  const [error, setError] = useState<unknown>(null);
  const evalRun = run || runs[0]?.id || '';
  return (
    <Modal open title={`Approve ${model.id}`} onClose={onClose}>
      <ErrorBox error={error} />
      <p className="mb-2 text-xs text-slate-500">Approval needs a passing eval run that used this model. Run one from “Model per step” (eval routing) with this model on the steps you want to approve.</p>
      <Field label="Steps">
        <div className="grid grid-cols-2 gap-1 text-sm">
          {TASKS.map((t) => (
            <label key={t} className="flex items-center gap-1.5">
              <input type="checkbox" checked={tasks.includes(t)} onChange={(e) => setTasks(e.target.checked ? [...tasks, t] : tasks.filter((x) => x !== t))} /> <code className="text-xs">{t}</code>
            </label>
          ))}
        </div>
      </Field>
      <Field label="Passing eval run">
        {runs.length ? (
          <select className={inputCls} value={evalRun} onChange={(e) => setRun(e.target.value)}>{runs.map((r) => <option key={r.id} value={r.id}>{dt(r.created_at)} · {r.suite}</option>)}</select>
        ) : (
          <p className="text-sm text-amber-700">No passing eval run has used this model yet.</p>
        )}
      </Field>
      <div className="flex justify-end">
        <Button disabled={!evalRun || !tasks.length} onClick={async () => { const reason = await askReason(`Approve ${model.id}`); if (!reason) return; try { await patch(`/ai/models/${encodeURIComponent(model.id)}`, { status: 'approved', approved_tasks: tasks, eval_run_id: evalRun, reason }); onDone(); } catch (e) { setError(e); } }}>Approve</Button>
      </div>
    </Modal>
  );
}
