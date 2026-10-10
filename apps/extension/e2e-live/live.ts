import { createSql, type Sql } from '../../../packages/db/src/client';

// Shared helpers for the live suite: the dev stack's URLs, sign-in through the API, a dev-database connection.

export const API = process.env.LIVE_API_URL ?? process.env.PUBLIC_API_URL ?? 'http://localhost:8787';
export const ADMIN_API = process.env.LIVE_ADMIN_API_URL ?? 'http://localhost:8788';
export const RUN = Date.now().toString(36);

export async function health(): Promise<{ ok: boolean; payments: string } | null> {
  try {
    const r = await fetch(`${API}/v1/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? ((await r.json()) as { ok: boolean; payments: string }) : null;
  } catch {
    return null;
  }
}

export async function api<T = any>(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (r.status === 204 ? undefined : await r.json().catch(() => ({}))) as T };
}

/** Signs in with an email code. The dev API shows the code; Resend's test inbox (delivered+…@resend.dev) receives the e-mail. */
export async function login(label: string): Promise<{ token: string; userId: string; email: string }> {
  const email = `delivered+jmo-${label}-${RUN}@resend.dev`;
  const r1 = await api<{ sent: boolean; dev_code: string }>('POST', '/v1/auth/otp/request', undefined, { email });
  if (r1.status !== 200) throw new Error(`code request ${r1.status} ${JSON.stringify(r1.json)}`);
  const r2 = await api<{ access_token: string; user: { id: string } }>('POST', '/v1/auth/otp/verify', undefined, { email, code: r1.json.dev_code, device: 'live-e2e' });
  if (r2.status !== 200) throw new Error(`code verify ${r2.status} ${JSON.stringify(r2.json)}`);
  return { token: r2.json.access_token, userId: r2.json.user.id, email };
}

export function db(): Sql {
  return createSql(process.env.DATABASE_URL ?? 'postgres://jmo:jmo@localhost:54329/jmo', { max: 2 });
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
