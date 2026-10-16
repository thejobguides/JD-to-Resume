import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSigningKeys } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { extractClaims, toClaimLite } from '@jmo/evidence';
import { analyzeJobText, extractJobFromText } from '@jmo/job-extraction';
import { toOptResume, toPlainText } from '@jmo/resume';
import { sampleResume } from '@jmo/resume/fixtures';
import { scoreResume, selectTargets } from '@jmo/scoring';
import { activateVersion, consoleMailer, createDraft, createServices, getActive, loadEnv, type Services } from '@jmo/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAvailable, freshDatabase } from '../../../tests/setup/db';
import { createApp } from './app';
import { resetRateLimits } from './middleware';

// Every public route and its error paths (mock AI, fake Stripe), plus regression tests for the security review.

const up = await dbAvailable();

describe.skipIf(!up)('Public API routes (Postgres)', () => {
  let sql: Sql;
  let services: Services;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  const jdHtml = readFileSync(resolve(__dirname, '../../../tests/fixtures/jd/lever-jsonld.html'), 'utf8');
  const jdText = (() => {
    const t = jdHtml.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
    return t.slice(t.indexOf('Acme Analytics is hiring'), t.indexOf('© Acme')).replace(/\n{2,}/g, '\n').trim();
  })();

  beforeAll(async () => {
    ({ sql } = await freshDatabase('jmo_test_routes'));
    const signing = await generateSigningKeys();
    services = createServices(loadEnv({ ENV: 'test', DATABASE_URL: 'unused', CONFIG_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(signing.privateJwk) }), { sql, mailer: consoleMailer(() => undefined) });
    app = createApp(services);
    ownerId = (await sql<Array<{ id: string }>>`SELECT user_id AS id FROM admin_members WHERE role = 'owner'`)[0]!.id;
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
  });

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const auth = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

  async function requestCode(email: string) {
    resetRateLimits();
    const r = await json('POST', '/v1/auth/otp/request', { email });
    expect(r.status).toBe(200);
    return ((await r.json()) as { dev_code: string }).dev_code;
  }
  async function login(email: string) {
    const code = await requestCode(email);
    const r = await json('POST', '/v1/auth/otp/verify', { email, code, device: 'test' });
    expect(r.status).toBe(200);
    return (await r.json()) as { access_token: string; refresh_token: string; user: { id: string } };
  }
  /** Changes one runtime-config namespace the way the admin panel does (draft → activate). */
  async function setConfig(ns: Parameters<typeof getActive>[1], change: (d: Record<string, any>) => void) {
    const data = structuredClone((await getActive(sql, ns, 'production'))!.data) as Record<string, any>;
    change(data);
    const d = await createDraft(sql, ns, 'production', data, 'integration test config change', { id: ownerId, role: 'owner' });
    await activateVersion(sql, d.id, { id: ownerId, role: 'owner' }, { reason: 'integration test config change' });
    services.config.invalidate();
  }
  const month = () => `m:${new Date().toISOString().slice(0, 7)}`;
  const day = () => `d:${new Date().toISOString().slice(0, 10)}`;
  async function setCounters(userId: string, period: string, set: Record<string, number>) {
    await sql`INSERT INTO usage_counters (user_id, period) VALUES (${userId}, ${period}) ON CONFLICT DO NOTHING`;
    for (const [k, v] of Object.entries(set)) await sql.unsafe(`UPDATE usage_counters SET ${k} = $1 WHERE user_id = $2 AND period = $3`, [v, userId, period]);
  }
  function optimizeBody(analysis = analyzeJobText(jdText, { title: 'Senior Data Engineer' })) {
    const { resume, claims } = extractClaims(sampleResume());
    const before = scoreResume({ analysis, resume, claims });
    return { job_analysis: analysis, resume: toOptResume(resume), claims: toClaimLite(claims), targets: { req_ids: selectTargets(before), edit_budget: { bullets: 8, summary: true, skills_order: true } } };
  }
  async function runOptimization(token: string, key: string) {
    resetRateLimits();
    const r = await json('POST', '/v1/optimizations', optimizeBody(), auth(token, { 'idempotency-key': key }));
    expect(r.status).toBe(202);
    const { optimization_id } = (await r.json()) as { optimization_id: string };
    await (await app.request(`/v1/optimizations/${optimization_id}/events`, { headers: auth(token) })).text();
    return optimization_id;
  }

  // ── Platform ──

  it('health, request ids, CORS and the error envelope', async () => {
    const h = await app.request('/v1/health');
    expect(await h.json()).toEqual({ ok: true, payments: 'fake', env: 'test' });
    expect((await app.request('/v1/health', { headers: { 'x-request-id': 'req-12345678' } })).headers.get('x-request-id')).toBe('req-12345678');
    expect((await app.request('/v1/health', { headers: { 'x-request-id': 'bad id!' } })).headers.get('x-request-id')).not.toBe('bad id!');

    const preflight = (origin: string) => app.request('/v1/me', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
    expect((await preflight('http://localhost:5175')).headers.get('access-control-allow-origin')).toBe('http://localhost:5175');
    expect((await preflight('chrome-extension://abcdefghijklmnop')).headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdefghijklmnop');
    for (const evil of ['https://evil.example', 'http://localhost.evil.example', 'https://localhost:5175']) {
      expect((await preflight(evil)).headers.get('access-control-allow-origin'), evil).not.toBe(evil);
    }

    const nf = await app.request('/v1/no-such-route');
    expect(nf.status).toBe(404);
    expect((await errorOf(nf)).code).toBe('not_found');
    const malformed = await json('POST', '/v1/auth/otp/request', '{"email":');
    expect(malformed.status).toBe(400);
    expect((await errorOf(malformed)).message).toBe('Malformed JSON body.');
    const invalid = await json('POST', '/v1/auth/otp/request', { email: 'not-an-email' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).details?.issues).toEqual([expect.objectContaining({ path: 'email' })]);
  });

  it('version gate and maintenance mode', async () => {
    const t = (await login('gate@example.org')).access_token;
    expect((await app.request('/v1/me', { headers: auth(t, { 'x-extension-version': '0.0.9' }) })).status).toBe(426);
    expect((await app.request('/v1/me', { headers: auth(t, { 'x-extension-version': '0.1.0' }) })).status).toBe(200);
    expect((await app.request('/v1/me', { headers: auth(t, { 'x-extension-version': 'dev-build' }) })).status).toBe(200);

    await setConfig('kill_switches', (d) => (d.maintenance = true));
    try {
      const m = await app.request('/v1/me', { headers: auth(t) });
      expect(m.status).toBe(503);
      expect((await errorOf(m)).code).toBe('maintenance');
      expect((await app.request('/v1/health')).status).toBe(200);
      expect((await app.request('/v1/config')).status).toBe(200);
      // Webhooks keep flowing during maintenance (a bad signature is still a 401, not a 503).
      expect((await app.request('/v1/webhooks/stripe', { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=x' } })).status).toBe(401);
    } finally {
      await setConfig('kill_switches', (d) => (d.maintenance = false));
    }
  });

  // ── Auth ──

  it('a sign-in code allows 5 wrong guesses, then even the right code is refused (brute-force regression)', async () => {
    const email = 'bruteforce@example.org';
    const code = await requestCode(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      resetRateLimits();
      const r = await json('POST', '/v1/auth/otp/verify', { email, code: wrong });
      expect(r.status).toBe(401);
      expect((await errorOf(r)).message).toBe('That code is not correct.');
    }
    const [v] = await sql<Array<{ attempts: number }>>`SELECT attempts FROM auth_verifications WHERE identifier = ${email} ORDER BY created_at DESC LIMIT 1`;
    expect(v!.attempts).toBe(5); // the counter survives the failed requests
    resetRateLimits();
    const locked = await json('POST', '/v1/auth/otp/verify', { email, code });
    expect(locked.status).toBe(429);
    // A fresh code works again.
    const fresh = await requestCode(email);
    expect((await json('POST', '/v1/auth/otp/verify', { email, code: fresh })).status).toBe(200);
  });

  it('codes expire, sign in once, and are limited to 5 per hour per address', async () => {
    const email = 'codes@example.org';
    const code = await requestCode(email);
    await sql`UPDATE auth_verifications SET expires_at = now() - interval '1 second' WHERE identifier = ${email}`;
    resetRateLimits();
    expect((await errorOf(await json('POST', '/v1/auth/otp/verify', { email, code }))).message).toMatch(/expired/);
    const code2 = await requestCode(email);
    resetRateLimits();
    expect((await json('POST', '/v1/auth/otp/verify', { email, code: code2 })).status).toBe(200);
    resetRateLimits();
    expect((await json('POST', '/v1/auth/otp/verify', { email, code: code2 })).status).toBe(401); // already used
    for (let i = 0; i < 3; i++) await requestCode(email); // 5 codes this hour in total
    resetRateLimits();
    const sixth = await json('POST', '/v1/auth/otp/request', { email });
    expect(sixth.status).toBe(429);
    expect((await errorOf(sixth)).message).toMatch(/Too many codes/);
  });

  it('the hourly code limit holds when many requests for one address arrive at once', async () => {
    // Seen live: a "Send code" button clicked repeatedly while the server woke up sent 7 requests in one second, and
    // all of them passed the count before any insert.
    const email = 'burst@example.org';
    resetRateLimits();
    const results = await Promise.all(Array.from({ length: 8 }, () => json('POST', '/v1/auth/otp/request', { email })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    expect((await sql`SELECT count(*)::int AS n FROM auth_verifications WHERE identifier = ${email}`)[0]!.n).toBe(5);
  });

  it('sessions: bad tokens, logout of one device, logout everywhere, refresh after logout', async () => {
    expect((await errorOf(await app.request('/v1/me'))).code).toBe('unauthenticated');
    expect((await app.request('/v1/me', { headers: auth('not-a-jwt') })).status).toBe(401);
    const a = await login('devices@example.org');
    const b = await login('devices@example.org');
    expect((await json('POST', '/v1/auth/logout', undefined, auth(a.access_token))).status).toBe(204);
    const revoked = await app.request('/v1/me', { headers: auth(a.access_token) });
    expect(revoked.status).toBe(401);
    expect((await errorOf(revoked)).code).toBe('session_revoked');
    resetRateLimits();
    expect((await json('POST', '/v1/auth/refresh', { refresh_token: a.refresh_token })).status).toBe(401);
    expect((await app.request('/v1/me', { headers: auth(b.access_token) })).status).toBe(200);
    const c = await login('devices@example.org');
    expect((await json('POST', '/v1/auth/logout-all', undefined, auth(c.access_token))).status).toBe(204);
    expect((await app.request('/v1/me', { headers: auth(b.access_token) })).status).toBe(401);
    expect((await app.request('/v1/me', { headers: auth(c.access_token) })).status).toBe(401);
  });

  it('refresh-token reuse revokes the whole family, including a thief’s newer session (regression)', async () => {
    const victim = await login('victim@example.org');
    resetRateLimits();
    // The thief uses the stolen refresh token first and gets a fresh session.
    const thief = (await (await json('POST', '/v1/auth/refresh', { refresh_token: victim.refresh_token })).json()) as { access_token: string; refresh_token: string };
    expect((await app.request('/v1/me', { headers: auth(thief.access_token) })).status).toBe(200);
    // The victim's app then presents the same (already rotated) token: reuse is detected.
    const reuse = await json('POST', '/v1/auth/refresh', { refresh_token: victim.refresh_token });
    expect((await errorOf(reuse)).code).toBe('session_revoked');
    expect((await app.request('/v1/me', { headers: auth(thief.access_token) })).status).toBe(401);
    expect((await json('POST', '/v1/auth/refresh', { refresh_token: thief.refresh_token })).status).toBe(401);
    // Both the victim's reuse and the thief's later attempt are recorded.
    expect((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'refresh_reuse_detected' AND target_id = ${victim.user.id}`)[0]!.n).toBe(2);
  });

  it('paused sign-ups block new accounts only; accounts being deleted cannot sign back in', async () => {
    await login('existing@example.org');
    await setConfig('kill_switches', (d) => (d.signups = true));
    try {
      resetRateLimits();
      const r = await json('POST', '/v1/auth/otp/request', { email: 'brand-new@example.org' });
      expect(r.status).toBe(503);
      expect((await errorOf(r)).message).toMatch(/sign-ups are temporarily paused/);
      await login('existing@example.org');
    } finally {
      await setConfig('kill_switches', (d) => (d.signups = false));
    }
    const zombie = await login('zombie@example.org');
    await sql`UPDATE users SET status = 'pending_deletion' WHERE id = ${zombie.user.id}`;
    const code = await requestCode('zombie@example.org');
    const r = await json('POST', '/v1/auth/otp/verify', { email: 'zombie@example.org', code });
    expect(r.status).toBe(403);
    expect((await errorOf(r)).message).toMatch(/being deleted/);
  });

  // ── Account ──

  it('settings, usage and the account export', async () => {
    const t = (await login('settings@example.org')).access_token;
    expect((await json('PATCH', '/v1/account/settings', { display_name: 'Robin', telemetry_opt_in: true }, auth(t))).status).toBe(204);
    const me = (await (await app.request('/v1/me', { headers: auth(t) })).json()) as { display_name: string; plan: string; settings: Record<string, boolean> };
    expect(me).toMatchObject({ display_name: 'Robin', plan: 'free', settings: { telemetry_opt_in: true, history_opt_in: false, content_opt_in: false } });
    expect((await json('PATCH', '/v1/account/settings', { telemetry_opt_in: 'yes' }, auth(t))).status).toBe(400);
    const usage = (await (await app.request('/v1/usage', { headers: auth(t) })).json()) as { optimizations: { limit: number; used: number }; analyses: { limit: number } };
    expect(usage).toMatchObject({ optimizations: { limit: 3, used: 0 }, analyses: { limit: 15 } });
    const exp = (await (await app.request('/v1/account/export', { headers: auth(t) })).json()) as Record<string, unknown>;
    expect(Object.keys(exp)).toEqual(expect.arrayContaining(['user', 'subscription', 'usage', 'jobs', 'optimizations', 'feedback', 'credits', 'saved_content']));
    expect(exp.saved_content).toEqual([]);
  });

  // ── AI routes and their limits ──

  it('job analysis: hash check, size limit, cache, monthly quota, AI kill switch, free-tier pause, BYOK plan', async () => {
    const u = await login('limits@example.org');
    const t = u.access_token;
    const job = await extractJobFromText(jdText);
    const analyze = (extra: Record<string, unknown> = {}) => json('POST', '/v1/jobs/analyze', { jd_text: job.description_text, jd_hash: job.jd_hash, ...extra }, auth(t));
    resetRateLimits();
    expect(((await (await analyze()).json()) as { cache: string }).cache).toBe('miss');
    expect(((await (await analyze()).json()) as { cache: string }).cache).toBe('hit');
    expect((await json('POST', '/v1/jobs/analyze', { jd_text: 'x'.repeat(70 * 1024), jd_hash: job.jd_hash }, auth(t))).status).toBe(413);

    await setCounters(u.user.id, month(), { analyses: 15 });
    const over = await analyze();
    expect(over.status).toBe(429);
    expect(await errorOf(over)).toMatchObject({ code: 'quota_exceeded', details: expect.objectContaining({ limit: 15, used: 15 }) });
    await setCounters(u.user.id, month(), { analyses: 0 });

    await setConfig('kill_switches', (d) => (d.hosted_ai = true));
    try {
      expect((await errorOf(await analyze())).code).toBe('ai_unavailable');
      // Resume structuring is not hosted "AI tailoring" and keeps working.
      const lines = toPlainText(sampleResume()).split('\n').filter(Boolean).map((text, i) => ({ span_id: `s_k_1_${i + 1}`, text, page: 1 }));
      expect((await json('POST', '/v1/resumes/structure', { version_id: 'k', lines }, auth(t))).status).toBe(200);
    } finally {
      await setConfig('kill_switches', (d) => (d.hosted_ai = false));
    }
    await setConfig('budgets', (d) => (d.free_tier_pause = true));
    try {
      expect((await errorOf(await analyze())).code).toBe('ai_unavailable');
    } finally {
      await setConfig('budgets', (d) => (d.free_tier_pause = false));
    }
    await sql`INSERT INTO entitlement_grants (id, user_id, plan_id, starts_at, ends_at, source, reason, granted_by)
              VALUES (gen_random_uuid(), ${u.user.id}, 'byok_annual', now() - interval '1 hour', now() + interval '1 day', 'comp', 'integration test grant', ${ownerId})`;
    const byok = await analyze();
    expect(byok.status).toBe(429);
    expect((await errorOf(byok)).message).toMatch(/own API key/);
  });

  it('resume structuring is limited to 10 a day; matching and validations return only known ids and charge the analysis quota', async () => {
    const u = await login('structure@example.org');
    const t = u.access_token;
    const lines = toPlainText(sampleResume()).split('\n').filter(Boolean).map((text, i) => ({ span_id: `s_v_1_${i + 1}`, text, page: 1 }));
    resetRateLimits();
    expect((await json('POST', '/v1/resumes/structure', { version_id: 'v', lines: [] }, auth(t))).status).toBe(400);
    await setCounters(u.user.id, day(), { structures: 10 });
    expect((await errorOf(await json('POST', '/v1/resumes/structure', { version_id: 'v', lines }, auth(t)))).code).toBe('rate_limited');

    const { claims } = extractClaims(sampleResume());
    const evidence = toClaimLite(claims);
    const known = new Set(evidence.map((e) => e.claim_id));
    const m = await json('POST', '/v1/matches/map', { requirements: [{ req_id: 'req_1', text: 'Hands-on Kubernetes in production', type: 'must' }], evidence }, auth(t));
    expect(m.status).toBe(200);
    const mapped = (await m.json()) as { mappings: Array<{ req_id: string; claim_ids: string[] }>; cost_usd?: number };
    expect(mapped.cost_usd).toBeUndefined(); // internal accounting stays internal
    for (const x of mapped.mappings) {
      expect(x.req_id).toBe('req_1');
      for (const id of x.claim_ids) expect(known.has(id)).toBe(true);
    }
    const v = await json('POST', '/v1/validations', { pairs: [{ bullet_id: 'b1', text: 'Operated Kafka on Kubernetes', evidence_texts: ['Operated Kafka clusters on Kubernetes with Helm'] }] }, auth(t));
    expect(v.status).toBe(200);
    expect(((await v.json()) as { results: Array<{ bullet_id: string }> }).results.map((r) => r.bullet_id)).toEqual(['b1']);
    const usage = (await (await app.request('/v1/usage', { headers: auth(t) })).json()) as { analyses: { used: number } };
    expect(usage.analyses.used).toBe(2);
    expect((await json('POST', '/v1/validations', { pairs: [] }, auth(t))).status).toBe(400);
  });

  // ── Optimizations ──

  it('optimizations: validation, list, isolation between users, scores, acknowledgement, cancel, concurrency, burst limit', async () => {
    const alice = await login('opt-alice@example.org');
    const mallory = await login('opt-mallory@example.org');
    resetRateLimits();
    expect((await errorOf(await json('POST', '/v1/optimizations', optimizeBody(), auth(alice.access_token)))).message).toMatch(/Idempotency-Key/);
    const { job_analysis: _drop, ...noAnalysis } = optimizeBody();
    expect((await errorOf(await json('POST', '/v1/optimizations', noAnalysis, auth(alice.access_token, { 'idempotency-key': 'opt-none-0001' })))).message).toMatch(/job_analysis_id is unknown/);

    const id = await runOptimization(alice.access_token, 'opt-alice-0001');
    const list = (await (await app.request('/v1/optimizations', { headers: auth(alice.access_token) })).json()) as { data: Array<{ id: string; status: string }> };
    expect(list.data.map((x) => x.id)).toEqual([id]);
    expect(['succeeded', 'partial']).toContain(list.data[0]!.status);
    const sse = await (await app.request(`/v1/optimizations/${id}/events`, { headers: auth(alice.access_token) })).text();
    expect(sse).toMatch(/event: status/);
    expect(sse).toMatch(/"status":"(succeeded|partial)"/);

    // Another user can't see, follow, cancel or score it.
    for (const path of [`/v1/optimizations/${id}`, `/v1/optimizations/${id}/events`]) expect((await app.request(path, { headers: auth(mallory.access_token) })).status).toBe(404);
    expect((await json('POST', `/v1/optimizations/${id}/cancel`, undefined, auth(mallory.access_token))).status).toBe(404);
    expect((await json('POST', `/v1/optimizations/${id}/scores`, { before_score: 1, after_score: 2, ceiling_score: 3 }, auth(mallory.access_token))).status).toBe(204);
    expect((await sql`SELECT before_score FROM optimizations WHERE id = ${id}`)[0]!.before_score).toBeNull();

    // Scores: after is capped at the ceiling; out-of-range values are rejected.
    expect((await json('POST', `/v1/optimizations/${id}/scores`, { before_score: 40, after_score: 90, ceiling_score: 70 }, auth(alice.access_token))).status).toBe(204);
    expect((await sql`SELECT before_score, after_score, ceiling_score FROM optimizations WHERE id = ${id}`)[0]).toMatchObject({ before_score: 40, after_score: 70, ceiling_score: 70 });
    expect((await json('POST', `/v1/optimizations/${id}/scores`, { before_score: 40, after_score: 101, ceiling_score: 70 }, auth(alice.access_token))).status).toBe(400);

    // The result can be read until acknowledged, then it is gone from the server.
    const first = (await (await app.request(`/v1/optimizations/${id}?ack=1`, { headers: auth(alice.access_token) })).json()) as { result: unknown };
    expect(first.result).not.toBeNull();
    expect(((await (await app.request(`/v1/optimizations/${id}`, { headers: auth(alice.access_token) })).json()) as { result: unknown }).result).toBeNull();
    expect(((await (await json('POST', `/v1/optimizations/${id}/cancel`, undefined, auth(alice.access_token))).json()) as { status: string }).status).toMatch(/succeeded|partial/);

    // One optimization at a time per user.
    await setCounters(alice.user.id, month(), { in_flight: 1 });
    resetRateLimits();
    expect((await errorOf(await json('POST', '/v1/optimizations', optimizeBody(), auth(alice.access_token, { 'idempotency-key': 'opt-alice-0002' })))).code).toBe('concurrency_limit');
    await setCounters(alice.user.id, month(), { in_flight: 0 });

    // Burst limit (3 a minute), counted even for idempotent replays; retry-after is set.
    resetRateLimits();
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 4; i++) {
      last = await json('POST', '/v1/optimizations', optimizeBody(), auth(alice.access_token, { 'idempotency-key': 'opt-alice-0001' }));
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await app.request(`/v1/optimizations/00000000-0000-0000-0000-000000000000`, { headers: auth(alice.access_token) })).status).toBe(404);
    expect((await app.request('/v1/optimizations/not-a-uuid', { headers: auth(alice.access_token) })).status).toBe(400);
  });

  // ── Billing catalogue, feedback, internal routes ──

  it('the public plan list shows visible plans with their prices', async () => {
    const r = (await (await app.request('/v1/billing/plans')).json()) as { plans: Array<{ plan_id: string; price: { amount: string; interval: string | null } | null }> };
    const byId = Object.fromEntries(r.plans.map((p) => [p.plan_id, p.price]));
    expect(byId.pro_monthly).toMatchObject({ amount: '19.00', interval: '1 month' });
    expect(byId.pro_quarterly).toMatchObject({ amount: '45.00', interval: '3 month' });
    expect(byId.credit_pack).toMatchObject({ amount: '12.00', interval: null });
  });

  it('feedback: anonymous or signed in; an optimization reference must be your own', async () => {
    const owner = await login('fb-owner@example.org');
    const other = await login('fb-other@example.org');
    const id = await runOptimization(owner.access_token, 'opt-fb-000001');
    resetRateLimits();
    expect((await json('POST', '/v1/feedback', { target: 'general', rating: 5, comment: 'Nice' })).status).toBe(201);
    expect((await json('POST', '/v1/feedback', { target: 'bullet', optimization_id: id, rating: 1 }, auth(owner.access_token))).status).toBe(201);
    expect((await json('POST', '/v1/feedback', { target: 'bullet', optimization_id: id, rating: 1 }, auth(other.access_token))).status).toBe(404);
    expect((await json('POST', '/v1/feedback', { target: 'bullet', optimization_id: id, rating: 1 })).status).toBe(404);
    expect((await json('POST', '/v1/feedback', { target: 'nonsense' })).status).toBe(400);
    const rows = await sql`SELECT user_id, optimization_id FROM feedback ORDER BY created_at`;
    expect(rows.map((r) => [r.user_id === null, r.optimization_id === id])).toEqual([[true, false], [false, true]]);
  });

  it('internal endpoints are invisible without the internal token', async () => {
    for (const path of ['/internal/config/invalidate', '/internal/credentials/x/test', '/internal/evals/run']) {
      expect((await app.request(path, { method: 'POST', body: '{}' })).status, path).toBe(404);
      expect((await app.request(path, { method: 'POST', body: '{}', headers: { 'x-internal-token': 'guess' } })).status, path).toBe(404);
    }
    const ok = await app.request('/internal/config/invalidate', { method: 'POST', headers: { 'x-internal-token': services.env.INTERNAL_TOKEN } });
    expect(await ok.json()).toEqual({ ok: true });
  });
});
