import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { downloadCsv, get } from '../api';
import { Badge, Button, Card, dt, ErrorBox, inputCls, Table } from '../components/ui';

interface Row {
  id: number;
  occurred_at: string;
  actor_type: string;
  actor_role: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
}

export function AuditPage() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [f, setF] = useState({ action: '', actor: '' });
  const q = useQuery({ queryKey: ['audit', f], queryFn: () => get<{ data: Row[] }>(`/audit?limit=200${f.action ? `&action=${encodeURIComponent(f.action)}` : ''}${f.actor ? `&actor=${encodeURIComponent(f.actor)}` : ''}`) });
  const verify = useQuery({ queryKey: ['audit-verify'], queryFn: () => get<{ ok: boolean; checked: number; broken_at?: number }>('/audit/verify') });
  const [open, setOpen] = useState<Row | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="space-y-4">
      <ErrorBox error={error ?? q.error} />
      <Card title="Integrity">
        {verify.data && (verify.data.ok ? <p className="text-sm"><Badge tone="green">hash chain intact</Badge> {verify.data.checked} rows verified</p> : <p className="text-sm text-rose-700"><Badge tone="red">chain broken</Badge> at row {verify.data.broken_at}</p>)}
      </Card>
      <Card title="Audit log (append-only)" actions={<Button small kind="secondary" onClick={() => downloadCsv('/audit/export', 'audit.csv').catch(setError)}>Export CSV (audited)</Button>}>
        <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); setF({ action, actor }); }}>
          <input className={inputCls} placeholder="Action prefix, e.g. coupon. or config." value={action} onChange={(e) => setAction(e.target.value)} />
          <input className={inputCls} placeholder="Actor email contains" value={actor} onChange={(e) => setActor(e.target.value)} />
          <Button type="submit">Filter</Button>
        </form>
        <Table rows={q.data?.data ?? []} onRow={setOpen} cols={[{ h: '#', r: (r) => r.id }, { h: 'When', r: (r) => dt(r.occurred_at) }, { h: 'Actor', r: (r) => `${r.actor_email ?? r.actor_type}${r.actor_role ? ` (${r.actor_role})` : ''}` }, { h: 'Action', r: (r) => <code className="text-xs">{r.action}</code> }, { h: 'Target', r: (r) => <span className="text-xs">{r.target_type} {r.target_id?.slice(0, 18)}</span> }, { h: 'Reason', r: (r) => <span className="text-xs">{r.reason}</span> }]} />
      </Card>
      {open && (
        <Card title={`Entry #${open.id}`} actions={<Button small kind="ghost" onClick={() => setOpen(null)}>Close</Button>}>
          <div className="grid gap-2 md:grid-cols-2">
            <pre className="overflow-auto rounded bg-slate-50 p-2 text-xs">before: {JSON.stringify(open.before, null, 2)}</pre>
            <pre className="overflow-auto rounded bg-slate-50 p-2 text-xs">after: {JSON.stringify(open.after, null, 2)}</pre>
          </div>
        </Card>
      )}
    </div>
  );
}
