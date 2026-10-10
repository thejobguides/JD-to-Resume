import type { MeResponse, UsageResponse } from '@jmo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, getSession, GOOGLE_CLIENT_ID, googleLogin, me as fetchMe, portal as fetchPortal, type PortalInfo, portalSession, requestCode, setSession, usage as fetchUsage, verifyCode } from '../api';
import { Button, ErrorText, inputCls } from '../App';

const PLAN_NAMES: Record<string, string> = { free: 'Free', pro_monthly: 'Pro (monthly)', pro_quarterly: 'Pro (quarterly)', byok_annual: 'Bring your own key (annual)', credit_pack: 'Credit pack' };
const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—');

export function AccountPage() {
  const [signedIn, setSignedIn] = useState(!!getSession());
  return <div className="mx-auto max-w-2xl px-4 py-12">{signedIn ? <Account onSignOut={() => setSignedIn(false)} /> : <SignIn onDone={() => setSignedIn(true)} />}</div>;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-1 text-2xl font-semibold">Your account</h1>
      <p className="mb-4 text-sm text-slate-600">Sign in the same way you do in the extension.</p>
      {GOOGLE_CLIENT_ID && (
        <div className="mb-4">
          <GoogleSignIn onDone={onDone} />
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-600">
            <span className="h-px flex-1 bg-slate-200" />
            or use your email
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        </div>
      )}
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
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
            setBusy(false);
          }
        }}
      >
        <input className={inputCls} type="email" required placeholder="you@example.com" value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} />
        {sent && (
          <>
            <input className={inputCls} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
            {devCode && <p className="text-xs text-amber-700">Development build: your code is {devCode}</p>}
          </>
        )}
        <ErrorText error={error} />
        <Button type="submit" disabled={busy || (sent && code.length !== 6)}>{sent ? 'Sign in' : 'Send code'}</Button>
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

  if (!me) return <><ErrorText error={error} />{!error && <p className="text-sm text-slate-500">Loading…</p>}</>;
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
  const portalButton = 'rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50';

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Your account</h1>
          <p className="text-sm text-slate-600">{me.email}</p>
        </div>
        <Button kind="secondary" onClick={async () => { await call('POST', '/v1/auth/logout').catch(() => undefined); setSession(null); onSignOut(); }}>Sign out</Button>
      </div>
      <ErrorText error={error} />

      <section className="rounded-lg border border-slate-200 p-5">
        <h2 className="font-semibold">Plan</h2>
        <p className="mt-1 text-lg">{PLAN_NAMES[me.plan] ?? me.plan}</p>
        {me.grant && <p className="text-sm text-slate-600">Complimentary access until {date(me.grant.ends_at)}.</p>}
        {sub && (
          <p className="text-sm text-slate-600">
            {sub.cancel_at_period_end ? <>Cancelled — you keep access until <b>{date(sub.current_period_end)}</b>.</> : <>Status: {sub.status}. Renews on {date(sub.current_period_end)}.</>}
          </p>
        )}
        {usage && (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <Stat label="Optimizations this period" value={`${usage.optimizations.used} / ${usage.optimizations.limit}`} />
            <Stat label="Today" value={`${usage.optimizations.daily_used} / ${usage.optimizations.daily_limit}`} />
            {usage.optimizations.credits_remaining > 0 && <Stat label="Credits left" value={String(usage.optimizations.credits_remaining)} />}
            <Stat label="Period ends" value={date(usage.period.end)} />
          </dl>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
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
          {!sub && me.plan === 'free' && <p className="text-sm text-slate-600">Upgrade from the extension’s “Upgrade” screen.</p>}
        </div>
        {fakeMode && <p className="mt-2 text-xs text-amber-700">Local test payments: these buttons send the same webhooks Stripe’s customer portal would.</p>}
      </section>

      <section className="rounded-lg border border-slate-200 p-5">
        <h2 className="font-semibold">Privacy settings</h2>
        {(['content_opt_in', 'history_opt_in', 'telemetry_opt_in'] as const).map((k) => (
          <label key={k} className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
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
      </section>

      <section className="rounded-lg border border-slate-200 p-5">
        <h2 className="font-semibold">Your data</h2>
        <p className="mt-1 text-sm text-slate-600">Your resume lives in the extension on your device. If you turned on “Help improve”, the job posts, minimized resumes and results we saved are included in this download.</p>
        <div className="mt-3 flex flex-wrap gap-2">
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
            Download my account data
          </Button>
          <Button kind="secondary" onClick={async () => { try { await call('POST', '/v1/auth/logout-all'); setSession(null); onSignOut(); } catch (e) { setError(e); } }}>Sign out on all devices</Button>
        </div>
        <DeleteAccount hasSub={!!sub && !sub.cancel_at_period_end && sub.status !== 'canceled'} onDeleted={() => { setSession(null); onSignOut(); }} />
      </section>
    </div>
  );
}

function DeleteAccount({ hasSub, onDeleted }: { hasSub: boolean; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  if (!open) return <button className="mt-4 text-sm text-rose-700" onClick={() => setOpen(true)}>Delete my account…</button>;
  return (
    <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-4">
      <p className="text-sm text-rose-800">This deletes your account, usage history and any saved optimization history. {hasSub && 'Your active subscription is cancelled too.'} It can’t be undone. To also remove the resume stored in the extension, use “Delete all local data” in the extension’s settings.</p>
      <input className={`${inputCls} mt-3`} placeholder="Type DELETE to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <ErrorText error={error} />
      <div className="mt-3 flex gap-2">
        <Button kind="danger" disabled={confirm !== 'DELETE'} onClick={async () => { try { await call('DELETE', '/v1/account'); onDeleted(); } catch (e) { setError(e); } }}>Delete account</Button>
        <Button kind="secondary" onClick={() => setOpen(false)}>Keep my account</Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
