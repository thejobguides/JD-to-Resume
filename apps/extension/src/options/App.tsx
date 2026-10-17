import type { PlanId } from '@jmo/shared';
import { uuidv7 } from '@jmo/shared';
import { cx, LogoMark } from '@jmo/ui';
import { CreditCard, History, KeyRound, type LucideIcon, ShieldCheck, UserRound } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { GOOGLE_ENABLED } from '../lib/api';
import { BYOK_HOSTS, type ByokProvider, type ByokSettings, byokModels, testByok } from '../lib/engine';
import { exportResume, saveBlob } from '../lib/files';
import * as store from '../lib/store';
import type { HistoryItem } from '../sidepanel/state';
import { GoogleButton } from '../ui/GoogleButton';
import { type Account, useAccount } from '../ui/useAccount';
import { Badge, Button, Card, ErrorText, Field, inputCls, Note, Spinner } from '../ui/ui';

type Tab = 'account' | 'plans' | 'byok' | 'history' | 'privacy';
const PLAN_NAMES: Record<string, string> = { free: 'Free', pro_monthly: 'Pro (monthly)', pro_quarterly: 'Pro (quarterly)', byok_annual: 'Own key (annual)', credit_pack: 'Credit pack' };
const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'plans', label: 'Plans', icon: CreditCard },
  { id: 'byok', label: 'Your own AI key', icon: KeyRound },
  { id: 'history', label: 'History', icon: History },
  { id: 'privacy', label: 'Privacy & data', icon: ShieldCheck },
];

