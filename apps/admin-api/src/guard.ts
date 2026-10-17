import type { Namespace } from '@jmo/config';
import { audit } from '@jmo/server';
import { ApiError } from '@jmo/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AdminEnv, AdminUser } from './context';

// Permission matrix (admin-panel.md §4.2) — code, not config.
export const PERMS = {
  'dashboards.view': ['owner', 'admin', 'support', 'finance', 'analyst'],
  'users.view': ['owner', 'admin', 'support', 'finance'],
  'users.grant': ['owner', 'admin', 'support'],
  'users.suspend': ['owner', 'admin', 'support'],
  'users.delete': ['owner', 'admin', 'support'],
  'coupons.view': ['owner', 'admin', 'support', 'finance'],
  'coupons.edit': ['owner', 'admin', 'finance'],
  'coupons.pause': ['owner', 'admin', 'support', 'finance'],
  'plans.limits': ['owner', 'admin'],
  'plans.prices': ['owner', 'finance'],
  'config.ai': ['owner', 'admin'],
  'config.ops': ['owner', 'admin'],
  'config.announcements': ['owner', 'admin', 'support'],
  'config.kill_switches': ['owner', 'admin', 'support'],
  'config.owner': ['owner'],
  'keys.manage': ['owner'],
  'keys.test': ['owner', 'admin'],
  'providers.policy': ['owner'],
  'models.edit': ['owner', 'admin'],
  'analytics.users': ['owner', 'admin', 'support', 'finance'],
  'insights.decide': ['owner', 'admin'],
  'traces.view': ['owner', 'admin', 'support'],
  'audit.view': ['owner', 'admin', 'support', 'finance'],
  'audit.export': ['owner', 'admin', 'finance'],
  'privacy.view': ['owner', 'admin', 'support'],
  'feedback.view': ['owner', 'admin', 'support'],
  'admins.manage': ['owner'],
  'system.view': ['owner', 'admin'],
  // Opt-in saved content: aggregates for everyone, raw job posts/resumes/results for Owner and Admin (step-up, audited).
  'content.stats': ['owner', 'admin', 'support', 'finance', 'analyst'],
  'content.view': ['owner', 'admin'],
} as const satisfies Record<string, readonly AdminUser['role'][]>;
export type Perm = keyof typeof PERMS;

export const NAMESPACE_PERM: Record<Namespace, Perm> = {
  plans: 'plans.limits',
  ai_routing: 'config.ai',
  budgets: 'config.ai',
  prompts: 'config.ai',
  scoring: 'config.ai',
  extraction: 'config.ops',
  features: 'config.ops',
  kill_switches: 'config.kill_switches',
  limits: 'config.ops',
  announcements: 'config.announcements',
  retention: 'config.owner',
  coupons_policy: 'config.owner',
  insights: 'config.ai',
};

export function can(role: AdminUser['role'], perm: Perm): boolean {
  return (PERMS[perm] as readonly string[]).includes(role);
}

export function need(perm: Perm): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (!can(c.get('admin').role, perm)) throw new ApiError('forbidden', `Your role (${c.get('admin').role}) cannot do this.`);
    await next();
  };
}

const STEP_UP_WINDOW_MS = 10 * 60_000;

/** Dangerous actions need a re-authentication within the last 10 minutes (admin-panel.md §4.1). */
export const stepUp: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const { auth } = c.get('deps');
  const s = await auth.sessionActive(c.get('admin').sid);
  if (!s.lastStepUp || Date.now() - s.lastStepUp.getTime() > STEP_UP_WINDOW_MS) throw new ApiError('step_up_required', 'Please confirm with a fresh sign-in code.');
  await next();
};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Layer 1–3: Cloudflare Access JWT (when configured) → admin bearer token → live admin membership. */
export const adminGuard: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const { env, auth, sql } = c.get('deps');
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    const assertion = c.req.header('cf-access-jwt-assertion');
    if (!assertion) throw new ApiError('unauthenticated', 'Cloudflare Access required.');
    jwks ??= createRemoteJWKSet(new URL(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    try {
      await jwtVerify(assertion, jwks, { issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`, audience: env.CF_ACCESS_AUD });
    } catch {
      throw new ApiError('unauthenticated', 'Invalid Cloudflare Access token.');
    }
  } else if (env.ENV === 'production' && !env.ADMIN_ALLOW_WITHOUT_ACCESS) {
    throw new ApiError('forbidden', 'Admin API requires Cloudflare Access in production.');
  }
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) throw new ApiError('unauthenticated', 'Admin sign-in required.');
  const claims = await auth.verifyAccess(h.slice(7), 'admin');
  const s = await auth.sessionActive(claims.sid);
  if (!s.active) throw new ApiError('session_revoked', 'Session revoked.');
  const [m] = await sql<Array<{ role: AdminUser['role']; email: string }>>`
    SELECT a.role, u.email FROM admin_members a JOIN users u ON u.id = a.user_id WHERE a.user_id = ${claims.sub} AND a.revoked_at IS NULL`;
  if (!m) throw new ApiError('forbidden', 'Admin access revoked.');
  c.set('admin', { id: claims.sub, email: m.email, role: m.role, sid: claims.sid });
  await next();
};

/** Writes need a human reason (≥ 10 chars); it is stored in the audit row. */
export function reasonOf(b: { reason?: unknown }): string {
  const r = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (r.length < 10) throw new ApiError('invalid_request', 'Please give a reason (at least 10 characters). It is saved in the audit log.');
  return r.slice(0, 500);
}

export async function auditRead(c: Context<AdminEnv>, action: string, targetType: string, targetId: string) {
  const a = c.get('admin');
  await c.get('deps').sql.begin((tx) => audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action, target_type: targetType, target_id: targetId, request_id: c.get('requestId') }));
}

export function actor(c: Context<AdminEnv>) {
  const a = c.get('admin');
  return { id: a.id, role: a.role, requestId: c.get('requestId') };
}
