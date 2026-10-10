// Hosted API client. Resume content only leaves the device in POST /v1/optimizations (minimized, pseudonymized)
// and /v1/matches/map (claim texts); job text goes to /v1/jobs/analyze. Tokens live in the encrypted local store.

import { verifyConfig } from '@jmo/config';
import type {
  AnalyzeJobResponse,
  ClaimLite,
  ExtractedJob,
  MatchMapResponse,
  MeResponse,
  OptimizationEvent,
  OptimizationResponse,
  OptimizeRequest,
  PlanId,
  PublicConfig,
  SignedConfig,
  UsageResponse,
} from '@jmo/shared';
import { randomToken } from '@jmo/shared';
import * as store from './store';

export const API_URL = __API_URL__;
export const WEB_URL = __WEB_URL__;

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Session {
  access_token: string;
  refresh_token: string;
  email: string;
}

let session: Session | null | undefined;
export async function getSession(): Promise<Session | null> {
  if (session === undefined) session = await store.get<Session>('session');
  return session;
}
async function setSession(s: Session | null) {
  session = s;
  if (s) await store.put('session', s);
  else await store.del('session');
}
store.onChange((id) => {
  if (id === 'session' || id === '*') session = undefined;
});

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  const s = await getSession();
  return fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-extension-version': __EXT_VERSION__,
      ...(s ? { authorization: `Bearer ${s.access_token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
}

/**
 * One refresh at a time across ALL extension pages (side panel and settings page are separate pages sharing one
 * session). Refresh tokens rotate, and presenting an already-rotated one revokes the whole session as suspected theft,
 * so a second page must reuse the first page's result instead of refreshing with the same token.
 */
let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const before = (await getSession())?.refresh_token;
    if (!before) return false;
    const run = async (): Promise<boolean> => {
      const s = await getSession();
      if (!s) return false;
      if (s.refresh_token !== before) return true; // another page refreshed while we waited for the lock
      const r = await fetch(`${API_URL}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
      if (!r.ok) {
        await setSession(null);
        return false;
      }
      const t = (await r.json()) as { access_token: string; refresh_token: string };
      await setSession({ ...s, access_token: t.access_token, refresh_token: t.refresh_token });
      return true;
    };
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('jmo-session-refresh', run) : run();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function toFailure(r: Response): Promise<ApiFailure> {
  const data = (await r.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: Record<string, unknown> } };
  return new ApiFailure(r.status, data.error?.code ?? 'error', data.error?.message ?? `Request failed (${r.status}).`, data.error?.details ?? {});
}

async function call<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  let r: Response;
  try {
    r = await raw(method, path, body, headers);
    if (r.status === 401 && (await refresh())) r = await raw(method, path, body, headers);
  } catch {
    throw new ApiFailure(0, 'offline', 'Can’t reach our servers. Local features still work.');
  }
  if (r.status === 204) return undefined as T;
  if (!r.ok) throw await toFailure(r);
  return (await r.json()) as T;
}

// ── Auth ──
export async function requestCode(email: string) {
  return call<{ sent: boolean; dev_code?: string }>('POST', '/v1/auth/otp/request', { email });
}
export async function verifyCode(email: string, code: string) {
  const t = await call<{ access_token: string; refresh_token: string; user: { email: string } }>('POST', '/v1/auth/otp/verify', { email, code, device: 'extension' });
  await setSession({ access_token: t.access_token, refresh_token: t.refresh_token, email: t.user.email });
}
export const GOOGLE_ENABLED = !!__GOOGLE_CLIENT_ID__;

/**
 * "Continue with Google": OpenID Connect in Google's own window (chrome.identity.launchWebAuthFlow). We get an
 * ID token for our client, bound to a fresh nonce, and exchange it at our API for our own session. We never see
 * the Google password, and we request no Google API access beyond name and email.
 */
export async function signInWithGoogle() {
  if (!GOOGLE_ENABLED) throw new ApiFailure(0, 'unavailable', 'Google sign-in isn’t set up in this build.');
  const nonce = randomToken(24);
  const state = randomToken(16);
  const url = new URL(__GOOGLE_AUTH_URL__);
  url.search = new URLSearchParams({
    client_id: __GOOGLE_CLIENT_ID__,
    response_type: 'id_token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email profile',
    nonce,
    state,
    prompt: 'select_account',
  }).toString();
  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    throw new ApiFailure(0, 'cancelled', /did not approve|closed|cancel/i.test(msg) ? 'Google sign-in was cancelled.' : 'Couldn’t open Google sign-in. Try again, or use your email.');
  }
  const params = new URLSearchParams(new URL(redirect ?? 'https://x/').hash.slice(1));
  if (params.get('error')) throw new ApiFailure(0, 'cancelled', 'Google sign-in was cancelled.');
  const idToken = params.get('id_token');
  if (!idToken || params.get('state') !== state) throw new ApiFailure(0, 'invalid', 'Google sign-in didn’t complete. Please try again.');
  const t = await call<{ access_token: string; refresh_token: string; user: { email: string } }>('POST', '/v1/auth/google', { id_token: idToken, nonce, device: 'extension' });
  await setSession({ access_token: t.access_token, refresh_token: t.refresh_token, email: t.user.email });
}

export async function signOut() {
  await call('POST', '/v1/auth/logout').catch(() => undefined);
  await setSession(null);
}
export const me = () => call<MeResponse>('GET', '/v1/me');
export const usage = () => call<UsageResponse>('GET', '/v1/usage');
/** Account settings on our servers; turning content_opt_in off deletes the saved job posts, resumes and results. */
export const updateSettings = (patch: { content_opt_in?: boolean; telemetry_opt_in?: boolean; history_opt_in?: boolean }) => call<void>('PATCH', '/v1/account/settings', patch);
export const deleteSavedContent = () => call<{ deleted: number }>('DELETE', '/v1/account/content');

