import type { MeResponse, UsageResponse } from '@jmo/shared';
import { cx, LogoMark } from '@jmo/ui';
import { CalendarClock, CreditCard, Database, Download, LogOut, Mail, ShieldCheck, TriangleAlert } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { call, getSession, GOOGLE_CLIENT_ID, googleLogin, me as fetchMe, portal as fetchPortal, type PortalInfo, portalSession, requestCode, setSession, usage as fetchUsage, verifyCode } from '../api';
import { Button, buttonCls, ErrorText, inputCls } from '../App';

const PLAN_NAMES: Record<string, string> = { free: 'Free', pro_monthly: 'Pro (monthly)', pro_quarterly: 'Pro (quarterly)', byok_annual: 'Bring your own key (annual)', credit_pack: 'Credit pack' };
const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—');

export function AccountPage() {
  const [signedIn, setSignedIn] = useState(!!getSession());
  return (
    <div className="min-h-[70vh] bg-gradient-to-b from-slate-50 to-white">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">{signedIn ? <Account onSignOut={() => setSignedIn(false)} /> : <SignIn onDone={() => setSignedIn(true)} />}</div>
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // A ref, not just state: a held Enter key submits again before React re-renders the disabled button.
  const inFlight = useRef(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 4_000);
    return () => clearTimeout(t);
  }, [busy]);
  return (
    <div className="mx-auto max-w-md animate-fade-up rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
      <LogoMark className="size-11" />
      <h1 className="mt-5 text-2xl font-bold tracking-tight">Your account</h1>
      <p className="mt-1 text-sm text-slate-600">Sign in the same way you do in the extension.</p>
      {GOOGLE_CLIENT_ID && (
        <div className="mt-6">
          <GoogleSignIn onDone={onDone} />
          <div className="mt-5 flex items-center gap-3 text-xs text-slate-600">
            <span className="h-px flex-1 bg-slate-200" />
            or use your email
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        </div>
      )}
      <form
        className="mt-6 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          setError(null);
          try {
            if (!sent) {
              const r = await requestCode(email);
              setDevCode(r.dev_code ?? null);
              setSent(true);
            } else {
              await verifyCode(email, code);
              onDone();
            }
          } catch (err) {
            setError(err);
          } finally {
            inFlight.current = false;
            setBusy(false);
          }
        }}
      >
        <div>
          <label htmlFor="signin-email" className="mb-1.5 block text-sm font-medium text-slate-800">Email</label>
          <input id="signin-email" className={inputCls} type="email" required autoComplete="email" placeholder="you@example.com" value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {sent && (
          <div className="animate-fade-in">
            <label htmlFor="signin-code" className="mb-1.5 block text-sm font-medium text-slate-800">Sign-in code</label>
            <input id="signin-code" className={cx(inputCls, 'tracking-[0.3em]')} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
            {devCode && <p className="mt-2 text-xs text-amber-800">Development build: your code is {devCode}</p>}
            {!devCode && <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-600"><Mail className="size-3.5" aria-hidden />Check your email. If several codes arrived, use the newest one.</p>}
          </div>
        )}
        <ErrorText error={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || (sent && code.length !== 6)}>{busy ? (sent ? 'Signing in…' : 'Sending…') : sent ? 'Sign in' : 'Send code'}</Button>
        {slow && <p role="status" className="text-center text-xs text-slate-600">The server is waking up after being idle. This can take up to a minute; please wait.</p>}
      </form>
    </div>
  );
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(o: { client_id: string; nonce: string; ux_mode: 'popup'; callback: (r: { credential: string }) => void }): void;
          renderButton(el: HTMLElement, o: Record<string, unknown>): void;
        };
      };
    };
  }
}

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: 'https://accounts.google.com/gsi/client', async: true });
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Couldn’t load Google sign-in. Check content blockers, or use your email.'));
    document.head.appendChild(s);
  });
}

/** Google's own "Continue with Google" button (Google Identity Services); the ID token is bound to a fresh nonce. */
function GoogleSignIn({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    // 24 random bytes from the browser's CSPRNG (no shared library in this small bundle).
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/[+/=]/g, '');
    loadGoogleScript()
      .then(() => {
        window.google!.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          nonce,
          ux_mode: 'popup',
          callback: (r) => {
            googleLogin(r.credential, nonce).then(onDone, setError);
          },
        });
        if (ref.current) window.google!.accounts.id.renderButton(ref.current, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: 320 });
      })
      .catch(setError);
  }, [onDone]);
  return (
    <div className="space-y-2">
      <div ref={ref} className="min-h-10" />
      <ErrorText error={error} />
    </div>
  );
}

