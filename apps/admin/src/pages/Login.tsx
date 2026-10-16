import { useEffect, useRef, useState } from 'react';
import { login, requestCode } from '../api';
import { Button, ErrorBox, Field, inputCls } from '../components/ui';

export function LoginPage() {
  // The seeded owner address is a development convenience only; production builds start empty.
  const [email, setEmail] = useState(import.meta.env.DEV ? 'owner@example.com' : '');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  // One request at a time: repeated clicks while a sleeping server wakes up used to send a code per click, and only
  // the newest code works.
  const [busy, setBusy] = useState(false);
  // A ref, not just state: a held Enter key submits again before React re-renders the disabled button.
  const inFlight = useRef(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 4_000);
    return () => clearTimeout(t);
  }, [busy]);

  const submit = async () => {
    if (inFlight.current || (sent ? code.length !== 6 : !email.includes('@'))) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!sent) {
        const r = await requestCode(email);
        setDevCode(r.dev_code ?? null);
        setSent(true);
      } else {
        await login(email, code);
      }
    } catch (e) {
      setError(e);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="mb-1 text-lg font-semibold">Admin sign-in</h1>
        <p className="mb-4 text-xs text-slate-500">In production this page sits behind Cloudflare Access (SSO + MFA).</p>
        <ErrorBox error={error} />
        <Field label="Email">
          <input className={inputCls} type="email" autoComplete="email" value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {sent && (
          <Field label="6-digit code" hint={devCode ? `Development: code ${devCode}` : 'Check your email. If several arrived, use the newest one.'}>
            <input className={inputCls} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
          </Field>
        )}
        <Button type="submit" disabled={busy || (sent ? code.length !== 6 : !email.includes('@'))}>
          {busy ? (sent ? 'Signing in…' : 'Sending…') : sent ? 'Sign in' : 'Send code'}
        </Button>
        {slow && (
          <p role="status" className="mt-3 text-xs text-slate-500">
            The server is waking up after being idle. This can take up to a minute; please wait.
          </p>
        )}
      </form>
    </div>
  );
}
