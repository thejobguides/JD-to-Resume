import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Me } from '../App';
import { get, post } from '../api';
import { askReason, Badge, Button, Card, dt, ErrorBox, Table } from '../components/ui';

// Every runtime namespace (admin-panel.md §6.1): edit JSON → validate (bounds + diff) → activate → rollback.
// Invariants (truthfulness gates, privacy posture, score wording, extension code, infra secrets) are not here by design.

export function ConfigPage({ me }: { me: Me }) {
  void me;
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['config-list'], queryFn: () => get<{ data: Array<{ namespace: string; active: { version: number; activated_at: string } | null; drafts: number; editable: boolean }> }>('/config') });
  const [ns, setNs] = useState('kill_switches');
  const cur = useQuery({ queryKey: ['config', ns], queryFn: () => get<{ active: { id: string; version: number; data: unknown } | null; versions: Array<{ id: string; version: number; status: string; change_note: string; activated_at: string | null }> }>(`/config/${ns}`) });
  const [text, setText] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [result, setResult] = useState<{ valid: boolean; errors: Array<{ path: string; message: string }>; diff: Array<{ path: string; before: unknown; after: unknown }>; eval_required: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (cur.data?.active) setText(JSON.stringify(cur.data.active.data, null, 2));
    setDraftId(null);
    setResult(null);
  }, [cur.data]);
  const editable = list.data?.data.find((x) => x.namespace === ns)?.editable ?? false;

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <Card title="Namespaces">
        <ul className="space-y-0.5 text-sm">
          {(list.data?.data ?? []).map((x) => (
            <li key={x.namespace}>
              <button className={`w-full rounded px-2 py-1 text-left ${x.namespace === ns ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-slate-100'}`} onClick={() => setNs(x.namespace)}>
                {x.namespace} <span className="text-xs text-slate-600">v{x.active?.version ?? 0}{x.drafts ? ` · ${x.drafts} draft` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <div className="space-y-4">
        <ErrorBox error={error} />
        <Card title={`${ns} (active v${cur.data?.active?.version ?? '—'})`}>
          <textarea aria-label={`${ns} configuration (JSON)`} className="mono h-96 w-full rounded-md border border-slate-300 p-2 text-xs" value={text} readOnly={!editable} onChange={(e) => { setText(e.target.value); setDraftId(null); setResult(null); }} />
          {editable ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={async () => {
                let data: unknown;
                try { data = JSON.parse(text); } catch { setError(new Error('Invalid JSON')); return; }
                const note = await askReason(`Describe this ${ns} change`);
                if (!note) return;
                try { setError(null); const d = await post<{ id: string }>(`/config/${ns}/versions`, { data, change_note: note }); setDraftId(d.id); setResult(await post(`/config/versions/${d.id}/validate`)); } catch (e) { setError(e); }
              }}>Save draft & validate</Button>
              {draftId && result?.valid && !result.eval_required && (
                <Button kind="danger" onClick={async () => { const reason = await askReason(`Activate ${ns}`); if (!reason) return; try { await post(`/config/versions/${draftId}/activate`, { reason }); await qc.invalidateQueries(); } catch (e) { setError(e); } }}>Activate</Button>
              )}
              {result?.eval_required && <span className="text-xs text-amber-700">This namespace needs a passing eval run: activate it from “Model per step” or after an eval.</span>}
              <Button kind="ghost" onClick={async () => { const reason = await askReason(`Roll back ${ns}`); if (!reason) return; try { await post(`/config/${ns}/rollback`, { reason }); await qc.invalidateQueries(); } catch (e) { setError(e); } }}>Roll back</Button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">Read-only for your role.</p>
          )}
          {result && (
            <div className="mt-3 text-sm">
              {result.valid ? <Badge tone="green">valid</Badge> : <Badge tone="red">invalid</Badge>}
              {result.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-rose-700">{result.errors.map((e, i) => <li key={i}><code className="text-xs">{e.path}</code>: {e.message}</li>)}</ul>}
              {result.diff.length > 0 && <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-xs">{result.diff.map((d) => `${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join('\n')}</pre>}
            </div>
          )}
        </Card>
        <Card title="History (immutable versions; rollback re-activates an old one)">
          <Table rows={cur.data?.versions ?? []} cols={[{ h: 'v', r: (v) => v.version }, { h: 'Status', r: (v) => <Badge tone={v.status === 'active' ? 'green' : 'slate'}>{v.status}</Badge> }, { h: 'Note', r: (v) => v.change_note }, { h: 'Activated', r: (v) => dt(v.activated_at) }]} />
        </Card>
      </div>
    </div>
  );
}