export function App() {
  const account = useAccount();
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => `#${t.id}` === location.hash)?.id ?? (location.hash === '#upgrade' ? 'plans' : 'account'));
  useEffect(() => {
    history.replaceState(null, '', `#${tab}`);
  }, [tab]);
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4 sm:px-6">
          <LogoMark className="size-9 shrink-0" />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight text-slate-900">Job Match Optimizer</h1>
            <p className="text-xs text-slate-500">Settings · version {__EXT_VERSION__}</p>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-8 md:py-8">
        {/* Phones: a row of pills that scrolls sideways; wider screens: a vertical menu. */}
        <nav aria-label="Settings sections" className="-mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 pb-1 md:sticky md:top-6 md:mx-0 md:mb-0 md:flex-col md:self-start md:overflow-visible md:px-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
              className={cx('flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-indigo-600', tab === t.id ? 'bg-white text-indigo-700 shadow-card ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white hover:text-slate-900')}
            >
              <t.icon aria-hidden className={cx('size-4 shrink-0', tab === t.id ? 'text-indigo-600' : 'text-slate-500')} />
              {t.label}
            </button>
          ))}
        </nav>
        <main className="min-w-0 space-y-4">
          {account.loading ? (
            <Spinner label="Loading…" />
          ) : (
            <>
              {tab === 'account' && <AccountTab account={account} />}
              {tab === 'plans' && <PlansTab account={account} />}
              {tab === 'byok' && <ByokTab account={account} />}
              {tab === 'history' && <HistoryTab />}
              {tab === 'privacy' && <PrivacyTab account={account} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Account ──

function AccountTab({ account }: { account: Account }) {
  if (!account.signedIn) return <SignIn />;
  const u = account.usage;
  return (
    <div className="space-y-3">
      <Card title="Signed in" actions={<Button small kind="secondary" onClick={() => void api.signOut()}>Sign out</Button>}>
        <p className="text-sm">{account.email}</p>
        {account.me && (
          <p className="mt-1 text-sm">
            Plan: <Badge tone="indigo">{PLAN_NAMES[account.me.plan] ?? account.me.plan}</Badge>
            {account.me.subscription?.cancel_at_period_end && account.me.subscription.current_period_end && (
              <span className="ml-2 text-xs text-amber-700">ends {new Date(account.me.subscription.current_period_end).toLocaleDateString()}</span>
            )}
          </p>
        )}
        {account.offline && <Note tone="amber">Can’t reach our servers right now.</Note>}
      </Card>
      {u && (
        <Card title="This period">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Tailoring runs" value={`${u.optimizations.used} / ${u.optimizations.limit}`} />
            <Stat label="Today" value={`${u.optimizations.daily_used} / ${u.optimizations.daily_limit}`} />
            <Stat label="Job analyses" value={`${u.analyses.used} / ${u.analyses.limit}`} />
            <Stat label="Credits" value={String(u.optimizations.credits_remaining)} />
          </dl>
          <p className="mt-2 text-xs text-slate-500">Resets {new Date(u.period.end).toLocaleDateString()}.</p>
        </Card>
      )}
      <Card title="Billing and account">
        <p className="mb-2 text-xs text-slate-600">Invoices, payment method, cancellation, data download and account deletion are on our website.</p>
        <Button kind="secondary" onClick={() => void chrome.tabs.create({ url: `${api.WEB_URL}/account` })}>Open account page</Button>
      </Card>
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Card title="Sign in">
      <p className="mb-3 text-xs text-slate-600">An account is only needed for AI tailoring and paid plans. Scoring and exports work without one.</p>
      {GOOGLE_ENABLED && (
        <div className="mb-4 max-w-sm">
          <GoogleButton />
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-600">
            <span className="h-px flex-1 bg-slate-200" />
            or use your email
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        </div>
      )}
      <p className="mb-2 text-xs text-slate-600">We’ll email you a 6-digit code.</p>
      <form
        className="max-w-sm space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            if (!sent) {
              const r = await api.requestCode(email);
              setDevCode(r.dev_code ?? null);
              setSent(true);
            } else {
              await api.verifyCode(email, code);
            }
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className={inputCls} type="email" required placeholder="you@example.com" value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} />
        {sent && <input className={inputCls} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />}
        {devCode && <p className="text-xs text-amber-700">Development build: your code is {devCode}</p>}
        <ErrorText error={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || (sent && code.length !== 6)}>{sent ? 'Sign in' : 'Email me a code'}</Button>
          {sent && <Button kind="ghost" onClick={() => { setSent(false); setCode(''); }}>Use a different email</Button>}
        </div>
      </form>
    </Card>
  );
}

// ── Plans, coupons, checkout ──

function PlansTab({ account }: { account: Account }) {
  const [plans, setPlans] = useState<api.PublicPlan[] | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<{ code: string; plan: PlanId; summary: string; list: string; discounted: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const checkoutOff = account.config?.kill_switches.checkout;
  const couponsOff = account.config?.kill_switches.coupons;
  const startPlan = account.me?.plan;
  const startCredits = account.usage?.optimizations.credits_remaining ?? 0;
  const reload = account.reload;

  useEffect(() => {
    api.plans().then((r) => setPlans(r.plans)).catch(setError);
  }, []);

  // After checkout opens in a tab, watch for the purchase to land (the webhook applies it within seconds): a new
  // plan for subscriptions, more credits for a credit pack (which doesn't change the plan).
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      const [me, usage] = await Promise.all([api.me().catch(() => null), api.usage().catch(() => null)]);
      const planChanged = !!me && !!startPlan && me.plan !== startPlan;
      const creditsAdded = !!usage && usage.optimizations.credits_remaining > startCredits;
      if (planChanged || creditsAdded) {
        setWaiting(false);
        await reload();
      }
    }, 4000);
    const stop = setTimeout(() => setWaiting(false), 15 * 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [waiting, startPlan, startCredits, reload]);

  const applyCode = async (plan: PlanId) => {
    setError(null);
    setPreview(null);
    try {
      const p = await api.previewCoupon(code.trim(), plan);
      setPreview({ code: code.trim().toUpperCase(), plan, summary: p.summary, list: p.price.list, discounted: p.price.discounted });
    } catch (e) {
      setError(e);
    }
  };

  const buy = async (plan: PlanId) => {
    setBusy(true);
    setError(null);
    try {
      const co = await api.checkout(plan, preview?.plan === plan ? preview.code : undefined, uuidv7());
      await chrome.tabs.create({ url: co.checkout_url });
      setWaiting(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!account.signedIn) return <Note>Sign in on the Account tab to upgrade.</Note>;
  const paid = (plans ?? []).filter((p) => p.price);
  return (
    <div className="space-y-3">
      {checkoutOff && <Note tone="amber">Checkout is temporarily unavailable. Please try again later.</Note>}
      {waiting && <Note tone="green">Complete payment in the new tab. Your plan updates here automatically.</Note>}
      <div className="grid gap-3 md:grid-cols-2">
        {paid.map((p) => {
          const current = account.me?.plan === p.plan_id;
          const discounted = preview?.plan === p.plan_id ? preview : null;
          return (
            <div key={p.plan_id} className={`rounded-lg border bg-white p-4 ${discounted ? 'border-emerald-400' : 'border-slate-200'}`}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{p.name}</h3>
                {p.badge && <Badge tone="indigo">{p.badge}</Badge>}
              </div>
              <p className="mt-1 text-lg font-bold">
                {discounted ? (
                  <>
                    <span className="mr-1 text-sm text-slate-500 line-through"><span className="sr-only">was </span>${discounted.list}</span><span className="sr-only">now </span>${discounted.discounted}
                  </>
                ) : (
                  `$${p.price!.amount}`
                )}
                {p.price!.interval && <span className="text-xs font-normal text-slate-500"> / {intervalLabel(p.price!.interval)}</span>}
              </p>
              {discounted && <p className="text-xs text-emerald-700">{discounted.summary}</p>}
              <ul className="mt-2 space-y-0.5 text-xs text-slate-600">{p.features.map((f) => <li key={f}>• {f}</li>)}</ul>
              <div className="mt-3">
                {current ? (
                  <Badge tone="green">Your plan</Badge>
                ) : (
                  <Button disabled={busy || !!checkoutOff} onClick={() => void buy(p.plan_id)}>{p.plan_id === 'credit_pack' ? 'Buy credits' : 'Choose'}</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!couponsOff && (
        <Card>
          {!codeOpen ? (
            <button className="text-sm text-indigo-700" onClick={() => setCodeOpen(true)}>Have a code?</button>
          ) : (
            <div className="space-y-2">
              <Field label="Discount code" hint="Codes can apply to specific plans. Pick a plan to see your price.">
                <input className={`${inputCls} max-w-xs uppercase`} value={code} onChange={(e) => { setCode(e.target.value); setPreview(null); }} />
              </Field>
              <div className="flex flex-wrap gap-1">
                {paid.map((p) => (
                  <Button key={p.plan_id} small kind="secondary" disabled={code.trim().length < 3} onClick={() => void applyCode(p.plan_id)}>Apply to {p.name}</Button>
                ))}
              </div>
              {preview && <Note tone="green">{preview.code}: {preview.summary.replace(/\.$/, '')}. Choose that plan above to continue.</Note>}
            </div>
          )}
        </Card>
      )}
      <ErrorText error={error} />
      <p className="text-xs text-slate-500">Payments are processed securely by Stripe. Cancel anytime from your account page.</p>
    </div>
  );
}

// ── Bring your own key ──

function ByokTab({ account }: { account: Account }) {
  const existing = account.byok;
  const [provider, setProvider] = useState<ByokProvider>(existing?.provider ?? 'openai');
  const models = byokModels(provider);
  const [key, setKey] = useState('');
  const [cheap, setCheap] = useState(existing?.cheap_model ?? models[0]?.id ?? '');
  const [strong, setStrong] = useState(existing?.strong_model ?? models[models.length - 1]?.id ?? '');
  const [status, setStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const allowed = account.me?.plan === 'byok_annual';

  const pickProvider = (p: ByokProvider) => {
    setProvider(p);
    const m = byokModels(p);
    setCheap(m[0]?.id ?? '');
    setStrong(m[m.length - 1]?.id ?? '');
  };

  return (
    <div className="space-y-3">
      <Card title="Use your own AI provider key">
        <p className="text-xs text-slate-600">
          With the Own-key plan, tailoring runs from this browser straight to your provider with your key, using the same checks as our hosted service. Your key is stored encrypted on this device and sent only to that provider. We never see it.
        </p>
        {!allowed && <div className="mt-2"><Note tone="amber">This needs the Own-key plan (see Plans).</Note></div>}
        {existing?.key && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Badge tone={existing.enabled ? 'green' : 'slate'}>{existing.enabled ? 'active' : 'off'}</Badge>
            {existing.provider} key ••••{existing.key.slice(-4)}
            <Button small kind="ghost" onClick={async () => { await store.del('byok'); setStatus(null); }}>Remove key</Button>
          </div>
        )}
      </Card>
      <Card title={existing?.key ? 'Replace key' : 'Add key'}>
        <div className="grid max-w-md gap-2">
          <Field label="Provider">
            <select className={inputCls} value={provider} onChange={(e) => pickProvider(e.target.value as ByokProvider)}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google Gemini (paid tier only)</option>
            </select>
          </Field>
          {provider === 'google' && <Note tone="amber">Use a paid-tier Gemini key. The free tier’s terms let Google use your inputs and don’t permit personal data like a resume.</Note>}
          <Field label="API key"><input className={inputCls} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
          <Field label="Model for extraction and checks">
            <select className={inputCls} value={cheap} onChange={(e) => setCheap(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.provider_model_id}</option>)}</select>
          </Field>
          <Field label="Model for rewriting">
            <select className={inputCls} value={strong} onChange={(e) => setStrong(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.provider_model_id}</option>)}</select>
          </Field>
          <div>
            <Button
              disabled={!allowed || key.trim().length < 10 || busy}
              onClick={async () => {
                setBusy(true);
                setStatus(null);
                try {
                  // Host access for this one provider, asked for at the moment it's needed.
                  const granted = await chrome.permissions.request({ origins: [BYOK_HOSTS[provider]] });
                  if (!granted) throw new Error('Permission to contact the provider was declined.');
                  const settings: ByokSettings = { provider, key: key.trim(), cheap_model: cheap, strong_model: strong, enabled: true };
                  const r = await testByok(settings);
                  setStatus(r);
                  if (r.ok) {
                    await store.put('byok', settings);
                    setKey('');
                  }
                } catch (e) {
                  setStatus({ ok: false, detail: (e as Error).message });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Testing…' : 'Save and test'}
            </Button>
          </div>
          {status && <Note tone={status.ok ? 'green' : 'amber'}>{status.detail}</Note>}
          <p className="text-[11px] text-slate-500">The test sends a short made-up job posting, never your resume.</p>
        </div>
      </Card>
    </div>
  );
}

// ── History ──

function HistoryTab() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = async () => {
    const ids = await store.keys('history:');
    const all = (await Promise.all(ids.map((id) => store.get<HistoryItem>(id)))).filter((x): x is HistoryItem => !!x);
    setItems(all.sort((a, b) => b.at.localeCompare(a.at)));
  };
  useEffect(() => {
    void load();
  }, []);
  const download = async (h: HistoryItem, format: 'pdf' | 'docx') => {
    try {
      const f = await exportResume(h.resume, format, 'classic', h.company);
      saveBlob(f.blob, f.name);
    } catch (e) {
      setError(e);
    }
  };
  if (!items) return <Spinner />;
  if (!items.length) return <Note>Tailored resumes you export are kept here, on this device only.</Note>;
  return (
    <div className="space-y-2">
      <ErrorText error={error} />
      {items.map((h) => (
        <Card key={h.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">
                {h.title ?? 'Job'} {h.company && <span className="font-normal text-slate-500">· {h.company}</span>}
              </p>
              <p className="text-xs text-slate-500">{new Date(h.at).toLocaleString()} · match estimate {h.before} → {h.after}</p>
            </div>
            <div className="flex gap-1">
              <Button small kind="secondary" onClick={() => void download(h, 'pdf')}>PDF</Button>
              <Button small kind="secondary" onClick={() => void download(h, 'docx')}>DOCX</Button>
              <Button small kind="ghost" onClick={async () => { await store.del(`history:${h.id}`); await load(); }}>Delete</Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Privacy ──

function PrivacyTab({ account }: { account: Account }) {
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  return (
    <div className="space-y-3">
      <Card title="Where your data lives">
        <ul className="list-disc space-y-1 pl-4 text-xs text-slate-700">
          <li><b>On this device (encrypted):</b> your resume, the jobs you analyze, tailoring results, history, your sign-in, and your own AI key if you add one.</li>
          <li><b>Sent when you use AI features:</b> your experience, skills and summary with your name and contact details removed. Not stored after processing, unless you turn on “Help improve” below.</li>
          <li><b>On our servers:</b> your email, plan, usage counts, and AI cost records without any content.</li>
        </ul>
        <a className="mt-2 inline-block text-xs text-indigo-700" href={`${api.WEB_URL}/privacy`} target="_blank" rel="noreferrer">Full privacy notice</a>
      </Card>
      {account.signedIn && account.me && <SaveDataCard account={account} />}
      <Card title="Download local data">
        <p className="mb-2 text-xs text-slate-600">Everything this extension stores on this device, as JSON (your sign-in and API key are left out).</p>
        <Button
          kind="secondary"
          onClick={async () => {
            const ids = (await store.keys()).filter((id) => id !== 'session');
            const out: Record<string, unknown> = {};
            for (const id of ids) {
              const v = await store.get<Record<string, unknown>>(id);
              out[id] = id === 'byok' && v ? { ...v, key: '(removed)' } : v;
            }
            saveBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), 'job-match-optimizer-local-data.json');
          }}
        >
          Download
        </Button>
      </Card>
      <Card title="Delete all local data">
        {done ? (
          <Note tone="green">Deleted. The extension is back to a fresh install.</Note>
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-600">
              Removes your resume, jobs, history, settings, AI key and sign-in from this device, including the encryption key. {account.signedIn && 'Your account itself stays; delete it on the account page.'}
            </p>
            <div className="flex max-w-sm gap-2">
              <input className={inputCls} placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              <Button kind="danger" disabled={confirm !== 'DELETE'} onClick={async () => { await api.signOut(); await store.wipeAll(); setDone(true); }}>Delete</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function SaveDataCard({ account }: { account: Account }) {
  const on = account.me?.settings.content_opt_in ?? false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [deleted, setDeleted] = useState<number | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await account.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Help improve Job Match Optimizer">
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={on} disabled={busy} onChange={(e) => void run(() => api.updateSettings({ content_opt_in: e.target.checked }))} />
        <span>
          Save the job posts I analyze, the resume I send for tailoring (without my name or contact details) and the tailored results, so they can be used to improve the product. Encrypted, kept for 12 months, never sold. Turning this off deletes what was saved.
        </span>
      </label>
      {on && (
        <div className="mt-2 flex items-center gap-2">
          <Button small kind="secondary" disabled={busy} onClick={() => void run(async () => setDeleted((await api.deleteSavedContent()).deleted))}>
            Delete saved data
          </Button>
          {deleted !== null && <span className="text-xs text-emerald-700">Deleted {deleted} saved item{deleted === 1 ? '' : 's'}.</span>}
        </div>
      )}
      <ErrorText error={error} />
    </Card>
  );
}

/** "1 month" → "month", "3 month" → "3 months". */
function intervalLabel(i: string): string {
  const [n, unit] = i.split(' ');
  return n === '1' ? unit! : `${n} ${unit}s`;
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