function Card({ icon, title, description, children, tone = 'default' }: { icon: ReactNode; title: string; description?: ReactNode; children: ReactNode; tone?: 'default' | 'danger' }) {
  return (
    <section className={cx('rounded-2xl border bg-white p-5 shadow-card sm:p-6', tone === 'danger' ? 'border-rose-200' : 'border-slate-200')}>
      <div className="flex items-start gap-3">
        <span className={cx('grid size-10 shrink-0 place-items-center rounded-xl ring-1', tone === 'danger' ? 'bg-rose-50 text-rose-700 ring-rose-100' : 'bg-indigo-50 text-indigo-700 ring-indigo-100')}>{icon}</span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {description && <div className="mt-0.5 text-sm text-slate-600">{description}</div>}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Account({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [portal, setPortal] = useState<PortalInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [m, u, p] = await Promise.all([fetchMe(), fetchUsage(), fetchPortal()]);
      setMe(m);
      setUsage(u);
      setPortal(p);
    } catch (e) {
      if (!getSession()) onSignOut();
      else setError(e);
    }
  }, [onSignOut]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!me)
    return (
      <div className="space-y-4">
        <ErrorText error={error} />
        {!error && (
          <div className="space-y-4" aria-busy="true">
            <p className="sr-only" role="status">Loading…</p>
            {[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white" />)}
          </div>
        )}
      </div>
    );
  const sub = me.subscription;
  const fakeMode = portal?.mode === 'fake';
  const openPortal = async (flow: 'overview' | 'cancel' | 'update_payment') => {
    setBusy(true);
    setError(null);
    try {
      location.href = (await portalSession(flow)).url;
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  const portalButton = buttonCls('secondary', 'md');
  const statusTone = sub?.cancel_at_period_end ? 'bg-amber-50 text-amber-800 ring-amber-200' : sub ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : 'bg-slate-100 text-slate-700 ring-slate-200';

  return (
    <div className="animate-fade-up space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-xl font-bold uppercase text-white shadow-lift">{me.email.slice(0, 1)}</span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Your account</h1>
            <p className="truncate text-sm text-slate-600">{me.email}</p>
          </div>
        </div>
        <Button kind="secondary" onClick={async () => { await call('POST', '/v1/auth/logout').catch(() => undefined); setSession(null); onSignOut(); }}>
          <LogOut className="size-4" aria-hidden />
          Sign out
        </Button>
      </div>
      <ErrorText error={error} />

      <Card icon={<CreditCard className="size-5" aria-hidden />} title="Plan" description="Your current plan and this period’s usage.">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-2xl font-bold tracking-tight text-slate-900">{PLAN_NAMES[me.plan] ?? me.plan}</p>
          {sub && <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1', statusTone)}>{sub.cancel_at_period_end ? 'Cancelling' : sub.status}</span>}
        </div>
        {me.grant && <p className="mt-1 text-sm text-slate-600">Complimentary access until {date(me.grant.ends_at)}.</p>}
        {sub && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-600">
            <CalendarClock className="size-4 shrink-0" aria-hidden />
            <span>{sub.cancel_at_period_end ? <>Cancelled — you keep access until <b className="text-slate-900">{date(sub.current_period_end)}</b>.</> : <>Status: {sub.status}. Renews on {date(sub.current_period_end)}.</>}</span>
          </p>
        )}
        {usage && (
          <dl className="mt-5 grid gap-3 sm:grid-cols-3">
            <Meter label="Optimizations this period" used={usage.optimizations.used} limit={usage.optimizations.limit} />
            <Meter label="Today" used={usage.optimizations.daily_used} limit={usage.optimizations.daily_limit} />
            {usage.optimizations.credits_remaining > 0 && <Stat label="Credits left" value={String(usage.optimizations.credits_remaining)} />}
            <Stat label="Period ends" value={date(usage.period.end)} />
          </dl>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {portal?.manageable && !fakeMode && (
            <>
              {sub && sub.status !== 'canceled' && <button className={portalButton} disabled={busy} onClick={() => void openPortal('update_payment')}>Update payment method</button>}
              {sub && sub.status !== 'canceled' && !sub.cancel_at_period_end && <button className={portalButton} disabled={busy} onClick={() => void openPortal('cancel')}>Cancel subscription</button>}
              <button className={portalButton} disabled={busy} onClick={() => void openPortal('overview')}>Invoices and billing</button>
            </>
          )}
          {fakeMode && sub && (
            <Button
              kind="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await call('POST', '/v1/dev/fake-subscription/cancel', { cancel: !sub.cancel_at_period_end });
                  await load();
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {sub.cancel_at_period_end ? 'Resume subscription (test)' : 'Cancel at period end (test)'}
            </Button>
          )}
          {!sub && me.plan === 'free' && <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-900">Upgrade from the extension’s “Upgrade” screen.</p>}
        </div>
        {fakeMode && <p className="mt-3 text-xs text-amber-800">Local test payments: these buttons send the same webhooks Stripe’s customer portal would.</p>}
      </Card>

      <Card icon={<ShieldCheck className="size-5" aria-hidden />} title="Privacy settings" description="Choose what, if anything, is kept on our servers.">
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {(['content_opt_in', 'history_opt_in', 'telemetry_opt_in'] as const).map((k) => (
            <label key={k} className="flex cursor-pointer items-start gap-3 p-4 text-sm leading-6 text-slate-700 hover:bg-slate-50">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 cursor-pointer rounded border-slate-300 accent-indigo-600"
                checked={me.settings[k]}
                onChange={async (e) => {
                  const v = e.target.checked;
                  try {
                    await call('PATCH', '/v1/account/settings', { [k]: v });
                    setMe({ ...me, settings: { ...me.settings, [k]: v } });
                  } catch (err) {
                    setError(err);
                  }
                }}
              />
              <span>
                {k === 'content_opt_in'
                  ? 'Help improve Job Match Optimizer: save the job posts I analyze, the resume I send for tailoring (without my name or contact details) and the results. Encrypted, kept 12 months. Turning this off deletes what was saved.'
                  : k === 'history_opt_in'
                    ? 'Keep an encrypted history of my optimizations on your servers (off: history stays only in the extension).'
                    : 'Send anonymous usage statistics (never resume or job text).'}
              </span>
            </label>
          ))}
        </div>
      </Card>

      <Card icon={<Database className="size-5" aria-hidden />} title="Your data" description="Your resume lives in the extension on your device. If you turned on “Help improve”, the job posts, minimized resumes and results we saved are included in this download.">
        <div className="flex flex-wrap gap-2">
          <Button
            kind="secondary"
            onClick={async () => {
              try {
                const data = await call('GET', '/v1/account/export');
                const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
                const a = Object.assign(document.createElement('a'), { href: url, download: 'job-match-optimizer-account.json' });
                a.click();
                URL.revokeObjectURL(url);
              } catch (e) {
                setError(e);
              }
            }}
          >
            <Download className="size-4" aria-hidden />
            Download my account data
          </Button>
          <Button kind="secondary" onClick={async () => { try { await call('POST', '/v1/auth/logout-all'); setSession(null); onSignOut(); } catch (e) { setError(e); } }}>Sign out on all devices</Button>
        </div>
        <DeleteAccount hasSub={!!sub && !sub.cancel_at_period_end && sub.status !== 'canceled'} onDeleted={() => { setSession(null); onSignOut(); }} />
      </Card>
    </div>
  );
}

function DeleteAccount({ hasSub, onDeleted }: { hasSub: boolean; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  if (!open)
    return (
      <div className="mt-6 border-t border-slate-100 pt-5">
        <button className="text-sm font-semibold text-rose-700 underline-offset-4 hover:underline" onClick={() => setOpen(true)}>Delete my account…</button>
      </div>
    );
  return (
    <div className="mt-6 animate-fade-in rounded-xl border border-rose-200 bg-rose-50 p-4 sm:p-5">
      <p className="flex gap-2 text-sm leading-6 text-rose-900">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>This deletes your account, usage history and any saved optimization history. {hasSub && 'Your active subscription is cancelled too.'} It can’t be undone. To also remove the resume stored in the extension, use “Delete all local data” in the extension’s settings.</span>
      </p>
      <input className={`${inputCls} mt-4`} aria-label="Type DELETE to confirm" placeholder="Type DELETE to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <ErrorText error={error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button kind="danger" disabled={confirm !== 'DELETE'} onClick={async () => { try { await call('DELETE', '/v1/account'); onDeleted(); } catch (e) { setError(e); } }}>Delete account</Button>
        <Button kind="secondary" onClick={() => setOpen(false)}>Keep my account</Button>
      </div>
    </div>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <dt className="text-xs font-medium text-slate-600">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-slate-900">{`${used} / ${limit}`}</dd>
      <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className={cx('h-full rounded-full transition-all', pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-indigo-600')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <dt className="text-xs font-medium text-slate-600">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-slate-900">{value}</dd>
    </div>
  );
}
