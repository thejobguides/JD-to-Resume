import { ProviderError } from '../types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Maps HTTP failures to error classes (architecture.md §14.1). Spend caps are non-retryable. */
export async function classifyHttp(res: Response, provider: string): Promise<ProviderError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, 2000);
  } catch {
    body = '';
  }
  const ra = Number(res.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
  const lower = body.toLowerCase();
  if (res.status === 401 || res.status === 403) return new ProviderError('auth', `${provider}: authentication failed (${res.status})`, res.status);
  if (res.status === 402 || /insufficient_quota|spend[_ ]limit|billing|credit balance|exceeded your current quota/.test(lower)) {
    return new ProviderError('spend_cap', `${provider}: spend cap or billing limit reached`, res.status);
  }
  if (res.status === 429) return new ProviderError('rate_limited', `${provider}: rate limited`, res.status, retryAfterMs);
  if (res.status === 400 || res.status === 404 || res.status === 422) return new ProviderError('invalid_request', `${provider}: invalid request (${res.status}): ${body.slice(0, 300)}`, res.status);
  if (res.status === 408 || res.status === 504) return new ProviderError('timeout', `${provider}: timeout`, res.status);
  if (res.status >= 500) return new ProviderError('server', `${provider}: server error ${res.status}`, res.status, retryAfterMs);
  return new ProviderError('server', `${provider}: unexpected status ${res.status}`, res.status);
}

export async function postJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, provider: string, signal?: AbortSignal, timeoutMs = 90_000): Promise<{ json: Record<string, unknown>; requestId?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new ProviderError('timeout', `${provider}: request timed out or was cancelled`);
      throw new ProviderError('retryable_transport', `${provider}: network error: ${(e as Error).message}`);
    }
    if (!res.ok) throw await classifyHttp(res, provider);
    const json = (await res.json()) as Record<string, unknown>;
    const requestId = res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? undefined;
    return { json, ...(requestId ? { requestId } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Rough token estimate for providers that return no usage (≈ 4 chars/token for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
