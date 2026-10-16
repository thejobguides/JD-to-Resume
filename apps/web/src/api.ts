// Public API client for the website (account page, checkout). The session lives in sessionStorage only: the
// website is a thin billing/account surface; the extension is the product.

import type { MeResponse, UsageResponse } from '@jmo/shared';

export const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Session {
  access_token: string;
  refresh_token: string;
  email: string;
}

const KEY = 'jmo_web_session';
let session: Session | null = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Session | null;
  } catch {
    return null;
  }
})();

export const getSession = () => session;
export function setSession(s: Session | null) {
  session = s;
  if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
  else sessionStorage.removeItem(KEY);
}

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.access_token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // The browser says only "Failed to fetch" for a network error, an unreachable host or a refused CORS check.
    throw new ApiFailure(0, 'unreachable', 'We can’t reach our servers right now. Check your connection and try again in a few minutes.');
  }
}

/**
 * One refresh in flight at a time. Pages load several things in parallel; when the access token expires they all get
 * a 401 together. Refresh tokens rotate, and presenting an already-rotated one revokes the session as suspected
 * theft, so the parallel requests must share a single refresh instead of each sending the same token.
 */
let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const s = session;
    if (!s) return false;
    const r = await fetch(`${API}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
    if (!r.ok) {
      setSession(null);
      return false;
    }
    const t = (await r.json()) as { access_token: string; refresh_token: string };
    setSession({ ...s, access_token: t.access_token, refresh_token: t.refresh_token });
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let r = await raw(method, path, body);
  if (r.status === 401 && (await refresh())) r = await raw(method, path, body);
  if (r.status === 204) return undefined as T;
  const data = (await r.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!r.ok) throw new ApiFailure(r.status, data.error?.code ?? 'error', data.error?.message ?? `Request failed (${r.status})`);
  return data as T;
}

export async function requestCode(email: string) {
  return call<{ sent: boolean; dev_code?: string }>('POST', '/v1/auth/otp/request', { email });
}

export async function verifyCode(email: string, code: string) {
  const t = await call<{ access_token: string; refresh_token: string; user: { email: string } }>('POST', '/v1/auth/otp/verify', { email, code, device: 'website' });
  setSession({ access_token: t.access_token, refresh_token: t.refresh_token, email: t.user.email });
}

export const GOOGLE_CLIENT_ID = (import.meta.env.GOOGLE_OAUTH_CLIENT_ID ?? '').split(',')[0]!.trim();

/** Exchanges a Google ID token (from the Google Identity Services button) for our own session. */
export async function googleLogin(idToken: string, nonce: string) {
  const t = await call<{ access_token: string; refresh_token: string; user: { email: string } }>('POST', '/v1/auth/google', { id_token: idToken, nonce, device: 'website' });
  setSession({ access_token: t.access_token, refresh_token: t.refresh_token, email: t.user.email });
}

export const me = () => call<MeResponse>('GET', '/v1/me');
export const usage = () => call<UsageResponse>('GET', '/v1/usage');

export interface PublicPlan {
  plan_id: string;
  name: string;
  price: { currency: string; amount: string; interval: string | null } | null;
  features: string[];
  badge?: string | null;
}
export const plans = () => call<{ plans: PublicPlan[] }>('GET', '/v1/billing/plans');

export interface PortalInfo {
  mode: 'fake' | 'test' | 'live';
  /** true once Stripe knows the user as a customer (they have or had a subscription) */
  manageable: boolean;
}
export const portal = () => call<PortalInfo>('GET', '/v1/billing/portal');
/** Stripe portal URLs expire within minutes, so one is created per click. */
export const portalSession = (flow: 'overview' | 'cancel' | 'update_payment') => call<{ url: string }>('POST', '/v1/billing/portal', { flow });
