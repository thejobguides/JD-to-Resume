import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Me } from '../App';
import { downloadCsv, get, post } from '../api';
import { askReason, Badge, Button, Card, dt, ErrorBox, Field, inputCls, Modal, Table, usd } from '../components/ui';

// Coupons (admin-panel.md §7): % off per plan, duration, total/per-user limits, dates, budget, bulk codes.

interface CouponRow {
  id: string;
  name: string;
  campaign: string | null;
  status: string;
  code: string | null;
  codes: number;
  rules: Array<{ plan_id: string; percent_off: string; duration: string; duration_periods: number | null }> | null;
  max_redemptions: number | null;
  redeemed: number;
  discount_minor: number;
  valid_until: string;
}

const PLANS = [
  { id: 'pro_monthly', label: 'Pro monthly', price: 19, period: 'month', months: 1 },
  { id: 'pro_quarterly', label: 'Pro quarterly', price: 45, period: 'quarter', months: 3 },
  { id: 'byok_annual', label: 'BYOK annual', price: 39, period: 'year', months: 12 },
  { id: 'credit_pack', label: 'Credit pack', price: 12, period: 'purchase', months: 1 },
];
// cost-analysis.md §11: typical paid-user AI cost $1.52/month. Stripe (US cards, 2026): 2.9% + $0.30 per charge, plus 0.7% Billing on subscriptions; no sales tax handling.
const TYPICAL_AI_PER_MONTH = 1.52;

export function CouponsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['coupons'], queryFn: () => get<{ data: CouponRow[] }>('/coupons') });
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="space-y-4">
      <ErrorBox error={error ?? q.error} />
      <Card title="Coupons" actions={me.permissions.includes('coupons.edit') && <Button onClick={() => setCreating(true)}>New coupon</Button>}>
        <Table
          rows={q.data?.data ?? []}
          onRow={(c) => setDetail(c.id)}
          cols={[
            { h: 'Code', r: (c) => <code>{c.code ?? `${c.codes} codes`}</code> },
            { h: 'Name', r: (c) => <div>{c.name}<div className="text-xs text-slate-500">{c.campaign}</div></div> },
            { h: 'Per plan', r: (c) => (c.rules ?? []).map((r) => `${r.plan_id} ${Number(r.percent_off)}% ${r.duration === 'repeating' ? `×${r.duration_periods}` : r.duration === 'forever' ? '∞' : '×1'}`).join(' · ') },
            { h: 'Used', r: (c) => `${c.redeemed}${c.max_redemptions ? ` / ${c.max_redemptions}` : ''}`, right: true },
            { h: 'Discount given', r: (c) => usd(c.discount_minor / 100), right: true },
            { h: 'Until', r: (c) => dt(c.valid_until) },
            { h: 'Status', r: (c) => <Badge tone={c.status === 'active' ? 'green' : c.status === 'paused' ? 'amber' : 'slate'}>{c.status}</Badge> },
          ]}
        />
      </Card>
      {creating && <CreateCoupon me={me} onClose={() => setCreating(false)} onCreated={async () => { setCreating(false); await qc.invalidateQueries({ queryKey: ['coupons'] }); }} />}
      {detail && <CouponDetail id={detail} me={me} onClose={() => setDetail(null)} onError={setError} />}
    </div>
  );
}

