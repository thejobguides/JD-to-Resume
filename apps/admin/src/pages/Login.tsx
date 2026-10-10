import { useState } from 'react';
import { login, requestCode } from '../api';
import { Button, ErrorBox, Field, inputCls } from '../components/ui';

export function LoginPage() {
  // The seeded owner address is a development convenience only; production builds start empty.
  const [email, setEmail] = useState(import.meta.env.DEV ? 'owner@example.com' : '');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold">Admin sign-in</h1>
        <p className="mb-4 text-xs text-slate-500">In production this page sits behind Cloudflare Access (SSO + MFA).</p>
        <ErrorBox error={error} />
        <Field label="Email">
          <input className={inputCls} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {sent && (
          <Field label="6-digit code" hint={devCode ? `Development: code ${devCode}` : 'Check your email.'}>
            <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
          </Field>
        )}
        {!sent ? (
          <Button
            disabled={!email.includes('@')}
            onClick={async () => {
              setError(null);
              try {
                const r = await requestCode(email);
                setDevCode(r.dev_code ?? null);
                setSent(true);
              } catch (e) {
                setError(e);
              }
            }}
          >
            Send code
          </Button>
        ) : (
          <Button
            disabled={code.length !== 6}
            onClick={async () => {
              try {
                await login(email, code);
              } catch (e) {
                setError(e);
              }
            }}
          >
            Sign in
          </Button>
        )}
      </div>
    </div>
  );
}
