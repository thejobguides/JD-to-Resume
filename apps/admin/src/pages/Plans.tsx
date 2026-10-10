import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Me } from '../App';
import { get, post } from '../api';
import { askReason, Button, Card, dt, ErrorBox, Field, inputCls, Modal, Table } from '../components/ui';

interface Plan {
  id: string;
  name: string;
  kind: string;
  limits?: { monthly_optimizations: number; daily_optimizations: number; monthly_analyses: number; monthly_ai_budget_usd: number };
  display?: { name: string; badge: string | null; visible: boolean };
  prices: Array<{ id: string; provider_price_id: string; currency: string; unit_amount_minor: number; status: string; created_at: string }>;
}

export function PlansPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['plans'], queryFn: () => get<{ plans: Plan[] }>('/plans') });
  const [pricing, setPricing] = useState<Plan | null>(null);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="space-y-4">
      <ErrorBox error={error ?? q.error} />
      <Card title="Plans">
        <p className="mb-2 text-xs text-slate-500">Limits and features are versioned runtime config (edit them under Runtime config → plans). A new price creates a new Stripe price; existing subscribers keep their current price.</p>
        <Table
          rows={q.data?.plans ?? []}
          cols={[
            { h: 'Plan', r: (p) => <div>{p.display?.name ?? p.name}<div className="text-xs text-slate-500">{p.id}</div></div> },
            { h: 'Optimizations / month', r: (p) => p.limits?.monthly_optimizations ?? '—', right: true },
            { h: '/ day', r: (p) => p.limits?.daily_optimizations ?? '—', right: true },
            { h: 'Analyses', r: (p) => p.limits?.monthly_analyses ?? '—', right: true },
            { h: 'AI budget', r: (p) => (p.limits ? `$${p.limits.monthly_ai_budget_usd}` : '—'), right: true },
            { h: 'Active price', r: (p) => { const a = p.prices.find((x) => x.status === 'active'); return a ? `${a.currency} ${(a.unit_amount_minor / 100).toFixed(2)}` : '—'; } },
            { h: '', r: (p) => p.id !== 'free' && me.permissions.includes('plans.prices') && <Button small kind="secondary" onClick={() => setPricing(p)}>New price</Button> },
          ]}
        />
      </Card>
      <Card title="Price history">
        <Table rows={(q.data?.plans ?? []).flatMap((p) => p.prices.map((x) => ({ ...x, plan: p.id })))} cols={[{ h: 'Plan', r: (x) => x.plan }, { h: 'Stripe price', r: (x) => <code className="text-xs">{x.provider_price_id}</code> }, { h: 'Amount', r: (x) => `${x.currency} ${(x.unit_amount_minor / 100).toFixed(2)}` }, { h: 'Status', r: (x) => x.status }, { h: 'Created', r: (x) => dt(x.created_at) }]} />
      </Card>
      <Modal open={!!pricing} title={`New price for ${pricing?.id}`} onClose={() => setPricing(null)}>
        <Field label="Amount (USD)" hint="Only new purchases use it. Moving existing subscribers is a separate, announced action (counsel: notice rules).">
          <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="19.00" />
        </Field>
        <div className="flex justify-end">
          <Button disabled={!amount} onClick={async () => { const reason = await askReason('Create new price'); if (!reason) return; try { await post(`/plans/${pricing!.id}/prices`, { currency: 'USD', unit_amount_minor: Math.round(Number(amount) * 100), reason }); setPricing(null); await qc.invalidateQueries({ queryKey: ['plans'] }); } catch (e) { setError(e); } }}>Create price</Button>
        </div>
      </Modal>
    </div>
  );
}