function CreateCoupon({ me, onClose, onCreated }: { me: Me; onClose: () => void; onCreated: () => void }) {
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [code, setCode] = useState('');
  const [count, setCount] = useState(100);
  const [prefix, setPrefix] = useState('INF-');
  const [name, setName] = useState('');
  const [campaign, setCampaign] = useState('');
  const [rules, setRules] = useState<Record<string, { on: boolean; pct: number; duration: string; periods: number }>>({
    pro_monthly: { on: true, pct: 20, duration: 'first_period', periods: 2 },
    pro_quarterly: { on: true, pct: 30, duration: 'repeating', periods: 2 },
    byok_annual: { on: false, pct: 10, duration: 'first_period', periods: 2 },
    credit_pack: { on: false, pct: 10, duration: 'first_period', periods: 2 },
  });
  const [total, setTotal] = useState('200');
  const [perUser, setPerUser] = useState(1);
  const [newOnly, setNewOnly] = useState(true);
  const [budget, setBudget] = useState('500');
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 16));
  const [until, setUntil] = useState(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16));
  const [error, setError] = useState<unknown>(null);

  const preview = useMemo(
    () =>
      PLANS.filter((p) => rules[p.id]?.on).map((p) => {
        const r = rules[p.id]!;
        const paid = p.price * (1 - r.pct / 100);
        const fee = paid > 0 ? paid * (p.id === 'credit_pack' ? 0.029 : 0.036) + 0.3 : 0;
        const contribution = paid - fee - TYPICAL_AI_PER_MONTH * p.months;
        const periods = r.duration === 'first_period' ? `first ${p.period}` : r.duration === 'forever' ? 'every period' : `first ${r.periods} ${p.period}s`;
        return { p, text: `$${p.price.toFixed(2)} → $${paid.toFixed(2)} for the ${periods}`, fee, contribution };
      }),
    [rules],
  );

  const submit = async () => {
    const reason = await askReason('Create coupon');
    if (!reason) return;
    try {
      setError(null);
      await post('/coupons', {
        name,
        campaign: campaign || null,
        codes: mode === 'single' ? { mode, ...(code ? { code } : {}) } : { mode, count, prefix },
        rules: Object.entries(rules).filter(([, r]) => r.on).map(([plan_id, r]) => ({ plan_id, percent_off: r.pct, duration: r.duration, duration_periods: r.duration === 'repeating' ? r.periods : null })),
        max_redemptions: mode === 'bulk' ? null : total ? Number(total) : null,
        max_per_user: perUser,
        new_customers_only: newOnly,
        max_discount_total_usd: budget ? Number(budget) : null,
        valid_from: new Date(from).toISOString(),
        valid_until: new Date(until).toISOString(),
        reason,
      });
      onCreated();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Modal open title="New coupon" onClose={onClose}>
      <div className="max-h-[75vh] overflow-y-auto pr-1">
        <ErrorBox error={error} />
        <div className="mb-3 flex gap-3 text-sm">
          <label><input type="radio" checked={mode === 'single'} onChange={() => setMode('single')} /> One code</label>
          <label><input type="radio" checked={mode === 'bulk'} onChange={() => setMode('bulk')} /> Bulk single-use codes</label>
        </div>
        {mode === 'single' ? (
          <Field label="Code" hint="Leave empty to generate one (no 0/O/1/I/L)."><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="LAUNCH30" /></Field>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="How many codes"><input type="number" className={inputCls} value={count} onChange={(e) => setCount(Number(e.target.value))} /></Field>
            <Field label="Prefix"><input className={inputCls} value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} /></Field>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Name (internal)"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch week — Reddit post" /></Field>
          <Field label="Campaign"><input className={inputCls} value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="launch-2026-10" /></Field>
        </div>
        <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Discount per plan</h4>
        {PLANS.map((p) => {
          const r = rules[p.id]!;
          const set = (patch: Partial<typeof r>) => setRules({ ...rules, [p.id]: { ...r, ...patch } });
          return (
            <div key={p.id} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <label className="w-40"><input type="checkbox" checked={r.on} onChange={(e) => set({ on: e.target.checked })} /> {p.label} (${p.price})</label>
              <input type="number" aria-label={`${p.label} percent off`} className={`${inputCls} w-20`} value={r.pct} min={1} max={100} disabled={!r.on} onChange={(e) => set({ pct: Number(e.target.value) })} />% off for
              <select aria-label={`${p.label} discount duration`} className={`${inputCls} w-44`} value={r.duration} disabled={!r.on || p.id === 'credit_pack'} onChange={(e) => set({ duration: e.target.value })}>
                <option value="first_period">first payment only</option>
                <option value="repeating">N billing periods</option>
                {me.role === 'owner' && <option value="forever">forever (Owner)</option>}
              </select>
              {r.duration === 'repeating' && <input type="number" aria-label={`${p.label} number of billing periods`} className={`${inputCls} w-16`} value={r.periods} min={2} max={24} onChange={(e) => set({ periods: Number(e.target.value) })} />}
            </div>
          );
        })}
        <div className="grid grid-cols-3 gap-2">
          {mode === 'single' && <Field label="Total uses" hint="1 = single-use code; empty = unlimited"><input className={inputCls} value={total} onChange={(e) => setTotal(e.target.value.replace(/\D/g, ''))} /></Field>}
          <Field label="Per user"><input type="number" className={inputCls} value={perUser} min={1} max={5} onChange={(e) => setPerUser(Number(e.target.value))} /></Field>
          <Field label="Stop after $ discount"><input className={inputCls} value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        </div>
        <label className="mb-3 block text-sm"><input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} /> New customers only</label>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Valid from"><input type="datetime-local" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Valid until"><input type="datetime-local" className={inputCls} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
        </div>
        <Card title="Preview (per billing period, typical AI use)">
          {preview.map((x) => (
            <div key={x.p.id} className="text-sm">
              <b>{x.p.label}:</b> {x.text}. Stripe fee ≈ ${x.fee.toFixed(2)} · contribution ≈ <span className={x.contribution < 0 ? 'text-rose-600' : 'text-emerald-700'}>${x.contribution.toFixed(2)}</span>
            </div>
          ))}
        </Card>
        <div className="mt-3 flex justify-end gap-2">
          <Button kind="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!name || !preview.length} onClick={submit}>Create coupon</Button>
        </div>
      </div>
    </Modal>
  );
}

