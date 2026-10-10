import { isLocalDevOrigin } from '@jmo/server';
import { ApiError, uuidv7 } from '@jmo/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { AdminDeps, AdminEnv } from './context';
import { adminGuard, can, PERMS } from './guard';
import { ai } from './routes/ai';
import { analytics } from './routes/analytics';
import { config } from './routes/config';
import { content } from './routes/content';
import { core } from './routes/core';
import { coupons } from './routes/coupons';
import { parse } from './util';

// Admin API (api-design.md §11) — a SEPARATE deployment behind Cloudflare Access. No public routes.

export function createAdminApp(deps: AdminDeps) {
  const app = new Hono<AdminEnv>();
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    const rid = uuidv7();
    c.set('requestId', rid);
    c.header('x-request-id', rid);
    c.header('x-frame-options', 'DENY');
    c.header('content-security-policy', "frame-ancestors 'none'");
    await next();
  });
  app.use('*', cors({ origin: (o) => (o === deps.env.ADMIN_ORIGIN || (deps.env.ENV !== 'production' && isLocalDevOrigin(o)) ? o : null), allowHeaders: ['authorization', 'content-type', 'cf-access-jwt-assertion'], exposeHeaders: ['x-request-id'] }));
  app.onError((err, c) => {
    const rid = c.get('requestId');
    if (err instanceof ApiError) return c.json(err.toEnvelope(rid), err.status as 400);
    if (err instanceof z.ZodError) return c.json(new ApiError('invalid_request', 'Invalid parameter.', { issues: err.issues.slice(0, 5) }).toEnvelope(rid), 400);
    if ((err as { code?: string })?.code === '22P02') return c.json(new ApiError('invalid_request', 'Invalid identifier.').toEnvelope(rid), 400);
    console.error(`[admin ${rid}]`, err);
    return c.json(new ApiError('internal', 'Something went wrong.').toEnvelope(rid), 500);
  });

  app.get('/admin/v1/health', async (c) => {
    await deps.sql`SELECT 1`;
    return c.json({ ok: true });
  });

  // ── Admin sign-in (email code → admin session; Cloudflare Access sits in front in production) ──
  app.post('/admin/v1/auth/otp/request', async (c) => {
    const b = await parse(c, z.object({ email: z.string().email() }));
    const [m] = await deps.sql`SELECT 1 FROM admin_members a JOIN users u ON u.id = a.user_id WHERE u.email = ${b.email.toLowerCase()} AND a.revoked_at IS NULL`;
    // Same response whether or not the address is an admin (no account enumeration).
    if (!m) return c.json({ sent: true });
    return c.json(await deps.auth.requestOtp(b.email, (await deps.config.get()).config, { audience: 'admin' }));
  });
  app.post('/admin/v1/auth/otp/verify', async (c) => {
    const b = await parse(c, z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) }));
    return c.json(await deps.auth.verifyOtp(b.email, b.code, { audience: 'admin', device: c.req.header('user-agent')?.slice(0, 80), requestId: c.get('requestId') }));
  });
  app.post('/admin/v1/auth/refresh', async (c) => {
    const b = await parse(c, z.object({ refresh_token: z.string() }));
    return c.json(await deps.auth.refresh(b.refresh_token, 'admin', c.get('requestId')));
  });

  app.use('/admin/v1/*', adminGuard);
  app.get('/admin/v1/me', async (c) => {
    const a = c.get('admin');
    const s = await deps.auth.sessionActive(a.sid);
    return c.json({ id: a.id, email: a.email, role: a.role, step_up_valid_until: s.lastStepUp ? new Date(s.lastStepUp.getTime() + 10 * 60_000).toISOString() : null, permissions: Object.keys(PERMS).filter((p) => can(a.role, p as keyof typeof PERMS)) });
  });
  app.post('/admin/v1/auth/step-up/request', async (c) => c.json(await deps.auth.requestOtp(c.get('admin').email, (await deps.config.get()).config, { audience: 'admin' })));
  app.post('/admin/v1/auth/step-up/verify', async (c) => {
    const b = await parse(c, z.object({ code: z.string().regex(/^\d{6}$/) }));
    await deps.auth.stepUp(c.get('admin').sid, c.get('admin').email, b.code);
    return c.json({ ok: true, valid_until: new Date(Date.now() + 10 * 60_000).toISOString() });
  });
  app.post('/admin/v1/auth/logout', async (c) => {
    await deps.auth.logout(c.get('admin').sid, false, c.get('admin').id);
    return c.body(null, 204);
  });

  app.route('/admin/v1', core);
  app.route('/admin/v1', coupons);
  app.route('/admin/v1', config);
  app.route('/admin/v1', ai);
  app.route('/admin/v1', analytics);
  app.route('/admin/v1', content);
  return app;
}
