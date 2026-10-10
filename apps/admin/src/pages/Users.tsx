import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Me } from '../App';
import { get, post } from '../api';
import { askReason, Badge, Button, Card, dt, ErrorBox, Field, inputCls, Modal, Table, usd } from '../components/ui';

interface UserRow {
  id: string;
  email_masked: string;
  status: string;
  plan: string;
  created_at: string;
}

export function UsersPage({ me }: { me: Me }) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['users', submitted], queryFn: () => get<{ data: UserRow[] }>(`/users?query=${encodeURIComponent(submitted)}`) });
  return (
    <div className="space-y-4">
      <Card>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSubmitted(query); }}>
          <input className={inputCls} placeholder="Search by email, user ID or Stripe customer ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit">Search</Button>
        </form>
      </Card>
      <Card title="Users (emails masked)">
        <ErrorBox error={q.error} />
        <Table rows={q.data?.data ?? []} onRow={(u) => setOpen(u.id)} cols={[{ h: 'User', r: (u) => u.email_masked }, { h: 'Plan', r: (u) => u.plan }, { h: 'Status', r: (u) => <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge> }, { h: 'Joined', r: (u) => dt(u.created_at) }]} />
      </Card>
      {open && <UserDetail id={open} me={me} onClose={() => setOpen(null)} />}
    </div>
  );
}

interface Detail {
  id: string;
  email_masked: string;
  status: string;
  created_at: string;
  plan: { plan: string; source: string; grant: { plan: string; ends_at: string } | null };
  usage: { optimizations: { used: number; limit: number; daily_used: number; daily_limit: number; credits_remaining: number }; analyses: { used: number; limit: number }; ai_budget: { used_usd: number; limit_usd: number } };
  grants: Array<{ id: string; plan_id: string; ends_at: string; source: string; reason: string; revoked_at: string | null }>;
  saved_content: { opted_in: boolean; since: string | null; items: number };
}

function UserDetail({ id, me, onClose }: { id: string; me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['user', id], queryFn: () => get<Detail>(`/users/${id}`) });
  const tl = useQuery({ queryKey: ['timeline', id], queryFn: () => get<{ data: Array<{ at: string; kind: string; title: string; detail: Record<string, unknown> }> }>(`/users/${id}/timeline`) });
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const act = async (label: string, fn: (reason: string) => Promise<unknown>) => {
    const reason = await askReason(label);
    if (!reason) return;
    try {
      setError(null);
      await fn(reason);
      await qc.invalidateQueries({ queryKey: ['user', id] });
      await qc.invalidateQueries({ queryKey: ['timeline', id] });
    } catch (e) {
      setError(e);
    }
  };
  const u = d.data;
  return (
    <Modal open title="User" onClose={onClose}>
      <ErrorBox error={error ?? d.error} />
      {u && (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto text-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">{email ?? u.email_masked} {!email && <button className="text-xs text-indigo-700" onClick={async () => { try { setEmail((await post<{ email: string }>(`/users/${id}/reveal-email`)).email); } catch (e) { setError(e); } }}>reveal (audited)</button>}</div>
              <div className="text-xs text-slate-500">{u.plan.plan} ({u.plan.source}) · {u.status} · joined {dt(u.created_at)}</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>Optimizations {u.usage.optimizations.used}/{u.usage.optimizations.limit} · today {u.usage.optimizations.daily_used}/{u.usage.optimizations.daily_limit} · credits {u.usage.optimizations.credits_remaining}</div>
            <div>Analyses {u.usage.analyses.used}/{u.usage.analyses.limit}</div>
            <div>AI {usd(u.usage.ai_budget.used_usd, 3)} / {usd(u.usage.ai_budget.limit_usd)}</div>
          </div>
          <div className="text-xs text-slate-600">
            Saved content: {u.saved_content.opted_in ? <>opted in since {dt(u.saved_content.since)} · {u.saved_content.items} item(s){me.permissions.includes('content.view') && <> · <a className="text-indigo-700" href="#/content">open</a></>}</> : 'not opted in'}
          </div>
          {me.permissions.includes('users.grant') && (
            <div className="flex flex-wrap gap-1">
              <Button small onClick={() => setGrantOpen(true)}>Complimentary access</Button>
              <Button small kind="secondary" onClick={() => act('Grant 5 credits', (reason) => post(`/users/${id}/credits`, { optimizations: 5, reason }))}>+5 credits</Button>
              <Button small kind="secondary" onClick={() => act('Reset this month’s optimizations', (reason) => post(`/users/${id}/quota/reset`, { kind: 'optimizations', reason }))}>Reset quota</Button>
              {me.permissions.includes('users.suspend') && (u.status === 'active' ? <Button small kind="danger" onClick={() => act('Suspend user', (reason) => post(`/users/${id}/suspend`, { reason }))}>Suspend</Button> : <Button small kind="secondary" onClick={() => act('Unsuspend user', (reason) => post(`/users/${id}/unsuspend`, { reason }))}>Unsuspend</Button>)}
              {me.permissions.includes('users.delete') && <Button small kind="danger" onClick={() => act('Delete this account (user request)', (reason) => post(`/users/${id}/deletion`, { reason }))}>Delete account</Button>}
            </div>
          )}
          <h4 className="text-xs font-semibold uppercase text-slate-500">Timeline (metadata only — no resume or job text)</h4>
          <ul className="space-y-1">
            {(tl.data?.data ?? []).map((t, i) => (
              <li key={i} className="border-l-2 border-slate-200 pl-2">
                <span className="text-xs text-slate-500">{dt(t.at)}</span> <Badge>{t.kind}</Badge> {t.title}
                {Object.keys(t.detail).length > 0 && <div className="truncate text-xs text-slate-500">{JSON.stringify(t.detail)}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <GrantModal open={grantOpen} onClose={() => setGrantOpen(false)} onSubmit={(b) => act('Grant complimentary access', (reason) => post(`/users/${id}/grants`, { ...b, reason })).then(() => setGrantOpen(false))} />
    </Modal>
  );
}

function GrantModal({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (b: { plan_id: string; days: number; source: string }) => void }) {
  const [plan, setPlan] = useState('pro_monthly');
  const [days, setDays] = useState(30);
  const [source, setSource] = useState('comp');
  return (
    <Modal open={open} title="Complimentary access (instead of 100% coupons)" onClose={onClose}>
      <Field label="Plan"><select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value)}><option value="pro_monthly">Pro</option><option value="byok_annual">BYOK</option></select></Field>
      <Field label="Days (≤ 90; Support ≤ 14)"><input type="number" className={inputCls} value={days} min={1} max={90} onChange={(e) => setDays(Number(e.target.value))} /></Field>
      <Field label="Source"><select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>{['comp', 'beta', 'support', 'partner'].map((s) => <option key={s}>{s}</option>)}</select></Field>
      <div className="flex justify-end"><Button onClick={() => onSubmit({ plan_id: plan, days, source })}>Grant</Button></div>
    </Modal>
  );
}
