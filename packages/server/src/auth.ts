import type { ActiveConfig } from '@jmo/config';
import type { Sql, Tx } from '@jmo/db';
import { ApiError, CONSENT_VERSION, type PlanId, randomOtp, randomToken, uuidv7 } from '@jmo/shared';
import { jwtVerify, SignJWT } from 'jose';
import { audit } from './audit';
import { saltedHash } from './crypto';
import type { GoogleIdentity, GoogleVerifier } from './google';
import type { Mailer } from './mailer';
import { effectivePlan } from './users';

// Auth for the extension and the admin panel (api-design.md §3): email OTP → short-lived access JWT (15 min) +
// rotating opaque refresh token (30 days) with family reuse detection. Google sign-in reuses issueTokens().

export type Audience = 'ext' | 'admin';

export interface AccessClaims {
  sub: string;
  plan: PlanId;
  aud: Audience;
  sid: string;
  role?: string;
}

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const ADMIN_REFRESH_TTL_MS = 12 * 3600 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;

export class AuthService {
  private key: Uint8Array;
  constructor(
    private sql: Sql,
    private secret: string,
    private mailer: Mailer,
    private opts: { exposeDevCode: boolean; google?: GoogleVerifier },
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async requestOtp(emailRaw: string, cfg: ActiveConfig, meta: { ip?: string; audience?: Audience } = {}): Promise<{ sent: true; dev_code?: string }> {
    const email = emailRaw.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (cfg.limits.disposable_domains.includes(domain)) throw new ApiError('invalid_request', 'Please use a permanent email address.');
    if (cfg.kill_switches.signups && meta.audience !== 'admin') {
      const [u] = await this.sql`SELECT 1 FROM users WHERE email = ${email}`;
      if (!u) throw new ApiError('maintenance', 'New sign-ups are temporarily paused.');
    }
    const code = randomOtp();
    const codeHash = await saltedHash(`${email}:${code}`, this.secret);
    // Count and insert under a per-address lock: concurrent requests (repeated clicks while a sleeping server wakes up)
    // used to all pass the count before any insert, sending more codes than the hourly limit allows.
    const allowed = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`otp:${email}`}))`;
      const [row] = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM auth_verifications WHERE identifier = ${email} AND created_at > now() - interval '1 hour'`;
      if (row!.n >= cfg.limits.otp_per_hour) return false;
      await tx`INSERT INTO auth_verifications (id, identifier, code_hash, expires_at) VALUES (${uuidv7()}, ${email}, ${codeHash}, ${new Date(Date.now() + OTP_TTL_MS)})`;
      return true;
    });
    if (!allowed) throw new ApiError('rate_limited', 'Too many codes requested. Try again later.', { retry_after_s: 3600 });
    try {
      await this.mailer.send(email, 'Your sign-in code', `Your Job Match Optimizer sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't request it, ignore this email.`);
    } catch (e) {
      // Development: the code is on screen anyway, so an address the mail provider refuses (Resend's test sender only
      // reaches the account owner; example.com is rejected) must not block sign-in. Production still fails loudly.
      if (!this.opts.exposeDevCode) throw e;
      console.warn(`[mail] not sent to ${email} (${(e as Error).message}); development code shown on screen instead`);
    }
    return { sent: true, ...(this.opts.exposeDevCode ? { dev_code: code } : {}) };
  }

  /**
   * Checks the newest unused code for `email`. A wrong guess is counted and COMMITTED before the error is raised:
   * throwing inside the transaction would roll the counter back and make the 5-attempt limit ineffective.
   */
  private async checkCode(email: string, code: string): Promise<string> {
    const outcome = await this.sql.begin(async (tx) => {
      const [v] = await tx<Array<{ id: string; code_hash: Uint8Array; attempts: number; expires_at: Date }>>`
        SELECT id, code_hash, attempts, expires_at FROM auth_verifications
        WHERE identifier = ${email} AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      if (!v || v.expires_at < new Date()) return { error: new ApiError('unauthenticated', 'That code has expired. Request a new one.') };
      if (v.attempts >= MAX_CODE_ATTEMPTS) return { error: new ApiError('rate_limited', 'Too many attempts. Request a new code.') };
      const hash = await saltedHash(`${email}:${code}`, this.secret);
      if (!timingSafeEqualBytes(hash, v.code_hash)) {
        await tx`UPDATE auth_verifications SET attempts = attempts + 1 WHERE id = ${v.id}`;
        return { error: new ApiError('unauthenticated', 'That code is not correct.') };
      }
      return { id: v.id };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.id;
  }

  async verifyOtp(emailRaw: string, code: string, meta: { audience: Audience; device?: string; ip?: string; requestId?: string }) {
    const email = emailRaw.trim().toLowerCase();
    const verificationId = await this.checkCode(email, code);
    return this.sql.begin(async (tx) => {
      // Consume it only if nobody else did in the meantime (a code signs in once).
      const consumed = await tx`UPDATE auth_verifications SET consumed_at = now() WHERE id = ${verificationId} AND consumed_at IS NULL RETURNING id`;
      if (!consumed.length) throw new ApiError('unauthenticated', 'That code has expired. Request a new one.');
      let [user] = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE email = ${email}`;
      if (!user) {
        if (meta.audience === 'admin') throw new ApiError('forbidden', 'Not an admin account.');
        [user] = await tx<Array<{ id: string; status: string }>>`
          INSERT INTO users (id, email, email_verified, consent_version) VALUES (${uuidv7()}, ${email}, true, ${CONSENT_VERSION}) RETURNING id, status`;
        await tx`INSERT INTO auth_accounts (id, user_id, provider, provider_account_id) VALUES (${uuidv7()}, ${user!.id}, 'email', ${email})`;
      } else {
        await tx`UPDATE users SET email_verified = true WHERE id = ${user.id}`;
      }
      assertCanSignIn(user!.status);
      let role: string | undefined;
      if (meta.audience === 'admin') {
        const [m] = await tx<Array<{ role: string }>>`SELECT role FROM admin_members WHERE user_id = ${user!.id} AND revoked_at IS NULL`;
        if (!m) throw new ApiError('forbidden', 'Not an admin account.');
        role = m.role;
      }
      await audit(tx, { actor_type: meta.audience === 'admin' ? 'admin' : 'user', actor_id: user!.id, actor_role: role ?? null, action: meta.audience === 'admin' ? 'admin.login' : 'login', target_type: 'user', target_id: user!.id, request_id: meta.requestId ?? null });
      return this.issueTokens(tx, user!.id, meta.audience, { device: meta.device, ...(role ? { role } : {}), stepUp: meta.audience === 'admin' });
    });
  }

  /**
   * Sign in with a Google ID token. The account is found by Google's stable subject id, else linked to an existing
   * account with the same (Google-verified) email, else created. Extension and website users only; admins sign in
   * with an email code behind Cloudflare Access.
   */
  async verifyGoogle(idToken: string, nonce: string, cfg: ActiveConfig, meta: { device?: string; requestId?: string }) {
    if (!this.opts.google) throw new ApiError('invalid_request', 'Google sign-in is not available.');
    let id: GoogleIdentity;
    try {
      id = await this.opts.google.verify(idToken);
    } catch {
      throw new ApiError('unauthenticated', 'Google sign-in failed. Please try again.');
    }
    // The nonce binds the token to the sign-in attempt that asked for it (no replay of a token issued elsewhere).
    if (!id.nonce || id.nonce !== nonce) throw new ApiError('unauthenticated', 'Google sign-in failed. Please try again.');
    if (!id.email_verified) throw new ApiError('unauthenticated', 'Your Google account’s email address isn’t verified.');
    const email = id.email.trim().toLowerCase();
    if (cfg.limits.disposable_domains.includes(email.split('@')[1] ?? '')) throw new ApiError('invalid_request', 'Please use a permanent email address.');
    return this.sql.begin(async (tx) => {
      let [user] = await tx<Array<{ id: string; status: string }>>`
        SELECT u.id, u.status FROM auth_accounts a JOIN users u ON u.id = a.user_id WHERE a.provider = 'google' AND a.provider_account_id = ${id.sub}`;
      let created = false;
      if (!user) {
        [user] = await tx<Array<{ id: string; status: string }>>`SELECT id, status FROM users WHERE email = ${email}`;
        if (!user) {
          if (cfg.kill_switches.signups) throw new ApiError('maintenance', 'New sign-ups are temporarily paused.');
          [user] = await tx<Array<{ id: string; status: string }>>`
            INSERT INTO users (id, email, email_verified, display_name, consent_version) VALUES (${uuidv7()}, ${email}, true, ${id.name ?? null}, ${CONSENT_VERSION}) RETURNING id, status`;
          created = true;
        }
        await tx`INSERT INTO auth_accounts (id, user_id, provider, provider_account_id) VALUES (${uuidv7()}, ${user!.id}, 'google', ${id.sub}) ON CONFLICT (provider, provider_account_id) DO NOTHING`;
      }
      assertCanSignIn(user!.status);
      await tx`UPDATE users SET email_verified = true, updated_at = now() WHERE id = ${user!.id}`;
      await audit(tx, { actor_type: 'user', actor_id: user!.id, action: created ? 'signup' : 'login', target_type: 'user', target_id: user!.id, after: { method: 'google' }, request_id: meta.requestId ?? null });
      return this.issueTokens(tx, user!.id, 'ext', { device: meta.device });
    });
  }

  private async issueTokens(tx: Tx, userId: string, aud: Audience, o: { device?: string | undefined; role?: string; familyId?: string; stepUp?: boolean; lastStepUp?: Date | null }) {
    const refresh = randomToken(32);
    const sid = uuidv7();
    const ttl = aud === 'admin' ? ADMIN_REFRESH_TTL_MS : REFRESH_TTL_MS;
    const expires = new Date(Date.now() + ttl);
    await tx`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, family_id, device_label, kind, expires_at, last_step_up_at)
             VALUES (${sid}, ${userId}, ${await saltedHash(refresh, this.secret)}, ${o.familyId ?? uuidv7()}, ${o.device ?? null}, ${aud === 'admin' ? 'admin' : 'user'}, ${expires}, ${o.stepUp ? new Date() : (o.lastStepUp ?? null)})`;
    const ep = await effectivePlan(tx, userId);
    const [u] = await tx<Array<{ email: string }>>`SELECT email FROM users WHERE id = ${userId}`;
    const access = await this.signAccess({ sub: userId, plan: ep.plan, aud, sid, ...(o.role ? { role: o.role } : {}) });
    return {
      access_token: access.token,
      access_expires_at: access.expiresAt,
      refresh_token: refresh,
      refresh_expires_at: expires.toISOString(),
      user: { id: userId, email: u!.email, plan: ep.plan },
      ...(o.role ? { role: o.role } : {}),
    };
  }

  async signAccess(c: AccessClaims): Promise<{ token: string; expiresAt: string }> {
    const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_S;
    const token = await new SignJWT({ plan: c.plan, sid: c.sid, ...(c.role ? { role: c.role } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub)
      .setAudience(c.aud)
      .setIssuer('jmo')
      .setJti(uuidv7())
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async verifyAccess(token: string, aud: Audience): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { audience: aud, issuer: 'jmo', algorithms: ['HS256'] });
      return { sub: String(payload.sub), plan: payload.plan as PlanId, aud, sid: String(payload.sid), ...(payload.role ? { role: String(payload.role) } : {}) };
    } catch (e) {
      const expired = (e as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw new ApiError(expired ? 'token_expired' : 'unauthenticated', expired ? 'Session expired.' : 'Invalid session.');
    }
  }

  /** Rotation with family reuse detection: presenting an already-rotated token revokes the whole family. */
  async refresh(refreshToken: string, aud: Audience, requestId?: string) {
    const hash = await saltedHash(refreshToken, this.secret);
    // Reuse of a rotated token revokes the whole family. That revocation must be COMMITTED, so it is reported after
    // the transaction instead of thrown inside it (a throw would roll it back and leave a thief's session alive).
    const reused = await this.sql.begin(async (tx) => {
      const [s] = await tx<Array<{ user_id: string; family_id: string; revoked_at: Date | null; replaced_by: string | null }>>`
        SELECT user_id, family_id, revoked_at, replaced_by FROM auth_sessions WHERE refresh_token_hash = ${hash} FOR UPDATE`;
      if (!s || !(s.revoked_at || s.replaced_by)) return false;
      await tx`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = ${s.family_id}`;
      await audit(tx, { actor_type: 'system', action: 'refresh_reuse_detected', target_type: 'user', target_id: s.user_id, request_id: requestId ?? null });
      return true;
    });
    if (reused) throw new ApiError('session_revoked', 'Session revoked. Please sign in again.');
    return this.sql.begin(async (tx) => {
      const [s] = await tx<Array<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; replaced_by: string | null; expires_at: Date; kind: string; device_label: string | null; last_step_up_at: Date | null }>>`
        SELECT id, user_id, family_id, revoked_at, replaced_by, expires_at, kind, device_label, last_step_up_at FROM auth_sessions WHERE refresh_token_hash = ${hash} FOR UPDATE`;
      if (!s || s.kind !== (aud === 'admin' ? 'admin' : 'user')) throw new ApiError('unauthenticated', 'Invalid session.');
      // Rotated by a concurrent request between the two transactions: treat like reuse on the next attempt.
      if (s.revoked_at || s.replaced_by) throw new ApiError('session_revoked', 'Session revoked. Please sign in again.');
      if (s.expires_at < new Date()) throw new ApiError('session_revoked', 'Session expired. Please sign in again.');
      const [u] = await tx<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${s.user_id}`;
      if (u?.status !== 'active') throw new ApiError('account_suspended', 'This account is not active.');
      let role: string | undefined;
      if (aud === 'admin') {
        const [m] = await tx<Array<{ role: string }>>`SELECT role FROM admin_members WHERE user_id = ${s.user_id} AND revoked_at IS NULL`;
        if (!m) throw new ApiError('forbidden', 'Admin access revoked.');
        role = m.role;
      }
      const tokens = await this.issueTokens(tx, s.user_id, aud, { device: s.device_label ?? undefined, familyId: s.family_id, lastStepUp: s.last_step_up_at, ...(role ? { role } : {}) });
      const [next] = await tx<Array<{ id: string }>>`SELECT id FROM auth_sessions WHERE family_id = ${s.family_id} ORDER BY created_at DESC LIMIT 1`;
      await tx`UPDATE auth_sessions SET replaced_by = ${next!.id}, revoked_at = now(), last_used_at = now() WHERE id = ${s.id}`;
      return tokens;
    });
  }

  async logout(sessionId: string, all: boolean, userId: string) {
    if (all) await this.sql`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
    else await this.sql`UPDATE auth_sessions SET revoked_at = now() WHERE family_id = (SELECT family_id FROM auth_sessions WHERE id = ${sessionId}) AND revoked_at IS NULL`;
  }

  async sessionActive(sessionId: string): Promise<{ active: boolean; lastStepUp: Date | null }> {
    const [s] = await this.sql<Array<{ revoked_at: Date | null; replaced_by: string | null; expires_at: Date; last_step_up_at: Date | null }>>`
      SELECT revoked_at, replaced_by, expires_at, last_step_up_at FROM auth_sessions WHERE id = ${sessionId}`;
    // A rotated (replaced) session's access token stays valid until it expires; revocation is immediate.
    const revoked = !!s?.revoked_at && !s.replaced_by;
    return { active: !!s && !revoked && s.expires_at > new Date(), lastStepUp: s?.last_step_up_at ?? null };
  }

  /** Admin step-up: a fresh OTP marks the session family as recently re-authenticated (admin-panel.md §4.1). */
  async stepUp(sessionId: string, email: string, code: string) {
    const lower = email.toLowerCase();
    // Same attempt limit as sign-in: a stolen admin session must not be able to brute-force its way past step-up.
    const verificationId = await this.checkCode(lower, code);
    await this.sql.begin(async (tx) => {
      const consumed = await tx`UPDATE auth_verifications SET consumed_at = now() WHERE id = ${verificationId} AND consumed_at IS NULL RETURNING id`;
      if (!consumed.length) throw new ApiError('unauthenticated', 'Code expired.');
      await tx`UPDATE auth_sessions SET last_step_up_at = now() WHERE family_id = (SELECT family_id FROM auth_sessions WHERE id = ${sessionId})`;
    });
  }
}

const MAX_CODE_ATTEMPTS = 5;

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i]! ^ b[i]!;
  return r === 0;
}

/** Suspended accounts, and accounts whose deletion has started, cannot sign in (or be revived by signing in). */
function assertCanSignIn(status: string) {
  if (status === 'suspended') throw new ApiError('account_suspended', 'This account is suspended. Contact support.');
  if (status !== 'active') throw new ApiError('account_suspended', 'This account is being deleted.');
}
