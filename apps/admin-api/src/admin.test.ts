import { createApp } from '@jmo/api';
import { generateSigningKeys } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { AuthService, consoleMailer, createServices, fakeStripe, loadEnv, type Services } from '@jmo/server';
import { encryptSecret, generateVaultKeyPair } from '@jmo/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAvailable, freshDatabase } from '../../../tests/setup/db';
import { createAdminApp } from './app';

const up = await dbAvailable();

describe.skipIf(!up)('Admin API integration (Postgres)', () => {
  let sql: Sql;
  let api: Services;
  let apiApp: ReturnType<typeof createApp>;
  let admin: ReturnType<typeof createAdminApp>;
  let vaultPublic: JsonWebKey;
  let token = '';

  beforeAll(async () => {
    ({ sql } = await freshDatabase('jmo_test_admin'));
    const vault = await generateVaultKeyPair();
    const signing = await generateSigningKeys();
    vaultPublic = vault.publicJwk;
    const base = { ENV: 'test', DATABASE_URL: 'unused', CONFIG_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(signing.privateJwk) };
    api = createServices(loadEnv({ ...base, VAULT_PRIVATE_KEY_JWK: JSON.stringify(vault.privateJwk) }), { sql, mailer: consoleMailer(() => undefined) });
    apiApp = createApp(api);
    const adminEnv = loadEnv({ ...base, VAULT_PUBLIC_KEY_JWK: JSON.stringify(vault.publicJwk) });
    const payments = fakeStripe('http://web');
    admin = createAdminApp({
      sql,
      env: adminEnv,
      config: api.config,
      auth: new AuthService(sql, adminEnv.JWT_SECRET, consoleMailer(() => undefined), { exposeDevCode: true }),
      billing: api.billing,
      payments,
      internal: async (path, body) => {
        const r = await apiApp.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': adminEnv.INTERNAL_TOKEN }, body: JSON.stringify(body ?? {}) });
        return r.json();
      },
    });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
  });

  const call = async (method: string, path: string, body?: unknown, t = token) => {
    const r = await admin.request(`/admin/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, json: (text && r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as any };
  };

  async function adminLogin(email: string) {
    const r1 = await call('POST', '/auth/otp/request', { email }, '');
    const r2 = await call('POST', '/auth/otp/verify', { email, code: r1.json.dev_code }, '');
    return r2;
  }

  async function stepUp(t = token) {
    const r = await call('POST', '/auth/step-up/request', {}, t);
    expect((await call('POST', '/auth/step-up/verify', { code: r.json.dev_code }, t)).status).toBe(200);
  }

  it('only admins can sign in; the owner gets an admin session', async () => {
    const stranger = await call('POST', '/auth/otp/request', { email: 'nobody@example.com' }, '');
    expect(stranger.json).toEqual({ sent: true }); // no enumeration, no code
    const r = await adminLogin('owner@example.com');
    expect(r.status).toBe(200);
    token = r.json.access_token;
    const me = await call('GET', '/me');
    expect(me.json.role).toBe('owner');
    expect((await call('GET', '/overview', undefined, '')).status).toBe(401);
  });

  it('enforces the permission matrix and step-up', async () => {
    // Signing in counts as a fresh re-authentication; age it past the 10-minute window.
    await sql`UPDATE auth_sessions SET last_step_up_at = now() - interval '11 minutes' WHERE kind = 'admin'`;
    const add = await call('POST', '/admins', { email: 'ana@example.com', role: 'analyst', reason: 'read-only analytics access' });
    expect(add.status).toBe(403);
    expect(add.json.error.code).toBe('step_up_required');
    await stepUp();
    expect((await call('POST', '/admins', { email: 'ana@example.com', role: 'analyst', reason: 'read-only analytics access' })).status).toBe(201);
    const analyst = (await adminLogin('ana@example.com')).json.access_token as string;
    expect((await call('GET', '/overview', undefined, analyst)).status).toBe(200);
    expect((await call('GET', '/users', undefined, analyst)).status).toBe(403);
    expect((await call('POST', '/coupons', {}, analyst)).status).toBe(403);
    expect((await call('GET', '/analytics/ai/users', undefined, analyst)).status).toBe(403);
    // Writes need a reason.
    expect((await call('POST', '/insights/x/dismiss', { reason: 'short' })).status).toBe(400);
  });

  it('config: draft → validate → activate → rollback, with bounds and diffs', async () => {
    const active = (await call('GET', '/config/limits')).json.active;
    const bad = await call('POST', '/config/limits/versions', { data: { ...active.data, otp_per_hour: 99 }, change_note: 'too many codes per hour' });
    const v = await call('POST', `/config/versions/${bad.json.id}/validate`);
    expect(v.json.valid).toBe(false);
    const good = await call('POST', '/config/limits/versions', { data: { ...active.data, otp_per_hour: 4 }, change_note: 'tighten sign-in code rate' });
    const v2 = await call('POST', `/config/versions/${good.json.id}/validate`);
    expect(v2.json.valid).toBe(true);
    expect(v2.json.diff).toEqual([{ path: 'otp_per_hour', before: 5, after: 4 }]);
    const act = await call('POST', `/config/versions/${good.json.id}/activate`, { reason: 'reduce OTP abuse risk' });
    expect(act.status).toBe(200);
    expect((await api.config.get()).config.limits.otp_per_hour).toBe(4);
    const rb = await call('POST', '/config/limits/rollback', { reason: 'rollback test for the audit log' });
    expect(rb.status).toBe(200);
    expect((await api.config.get()).config.limits.otp_per_hour).toBe(5);
  });

  it('ai_routing needs a passing eval; NVIDIA trial keys are blocked from production routes', async () => {
    await stepUp();
    const enc = await encryptSecret('nvapi-TEST-abcdefghijklmnop', vaultPublic, 1);
    const prodKey = await call('POST', '/ai/credentials', { provider_id: 'nvidia_trial', label: 'NVIDIA trial', env: 'eval', scope: 'production', ...enc, reason: 'trying free models for evals' });
    expect(prodKey.status).toBe(400);
    const key = await call('POST', '/ai/credentials', { provider_id: 'nvidia_trial', label: 'NVIDIA trial', env: 'eval', scope: 'non_production', ...enc, reason: 'trying free models for evals' });
    expect(key.status).toBe(201);
    const [row] = await sql`SELECT ciphertext, last4 FROM provider_credentials WHERE id = ${key.json.id}`;
    expect(Buffer.from(row!.ciphertext).toString('utf8')).not.toContain('nvapi-TEST');
    expect(row!.last4).toBe('mnop');
    const list = await call('GET', '/ai/credentials');
    expect(JSON.stringify(list.json)).not.toMatch(/ciphertext|wrapped_dek|nvapi-TEST/);
    // Register a model on the trial provider and try to route a resume step to it in production.
    await call('POST', '/ai/models', { provider_id: 'nvidia_trial', provider_model_id: 'meta/test-model', tier: 'cheap', structured: 'json_mode', input_per_mtok: 0, output_per_mtok: 0, source_url: 'https://build.nvidia.com', reason: 'eval candidate for jd_extract' });
    const routing = (await call('GET', '/config/ai_routing')).json.active.data;
    routing.routes.optimize = { primary: { model: 'nvidia_trial:meta/test-model', credential: key.json.id } };
    const draft = await call('POST', '/config/ai_routing/versions', { data: routing, change_note: 'try NVIDIA for the rewrite' });
    const val = await call('POST', `/config/versions/${draft.json.id}/validate`);
    expect(val.json.valid).toBe(false);
    expect(JSON.stringify(val.json.errors)).toMatch(/not allowed in production|sends resume content|cannot serve production/);
    // A compliant routing change still needs a passing eval run.
    const mock = (await call('GET', '/config/ai_routing')).json.active.data;
    mock.routes.optimize.max_output_tokens = 3000;
    const d2 = await call('POST', '/config/ai_routing/versions', { data: mock, change_note: 'lower rewrite output cap' });
    const noEval = await call('POST', `/config/versions/${d2.json.id}/activate`, { reason: 'insight: expensive step' });
    expect(noEval.status).toBe(412);
    const ev = await call('POST', '/evals/run', { version_id: d2.json.id });
    expect(ev.json.passed).toBe(true);
    const ok = await call('POST', `/config/versions/${d2.json.id}/activate`, { reason: 'insight: expensive step' });
    expect(ok.status).toBe(200);
  });

  it('keys are testable through the API (never decrypted by the admin plane) and revocable', async () => {
    await stepUp();
    const enc = await encryptSecret('sk-test-openai-000000000000', vaultPublic, 1);
    const k = await call('POST', '/ai/credentials', { provider_id: 'openai', label: 'OpenAI prod', env: 'production', scope: 'production', ...enc, monthly_soft_budget_usd: 500, reason: 'production key for hosted mode' });
    expect(k.status).toBe(201);
    const t = await call('POST', `/ai/credentials/${k.json.id}/test`);
    expect(t.json.ok).toBe(false); // the fake key is rejected by the network/provider; the call path works
    const rv = await call('POST', `/ai/credentials/${k.json.id}/revoke`, { reason: 'rotation test revoke' });
    expect(rv.status).toBe(200);
    expect(rv.json.note).toMatch(/revoke this key at the provider/);
  });

  it('coupons via the admin API: validation, create, stats, frozen terms', async () => {
    const now = Date.now();
    const base = { name: 'Oct launch', codes: { mode: 'single', code: 'OCT20' }, rules: [{ plan_id: 'pro_monthly', percent_off: 20, duration: 'first_period' }], max_redemptions: 100, valid_from: new Date(now).toISOString(), valid_until: new Date(now + 7 * 86_400_000).toISOString(), reason: 'launch promo from the marketing plan' };
    const tooDeep = await call('POST', '/coupons', { ...base, codes: { mode: 'single', code: 'OCT80' }, rules: [{ plan_id: 'pro_monthly', percent_off: 80, duration: 'first_period' }] });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.json.error.message).toMatch(/shared codes are limited to 50%/);
    const created = await call('POST', '/coupons', base);
    expect(created.status).toBe(201);
    const dup = await call('POST', '/coupons', base);
    expect(dup.status).toBe(409);
    const list = await call('GET', '/coupons');
    expect(list.json.data[0].code).toBe('OCT20');
    const stats = await call('GET', `/coupons/${created.json.id}/stats`);
    expect(stats.json.redemptions).toBe(0);
    const pause = await call('POST', `/coupons/${created.json.id}/pause`, { reason: 'code leaked to a deals site' });
    expect(pause.status).toBe(200);
  });

  it('AI usage dashboard, what-if, insights and audit verification', async () => {
    // Generate some traffic through the public API.
    const email = 'dana@example.org';
    const r1 = await apiApp.request('/v1/auth/otp/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    const code = ((await r1.json()) as { dev_code: string }).dev_code;
    const r2 = await apiApp.request('/v1/auth/otp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
    const t = ((await r2.json()) as { access_token: string }).access_token;
    const { extractJobFromText } = await import('@jmo/job-extraction');
    const job = await extractJobFromText('Data Analyst\nRequirements:\n• 2+ years of SQL and Tableau\n• Python for data analysis\n• Build dashboards for finance stakeholders\nResponsibilities:\n• Maintain weekly reporting pipelines');
    await apiApp.request('/v1/jobs/analyze', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ jd_text: job.description_text, jd_hash: job.jd_hash }) });

    // Manual rollups keep a 10-second safety lag (rows still being inserted are never skipped); a minute has "passed".
    await sql`UPDATE ai_requests SET created_at = created_at - interval '1 minute'`;
    expect((await call('POST', '/analytics/rollup')).status).toBe(200);
    const s = await call('GET', '/analytics/ai/summary');
    expect(s.json.current.calls).toBeGreaterThan(0);
    const b = await call('GET', '/analytics/ai/breakdown?dims=task,model');
    expect(b.json.data.some((x: { task: string }) => x.task === 'jd_extract')).toBe(true);
    const users = await call('GET', '/analytics/ai/users');
    expect(users.json.data[0].email_masked).toMatch(/\*\*\*@/);
    const wi = await call('POST', '/analytics/ai/what-if', { tasks: ['jd_extract', 'optimize', 'validate_entail'], model_id: 'openai:gpt-6-luna' });
    expect(wi.json.label).toBe('ESTIMATE');
    expect((await call('POST', '/insights/refresh')).status).toBe(200);
    const audit = await call('GET', '/audit?limit=200');
    const actions = audit.json.data.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.login', 'config.activate', 'config.rollback', 'credential.create', 'credential.revoke', 'coupon.create', 'coupon.pause', 'admin.grant']));
    const verify = await call('GET', '/audit/verify');
    expect(verify.json.ok).toBe(true);
  });
});