function CouponDetail({ id, me, onClose, onError }: { id: string; me: Me; onClose: () => void; onError: (e: unknown) => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['coupon', id], queryFn: () => get<Record<string, unknown> & { name: string; status: string; editable_terms: boolean; rules: Array<Record<string, unknown>>; code_count: number; codes: Array<{ code: string; status: string }> }>(`/coupons/${id}`) });
  const stats = useQuery({ queryKey: ['coupon-stats', id], queryFn: () => get<Record<string, number>>(`/coupons/${id}/stats`) });
  const red = useQuery({ queryKey: ['coupon-red', id], queryFn: () => get<{ data: Array<{ status: string; plan_id: string; discount_amount_minor: number; created_at: string; code: string }> }>(`/coupons/${id}/redemptions`) });
  const act = async (verb: string) => {
    const reason = await askReason(`${verb} coupon`);
    if (!reason) return;
    try {
      await post(`/coupons/${id}/${verb}`, { reason });
      await qc.invalidateQueries();
    } catch (e) {
      onError(e);
    }
  };
  const c = d.data;
  return (
    <Modal open title={c ? `Coupon: ${c.name}` : 'Coupon'} onClose={onClose}>
      {c && (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto text-sm">
          <div>Status <Badge>{c.status}</Badge> · {c.code_count} code(s) · terms {c.editable_terms ? 'editable (not redeemed yet)' : 'frozen (redeemed)'}</div>
          <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(c.rules, null, 2)}</pre>
          {stats.data && (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>Redeemed {stats.data.redemptions} · reserved {stats.data.reserved} · refunded {stats.data.refunded}</div>
              <div>Discount {usd((stats.data.discount_minor ?? 0) / 100)} · net {usd((stats.data.net_minor ?? 0) / 100)}</div>
              <div>Full-price renewals {stats.data.full_price_renewals}/{stats.data.subscriptions} · AI cost {usd(stats.data.ai_cost_usd, 3)}</div>
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {c.status === 'active' && me.permissions.includes('coupons.pause') && <Button small kind="secondary" onClick={() => act('pause')}>Pause</Button>}
            {c.status === 'paused' && me.permissions.includes('coupons.edit') && <Button small onClick={() => act('resume')}>Resume</Button>}
            {c.status !== 'archived' && me.permissions.includes('coupons.edit') && <Button small kind="danger" onClick={() => act('archive')}>Archive</Button>}
            {me.permissions.includes('coupons.edit') && c.code_count > 1 && <Button small kind="ghost" onClick={() => downloadCsv(`/coupons/${id}/codes/export`, 'codes.csv').catch(onError)}>Export codes (audited)</Button>}
          </div>
          <Table rows={red.data?.data ?? []} empty="No redemptions yet." cols={[{ h: 'When', r: (r) => dt(r.created_at) }, { h: 'Code', r: (r) => <code>{r.code}</code> }, { h: 'Plan', r: (r) => r.plan_id }, { h: 'Discount', r: (r) => usd((r.discount_amount_minor ?? 0) / 100), right: true }, { h: 'Status', r: (r) => r.status }]} />
        </div>
      )}
    </Modal>
  );
}
