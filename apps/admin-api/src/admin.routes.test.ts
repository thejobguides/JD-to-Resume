import { createApp, resetRateLimits } from '@jmo/api';
import { generateSigningKeys } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { extractClaims, toClaimLite } from '@jmo/evidence';
import { extractJobFromText } from '@jmo/job-extraction';
import { toOptResume } from '@jmo/resume';
import { sampleResume } from '@jmo/resume/fixtures';
import { scoreResume, selectTargets } from '@jmo/scoring';
import { AuthService, consoleMailer, createServices, fakeStripe, loadEnv, type PaymentGateway, type Services } from '@jmo/server';
import { encryptSecret, generateVaultKeyPair } from '@jmo/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAvailable, freshDatabase } from '../../../tests/setup/db';
import { createAdminApp } from './app';

// Every admin route not covered by admin.test.ts: sign-in and step-up limits, the role matrix, users & support,
// admins, audit (CSV-safe export), providers/keys/models, analytics, config, coupons, prices, saved content, system.

const up = await dbAvailable();

describe.skipIf(!up)('Admin API routes (Postgres)', () => {
  let sql: Sql;
  let api: Services;
  let apiApp: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof createAdminApp>;
  let vaultPublic: JsonWebKey;
  let owner = '';
  const payments: Array<{ method: string; args: unknown[] }> = [];

  beforeAll(async () => {
    ({ sql } = await freshDatabase('jmo_test_admin_routes'));
    const vault = await generateVaultKeyPair();
    const signing = await generateSigningKeys();
    vaultPublic = vault.publicJwk;
    const base = { ENV: 'test', DATABASE_URL: 'unused', CONFIG_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(signing.privateJwk) };
    api = createServices(loadEnv({ ...base, VAULT_PRIVATE_KEY_JWK: JSON.stringify(vault.privateJwk) }), { sql, mailer: consoleMailer(() => undefined) });
    apiApp = createApp(api);
    const adminEnv = loadEnv({ ...base, VAULT_PUBLIC_KEY_JWK: JSON.stringify(vault.publicJwk) });
    const fake = fakeStripe('http://web');
    const recorded = new Proxy(fake, {
      get: (t, m: string) => (typeof (t as any)[m] === 'function' ? (...args: unknown[]) => (payments.push({ method: m, args }), (t as any)[m](...args)) : (t as any)[m]),
    }) as PaymentGateway;
    admin = createAdminApp({
      sql,
      env: adminEnv,
      config: api.config,
      auth: new AuthService(sql, adminEnv.JWT_SECRET, consoleMailer(() => undefined), { exposeDevCode: true }),
      billing: api.billing,
      payments: recorded,
      internal: async (path, body) => (await apiApp.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': adminEnv.INTERNAL_TOKEN }, body: JSON.stringify(body ?? {}) })).json(),
    });
    owner = (await adminLogin('owner@example.com')).json.access_token;
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
  });

  const call = async (method: string, path: string, body?: unknown, t = owner) => {
    const r = await admin.request(`/admin/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, type: r.headers.get('content-type') ?? '', json: (text && r.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text) as any };
  };
  async function adminLogin(email: string) {
    await sql`DELETE FROM auth_verifications WHERE identifier = ${email}`;
    const r1 = await call('POST', '/auth/otp/request', { email }, '');
    return call('POST', '/auth/otp/verify', { email, code: r1.json.dev_code }, '');
  }
  /** A fresh step-up for `t` (older codes are cleared: the 5-codes-an-hour limit is tested in routes.test.ts). */
  async function stepUp(t = owner, email = 'owner@example.com') {
    await sql`DELETE FROM auth_verifications WHERE identifier = ${email}`;
    const r = await call('POST', '/auth/step-up/request', {}, t);
    expect((await call('POST', '/auth/step-up/verify', { code: r.json.dev_code }, t)).status).toBe(200);
  }
  const ageStepUp = () => sql`UPDATE auth_sessions SET last_step_up_at = now() - interval '11 minutes' WHERE kind = 'admin'`;
  const apiJson = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    apiApp.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function userLogin(email: string) {
    resetRateLimits();
    const r1 = await apiJson('POST', '/v1/auth/otp/request', { email });
    const r2 = await apiJson('POST', '/v1/auth/otp/verify', { email, code: ((await r1.json()) as { dev_code: string }).dev_code });
    return (await r2.json()) as { access_token: string; user: { id: string } };
  }
  async function useTheProduct(t: string, key: string, requestId?: string) {
    resetRateLimits();
    const h = { authorization: `Bearer ${t}`, ...(requestId ? { 'x-request-id': requestId } : {}) };
    const job = await extractJobFromText('Data Analyst\nRequirements:\n• 2+ years of SQL and Tableau\n• Python for data analysis\n• Build dashboards for finance stakeholders\nResponsibilities:\n• Maintain weekly reporting pipelines');
    const a = (await (await apiJson('POST', '/v1/jobs/analyze', { jd_text: job.description_text, jd_hash: job.jd_hash, structured_hint: { title: 'Data Analyst' } }, h)).json()) as { job_analysis_id: string; analysis: Parameters<typeof scoreResume>[0]['analysis'] };
    const { resume, claims } = extractClaims(sampleResume());
    const r = await apiJson('POST', '/v1/optimizations', { job_analysis_id: a.job_analysis_id, resume: toOptResume(resume), claims: toClaimLite(claims), targets: { req_ids: selectTargets(scoreResume({ analysis: a.analysis, resume, claims })), edit_budget: { bullets: 8, summary: true, skills_order: true } } }, { ...h, 'idempotency-key': key });
    const { optimization_id } = (await r.json()) as { optimization_id: string };
    await (await apiApp.request(`/v1/optimizations/${optimization_id}/events`, { headers: h })).text();
    return optimization_id;
  }
  const auditActions = async (prefix: string) => (await sql<Array<{ action: string }>>`SELECT action FROM audit_log WHERE action LIKE ${`${prefix}%`}`).map((r) => r.action);
  async function addAdmin(email: string, role: string) {
    await stepUp();
    expect((await call('POST', '/admins', { email, role, reason: 'integration test team member' })).status).toBe(201);
    return (await adminLogin(email)).json.access_token as string;
  }

  // ── Sign-in, step-up ──

  it('sign-in: no enumeration, non-admin users refused, refresh rotates (reuse revokes), logout ends the session', async () => {
    expect(await (await call('POST', '/auth/otp/request', { email: 'stranger@example.org' }, '')).json).toEqual({ sent: true });
    await userLogin('just-a-user@example.org');
    expect((await call('POST', '/auth/otp/request', { email: 'just-a-user@example.org' }, '')).json).toEqual({ sent: true });

    await sql`DELETE FROM auth_verifications WHERE identifier = 'owner@example.com'`;
    const r1 = await call('POST', '/auth/otp/request', { email: 'owner@example.com' }, '');
    const s = (await call('POST', '/auth/otp/verify', { email: 'owner@example.com', code: r1.json.dev_code }, '')).json;
    const rotated = await call('POST', '/auth/refresh', { refresh_token: s.refresh_token }, '');
    expect(rotated.status).toBe(200);
    expect((await call('GET', '/me', undefined, rotated.json.access_token)).json.role).toBe('owner');
    expect((await call('POST', '/auth/refresh', { refresh_token: s.refresh_token }, '')).status).toBe(401); // reuse
    expect((await call('GET', '/me', undefined, rotated.json.access_token)).status).toBe(401); // whole family revoked
    const fresh = (await adminLogin('owner@example.com')).json.access_token as string;
    expect((await call('POST', '/auth/logout', undefined, fresh)).status).toBe(204);
    expect((await call('GET', '/me', undefined, fresh)).status).toBe(401);
  });

  it('step-up allows 5 wrong codes, then refuses even the right one (brute-force regression)', async () => {
    const t = (await adminLogin('owner@example.com')).json.access_token as string;
    await ageStepUp();
    await sql`DELETE FROM auth_verifications WHERE identifier = 'owner@example.com'`;
    const code = (await call('POST', '/auth/step-up/request', {}, t)).json.dev_code as string;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await call('POST', '/auth/step-up/verify', { code: wrong }, t)).status).toBe(401);
    expect((await call('POST', '/auth/step-up/verify', { code }, t)).status).toBe(429);
    expect((await call('GET', '/me', undefined, t)).json.step_up_valid_until).not.toBeNull(); // still the old (aged) step-up
    await stepUp(t);
  });

  // ── Roles ──

  it('roles: analyst sees dashboards only; support has capped grants and can only switch features off; finance sees money', async () => {
    const analyst = await addAdmin('ana@example.org', 'analyst');
    const support = await addAdmin('sam@example.org', 'support');
    const finance = await addAdmin('fin@example.org', 'finance');
    const status = async (t: string, method: string, path: string, body?: unknown) => (await call(method, path, body, t)).status;

    expect(await status(analyst, 'GET', '/overview')).toBe(200);
    expect(await status(analyst, 'GET', '/content/stats')).toBe(200);
    for (const p of ['/users', '/content', '/audit', '/coupons', '/admins', '/system/health']) expect(await status(analyst, 'GET', p), p).toBe(403);

    const customer = await userLogin('support-case@example.org');
    expect((await call('POST', `/users/${customer.user.id}/credits`, { optimizations: 11, reason: 'goodwill after outage' }, support)).json.error.message).toMatch(/up to 10/);
    expect(await status(support, 'POST', `/users/${customer.user.id}/credits`, { optimizations: 5, reason: 'goodwill after outage' })).toBe(201);
    expect((await call('POST', `/users/${customer.user.id}/grants`, { plan_id: 'pro_monthly', days: 20, source: 'support', reason: 'goodwill after outage' }, support)).json.error.message).toMatch(/up to 14 days/);
    expect(await status(support, 'POST', `/users/${customer.user.id}/grants`, { plan_id: 'pro_monthly', days: 7, source: 'support', reason: 'goodwill after outage' })).toBe(201);
    expect(await status(support, 'GET', '/coupons')).toBe(200);
    expect(await status(support, 'POST', '/coupons', {})).toBe(403);
    expect(await status(support, 'GET', '/content')).toBe(403);
    const ks = (await call('GET', '/config/kill_switches')).json.active.data;
    expect(await status(support, 'POST', '/config/kill_switches/versions', { data: { ...ks, coupons: true }, change_note: 'pause coupons during incident' })).toBe(201);
    const on = { ...ks, coupons: true };
    await sql`UPDATE config_versions SET data = ${sql.json(on)} WHERE namespace = 'kill_switches' AND status = 'active'`;
    api.config.invalidate();
    expect((await call('POST', '/config/kill_switches/versions', { data: { ...on, coupons: false }, change_note: 'resume coupons after incident' }, support)).json.error.message).toMatch(/only switch features off/);
    await sql`UPDATE config_versions SET data = ${sql.json(ks)} WHERE namespace = 'kill_switches' AND status = 'active'`;
    api.config.invalidate();
    const supportAudit = (await call('GET', '/audit?limit=500', undefined, support)).json.data as Array<{ target_type: string; actor_email: string | null }>;
    expect(supportAudit.every((r) => r.target_type === 'user' || r.actor_email?.startsWith('s'))).toBe(true);

    expect(await status(finance, 'GET', '/users')).toBe(200);
    expect(await status(finance, 'POST', `/users/${customer.user.id}/credits`, { optimizations: 1, reason: 'should be refused' })).toBe(403);
    expect(await status(finance, 'GET', '/plans')).toBe(200);
    const financeAudit = (await call('GET', '/audit?limit=500', undefined, finance)).json.data as Array<{ action: string }>;
    expect(financeAudit.every((r) => /^(coupon|price|subscription|transaction)/.test(r.action))).toBe(true);
    const csv = await call('GET', '/audit/export', undefined, finance);
    expect(csv.status).toBe(200);
    expect(csv.type).toContain('text/csv');
  });

  // ── Users & support ──

  it('users & support: search, audited detail and email reveal, timeline, credits, grants, quota reset, suspend, sessions, deletion', async () => {
    const u = await userLogin('customer@example.org');
    const found = (await call('GET', '/users?query=customer')).json.data as Array<{ id: string; email_masked: string }>;
    expect(found.map((x) => x.id)).toContain(u.user.id);
    expect(found.find((x) => x.id === u.user.id)!.email_masked).not.toBe('customer@example.org');
    const detail = await call('GET', `/users/${u.user.id}`);
    expect(detail.json).toMatchObject({ saved_content: { opted_in: false, items: 0 }, plan: { plan: 'free' } });
    expect((await call('POST', `/users/${u.user.id}/reveal-email`)).json.email).toBe('customer@example.org');
    expect(await auditActions('user.')).toEqual(expect.arrayContaining(['user.view', 'user.email_reveal']));
    expect((await call('GET', `/users/${u.user.id}/timeline`)).status).toBe(200);
    expect((await call('GET', '/users/00000000-0000-0000-0000-000000000000')).status).toBe(404);

    expect((await call('POST', `/users/${u.user.id}/credits`, { optimizations: 3, reason: 'short' })).status).toBe(400); // reason too short
    expect((await call('POST', `/users/${u.user.id}/credits`, { optimizations: 3, reason: 'compensation for a failed run' })).status).toBe(201);
    const usage = (await (await apiApp.request('/v1/usage', { headers: { authorization: `Bearer ${u.access_token}` } })).json()) as { optimizations: { credits_remaining: number } };
    expect(usage.optimizations.credits_remaining).toBe(3);

    expect((await call('POST', `/users/${u.user.id}/grants`, { plan_id: 'free', days: 7, source: 'comp', reason: 'not a paid plan' })).status).toBe(400);
    const g = await call('POST', `/users/${u.user.id}/grants`, { plan_id: 'pro_monthly', days: 7, source: 'comp', reason: 'press review account' });
    const me = async () => ((await (await apiApp.request('/v1/me', { headers: { authorization: `Bearer ${u.access_token}` } })).json()) as { plan: string }).plan;
    expect(await me()).toBe('pro_monthly');
    expect((await call('DELETE', `/users/${u.user.id}/grants/${g.json.id}`, { reason: 'review period is over' })).status).toBe(204);
    expect(await me()).toBe('free');

    const month = `m:${new Date().toISOString().slice(0, 7)}`;
    await sql`INSERT INTO usage_counters (user_id, period, optimizations) VALUES (${u.user.id}, ${month}, 3) ON CONFLICT (user_id, period) DO UPDATE SET optimizations = 3`;
    expect((await call('POST', `/users/${u.user.id}/quota/reset`, { kind: 'optimizations', reason: 'counted a failed run twice' })).status).toBe(204);
    expect((await sql`SELECT optimizations FROM usage_counters WHERE user_id = ${u.user.id} AND period = ${month}`)[0]!.optimizations).toBe(0);

    expect((await call('POST', `/users/${u.user.id}/suspend`, { reason: 'abuse report under review' })).status).toBe(204);
    expect((await apiApp.request('/v1/me', { headers: { authorization: `Bearer ${u.access_token}` } })).status).toBe(401);
    resetRateLimits();
    const code = ((await (await apiJson('POST', '/v1/auth/otp/request', { email: 'customer@example.org' })).json()) as { dev_code: string }).dev_code;
    expect((await apiJson('POST', '/v1/auth/otp/verify', { email: 'customer@example.org', code })).status).toBe(403);
    expect((await call('POST', `/users/${u.user.id}/unsuspend`, { reason: 'abuse report was unfounded' })).status).toBe(204);
    const back = await userLogin('customer@example.org');
    expect((await call('POST', `/users/${u.user.id}/sessions/revoke`, { reason: 'customer lost their laptop' })).status).toBe(204);
    expect((await apiApp.request('/v1/me', { headers: { authorization: `Bearer ${back.access_token}` } })).status).toBe(401);

    await ageStepUp();
    expect((await call('POST', `/users/${u.user.id}/deletion`, { reason: 'customer asked by email' })).json.error.code).toBe('step_up_required');
    await stepUp();
    expect((await call('POST', `/users/${u.user.id}/deletion`, { reason: 'customer asked by email' })).status).toBe(202);
    expect((await sql`SELECT count(*)::int AS n FROM users WHERE id = ${u.user.id}`)[0]!.n).toBe(0);
    expect((await call('GET', '/privacy/requests')).json.data.map((r: { user_id: string }) => r.user_id)).toContain(u.user.id);
  });

  it('admins: list, remove (their session ends); you cannot remove yourself', async () => {
    const t = await addAdmin('temp-admin@example.org', 'admin');
    const list = (await call('GET', '/admins')).json.data as Array<{ user_id: string; email: string; role: string }>;
    const temp = list.find((a) => a.email === 'temp-admin@example.org')!;
    expect(temp.role).toBe('admin');
    const ownerId = list.find((a) => a.role === 'owner')!.user_id;
    await stepUp();
    expect((await call('DELETE', `/admins/${ownerId}`, { reason: 'trying to remove myself' })).status).toBe(400);
    expect((await call('DELETE', `/admins/${temp.user_id}`, { reason: 'contract ended this week' })).status).toBe(204);
    expect((await call('GET', '/overview', undefined, t)).status).toBe(401);
    // Admin is not allowed to set prices (Owner and Finance only).
    expect((await call('POST', '/plans/pro_monthly/prices', { currency: 'USD', unit_amount_minor: 2000, reason: 'should be refused' }, await addAdmin('admin2@example.org', 'admin'))).status).toBe(403);
  });

  // ── Audit ──

  it('audit log: filters, chain verification, and a CSV export that spreadsheets cannot execute', async () => {
    const u = await userLogin('csv-target@example.org');
    expect((await call('POST', `/users/${u.user.id}/credits`, { optimizations: 1, reason: '=HYPERLINK("http://evil.example","click") reason' })).status).toBe(201);
    const credits = (await call('GET', '/audit?action=credits')).json.data as Array<{ action: string }>;
    expect(credits.length).toBeGreaterThan(0);
    expect(credits.every((r) => r.action.startsWith('credits'))).toBe(true);
    expect((await call('GET', `/audit?target_id=${u.user.id}`)).json.data.every((r: { target_id: string }) => r.target_id === u.user.id)).toBe(true);
    expect((await call('GET', '/audit/verify')).json.ok).toBe(true);
    const csv = (await call('GET', '/audit/export')).json as string;
    expect(csv.split('\n')[0]).toBe('id,occurred_at,actor_type,actor_role,action,target_type,target_id,reason,request_id');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"") reason"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  // ── AI providers, keys, models ──

  it('providers, keys and models: base URL required, policy changes need terms, key lifecycle, model approval needs an eval', async () => {
    expect((await call('GET', '/ai/providers')).json.data.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['openai', 'nvidia_trial', 'openrouter_free']));
    await stepUp();
    expect((await call('POST', '/ai/providers', { id: 'acme_ai', name: 'Acme AI', kind: 'openai_compatible', terms_url: 'https://acme.example/terms', reason: 'evaluate a new vendor' })).json.error.message).toMatch(/need a base URL/);
    expect((await call('POST', '/ai/providers', { id: 'acme_ai', name: 'Acme AI', kind: 'openai_compatible', base_url: 'https://api.acme.example/v1', terms_url: 'https://acme.example/terms', reason: 'evaluate a new vendor' })).status).toBe(201);
    const p = (await call('GET', '/ai/providers')).json.data.find((x: { id: string }) => x.id === 'acme_ai');
    expect(p).toMatchObject({ production_allowed: false, personal_data_allowed: false, trains_on_inputs: 'unknown' });
    expect((await call('PATCH', '/ai/providers/acme_ai', { production_allowed: true, reason: 'signed the DPA last week' })).json.error.message).toMatch(/terms URL/);
    expect((await call('PATCH', '/ai/providers/acme_ai', { production_allowed: true, personal_data_allowed: true, trains_on_inputs: 'no', terms_url: 'https://acme.example/dpa', reason: 'signed the DPA last week' })).status).toBe(200);
    expect(await auditActions('provider.')).toEqual(expect.arrayContaining(['provider.create', 'provider.policy_change']));

    expect((await call('GET', '/ai/vault/public-key')).json.public_jwk).toBeTruthy();
    const enc = await encryptSecret('sk-trial-0000000000000000', vaultPublic, 1);
    expect((await call('POST', '/ai/credentials', { provider_id: 'nvidia_trial', label: 'NVIDIA trial', env: 'production', scope: 'production', ...enc, reason: 'should be refused for prod' })).json.error.message).toMatch(/not allowed in production/);
    const k = await call('POST', '/ai/credentials', { provider_id: 'nvidia_trial', label: 'NVIDIA trial', env: 'eval', scope: 'non_production', ...enc, reason: 'evals on synthetic data' });
    expect(k.status).toBe(201);
    for (const verb of ['standby', 'activate', 'revoke']) expect((await call('POST', `/ai/credentials/${k.json.id}/${verb}`, { reason: `key lifecycle: ${verb}` })).status).toBe(200);
    expect((await call('POST', `/ai/credentials/${k.json.id}/activate`, { reason: 'try to revive a revoked key' })).status).toBe(409);
    expect((await call('GET', '/ai/credentials')).json.data.find((x: { id: string }) => x.id === k.json.id).status).toBe('revoked');

    const m = await call('POST', '/ai/models', { provider_id: 'acme_ai', provider_model_id: 'acme-large', tier: 'strong', structured: 'json_mode', input_per_mtok: 1, output_per_mtok: 4, source_url: 'https://acme.example/pricing', reason: 'candidate for rewriting' });
    expect(m.status).toBe(201);
    expect((await call('PATCH', `/ai/models/${encodeURIComponent(m.json.id)}`, { status: 'approved', reason: 'looks good to me' })).status).toBe(412);
    expect((await call('PATCH', `/ai/models/${encodeURIComponent(m.json.id)}`, { status: 'retired', reason: 'vendor dropped this model' })).status).toBe(200);
    expect((await call('GET', '/ai/models')).json.data.find((x: { id: string }) => x.id === m.json.id).status).toBe('retired');
  });

  // ── Analytics ──

  it('analytics: time series, breakdown, user drill-down, optimization waterfall, traces, CSV export, insights, date checks', async () => {
    const u = await userLogin('analytics@example.org');
    const optId = await useTheProduct(u.access_token, 'admin-analytics-1', 'trace-0000000001');
    await sql`UPDATE ai_requests SET created_at = created_at - interval '1 minute'`;
    expect((await call('POST', '/analytics/rollup')).status).toBe(200);
    for (const metric of ['cost', 'calls', 'tokens', 'latency_p95', 'errors']) {
      const r = await call('GET', `/analytics/ai/timeseries?metric=${metric}&group_by=task&interval=hour`);
      expect(r.status, metric).toBe(200);
      expect(r.json.data.length, metric).toBeGreaterThan(0);
    }
    expect((await call('GET', '/analytics/ai/timeseries?metric=bogus')).status).toBe(400);
    expect((await call('GET', '/analytics/ai/breakdown?dims=task,model')).json.data.length).toBeGreaterThan(0);
    expect((await call('GET', '/analytics/ai/breakdown?dims=task;drop')).status).toBe(400);
    expect((await call('GET', `/analytics/ai/users/${u.user.id}`)).status).toBe(200);
    const w = await call('GET', `/analytics/ai/optimizations/${optId}/waterfall`);
    expect(w.json.calls.map((c: { task: string }) => c.task)).toEqual(expect.arrayContaining(['optimize']));
    expect(w.json.optimization.user_id).toBeUndefined();
    expect((await call('GET', '/analytics/ai/optimizations/00000000-0000-0000-0000-000000000000/waterfall')).status).toBe(404);
    expect((await call('GET', '/traces/trace-0000000001')).json.calls.length).toBeGreaterThan(0);
    const csv = await call('GET', '/analytics/ai/export.csv');
    expect(csv.type).toContain('text/csv');
    expect((csv.json as string).split('\n')[0]).toMatch(/^task,model,credential,calls/);
    expect((await call('GET', '/analytics/ai/summary?from=2026-02-01&to=2026-01-01')).status).toBe(400);
    expect((await call('POST', '/insights/no-such-id/accept', { reason: 'apply this suggestion' })).status).toBe(400); // malformed id
    expect((await call('POST', '/insights/00000000-0000-0000-0000-000000000000/accept', { reason: 'apply this suggestion' })).status).toBe(404);
    expect((await call('GET', '/users/not-a-uuid')).status).toBe(400);
    expect((await call('GET', '/insights')).status).toBe(200);
  });

  // ── Config ──

  it('runtime config: namespaces with per-role edit rights, versions, dangerous namespaces need step-up, eval list', async () => {
    const list = (await call('GET', '/config')).json.data as Array<{ namespace: string; editable: boolean; active: unknown }>;
    expect(list.find((n) => n.namespace === 'kill_switches')).toMatchObject({ editable: true });
    const analyst = (await adminLogin('ana@example.org')).json.access_token;
    expect(((await call('GET', '/config', undefined, analyst)).json.data as typeof list).every((n) => !n.editable)).toBe(true);
    const ks = (await call('GET', '/config/kill_switches')).json;
    expect(ks.active.data).toHaveProperty('maintenance', false);
    const d = await call('POST', '/config/kill_switches/versions', { data: ks.active.data, change_note: 'no-op version for the test' });
    expect((await call('GET', `/config/versions/${d.json.id}`)).json).toMatchObject({ namespace: 'kill_switches', status: 'draft' });
    expect((await call('GET', '/config/versions/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    await ageStepUp();
    expect((await call('POST', `/config/versions/${d.json.id}/activate`, { reason: 'activate the no-op version' })).json.error.code).toBe('step_up_required');
    await stepUp();
    expect((await call('POST', `/config/versions/${d.json.id}/activate`, { reason: 'activate the no-op version' })).status).toBe(200);
    expect((await call('GET', '/config/not_a_namespace')).status).toBe(400);
    expect(Array.isArray((await call('GET', '/evals')).json.data)).toBe(true);
  });

  // ── Coupons, prices ──

  it('coupons: detail, edit, frozen terms after a redemption, bulk codes and step-up export, redemptions, resume and archive', async () => {
    const now = Date.now();
    const c = await call('POST', '/coupons', { name: 'Spring', codes: { mode: 'single', code: 'SPRING20' }, rules: [{ plan_id: 'pro_monthly', percent_off: 20, duration: 'first_period' }], valid_from: new Date(now - 60_000).toISOString(), valid_until: new Date(now + 7 * 86_400_000).toISOString(), reason: 'spring campaign launch' });
    expect(c.status).toBe(201);
    expect((await call('GET', `/coupons/${c.json.id}`)).json).toMatchObject({ name: 'Spring', editable_terms: true, codes: [{ code: 'SPRING20' }] });
    expect((await call('PATCH', `/coupons/${c.json.id}`, { name: 'Spring sale', reason: 'rename for clarity' })).status).toBe(200);

    const buyer = await userLogin('spring-buyer@example.org');
    resetRateLimits();
    const co = (await (await apiJson('POST', '/v1/billing/checkout', { plan_id: 'pro_monthly', coupon_code: 'SPRING20' }, { authorization: `Bearer ${buyer.access_token}`, 'idempotency-key': 'admin-coupon-co-1' })).json()) as { transaction_id: string };
    await apiJson('POST', `/v1/dev/fake-checkout/${co.transaction_id}/complete`);
    expect((await call('PATCH', `/coupons/${c.json.id}`, { rules: [{ plan_id: 'pro_monthly', percent_off: 30, duration: 'first_period' }], reason: 'make it more generous' })).status).toBe(409);
    expect((await call('GET', `/coupons/${c.json.id}/redemptions`)).json.data).toEqual([expect.objectContaining({ status: 'completed', code: 'SPRING20', discount_amount_minor: 380 })]);

    expect((await call('POST', `/coupons/${c.json.id}/codes/bulk`, { count: 5, prefix: 'sp', reason: 'codes for the partner newsletter' })).status).toBe(201);
    await ageStepUp();
    expect((await call('GET', `/coupons/${c.json.id}/codes/export`)).status).toBe(403);
    await stepUp();
    const exp = (await call('GET', `/coupons/${c.json.id}/codes/export`)).json as string;
    expect(exp.split('\n')).toHaveLength(7); // header + 1 + 5
    expect(exp).toMatch(/^"SP[A-Z0-9]{10}",/m);

    for (const verb of ['pause', 'resume']) expect((await call('POST', `/coupons/${c.json.id}/${verb}`, { reason: `campaign ${verb} test` })).status).toBe(200);
    const archivedBefore = payments.filter((p) => p.method === 'archiveDiscount').length;
    expect((await call('POST', `/coupons/${c.json.id}/archive`, { reason: 'campaign is over now' })).status).toBe(200);
    expect(payments.filter((p) => p.method === 'archiveDiscount').length).toBe(archivedBefore + 1);
    expect((await call('POST', `/coupons/${c.json.id}/pause`, { reason: 'too late to pause' })).status).toBe(409);
    expect((await call('GET', '/coupons?status=archived')).json.data.map((x: { id: string }) => x.id)).toContain(c.json.id);
  });

  it('plans & prices: a new price is created at Stripe (step-up), the old one archived; the free plan has no price', async () => {
    const plans = (await call('GET', '/plans')).json.plans as Array<{ id: string; prices: Array<{ provider_price_id: string; status: string }> }>;
    expect(plans.find((p) => p.id === 'pro_monthly')!.prices[0]).toMatchObject({ provider_price_id: 'pri_dev_pro_monthly', status: 'active' });
    await ageStepUp();
    expect((await call('POST', '/plans/pro_monthly/prices', { currency: 'USD', unit_amount_minor: 2100, reason: 'price increase for new users' })).status).toBe(403);
    await stepUp();
    const r = await call('POST', '/plans/pro_quarterly/prices', { currency: 'USD', unit_amount_minor: 4800, reason: 'price increase for new users' });
    expect(r.status).toBe(201);
    expect(r.json.archived_previous).toBe('pri_dev_pro_quarterly');
    expect(payments.filter((p) => p.method === 'createPrice').at(-1)!.args[0]).toEqual({ plan_id: 'pro_quarterly', plan_name: 'Pro quarterly', amount_minor: 4800, currency: 'USD', interval: 'month', interval_count: 3 });
    const after = ((await call('GET', '/plans')).json.plans as typeof plans).find((p) => p.id === 'pro_quarterly')!.prices;
    expect(after.filter((x) => x.status === 'active').map((x) => x.provider_price_id)).toEqual([r.json.provider_price_id]);
    expect((await call('POST', '/plans/free/prices', { currency: 'USD', unit_amount_minor: 100, reason: 'free plan cannot be priced' })).status).toBe(404);
    expect((await call('POST', '/plans/pro_monthly/prices', { currency: 'USD', unit_amount_minor: 50, reason: 'below the minimum price' })).status).toBe(400);
  });

  // ── Saved content ──

  it('saved content: aggregates for every role; Owner/Admin list metadata; opening and exporting need step-up and are audited', async () => {
    const u = await userLogin('content-helper@example.org');
    expect((await apiJson('PATCH', '/v1/account/settings', { content_opt_in: true }, { authorization: `Bearer ${u.access_token}` })).status).toBe(204);
    await useTheProduct(u.access_token, 'admin-content-1');

    const analyst = (await adminLogin('ana@example.org')).json.access_token;
    const stats = (await call('GET', '/content/stats', undefined, analyst)).json;
    expect(stats.users.opted_in).toBe(1);
    expect(stats.by_kind.map((k: { kind: string }) => k.kind).sort()).toEqual(['job_post', 'result', 'resume']);
    expect((await call('GET', '/content', undefined, analyst)).status).toBe(403);

    const list = (await call('GET', '/content')).json.data as Array<Record<string, unknown> & { id: string; kind: string }>;
    expect(list).toHaveLength(3);
    for (const item of list) {
      expect(item).not.toHaveProperty('payload');
      expect(item).not.toHaveProperty('ciphertext');
      expect(String(item.user_email_masked)).not.toBe('content-helper@example.org');
    }
    expect(((await call('GET', '/content?kind=resume')).json.data as typeof list).map((x) => x.kind)).toEqual(['resume']);
    expect((await call('GET', '/content?kind=bogus')).status).toBe(400);

    const resume = list.find((x) => x.kind === 'resume')!;
    await ageStepUp();
    expect((await call('GET', `/content/${resume.id}`)).json.error.code).toBe('step_up_required');
    await stepUp();
    const opened = (await call('GET', `/content/${resume.id}`)).json;
    expect(opened.payload.resume.roles.length).toBeGreaterThan(0);
    expect((await call('GET', '/content/not-a-uuid')).status).toBe(400);
    expect((await call('GET', '/content/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    const jsonl = await call('GET', '/content/export.jsonl?kind=job_post');
    expect(jsonl.type).toContain('application/x-ndjson');
    const lines = (jsonl.json as string).split('\n').map((l) => JSON.parse(l) as { kind: string; payload: { jd_text: string } });
    expect(lines.map((l) => l.kind)).toEqual(['job_post']);
    expect(lines[0]!.payload.jd_text).toContain('Data Analyst');
    expect(await auditActions('content.')).toEqual(expect.arrayContaining(['content.view', 'content.export']));
    expect((await call('GET', `/users/${u.user.id}`)).json.saved_content).toMatchObject({ opted_in: true, items: 3 });
  });

  // ── System, feedback ──

  it('system health, overview and the feedback queue', async () => {
    const u = await userLogin('feedback@example.org');
    resetRateLimits();
    expect((await apiJson('POST', '/v1/feedback', { target: 'general', rating: 4, comment: 'Useful tool' }, { authorization: `Bearer ${u.access_token}` })).status).toBe(201);
    expect((await call('GET', '/feedback')).json.data.map((f: { comment: string }) => f.comment)).toContain('Useful tool');
    const h = (await call('GET', '/system/health')).json;
    expect(h).toMatchObject({ failed_webhooks: [], config_snapshot: expect.any(String) });
    const o = (await call('GET', '/overview')).json;
    expect(o.users.total).toBeGreaterThan(0);
    expect(o).toHaveProperty('kill_switches');
  });
});
