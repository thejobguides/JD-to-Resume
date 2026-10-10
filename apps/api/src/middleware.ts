import { ApiError, EXTENSION_MIN_VERSION, uuidv7 } from '@jmo/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from './context';

// Shared middleware (api-design.md §2): request ids, error envelope, auth, version gate, burst limits, idempotency.

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : uuidv7();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
};

export function errorResponse(c: Context<AppEnv>, err: unknown) {
  const rid = c.get('requestId');
  if (err instanceof ApiError) {
    if (err.code === 'rate_limited' && typeof err.details?.retry_after_s === 'number') c.header('retry-after', String(err.details.retry_after_s));
    return c.json(err.toEnvelope(rid), err.status as 400);
  }
  if (err instanceof SyntaxError) return c.json(new ApiError('invalid_request', 'Malformed JSON body.').toEnvelope(rid), 400);
  // A malformed id in the URL (e.g. not a UUID) is the caller's mistake, not a server error.
  if ((err as { code?: string })?.code === '22P02') return c.json(new ApiError('invalid_request', 'Invalid identifier.').toEnvelope(rid), 400);
  const name = (err as Error)?.name;
  if (name === 'AiUnavailableError') return c.json(new ApiError('ai_unavailable', 'AI is temporarily unavailable. Your quota was not used.').toEnvelope(rid), 503);
  console.error(`[${rid}]`, err);
  return c.json(new ApiError('internal', 'Something went wrong.', { event_id: rid }).toEnvelope(rid), 500);
}

/** Parses and validates a JSON body; never logs it (privacy rule: bodies are never logged). */
export async function body<S extends z.ZodType>(c: Context<AppEnv>, schema: S, maxBytes = 256 * 1024): Promise<z.infer<S>> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > maxBytes) throw new ApiError('payload_too_large', 'Request body is too large.');
  const text = await c.req.text();
  if (text.length > maxBytes) throw new ApiError('payload_too_large', 'Request body is too large.');
  let json: unknown;
  try {
    json = JSON.parse(text || '{}');
  } catch {
    throw new ApiError('invalid_request', 'Malformed JSON body.');
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new ApiError('invalid_request', 'Request validation failed.', { issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const h = c.req.header('authorization');
  if (h?.startsWith('Bearer ')) {
    const { auth } = c.get('deps');
    const claims = await auth.verifyAccess(h.slice(7), 'ext');
    c.set('user', claims);
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) throw new ApiError('unauthenticated', 'Sign in required.');
  const { auth } = c.get('deps');
  const claims = await auth.verifyAccess(h.slice(7), 'ext');
  const s = await auth.sessionActive(claims.sid);
  if (!s.active) throw new ApiError('session_revoked', 'Session revoked. Please sign in again.');
  c.set('user', claims);
  await next();
};

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export const versionGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const v = c.req.header('x-extension-version');
  if (v && /^\d+\.\d+\.\d+$/.test(v)) {
    if (cmpVersion(v, EXTENSION_MIN_VERSION) < 0) throw new ApiError('extension_outdated', 'Please update the extension.');
  }
  if ((await c.get('deps').config.get()).config.kill_switches.maintenance && !c.req.path.startsWith('/v1/config') && !c.req.path.startsWith('/v1/webhooks')) {
    throw new ApiError('maintenance', 'We are doing maintenance. Local features still work.');
  }
  await next();
};

// In-memory sliding window (Node). The Workers deployment uses the Rate Limiting binding (api-design.md §5.1).
const windows = new Map<string, number[]>();
export function rateLimit(group: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfg = (await c.get('deps').config.get()).config;
    const limit = cfg.limits.burst_per_minute[group] ?? 60;
    const who = c.get('user')?.sub ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'anon';
    const key = `${group}:${who}`;
    const now = Date.now();
    const hits = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= limit) {
      c.header('x-ratelimit-limit', String(limit));
      c.header('x-ratelimit-remaining', '0');
      throw new ApiError('rate_limited', 'Too many requests. Please slow down.', { retry_after_s: Math.ceil((60_000 - (now - hits[0]!)) / 1000) });
    }
    hits.push(now);
    windows.set(key, hits);
    c.header('x-ratelimit-limit', String(limit));
    c.header('x-ratelimit-remaining', String(limit - hits.length));
    await next();
  };
}

export function resetRateLimits() {
  windows.clear();
}

export function requireIdempotencyKey(c: Context<AppEnv>): string {
  const k = c.req.header('idempotency-key');
  if (!k || !/^[\w-]{8,100}$/.test(k)) throw new ApiError('invalid_request', 'Idempotency-Key header is required.');
  return k;
}

/** Daily spend for the global circuit breaker (cached 60 s). */
let spendCache: { at: number; usd: number } | null = null;
export async function dailySpend(c: Context<AppEnv>): Promise<number> {
  if (spendCache && Date.now() - spendCache.at < 60_000) return spendCache.usd;
  const [r] = await c.get('deps').sql<Array<{ c: string }>>`SELECT COALESCE(sum(cost_usd), 0) AS c FROM ai_requests WHERE created_at >= date_trunc('day', now())`;
  spendCache = { at: Date.now(), usd: Number(r?.c ?? 0) };
  return spendCache.usd;
}
