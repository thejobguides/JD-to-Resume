import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { Badge, Card, ErrorBox, pct, Stat, usd } from '../components/ui';

interface Overview {
  users: { total: number; new_7d: number; mau: number };
  paid: Record<string, number>;
  mrr_usd: number;
  ai: { today_usd: number; mtd_usd: number; daily_ceiling_usd: number; calls_24h: number; error_rate_24h: number };
  optimizations_7d: { count: number; avg_cost_usd: number; revert_rate: number };
  active_coupons: number;
  open_insights: number;
  kill_switches: Record<string, unknown>;
}

export function OverviewPage() {
  const q = useQuery({ queryKey: ['overview'], queryFn: () => get<Overview>('/overview'), refetchInterval: 60_000 });
  if (q.error) return <ErrorBox error={q.error} />;
  const o = q.data;
  if (!o) return <p className="text-sm text-slate-500">Loading…</p>;
  const killed = Object.entries(o.kill_switches).filter(([, v]) => v === true).map(([k]) => k);
  return (
    <div className="space-y-4">
      {killed.length > 0 && <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">Kill switches ON: {killed.join(', ')}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Users" value={o.users.total.toLocaleString()} sub={`+${o.users.new_7d} in 7 days · MAU ${o.users.mau}`} />
        <Stat label="MRR (est.)" value={usd(o.mrr_usd)} sub={Object.entries(o.paid).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no paid users yet'} />
        <Stat label="AI spend today" value={usd(o.ai.today_usd, 3)} sub={`ceiling ${usd(o.ai.daily_ceiling_usd, 0)} · MTD ${usd(o.ai.mtd_usd)}`} />
        <Stat label="AI calls (24 h)" value={o.ai.calls_24h.toLocaleString()} sub={`error rate ${pct(o.ai.error_rate_24h)}`} />
        <Stat label="Optimizations (7 d)" value={o.optimizations_7d.count} sub={`avg ${usd(o.optimizations_7d.avg_cost_usd, 4)} each`} />
        <Stat label="Kept original (7 d)" value={pct(o.optimizations_7d.revert_rate)} sub="changes reverted by the truthfulness gates" />
        <Stat label="Active coupons" value={o.active_coupons} />
        <Stat label="Open insights" value={o.open_insights} sub={<a className="text-indigo-700" href="#/usage">See what to optimize →</a>} />
      </div>
      <Card title="Privacy by design">
        <p className="text-sm text-slate-600">
          The server never stores resume or job text, prompts or completions. Everything in this panel is metadata. <Badge tone="green">content-free</Badge>
        </p>
      </Card>
    </div>
  );
}