// ── Signed public config (kill switches, extractor adapters, announcements) ──
export async function config(): Promise<PublicConfig | null> {
  const cached = (await chrome.storage.local.get('config')).config as { at: number; config: PublicConfig } | undefined;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.config;
  try {
    const r = await fetch(`${API_URL}/v1/config`);
    if (!r.ok) return cached?.config ?? null;
    const signed = (await r.json()) as SignedConfig;
    // An unsigned or tampered config is ignored: the extension keeps its built-in defaults.
    if (!__CONFIG_PUBLIC_KEY__ || !(await verifyConfig(signed, JSON.parse(__CONFIG_PUBLIC_KEY__) as JsonWebKey))) return cached?.config ?? null;
    await chrome.storage.local.set({ config: { at: Date.now(), config: signed.config } });
    return signed.config;
  } catch {
    return cached?.config ?? null;
  }
}

// ── Jobs and matching ──
export function analyzeJob(job: ExtractedJob) {
  return call<AnalyzeJobResponse>('POST', '/v1/jobs/analyze', {
    jd_text: job.description_text,
    jd_hash: job.jd_hash,
    source: { ...(job.source.host ? { host: job.source.host } : {}), adapter: job.source.adapter, layers_used: job.source.layers_used },
    structured_hint: {
      ...(job.fields.title ? { title: job.fields.title } : {}),
      ...(job.fields.company ? { company: job.fields.company } : {}),
      ...(job.fields.location.length ? { location: job.fields.location } : {}),
    },
  });
}
export function mapMatches(body: { job_analysis_id?: string; requirements: Array<{ req_id: string; text: string; type: string }>; evidence: ClaimLite[] }) {
  return call<MatchMapResponse>('POST', '/v1/matches/map', body);
}

// ── Optimizations ──
export function createOptimization(body: OptimizeRequest, idempotencyKey: string) {
  return call<{ optimization_id: string; status: string }>('POST', '/v1/optimizations', body, { 'idempotency-key': idempotencyKey });
}
export const getOptimization = (id: string, ack = false) => call<OptimizationResponse>('GET', `/v1/optimizations/${id}${ack ? '?ack=1' : ''}`);
export const cancelOptimization = (id: string) => call('POST', `/v1/optimizations/${id}/cancel`);
export const postScores = (id: string, s: { before_score: number; after_score: number; ceiling_score: number }) => call('POST', `/v1/optimizations/${id}/scores`, s);

const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'canceled']);

/**
 * Follows progress over SSE (fetch-based, so the bearer token is sent in a header, not the URL). If the stream
 * drops, falls back to polling until the job reaches a terminal state.
 */
export async function followOptimization(id: string, onEvent: (e: OptimizationEvent) => void, signal: AbortSignal): Promise<OptimizationEvent> {
  let last: OptimizationEvent | null = null;
  try {
    let r = await raw('GET', `/v1/optimizations/${id}/events`, undefined, { accept: 'text/event-stream' }, signal);
    if (r.status === 401 && (await refresh())) r = await raw('GET', `/v1/optimizations/${id}/events`, undefined, { accept: 'text/event-stream' }, signal);
    if (!r.ok || !r.body) throw await toFailure(r);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        last = JSON.parse(data) as OptimizationEvent;
        onEvent(last);
        if (TERMINAL.has(last.status)) {
          void reader.cancel();
          return last;
        }
      }
    }
  } catch (e) {
    if (signal.aborted) throw e;
  }
  // Polling fallback. The job keeps running on the server, so short network drops are waited out (up to ~2
  // minutes of consecutive failures) instead of reporting the run as failed.
  let failures = 0;
  while (!signal.aborted) {
    try {
      const o = await getOptimization(id);
      failures = 0;
      last = { status: o.status, progress: TERMINAL.has(o.status) ? 1 : (last?.progress ?? 0) };
      onEvent(last);
      if (TERMINAL.has(o.status)) return last;
    } catch (e) {
      if (!(e instanceof ApiFailure) || e.code !== 'offline' || ++failures > 40) throw e;
    }
    await new Promise((res) => setTimeout(res, failures ? Math.min(3000 * failures, 10_000) : 2000));
  }
  throw new DOMException('Aborted', 'AbortError');
}

// ── Billing ──
export interface PublicPlan {
  plan_id: PlanId;
  name: string;
  price: { currency: string; amount: string; interval: string | null } | null;
  features: string[];
  badge?: string | null;
}
export const plans = () => call<{ plans: PublicPlan[] }>('GET', '/v1/billing/plans');
export const previewCoupon = (code: string, plan_id: PlanId) =>
  call<{ percent_off: number; summary: string; price: { currency: string; list: string; discounted: string } }>('POST', '/v1/billing/coupons/preview', { code, plan_id });
export const checkout = (plan_id: PlanId, coupon_code: string | undefined, idempotencyKey: string) =>
  call<{ checkout_url: string; transaction_id: string }>('POST', '/v1/billing/checkout', { plan_id, ...(coupon_code ? { coupon_code } : {}) }, { 'idempotency-key': idempotencyKey });

export const sendFeedback = (f: { optimization_id?: string; target: 'score' | 'bullet' | 'summary' | 'export' | 'extraction' | 'general'; rating?: number; reason_code?: string; comment?: string }) =>
  call('POST', '/v1/feedback', { ...f, content_shared: false });
