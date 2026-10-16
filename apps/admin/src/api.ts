// Admin API client: bearer session in sessionStorage, silent refresh, and a hook for step-up prompts.

const BASE = (import.meta.env.VITE_ADMIN_API_URL as string | undefined) ?? 'http://localhost:8788';

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface Session {
  access_token: string;
  refresh_token: string;
  email: string;
  role?: string;
}

let session: Session | null = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('jmo_admin') ?? 'null') as Session | null;
  } catch {
    return null;
  }
})();
const listeners = new Set<() => void>();

export function getSession() {
  return session;
}
export function setSession(s: Session | null) {
  session = s;
  if (s) sessionStorage.setItem('jmo_admin', JSON.stringify(s));
  else sessionStorage.removeItem('jmo_admin');
  listeners.forEach((l) => l());
}
export function onSession(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Set by the StepUp component: resolves when the admin has re-authenticated. */
export let requestStepUp: (() => Promise<void>) | null = null;
export function registerStepUp(fn: () => Promise<void>) {
  requestStepUp = fn;
}

async function raw(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
  try {
    return await fetch(`${BASE}/admin/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth && session ? { authorization: `Bearer ${session.access_token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // The browser says only "Failed to fetch" for a network error, an unreachable host or a refused CORS check.
    throw new AdminApiError(0, 'unreachable', `Can't reach the admin API (${BASE}). Check your connection; if this keeps happening, the service is down.`);
  }
}

/**
 * One refresh in flight at a time: every page loads several queries in parallel, and when the 15-minute access token
 * expires they all get a 401 together. Refresh tokens rotate and a reused one revokes the session (theft detection),
 * so parallel requests must share one refresh instead of each sending the same token — or the admin is signed out.
 */
let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const s = session;
    if (!s) return false;
    const r = await raw('POST', '/auth/refresh', { refresh_token: s.refresh_token }, false);
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

export async function api<T = unknown>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  let r = await raw(method, path, body);
  if (r.status === 401 && retry && (await refresh())) r = await raw(method, path, body);
  const text = await r.text();
  const isJson = r.headers.get('content-type')?.includes('json');
  const data = isJson && text ? JSON.parse(text) : text;
  if (!r.ok) {
    const e = (data as { error?: { code: string; message: string; details?: Record<string, unknown> } }).error;
    if (e?.code === 'step_up_required' && retry && requestStepUp) {
      await requestStepUp();
      return api<T>(method, path, body, false);
    }
    if (r.status === 401 && e?.code !== 'unauthenticated') setSession(null);
    throw new AdminApiError(r.status, e?.code ?? 'error', e?.message ?? `HTTP ${r.status}`, e?.details);
  }
  return data as T;
}

export const get = <T = unknown>(p: string) => api<T>('GET', p);
export const post = <T = unknown>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T = unknown>(p: string, b?: unknown) => api<T>('PATCH', p, b ?? {});
export const del = <T = unknown>(p: string, b?: unknown) => api<T>('DELETE', p, b ?? {});

export async function login(email: string, code: string) {
  const r = await raw('POST', '/auth/otp/verify', { email, code }, false);
  const data = await r.json();
  if (!r.ok) throw new AdminApiError(r.status, data.error?.code, data.error?.message);
  setSession({ access_token: data.access_token, refresh_token: data.refresh_token, email, role: data.role });
}

export async function requestCode(email: string): Promise<{ sent: boolean; dev_code?: string }> {
  const r = await raw('POST', '/auth/otp/request', { email }, false);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new AdminApiError(r.status, data.error?.code ?? 'error', data.error?.message ?? `HTTP ${r.status}`);
  return data;
}

/** Downloads a file export. Like api(): refreshes an expired session and asks for step-up when the export needs it. */
export async function downloadCsv(path: string, filename: string, retry = true) {
  let r = await raw('GET', path);
  if (r.status === 401 && retry && (await refresh())) r = await raw('GET', path);
  if (!r.ok) {
    const e = ((await r.json().catch(() => ({}))) as { error?: { code: string; message: string } }).error;
    if (e?.code === 'step_up_required' && retry && requestStepUp) {
      await requestStepUp();
      return downloadCsv(path, filename, false);
    }
    throw new AdminApiError(r.status, e?.code ?? 'error', e?.message ?? 'Export failed');
  }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
