import { useQuery } from '@tanstack/react-query';
import { Activity, CircleDollarSign, Lightbulb, ShieldCheck, Sparkles, TicketPercent, TriangleAlert, Undo2, Users, Wallet } from 'lucide-react';
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
  if (!o)
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
        <p role="status" className="sr-only">Loading…</p>
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-32 animate-pulse rounded-xl border border-slate-200 bg-white" />)}
      </div>
    );
  const killed = Object.entries(o.kill_switches).filter(([, v]) => v === true).map(([k]) => k);
  return (
    <div className="space-y-4">
      {killed.length > 0 && <div role="alert" className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800"><TriangleAlert className="size-4 shrink-0" aria-hidden />Kill switches ON: {killed.join(', ')}</div>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<Users />} label="Users" value={o.users.total.toLocaleString()} sub={`+${o.users.new_7d} in 7 days · MAU ${o.users.mau}`} />
        <Stat icon={<CircleDollarSign />} label="MRR (est.)" value={usd(o.mrr_usd)} sub={Object.entries(o.paid).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'no paid users yet'} />
        <Stat icon={<Wallet />} label="AI spend today" value={usd(o.ai.today_usd, 3)} sub={`ceiling ${usd(o.ai.daily_ceiling_usd, 0)} · MTD ${usd(o.ai.mtd_usd)}`} />
        <Stat icon={<Activity />} label="AI calls (24 h)" value={o.ai.calls_24h.toLocaleString()} sub={`error rate ${pct(o.ai.error_rate_24h)}`} />
        <Stat icon={<Sparkles />} label="Optimizations (7 d)" value={o.optimizations_7d.count} sub={`avg ${usd(o.optimizations_7d.avg_cost_usd, 4)} each`} />
        <Stat icon={<Undo2 />} label="Kept original (7 d)" value={pct(o.optimizations_7d.revert_rate)} sub="changes reverted by the truthfulness gates" />
        <Stat icon={<TicketPercent />} label="Active coupons" value={o.active_coupons} />
        <Stat icon={<Lightbulb />} label="Open insights" value={o.open_insights} sub={<a className="font-medium text-indigo-700 hover:underline" href="#/usage">See what to optimize →</a>} />
      </div>
      <Card>
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"><ShieldCheck className="size-5" aria-hidden /></span>
          <div>
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-slate-900">Privacy by design <Badge tone="green">content-free</Badge></h2>
            <p className="mt-1 text-sm text-slate-600">The server never stores resume or job text, prompts or completions. Everything in this panel is metadata.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
