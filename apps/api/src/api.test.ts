import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateSigningKeys, verifyConfig } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { extractClaims, toClaimLite } from '@jmo/evidence';
import { analyzeJobText, extractJobFromText } from '@jmo/job-extraction';
import { toOptResume, toPlainText } from '@jmo/resume';
import { sampleResume } from '@jmo/resume/fixtures';
import { scoreResume, selectTargets } from '@jmo/scoring';
import { consoleMailer, createCoupon, createServices, fakeStripe, googleVerifier, loadEnv, rollupHourly, type Services, signStripePayload, verifyAuditChain } from '@jmo/server';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { generateVaultKeyPair } from '@jmo/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAvailable, freshDatabase } from '../../../tests/setup/db';
import { createApp } from './app';
import { resetRateLimits } from './middleware';

const up = await dbAvailable();

describe.skipIf(!up)('API integration (Postgres)', () => {
  let sql: Sql;
  let services: Services;
  let app: ReturnType<typeof createApp>;
  let publicJwk: JsonWebKey;
  // A stand-in for Google's signing key: tokens signed with it verify exactly like Google's would.
  const GOOGLE_CLIENT = 'test-client.apps.googleusercontent.com';
  let googleKey: CryptoKey;
  const googleToken = (claims: Record<string, unknown>, o: { aud?: string; iss?: string; exp?: string } = {}) =>
    new SignJWT({ email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(o.iss ?? 'https://accounts.google.com')
      .setAudience(o.aud ?? GOOGLE_CLIENT)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '10m')
      .sign(googleKey);
  const jdHtml = readFileSync(resolve(__dirname, '../../../tests/fixtures/jd/lever-jsonld.html'), 'utf8');
  const jdText = (() => {
    const t = jdHtml.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
    return t.slice(t.indexOf('Acme Analytics is hiring'), t.indexOf('© Acme')).replace(/\n{2,}/g, '\n').trim();
  })();

  beforeAll(async () => {
    ({ sql } = await freshDatabase('jmo_test_api'));
    const signing = await generateSigningKeys();
    const vault = await generateVaultKeyPair();
    publicJwk = signing.publicJwk;
    const env = loadEnv({ ENV: 'test', DATABASE_URL: 'unused', CONFIG_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(signing.privateJwk), VAULT_PRIVATE_KEY_JWK: JSON.stringify(vault.privateJwk), VAULT_PUBLIC_KEY_JWK: JSON.stringify(vault.publicJwk) });
    const kp = await generateKeyPair('RS256');
    googleKey = kp.privateKey;
    const google = googleVerifier({ clientIds: [GOOGLE_CLIENT], jwks: createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'test', alg: 'RS256' }] }) });
    services = createServices(env, { sql, mailer: consoleMailer(() => undefined), google });
    app = createApp(services);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
  });

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  async function login(email: string) {
    resetRateLimits();
    const r1 = await json('POST', '/v1/auth/otp/request', { email });
    expect(r1.status).toBe(200);
    const { dev_code } = (await r1.json()) as { dev_code: string };
    const r2 = await json('POST', '/v1/auth/otp/verify', { email, code: dev_code, device: 'test' });
    expect(r2.status).toBe(200);
    return (await r2.json()) as { access_token: string; refresh_token: string; user: { id: string; plan: string } };
  }
  const auth = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });

  it('serves a signed config that verifies with the public key', async () => {
    const r = await app.request('/v1/config');
    expect(r.status).toBe(200);
    const signed = (await r.json()) as Parameters<typeof verifyConfig>[0];
    expect(await verifyConfig(signed, publicJwk)).toBe(true);
    expect(signed.config.config_snapshot).toMatch(/^cs_[0-9a-f]{12}$/);
  });

  it('logs in with an email code; rotates refresh tokens; detects reuse', async () => {
    const t = await login('alice@example.org');
    expect(t.user.plan).toBe('free');
    const me = await app.request('/v1/me', { headers: auth(t.access_token) });
    expect(((await me.json()) as { email: string }).email).toBe('alice@example.org');
    const r1 = await json('POST', '/v1/auth/refresh', { refresh_token: t.refresh_token });
    expect(r1.status).toBe(200);
    const again = await json('POST', '/v1/auth/refresh', { refresh_token: t.refresh_token });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('session_revoked');
    const bad = await json('POST', '/v1/auth/otp/verify', { email: 'alice@example.org', code: '000000' });
    expect(bad.status).toBe(401);
  });

  it('signs in with Google: creates the account, links an existing email account, rejects bad tokens', async () => {
    resetRateLimits();
    const nonce = 'n'.repeat(24);
    const google = async (token: string, n = nonce) => app.request('/v1/auth/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: token, nonce: n, device: 'test' }) });

    // New user
    const r1 = await google(await googleToken({ sub: 'g-111', email: 'Grace.Hopper@Example.org', name: 'Grace Hopper', nonce }));
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as { access_token: string; user: { email: string; plan: string } };
    expect(t1.user).toMatchObject({ email: 'grace.hopper@example.org', plan: 'free' });
    const me = (await (await app.request('/v1/me', { headers: { authorization: `Bearer ${t1.access_token}` } })).json()) as { display_name: string };
    expect(me.display_name).toBe('Grace Hopper');
    // Same Google account again → same user
    const again = (await (await google(await googleToken({ sub: 'g-111', email: 'grace.hopper@example.org', nonce }))).json()) as { user: { id: string } };
    expect(again.user.id).toBe((t1 as unknown as { user: { id: string } }).user.id);

    // Existing email-code user → linked, not duplicated
    const viaEmail = await login('linus@example.org');
    const linked = (await (await google(await googleToken({ sub: 'g-222', email: 'linus@example.org', nonce }))).json()) as { user: { id: string } };
    const [u] = await sql`SELECT id FROM users WHERE email = 'linus@example.org'`;
    expect(linked.user.id).toBe(u!.id);
    void viaEmail;
    const accounts = await sql`SELECT provider FROM auth_accounts WHERE user_id = ${u!.id} ORDER BY provider`;
    expect(accounts.map((a) => a.provider)).toEqual(['email', 'google']);

    // Rejections: wrong audience, wrong issuer, expired, nonce mismatch, unverified email, garbage
    const bad = [
      await googleToken({ sub: 'g-3', email: 'x@example.org', nonce }, { aud: 'someone-else.apps.googleusercontent.com' }),
      await googleToken({ sub: 'g-3', email: 'x@example.org', nonce }, { iss: 'https://evil.example' }),
      await googleToken({ sub: 'g-3', email: 'x@example.org', nonce }, { exp: '-5m' }),
      await googleToken({ sub: 'g-3', email: 'x@example.org', nonce: 'other-nonce-value-123456' }),
      await googleToken({ sub: 'g-3', email: 'x@example.org', nonce, email_verified: false }),
      'not.a.jwt.at.all-but-long-enough',
    ];
    for (const tok of bad) expect((await google(tok)).status).toBe(401);
    const [none] = await sql`SELECT count(*)::int AS n FROM users WHERE email = 'x@example.org'`;
    expect(none!.n).toBe(0);
  });

  it('rejects disposable email domains and invalid bodies with the error envelope', async () => {
    resetRateLimits();
    const r = await json('POST', '/v1/auth/otp/request', { email: 'x@mailinator.com' });
    expect(r.status).toBe(400);
    const e = (await r.json()) as { error: { code: string; request_id: string } };
    expect(e.error.code).toBe('invalid_request');
    expect(e.error.request_id).toBeTruthy();
    expect((await json('POST', '/v1/auth/otp/request', { email: 'nope' })).status).toBe(400);
  });

  let aliceToken = '';
  let jobAnalysisId = '';

  it('analyzes a job (miss → hit) and validates the jd_hash', async () => {
    const t = await login('alice@example.org');
    aliceToken = t.access_token;
    const job = await extractJobFromText(jdText);
    const bad = await json('POST', '/v1/jobs/analyze', { jd_text: jdText, jd_hash: `sha256:${'0'.repeat(64)}` }, auth(aliceToken));
    expect(bad.status).toBe(400);
    const r1 = await json('POST', '/v1/jobs/analyze', { jd_text: job.description_text, jd_hash: job.jd_hash, structured_hint: { title: 'Senior Data Engineer', company: 'Acme Analytics' } }, auth(aliceToken));
    expect(r1.status).toBe(200);
    const a1 = (await r1.json()) as { cache: string; job_analysis_id: string; analysis: { requirements: Array<{ quote: string }> } };
    expect(a1.cache).toBe('miss');
    for (const r of a1.analysis.requirements) expect(job.description_text).toContain(r.quote);
    const r2 = await json('POST', '/v1/jobs/analyze', { jd_text: job.description_text, jd_hash: job.jd_hash }, auth(aliceToken));
    expect(((await r2.json()) as { cache: string }).cache).toBe('hit');
    jobAnalysisId = a1.job_analysis_id;
    const usage = (await (await app.request('/v1/usage', { headers: auth(aliceToken) })).json()) as { analyses: { used: number } };
    expect(usage.analyses.used).toBe(2);
    const [logged] = await sql`SELECT count(*)::int AS n FROM ai_requests WHERE task = 'jd_extract' AND config_snapshot_id IS NOT NULL`;
    expect(logged!.n).toBe(1);
  });

  it('structures resume lines transiently', async () => {
    const lines = toPlainText(sampleResume()).split('\n').filter(Boolean).map((text, i) => ({ span_id: `s_v1_1_${i + 1}`, text, page: 1 }));
    const r = await json('POST', '/v1/resumes/structure', { version_id: 'v1', lines }, auth(aliceToken));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { resume: { experience: Array<{ employer: { value: string } }> } };
    expect(body.resume.experience.map((x) => x.employer.value)).toEqual(['Globex', 'Initech']);
  });

  function optimizeBody() {
    const analysis = analyzeJobText(jdText, { title: 'Senior Data Engineer' });
    const { resume, claims } = extractClaims(sampleResume());
    const before = scoreResume({ analysis, resume, claims });
    return { job_analysis_id: jobAnalysisId, resume: toOptResume(resume), claims: toClaimLite(claims), targets: { req_ids: selectTargets(before), edit_budget: { bullets: 8, summary: true, skills_order: true } } };
  }

  async function runOptimization(token: string, key: string) {
    resetRateLimits();
    const r = await json('POST', '/v1/optimizations', optimizeBody(), auth(token, { 'idempotency-key': key }));
    return { status: r.status, body: (await r.json()) as { optimization_id: string; error?: { code: string } } };
  }

  async function waitDone(token: string, id: string) {
    const res = await app.request(`/v1/optimizations/${id}/events`, { headers: auth(token) });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    return text;
  }

  it('runs an optimization end to end with SSE progress; idempotent replay', async () => {
    const r = await runOptimization(aliceToken, 'idem-opt-0001');
    expect(r.status).toBe(202);
    const events = await waitDone(aliceToken, r.body.optimization_id);
    expect(events).toMatch(/"status":"(succeeded|partial)"/);
    const g = await app.request(`/v1/optimizations/${r.body.optimization_id}`, { headers: auth(aliceToken) });
    const out = (await g.json()) as { status: string; result: { bullets: Array<{ text: string; validation: string }> }; meta: { models: string[] } };
    expect(out.result.bullets.some((b) => b.text.includes('Kubernetes'))).toBe(true);
    expect(out.result.bullets.every((b) => b.validation === 'entailed')).toBe(true);
    const replay = await runOptimization(aliceToken, 'idem-opt-0001');
    expect(replay.status).toBe(200);
    expect(replay.body.optimization_id).toBe(r.body.optimization_id);
    const [c] = await sql`SELECT in_flight, optimizations FROM usage_counters WHERE period LIKE 'm:%' AND user_id = (SELECT id FROM users WHERE email = 'alice@example.org')`;
    expect(c!.in_flight).toBe(0);
    expect(c!.optimizations).toBe(1);
    const reqs = await sql`SELECT DISTINCT task FROM ai_requests WHERE optimization_id = ${r.body.optimization_id}`;
    expect(reqs.map((x) => x.task)).toEqual(expect.arrayContaining(['optimize', 'validate_entail']));
  });

  it('enforces the free quota exactly, then credits from a credit pack work', async () => {
    for (const k of ['idem-opt-0002', 'idem-opt-0003']) {
      const r = await runOptimization(aliceToken, k);
      expect(r.status).toBe(202);
      await waitDone(aliceToken, r.body.optimization_id);
    }
    const over = await runOptimization(aliceToken, 'idem-opt-0004');
    expect(over.status).toBe(429);
    expect(over.body.error!.code).toBe('quota_exceeded');
    // Buy a credit pack through the fake Stripe flow.
    const co = await json('POST', '/v1/billing/checkout', { plan_id: 'credit_pack' }, auth(aliceToken, { 'idempotency-key': 'idem-co-0001' }));
    const { transaction_id } = (await co.json()) as { transaction_id: string };
    expect((await json('POST', `/v1/dev/fake-checkout/${transaction_id}/complete`)).status).toBe(200);
    const ok = await runOptimization(aliceToken, 'idem-opt-0005');
    expect(ok.status).toBe(202);
    await waitDone(aliceToken, ok.body.optimization_id);
    const usage = (await (await app.request('/v1/usage', { headers: auth(aliceToken) })).json()) as { optimizations: { credits_remaining: number } };
    expect(usage.optimizations.credits_remaining).toBe(24);
  });

  it('coupons: per-plan preview, per-user limit, single-use race, discounted subscription', async () => {
    const [owner] = await sql`SELECT id FROM users WHERE email = 'owner@example.com'`;
    const cfg = (await services.config.get()).config;
    const now = Date.now();
    const shared = await createCoupon(sql, fakeStripe('http://web'), {
      name: 'Launch',
      codes: { mode: 'single', code: 'LAUNCH30' },
      rules: [
        { plan_id: 'pro_monthly', percent_off: 20, duration: 'first_period' },
        { plan_id: 'pro_quarterly', percent_off: 30, duration: 'repeating', duration_periods: 2 },
      ],
      max_redemptions: 200,
      max_per_user: 1,
      valid_from: new Date(now - 60_000).toISOString(),
      valid_until: new Date(now + 7 * 86_400_000).toISOString(),
    }, { id: owner!.id, role: 'owner', reason: 'integration test coupon' });
    expect(shared.codes).toEqual(['LAUNCH30']);
    void cfg;

    const bob = await login('bob@example.net');
    const pv = await json('POST', '/v1/billing/coupons/preview', { code: 'launch30', plan_id: 'pro_quarterly' }, auth(bob.access_token));
    const p = (await pv.json()) as { price: { list: string; discounted: string }; summary: string };
    expect(p.price).toMatchObject({ list: '45.00', discounted: '31.50' });
    expect(p.summary).toMatch(/first 2 quarters/);
    const wrong = await json('POST', '/v1/billing/coupons/preview', { code: 'LAUNCH30', plan_id: 'byok_annual' }, auth(bob.access_token));
    expect(((await wrong.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('not_for_plan');
    const invalid = await json('POST', '/v1/billing/coupons/preview', { code: 'NOPE1234', plan_id: 'pro_monthly' }, auth(bob.access_token));
    expect(((await invalid.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('invalid');

    const co = await json('POST', '/v1/billing/checkout', { plan_id: 'pro_quarterly', coupon_code: 'LAUNCH30' }, auth(bob.access_token, { 'idempotency-key': 'idem-co-0002' }));
    expect(co.status).toBe(200);
    const { transaction_id, checkout_url } = (await co.json()) as { transaction_id: string; checkout_url: string };
    expect(checkout_url).toContain(`/checkout?session=${transaction_id}`);
    expect(transaction_id).toMatch(/^cs_fake_/);
    const again = await json('POST', '/v1/billing/coupons/preview', { code: 'LAUNCH30', plan_id: 'pro_quarterly' }, auth(bob.access_token));
    expect(((await again.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe('already_used'); // reservation counts
    await json('POST', `/v1/dev/fake-checkout/${transaction_id}/complete`);
    const me = (await (await app.request('/v1/me', { headers: auth(bob.access_token) })).json()) as { plan: string };
    expect(me.plan).toBe('pro_quarterly');
    const [red] = await sql`SELECT status, discount_amount_minor FROM coupon_redemptions WHERE provider_transaction_id = ${transaction_id}`;
    expect(red).toMatchObject({ status: 'completed', discount_amount_minor: 1350 });

    // Customer portal + cancel at period end (the fake emits the same customer.subscription.updated webhook as Stripe's portal).
    const portal = (await (await app.request('/v1/billing/portal', { headers: auth(bob.access_token) })).json()) as { mode: string; manageable: boolean };
    expect(portal).toMatchObject({ mode: 'fake', manageable: true });
    const session = (await (await json('POST', '/v1/billing/portal', { flow: 'cancel' }, auth(bob.access_token))).json()) as { url: string };
    expect(session.url).toContain('/account');
    expect((await json('POST', '/v1/dev/fake-subscription/cancel', { cancel: true }, auth(bob.access_token))).status).toBe(200);
    const canceled = (await (await app.request('/v1/me', { headers: auth(bob.access_token) })).json()) as { plan: string; subscription: { cancel_at_period_end: boolean } };
    expect(canceled).toMatchObject({ plan: 'pro_quarterly', subscription: { cancel_at_period_end: true } }); // keeps access until the period ends
    await json('POST', '/v1/dev/fake-subscription/cancel', { cancel: false }, auth(bob.access_token));
    const resumed = (await (await app.request('/v1/me', { headers: auth(bob.access_token) })).json()) as { subscription: { cancel_at_period_end: boolean } };
    expect(resumed.subscription.cancel_at_period_end).toBe(false);

    // Single-use code: 50 concurrent buyers → exactly one reservation.
    const single = await createCoupon(sql, fakeStripe('http://web'), {
      name: 'Partner',
      codes: { mode: 'single', code: 'ONLYONCE' },
      rules: [{ plan_id: 'pro_monthly', percent_off: 50, duration: 'first_period' }],
      max_redemptions: 1,
      valid_from: new Date(now - 60_000).toISOString(),
      valid_until: new Date(now + 86_400_000).toISOString(),
    }, { id: owner!.id, role: 'owner', reason: 'race test' });
    expect(single.codes).toEqual(['ONLYONCE']);
    const tokens: Array<{ access_token: string }> = [];
    for (let i = 0; i < 50; i++) tokens.push(await login(`racer${i}@example.com`));
    resetRateLimits();
    const results = await Promise.all(tokens.map((t, i) => json('POST', '/v1/billing/checkout', { plan_id: 'pro_monthly', coupon_code: 'ONLYONCE' }, auth(t.access_token, { 'idempotency-key': `idem-race-${i}-xyz` }))));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 422)).toHaveLength(49);
  });

  it('rejects webhooks with a bad signature and ignores duplicates', async () => {
    const raw = JSON.stringify({ id: 'evt_dup_1', type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'paid', metadata: {} } } });
    expect((await app.request('/v1/webhooks/stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': 't=1,v1=abc' } })).status).toBe(401);
    const sig = await signStripePayload(raw, services.env.STRIPE_WEBHOOK_SECRET);
    const a = await app.request('/v1/webhooks/stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': sig } });
    const b = await app.request('/v1/webhooks/stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': sig } });
    expect(((await a.json()) as { processed: boolean }).processed).toBe(true);
    expect(((await b.json()) as { processed: boolean }).processed).toBe(false);
  });

  const stripeEvent = async (id: string, type: string, object: Record<string, unknown>) => {
    const raw = JSON.stringify({ id, object: 'event', type, data: { object } });
    return app.request('/v1/webhooks/stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': await signStripePayload(raw, services.env.STRIPE_WEBHOOK_SECRET) } });
  };

  it('refunds a credit pack: charge.refunded finds its checkout and zeroes the credits', async () => {
    const t = await login('erin@example.org');
    const co = await json('POST', '/v1/billing/checkout', { plan_id: 'credit_pack' }, auth(t.access_token, { 'idempotency-key': 'idem-co-erin1' }));
    const { transaction_id } = (await co.json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${transaction_id}/complete`);
    const [grant] = await sql`SELECT remaining FROM credit_grants WHERE provider_transaction_id = ${transaction_id}`;
    expect(grant!.remaining).toBe(25);
    const partial = await stripeEvent('evt_refund_partial', 'charge.refunded', { id: 'ch_1', refunded: false, payment_intent: `pi_fake_${transaction_id.slice('cs_fake_'.length)}` });
    expect(partial.status).toBe(200);
    expect((await sql`SELECT remaining FROM credit_grants WHERE provider_transaction_id = ${transaction_id}`)[0]!.remaining).toBe(25); // partial refunds keep the pack
    await stripeEvent('evt_refund_full', 'charge.refunded', { id: 'ch_1', refunded: true, payment_intent: `pi_fake_${transaction_id.slice('cs_fake_'.length)}` });
    expect((await sql`SELECT remaining FROM credit_grants WHERE provider_transaction_id = ${transaction_id}`)[0]!.remaining).toBe(0);
  });

  it("keeps a user's current subscription when a late cancellation for an older one arrives", async () => {
    const t = await login('frank@example.org');
    const co = await json('POST', '/v1/billing/checkout', { plan_id: 'pro_monthly' }, auth(t.access_token, { 'idempotency-key': 'idem-co-frank1' }));
    const { transaction_id } = (await co.json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${transaction_id}/complete`);
    const [sub] = await sql<Array<{ user_id: string; provider_subscription_id: string; current_period_end: Date }>>`
      SELECT s.user_id, s.provider_subscription_id, s.current_period_end FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE u.email = 'frank@example.org'`;
    expect(sub!.current_period_end.getTime()).toBeGreaterThan(Date.now()); // period read from the subscription item
    await stripeEvent('evt_old_sub_deleted', 'customer.subscription.deleted', { id: 'sub_older', status: 'canceled', customer: 'cus_x', metadata: { user_id: sub!.user_id, plan_id: 'pro_monthly' } });
    const me = (await (await app.request('/v1/me', { headers: auth(t.access_token) })).json()) as { plan: string; subscription: { status: string } };
    expect(me).toMatchObject({ plan: 'pro_monthly', subscription: { status: 'active' } });
    // An "incomplete" subscription (first payment pending) is recorded as an event but grants nothing.
    await stripeEvent('evt_incomplete', 'customer.subscription.updated', { id: sub!.provider_subscription_id, status: 'incomplete', metadata: { user_id: sub!.user_id } });
    expect(((await (await app.request('/v1/me', { headers: auth(t.access_token) })).json()) as { subscription: { status: string } }).subscription.status).toBe('active');
  });

  it('rolls up usage per step and keeps a verifiable audit chain', async () => {
    const r = await rollupHourly(sql, { lagSeconds: -60 });
    expect(r.rows).toBeGreaterThan(0);
    const [raw] = await sql`SELECT sum(input_tokens)::bigint AS t, count(*)::int AS n FROM ai_requests`;
    const [agg] = await sql`SELECT sum(input_tokens)::bigint AS t, sum(calls)::int AS n FROM ai_usage_hourly`;
    expect(agg!.t).toBe(raw!.t);
    expect(agg!.n).toBe(raw!.n);
    const chain = await verifyAuditChain(sql);
    expect(chain.ok).toBe(true);
    expect(chain.checked).toBeGreaterThan(5);
    await expect(sql`UPDATE audit_log SET reason = 'tampered' WHERE id = 1`).rejects.toThrow(/append-only/);
  });

  it('exports and deletes an account (cascade; AI cost history anonymized)', async () => {
    const t = await login('carol@example.org');
    const exp = await app.request('/v1/account/export', { headers: auth(t.access_token) });
    expect(((await exp.json()) as { user: { email: string } }).user.email).toBe('carol@example.org');
    const del = await app.request('/v1/account', { method: 'DELETE', headers: auth(t.access_token) });
    expect(del.status).toBe(202);
    const [u] = await sql`SELECT count(*)::int AS n FROM users WHERE email = 'carol@example.org'`;
    expect(u!.n).toBe(0);
    const after = await app.request('/v1/me', { headers: auth(t.access_token) });
    expect(after.status).toBe(401);
  });

  it('cancels billing at Stripe before deleting a subscriber, and tolerates later webhooks', async () => {
    const t = await login('dave@example.org');
    const co = await json('POST', '/v1/billing/checkout', { plan_id: 'pro_monthly' }, auth(t.access_token, { 'idempotency-key': 'idem-co-dave1' }));
    const { transaction_id } = (await co.json()) as { transaction_id: string };
    await json('POST', `/v1/dev/fake-checkout/${transaction_id}/complete`);
    const [sub] = await sql<Array<{ user_id: string; provider_subscription_id: string }>>`SELECT s.user_id, s.provider_subscription_id FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE u.email = 'dave@example.org'`;
    const del = await app.request('/v1/account', { method: 'DELETE', headers: auth(t.access_token) });
    expect(((await del.json()) as { steps: Record<string, string> }).steps.billing).toBe(`canceled:${sub!.provider_subscription_id}`);
    const wh = await stripeEvent('evt_after_delete', 'customer.subscription.deleted', { id: sub!.provider_subscription_id, status: 'canceled', metadata: { user_id: sub!.user_id, plan_id: 'pro_monthly' } });
    expect(wh.status).toBe(200);
    const [evt] = await sql`SELECT user_id, processed_at FROM subscription_events WHERE provider_event_id = 'evt_after_delete'`;
    expect(evt).toMatchObject({ user_id: null });
    expect(evt!.processed_at).not.toBeNull();
  });
});
