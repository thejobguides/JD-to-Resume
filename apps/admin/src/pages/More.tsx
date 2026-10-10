import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Me } from '../App';
import { del, get, post } from '../api';
import { askReason, Badge, Button, Card, dt, ErrorBox, Field, inputCls, Table } from '../components/ui';

export function MorePage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const admins = useQuery({ queryKey: ['admins'], queryFn: () => get<{ data: Array<{ user_id: string; email: string; role: string; revoked_at: string | null; last_sign_in: string | null }> }>('/admins'), enabled: me.permissions.includes('admins.manage') });
  const privacy = useQuery({ queryKey: ['privacy'], queryFn: () => get<{ data: Array<{ id: string; requested_at: string; completed_at: string | null; requested_by: string; steps: Record<string, string> }> }>('/privacy/requests'), enabled: me.permissions.includes('privacy.view') });
  const feedback = useQuery({ queryKey: ['feedback'], queryFn: () => get<{ data: Array<{ id: string; target: string; rating: number | null; reason_code: string | null; comment: string | null; created_at: string }> }>('/feedback'), enabled: me.permissions.includes('feedback.view') });
  const system = useQuery({ queryKey: ['system'], queryFn: () => get<{ rollup_lag_minutes: number | null; failed_webhooks: unknown[]; config_snapshot: string }>('/system/health'), enabled: me.permissions.includes('system.view') });
  const evals = useQuery({ queryKey: ['evals'], queryFn: () => get<{ data: Array<{ id: string; suite: string; models: string[]; passed: boolean; created_at: string; metrics: Record<string, unknown> }> }>('/evals') });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('support');
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      {me.permissions.includes('admins.manage') && (
        <Card title="Admins and roles (Owner only)">
          <Table rows={admins.data?.data ?? []} cols={[{ h: 'Email', r: (a) => a.email }, { h: 'Role', r: (a) => <Badge tone="indigo">{a.role}</Badge> }, { h: 'Last sign-in', r: (a) => dt(a.last_sign_in) }, { h: '', r: (a) => (a.revoked_at ? <Badge tone="red">revoked</Badge> : a.role !== 'owner' && <Button small kind="danger" onClick={async () => { const reason = await askReason(`Revoke ${a.email}`); if (!reason) return; try { await del(`/admins/${a.user_id}`, { reason }); await qc.invalidateQueries({ queryKey: ['admins'] }); } catch (e) { setError(e); } }}>Revoke</Button>) }]} />
          <div className="mt-3 flex items-end gap-2">
            <Field label="Email"><input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Role"><select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>{['admin', 'support', 'finance', 'analyst'].map((r) => <option key={r}>{r}</option>)}</select></Field>
            <div className="pb-3"><Button disabled={!email} onClick={async () => { const reason = await askReason('Grant admin access'); if (!reason) return; try { await post('/admins', { email, role, reason }); setEmail(''); await qc.invalidateQueries({ queryKey: ['admins'] }); } catch (e) { setError(e); } }}>Invite</Button></div>
          </div>
        </Card>
      )}
      <Card title="Eval runs (synthetic smoke suite; CI records the full golden set here too)">
        <Table rows={evals.data?.data ?? []} cols={[{ h: 'When', r: (e) => dt(e.created_at) }, { h: 'Suite', r: (e) => e.suite }, { h: 'Models', r: (e) => <span className="text-xs">{e.models.join(', ')}</span> }, { h: 'Result', r: (e) => <Badge tone={e.passed ? 'green' : 'red'}>{e.passed ? 'passed' : 'failed'}</Badge> }, { h: 'Cost', r: (e) => `$${Number(e.metrics.cost_usd ?? 0).toFixed(5)}`, right: true }]} />
      </Card>
      {me.permissions.includes('privacy.view') && (
        <Card title="Privacy requests (deletion queue)">
          <Table rows={privacy.data?.data ?? []} cols={[{ h: 'Requested', r: (p) => dt(p.requested_at) }, { h: 'By', r: (p) => p.requested_by }, { h: 'Completed', r: (p) => dt(p.completed_at) }, { h: 'Steps', r: (p) => <span className="text-xs">{JSON.stringify(p.steps)}</span> }]} />
        </Card>
      )}
      {me.permissions.includes('feedback.view') && (
        <Card title="User feedback">
          <Table rows={feedback.data?.data ?? []} cols={[{ h: 'When', r: (f) => dt(f.created_at) }, { h: 'On', r: (f) => f.target }, { h: 'Rating', r: (f) => f.rating ?? '—' }, { h: 'Reason', r: (f) => f.reason_code ?? '—' }, { h: 'Comment', r: (f) => <span className="text-xs">{f.comment}</span> }]} />
        </Card>
      )}
      {me.permissions.includes('system.view') && system.data && (
        <Card title="System health">
          <p className="text-sm">Rollup lag: {system.data.rollup_lag_minutes ?? '—'} min · failed webhooks: {system.data.failed_webhooks.length} · config snapshot <code className="text-xs">{system.data.config_snapshot}</code></p>
        </Card>
      )}
    </div>
  );
}
