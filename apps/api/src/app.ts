import { validateAnalysisQuotes } from '@jmo/job-extraction';
import { annotateResult, deleteAccount, deleteUserContent, effectivePlan, exportAccount, isLocalDevOrigin, previewCoupon, release, reserve, runSmokeEval, saveContent, setContentOptIn, settle, timingSafeEqual, usageSummary, userContent } from '@jmo/server';
import {
  AnalyzeJobRequest,
  ApiError,
  CheckoutRequest,
  CouponPreviewRequest,
  FeedbackRequest,
  JobAnalysis,
  jdHash,
  MatchMapRequest,
  OptimizationScores,
  OptimizeRequest,
  OtpRequest,
  OtpVerify,
  RefreshRequest,
  StructureResumeRequest,
  uuidv7,
  ValidationRequest,
} from '@jmo/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppEnv, Deps } from './context';
import { body, dailySpend, errorResponse, optionalAuth, rateLimit, requestId, requireAuth, requireIdempotencyKey, versionGate } from './middleware';

/** For integration tests of other packages (the admin API drives this app in-process). */
export { resetRateLimits } from './middleware';

// Public API (api-design.md §6). Stateless handlers; all state in Postgres (+ in-process job runner on Node).

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const allowed = new Set([deps.env.WEB_ORIGIN, ...deps.env.EXTENSION_ORIGINS]);

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use('*', requestId);
  app.use(
    '*',
    cors({
      origin: (origin) => (allowed.has(origin) || (deps.env.ENV !== 'production' && (origin.startsWith('chrome-extension://') || isLocalDevOrigin(origin))) ? origin : null),
      allowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-extension-version', 'x-request-id', 'last-event-id'],
      exposeHeaders: ['x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-quota-optimizations-remaining', 'retry-after'],
      maxAge: 600,
    }),
  );
  app.onError((err, c) => errorResponse(c, err));
  app.notFound((c) => c.json(new ApiError('not_found', 'Not found.').toEnvelope(c.get('requestId')), 404));

  app.get('/v1/health', async (c) => {
    await deps.sql`SELECT 1`;
    return c.json({ ok: true, payments: deps.billing.mode, env: deps.env.ENV });
  });

  // ── Config (public, signed) ──
  app.get('/v1/config', rateLimit('reads'), async (c) => {
    // Local test mode on trial models: tell the user, in the extension, to use made-up data only.
    const testMode = deps.env.AI_ROUTING_ENV === 'eval' ? [{ id: 'eval-routing', text: 'Test mode: AI runs on free trial models whose terms forbid personal data. Use a made-up resume, not your real one.', plans: ['all'] }] : [];
    const signed = await deps.config.publicSigned(deps.env.CONFIG_SIGNING_PRIVATE_KEY_JWK, deps.env.CONFIG_SIGNING_KEY_ID, { announcements: testMode });
    c.header('cache-control', 'public, max-age=60');
    return c.json(signed);
  });

  app.use('/v1/*', versionGate);

  // ── Auth (api-design.md §3) ──
  app.post('/v1/auth/otp/request', rateLimit('auth'), async (c) => {
    const b = await body(c, OtpRequest);
    const cfg = (await deps.config.get()).config;
    return c.json(await deps.auth.requestOtp(b.email, cfg, { audience: 'ext' }));
  });
  app.post('/v1/auth/otp/verify', rateLimit('auth'), async (c) => {
    const b = await body(c, OtpVerify.extend({ device: z.string().max(80).optional() }));
    return c.json(await deps.auth.verifyOtp(b.email, b.code, { audience: 'ext', device: b.device, requestId: c.get('requestId') }));
  });
  app.post('/v1/auth/google', rateLimit('auth'), async (c) => {
    const b = await body(c, z.object({ id_token: z.string().min(20).max(8192), nonce: z.string().min(16).max(128), device: z.string().max(80).optional() }));
    const cfg = (await deps.config.get()).config;
    return c.json(await deps.auth.verifyGoogle(b.id_token, b.nonce, cfg, { ...(b.device ? { device: b.device } : {}), requestId: c.get('requestId') }));
  });
  app.post('/v1/auth/refresh', rateLimit('auth'), async (c) => {
    const b = await body(c, RefreshRequest);
    return c.json(await deps.auth.refresh(b.refresh_token, 'ext', c.get('requestId')));
  });
  app.post('/v1/auth/logout', requireAuth, async (c) => {
    const u = c.get('user')!;
    await deps.auth.logout(u.sid, false, u.sub);
    return c.body(null, 204);
  });
  app.post('/v1/auth/logout-all', requireAuth, async (c) => {
    const u = c.get('user')!;
    await deps.auth.logout(u.sid, true, u.sub);
    return c.body(null, 204);
  });

  // ── Me / usage ──
  app.get('/v1/me', requireAuth, async (c) => {
    const u = c.get('user')!;
    const [row] = await deps.sql<Array<{ email: string; display_name: string | null; history_opt_in: boolean; telemetry_opt_in: boolean; content_opt_in: boolean; consent_version: string }>>`
      SELECT email, display_name, history_opt_in, telemetry_opt_in, content_opt_in, consent_version FROM users WHERE id = ${u.sub}`;
    if (!row) throw new ApiError('unauthenticated', 'Account not found.');
    const ep = await effectivePlan(deps.sql, u.sub);
    return c.json({
      id: u.sub,
      email: row.email,
      display_name: row.display_name,
      plan: ep.plan,
      subscription: ep.subscription ? { status: ep.subscription.status, current_period_end: ep.subscription.current_period_end, cancel_at_period_end: ep.subscription.cancel_at_period_end } : null,
      grant: ep.grant,
      settings: { history_opt_in: row.history_opt_in, telemetry_opt_in: row.telemetry_opt_in, content_opt_in: row.content_opt_in },
      consent_version: row.consent_version,
    });
  });
  app.get('/v1/usage', requireAuth, async (c) => c.json(await usageSummary(deps.sql, (await deps.config.get()).config, c.get('user')!.sub)));
  app.patch('/v1/account/settings', requireAuth, async (c) => {
    const b = await body(c, z.object({ history_opt_in: z.boolean().optional(), telemetry_opt_in: z.boolean().optional(), content_opt_in: z.boolean().optional(), consent_version: z.string().max(20).optional(), display_name: z.string().max(80).optional() }));
    const u = c.get('user')!;
    // Opting out of "save my data" deletes what was saved (content-store.ts).
    if (b.content_opt_in !== undefined) await setContentOptIn(deps.sql, u.sub, b.content_opt_in);
    await deps.sql`UPDATE users SET history_opt_in = COALESCE(${b.history_opt_in ?? null}, history_opt_in), telemetry_opt_in = COALESCE(${b.telemetry_opt_in ?? null}, telemetry_opt_in),
                   consent_version = COALESCE(${b.consent_version ?? null}, consent_version), display_name = COALESCE(${b.display_name ?? null}, display_name), updated_at = now() WHERE id = ${u.sub}`;
    return c.body(null, 204);
  });

  // ── Jobs: analysis with the shared jd_hash cache (api-design.md §6.4) ──
  app.post('/v1/jobs/analyze', requireAuth, rateLimit('ai'), async (c) => {
    const b = await body(c, AnalyzeJobRequest, 64 * 1024);
    const u = c.get('user')!;
    if ((await jdHash(b.jd_text)) !== b.jd_hash) throw new ApiError('invalid_request', 'jd_hash does not match jd_text.');
    const { config, snapshot } = await deps.config.get();
    const promptVersion = config.prompts.live.jd_extract ?? 'jd_extract@v1';
    const reservation = await reserve(deps.sql, config, u.sub, 'analysis', { dailySpendUsd: await dailySpend(c) });
    try {
      let [row] = await deps.sql<Array<{ id: string; analysis: unknown }>>`
        UPDATE job_analyses SET hits = hits + 1, last_used_at = now() WHERE jd_hash = ${b.jd_hash} AND prompt_version = ${promptVersion} AND model_tier = 'cheap' RETURNING id, analysis`;
      let cache: 'hit' | 'miss' = 'hit';
      let cost = 0;
      if (!row) {
        cache = 'miss';
        const { service } = await deps.ai.ready();
        const r = await service.analyzeJob(b.jd_text, { ...(b.structured_hint?.title ? { title: b.structured_hint.title } : {}), ...(b.structured_hint?.company ? { company: b.structured_hint.company } : {}), ...(b.structured_hint?.location ? { location: b.structured_hint.location } : {}), ...(b.source?.host ? { host: b.source.host } : {}) }, { userId: u.sub, plan: u.plan, requestId: c.get('requestId'), configSnapshotId: snapshot, bucketKey: u.sub });
        cost = r.cost_usd;
        const id = uuidv7();
        [row] = await deps.sql<Array<{ id: string; analysis: unknown }>>`
          INSERT INTO job_analyses (id, jd_hash, prompt_version, model_tier, analysis, model_id) VALUES (${id}, ${b.jd_hash}, ${promptVersion}, 'cheap', ${deps.sql.json(r.analysis as never)}, ${r.model})
          ON CONFLICT (jd_hash, prompt_version, model_tier) DO UPDATE SET last_used_at = now() RETURNING id, analysis`;
      }
      const analysis = JobAnalysis.parse(row!.analysis);
      await deps.sql`INSERT INTO jobs (id, user_id, job_analysis_id, jd_hash, title, company, host) VALUES (${uuidv7()}, ${u.sub}, ${row!.id}, ${b.jd_hash}, ${analysis.title || null}, ${analysis.company || null}, ${b.source?.host ?? null})
                     ON CONFLICT (user_id, jd_hash) DO UPDATE SET job_analysis_id = EXCLUDED.job_analysis_id`;
      await settle(deps.sql, reservation.reservation_id, cost);
      // The quote check also runs on cached analyses (defence in depth).
      const { analysis: validated } = validateAnalysisQuotes(analysis, b.jd_text);
      await saveContent(deps.sql, deps.env.CONTENT_ENCRYPTION_KEY, {
        userId: u.sub,
        kind: 'job_post',
        jobAnalysisId: row!.id,
        oncePerJob: true,
        payload: { jd_text: b.jd_text, source: b.source ?? null, structured_hint: b.structured_hint ?? null },
        meta: { title: validated.title || null, company: validated.company || null, host: b.source?.host ?? null, jd_hash: b.jd_hash, requirements: validated.requirements.length, chars: b.jd_text.length, cache },
      }).catch((e: Error) => console.warn(`[content] job post not saved: ${e.message}`));
      return c.json({ job_analysis_id: row!.id, cache, analysis: validated });
    } catch (e) {
      await release(deps.sql, reservation.reservation_id);
      throw e;
    }
  });

  // ── Resumes: transient structuring (nothing stored) ──
  app.post('/v1/resumes/structure', requireAuth, rateLimit('ai'), async (c) => {
    const b = await body(c, StructureResumeRequest, 200 * 1024);
    const u = c.get('user')!;
    const { config, snapshot } = await deps.config.get();
    const reservation = await reserve(deps.sql, config, u.sub, 'resume_structure');
    try {
      const { service } = await deps.ai.ready();
      const { cost_usd, ...r } = await service.structureResume(b.lines, { resumeId: 'r', versionId: b.version_id }, { userId: u.sub, plan: u.plan, requestId: c.get('requestId'), configSnapshotId: snapshot, bucketKey: u.sub });
      await settle(deps.sql, reservation.reservation_id, cost_usd);
      return c.json(r);
    } catch (e) {
      await release(deps.sql, reservation.reservation_id);
      throw e;
    }
  });

  // ── Matching: ambiguous requirements only ──
  app.post('/v1/matches/map', requireAuth, rateLimit('ai'), async (c) => {
    const b = await body(c, MatchMapRequest, 200 * 1024);
    const u = c.get('user')!;
    const { config, snapshot } = await deps.config.get();
    const reservation = await reserve(deps.sql, config, u.sub, 'analysis', { dailySpendUsd: await dailySpend(c) });
    try {
      const { service } = await deps.ai.ready();
      const { cost_usd, ...r } = await service.mapMatches(b.requirements, b.evidence, { userId: u.sub, plan: u.plan, requestId: c.get('requestId'), configSnapshotId: snapshot, bucketKey: u.sub });
      await settle(deps.sql, reservation.reservation_id, cost_usd);
      return c.json(r);
    } catch (e) {
      await release(deps.sql, reservation.reservation_id);
      throw e;
    }
  });

  // ── Optimizations (async + SSE) ──
  app.post('/v1/optimizations', requireAuth, rateLimit('optimizations'), async (c) => {
    const key = requireIdempotencyKey(c);
    const b = await body(c, OptimizeRequest, 256 * 1024);
    const u = c.get('user')!;
    const r = await deps.runner.create({ id: u.sub, plan: u.plan }, b, key, { requestId: c.get('requestId'), dailySpendUsd: await dailySpend(c) });
    return c.json({ optimization_id: r.optimization_id, status: r.status, events_url: `/v1/optimizations/${r.optimization_id}/events`, estimated_seconds: 35 }, r.replay ? 200 : 202);
  });
  app.get('/v1/optimizations', requireAuth, rateLimit('reads'), async (c) => c.json({ data: await deps.runner.list(c.get('user')!.sub, Math.min(50, Number(c.req.query('limit') ?? 20))) }));
  app.get('/v1/optimizations/:id', requireAuth, rateLimit('reads'), async (c) => c.json(await deps.runner.get(c.get('user')!.sub, c.req.param('id'), { ack: c.req.query('ack') === '1' })));
  app.post('/v1/optimizations/:id/cancel', requireAuth, async (c) => c.json(await deps.runner.cancel(c.get('user')!.sub, c.req.param('id')), 202));
  app.post('/v1/optimizations/:id/scores', requireAuth, async (c) => {
    const b = await body(c, OptimizationScores);
    await deps.runner.recordScores(c.get('user')!.sub, c.req.param('id'), b);
    await annotateResult(deps.sql, c.get('user')!.sub, c.req.param('id'), { before_score: b.before_score, after_score: Math.min(b.after_score, b.ceiling_score), ceiling_score: b.ceiling_score });
    return c.body(null, 204);
  });
  app.get('/v1/optimizations/:id/events', requireAuth, async (c) => {
    const userId = c.get('user')!.sub;
    const id = c.req.param('id');
    const first = await deps.runner.status(userId, id);
    if (!first) throw new ApiError('not_found', 'Optimization not found.');
    return streamSSE(c, async (stream) => {
      let n = 0;
      const terminal = (s: string) => ['succeeded', 'partial', 'failed', 'canceled'].includes(s);
      await stream.writeSSE({ event: 'status', data: JSON.stringify(first), id: String(++n) });
      if (terminal(first.status)) return;
      await new Promise<void>((resolve) => {
        // Writes are chained so the terminal event is flushed before the stream closes.
        let chain: Promise<unknown> = Promise.resolve();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          unsub();
          clearInterval(hb);
          void chain.then(() => resolve());
        };
        const unsub = deps.runner.subscribe(id, (e) => {
          chain = chain.then(() => stream.writeSSE({ event: 'status', data: JSON.stringify(e), id: String(++n) }));
          if (terminal(e.status)) finish();
        });
        const hb = setInterval(() => {
          chain = chain.then(() => stream.write(': heartbeat\n\n'));
        }, 15_000);
        stream.onAbort(finish);
        // The job may have finished between the first read and the subscription.
        void deps.runner.status(userId, id).then((s) => {
          if (s && terminal(s.status) && !done) {
            chain = chain.then(() => stream.writeSSE({ event: 'status', data: JSON.stringify(s), id: String(++n) }));
            finish();
          }
        });
      });
    });
  });

  // ── Validations (G7 for user edits) ──
  app.post('/v1/validations', requireAuth, rateLimit('ai'), async (c) => {
    const b = await body(c, ValidationRequest);
    const u = c.get('user')!;
    const { config, snapshot } = await deps.config.get();
    const reservation = await reserve(deps.sql, config, u.sub, 'validation', { dailySpendUsd: await dailySpend(c) });
    try {
      const { service } = await deps.ai.ready();
      const { cost_usd, ...r } = await service.validateEdits(b.pairs, { userId: u.sub, plan: u.plan, requestId: c.get('requestId'), configSnapshotId: snapshot, bucketKey: u.sub });
      await settle(deps.sql, reservation.reservation_id, cost_usd);
      return c.json(r);
    } catch (e) {
      await release(deps.sql, reservation.reservation_id);
      throw e;
    }
  });

  // ── Billing (api-design.md §6.16) ──
  app.get('/v1/billing/plans', async (c) => c.json({ plans: await deps.billing.listPlans((await deps.config.get()).config) }));
  app.post('/v1/billing/coupons/preview', requireAuth, rateLimit('coupons'), async (c) => {
    const b = await body(c, CouponPreviewRequest);
    const u = c.get('user')!;
    const [row] = await deps.sql<Array<{ email: string }>>`SELECT email FROM users WHERE id = ${u.sub}`;
    return c.json(await previewCoupon(deps.sql, (await deps.config.get()).config, b.code, b.plan_id, { id: u.sub, email: row!.email }));
  });
  app.post('/v1/billing/checkout', requireAuth, rateLimit('coupons'), async (c) => {
    requireIdempotencyKey(c);
    const b = await body(c, CheckoutRequest);
    const u = c.get('user')!;
    const [row] = await deps.sql<Array<{ email: string }>>`SELECT email FROM users WHERE id = ${u.sub}`;
    return c.json(await deps.billing.checkout((await deps.config.get()).config, { id: u.sub, email: row!.email }, b.plan_id, b.coupon_code));
  });
  app.get('/v1/billing/portal', requireAuth, rateLimit('reads'), async (c) => c.json(await deps.billing.portal(c.get('user')!.sub)));
  // Stripe portal URLs expire within minutes, so the account page asks for one when a billing button is clicked.
  app.post('/v1/billing/portal', requireAuth, rateLimit('reads'), async (c) => {
    const b = await body(c, z.object({ flow: z.enum(['overview', 'cancel', 'update_payment']).default('overview') }));
    return c.json(await deps.billing.portalSession(c.get('user')!.sub, b.flow));
  });

  // ── Webhooks (raw body; signature verified) ──
  app.post('/v1/webhooks/stripe', async (c) => {
    const raw = await c.req.text();
    const r = await deps.billing.handleWebhook(raw, c.req.header('stripe-signature') ?? null);
    deps.config.invalidate();
    return c.json({ ok: true, processed: r.processed });
  });

  // ── Dev-only: complete a fake checkout (the web checkout page calls this) ──
  app.post('/v1/dev/fake-checkout/:session/complete', async (c) => {
    if (deps.env.ENV === 'production' || deps.billing.mode !== 'fake') throw new ApiError('not_found', 'Not found.');
    await deps.billing.completeFakeCheckout(c.req.param('session'));
    return c.json({ ok: true });
  });

  app.post('/v1/dev/fake-subscription/cancel', requireAuth, async (c) => {
    if (deps.env.ENV === 'production' || deps.billing.mode !== 'fake') throw new ApiError('not_found', 'Not found.');
    const b = await body(c, z.object({ cancel: z.boolean() }));
    await deps.billing.fakeSetCancel(c.get('user')!.sub, b.cancel);
    return c.json({ ok: true });
  });

  // ── Internal (admin plane → API; a Cloudflare service binding in production, never public) ──
  const internalCaller = (token: string | undefined) => !!token && timingSafeEqual(token, deps.env.INTERNAL_TOKEN);
  app.post('/internal/credentials/:id/test', async (c) => {
    if (!internalCaller(c.req.header('x-internal-token'))) throw new ApiError('not_found', 'Not found.');
    return c.json(await deps.ai.testCredential(c.req.param('id')));
  });
  app.post('/internal/config/invalidate', async (c) => {
    if (!internalCaller(c.req.header('x-internal-token'))) throw new ApiError('not_found', 'Not found.');
    deps.config.invalidate();
    deps.ai.forgetAllKeys();
    await deps.ai.refresh(true);
    return c.json({ ok: true });
  });
  app.post('/internal/evals/run', async (c) => {
    if (!internalCaller(c.req.header('x-internal-token'))) throw new ApiError('not_found', 'Not found.');
    const b = (await c.req.json()) as { routing: unknown; label?: string };
    return c.json(await runSmokeEval(deps.sql, deps.ai, b.routing as never, b.label ?? 'admin'));
  });

  // ── Account rights ──
  app.get('/v1/account/export', requireAuth, rateLimit('reads'), async (c) => {
    const id = c.get('user')!.sub;
    return c.json({ ...(await exportAccount(deps.sql, id)), saved_content: await userContent(deps.sql, deps.env.CONTENT_ENCRYPTION_KEY, id) });
  });
  app.delete('/v1/account/content', requireAuth, async (c) => c.json({ deleted: await deleteUserContent(deps.sql, c.get('user')!.sub) }));
  app.delete('/v1/account', requireAuth, async (c) => c.json(await deleteAccount(deps.sql, c.get('user')!.sub, 'user', undefined, { cancelBilling: (id) => deps.billing.cancelForDeletion(id) }), 202));

  // ── Feedback ──
  app.post('/v1/feedback', optionalAuth, rateLimit('reads'), async (c) => {
    const b = await body(c, FeedbackRequest);
    const u = c.get('user');
    // Feedback may reference only the caller's own optimization (ids are not secrets).
    if (b.optimization_id && !(u && (await deps.sql`SELECT 1 FROM optimizations WHERE id = ${b.optimization_id} AND user_id = ${u.sub}`).length)) {
      throw new ApiError('not_found', 'Optimization not found.');
    }
    await deps.sql`INSERT INTO feedback (id, user_id, optimization_id, target, target_ref, rating, reason_code, comment, content_shared)
                   VALUES (${uuidv7()}, ${u?.sub ?? null}, ${b.optimization_id ?? null}, ${b.target}, ${b.target_ref ?? null}, ${b.rating ?? null}, ${b.reason_code ?? null}, ${b.comment ?? null}, ${b.content_shared})`;
    return c.body(null, 201);
  });

  return app;
}
