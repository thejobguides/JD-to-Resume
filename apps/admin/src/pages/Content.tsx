import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Me } from '../App';
import { downloadCsv, get } from '../api';
import { Badge, Button, Card, dt, ErrorBox, inputCls, Modal, num, pct, Stat, Table } from '../components/ui';

// Saved content of users who opted in ("Help improve"): aggregates for every role; Owner and Admin can list items
// (metadata only), open one (step-up, audited) and export decrypted JSON Lines for offline analysis (step-up, audited).

interface Stats {
  users: { active: number; opted_in: number; opt_in_rate: number };
  by_kind: Array<{ kind: string; n: number; bytes: number; last_30d: number }>;
  results: { total: number; with_scores: number; avg_score_gain: number | null };
  retention_days: number;
}

interface Item {
  id: string;
  kind: 'job_post' | 'resume' | 'result';
  user_email_masked: string;
  optimization_id: string | null;
  meta: Record<string, unknown>;
  bytes: number;
  created_at: string;
  expires_at: string;
}

const KIND_LABEL: Record<string, string> = { job_post: 'Job post', resume: 'Resume (minimized)', result: 'Result' };

function summary(i: Item): string {
  const m = i.meta;
  if (i.kind === 'job_post') return [m.title, m.company, m.host].filter(Boolean).join(' · ') || `${m.chars ?? '?'} chars`;
  if (i.kind === 'resume') return `${m.roles ?? 0} roles, ${m.bullets ?? 0} bullets${m.job_title ? ` → ${String(m.job_title)}` : ''}`;
  const scores = m.after_score !== undefined ? ` · score ${String(m.before_score)} → ${String(m.after_score)}` : '';
  return `${String(m.status ?? '')}${m.bullets_changed !== undefined ? ` · ${String(m.bullets_changed)} bullets changed` : ''}${scores}`;
}

export function ContentPage({ me }: { me: Me }) {
  const canView = me.permissions.includes('content.view');
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);
  const stats = useQuery({ queryKey: ['content-stats'], queryFn: () => get<Stats>('/content/stats') });
  const list = useQuery({ queryKey: ['content', kind], queryFn: () => get<{ data: Item[] }>(`/content${kind ? `?kind=${kind}` : ''}`), enabled: canView });
  const s = stats.data;
  return (
    <div className="space-y-4">
      <ErrorBox error={stats.error} />
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Users opted in" value={num(s.users.opted_in)} sub={`${pct(s.users.opt_in_rate)} of active users`} />
          {(['job_post', 'resume', 'result'] as const).map((k) => {
            const row = s.by_kind.find((r) => r.kind === k);
            return <Stat key={k} label={KIND_LABEL[k]!} value={num(row?.n ?? 0)} sub={`${num(row?.last_30d ?? 0)} in the last 30 days`} />;
          })}
        </div>
      )}
      {s && (
        <Card title="Results">
          <p className="text-sm text-slate-700">
            {num(s.results.total)} saved results, {num(s.results.with_scores)} with before/after scores
            {s.results.avg_score_gain !== null && <> · average score gain <b>{s.results.avg_score_gain}</b> points</>}. Items are deleted after {s.retention_days} days, when the user opts out, or when the account is deleted.
          </p>
        </Card>
      )}
      {canView ? (
        <Card
          title="Saved items (metadata only)"
          actions={
            <div className="flex gap-2">
              <select className={inputCls} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All kinds</option>
                <option value="job_post">Job posts</option>
                <option value="resume">Resumes</option>
                <option value="result">Results</option>
              </select>
              <Button
                small
                kind="secondary"
                onClick={() => {
                  setExportError(null);
                  downloadCsv(`/content/export.jsonl${kind ? `?kind=${kind}` : ''}`, 'saved-content.jsonl').catch(setExportError);
                }}
              >
                Export JSONL
              </Button>
            </div>
          }
        >
          <ErrorBox error={list.error ?? exportError} />
          <p className="mb-2 text-xs text-slate-500">Opening an item or exporting decrypts content: it asks for a fresh sign-in code and is written to the audit log.</p>
          <Table
            rows={list.data?.data ?? []}
            onRow={(i) => setOpen(i.id)}
            empty="Nothing saved yet. Only users who turn on “Help improve” have saved items."
            cols={[
              { h: 'Kind', r: (i) => <Badge tone={i.kind === 'result' ? 'green' : i.kind === 'resume' ? 'indigo' : 'slate'}>{KIND_LABEL[i.kind]}</Badge> },
              { h: 'Summary', r: (i) => summary(i) },
              { h: 'User', r: (i) => i.user_email_masked },
              { h: 'Saved', r: (i) => dt(i.created_at) },
              { h: 'Size', r: (i) => `${num(i.bytes / 1024)} KB` },
            ]}
          />
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-slate-600">Your role sees aggregates only. Owner and Admin can open saved items.</p>
        </Card>
      )}
      {open && <ContentViewer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ContentViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['content-item', id], queryFn: () => get<Item & { payload: unknown }>(`/content/${id}`), retry: false });
  return (
    <Modal open title={q.data ? `${KIND_LABEL[q.data.kind]} · ${dt(q.data.created_at)}` : 'Saved item'} onClose={onClose}>
      <ErrorBox error={q.error} />
      {!q.data && !q.error && <p className="text-sm text-slate-500">Decrypting…</p>}
      {q.data && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            {q.data.user_email_masked ?? ''} {q.data.optimization_id && <>· optimization <code>{q.data.optimization_id}</code></>} · expires {dt(q.data.expires_at)}
          </p>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">{JSON.stringify(q.data.payload, null, 2)}</pre>
        </div>
      )}
    </Modal>
  );
}
