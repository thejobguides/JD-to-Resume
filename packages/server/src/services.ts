import type { ActiveConfig } from '@jmo/config';
import { createSql, type Sql } from '@jmo/db';
import { AiRuntime } from './ai-runtime';
import { AuthService } from './auth';
import { getActive } from './admin-config';
import { BillingService } from './billing/service';
import { fakeStripe, stripeClient } from './billing/stripe';
import { type GoogleVerifier, googleVerifier } from './google';
import { ConfigStore } from './config-store';
import type { ServerEnv } from './env';
import { consoleMailer, type Mailer, resendMailer } from './mailer';
import { OptimizationRunner } from './optimizations';

export interface Services {
  sql: Sql;
  env: ServerEnv;
  config: ConfigStore;
  auth: AuthService;
  ai: AiRuntime;
  runner: OptimizationRunner;
  billing: BillingService;
  mailer: Mailer;
}

/** Wires every service for one process (Node) or one isolate (Workers). */
export function createServices(env: ServerEnv, opts: { sql?: Sql; mailer?: Mailer; fetchFn?: typeof fetch; google?: GoogleVerifier } = {}): Services {
  const sql = opts.sql ?? createSql(env.DATABASE_URL);
  const config = new ConfigStore(sql, 'production', env.ENV === 'test' ? 0 : 30_000);
  const mailer = opts.mailer ?? (env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY, env.EMAIL_FROM) : consoleMailer());
  const google =
    opts.google ??
    (env.GOOGLE_OAUTH_CLIENT_IDS.length
      ? googleVerifier({ clientIds: env.GOOGLE_OAUTH_CLIENT_IDS, ...(env.GOOGLE_JWKS_URL_OVERRIDE ? { jwksUrl: env.GOOGLE_JWKS_URL_OVERRIDE } : {}), ...(env.GOOGLE_ISSUER_OVERRIDE ? { issuers: [env.GOOGLE_ISSUER_OVERRIDE] } : {}) })
      : undefined);
  const auth = new AuthService(sql, env.JWT_SECRET, mailer, { exposeDevCode: env.ENV !== 'production', ...(google ? { google } : {}) });
  // AI_ROUTING=eval (development only): AI calls use the eval routing, where trial providers are allowed.
  let evalRouting: { at: number; data: ActiveConfig['ai_routing'] } | null = null;
  const ai = new AiRuntime(sql, env, async () => {
    const c = await config.get();
    if (env.AI_ROUTING_ENV !== 'eval') return { config: c.config, snapshot: c.snapshot };
    if (!evalRouting || Date.now() - evalRouting.at > 5_000) {
      const row = await getActive(sql, 'ai_routing', 'eval');
      evalRouting = { at: Date.now(), data: (row?.data as ActiveConfig['ai_routing'] | undefined) ?? c.config.ai_routing };
    }
    return { config: { ...c.config, ai_routing: evalRouting.data }, snapshot: `${c.snapshot}+eval` };
  }, opts.fetchFn);
  const runner = new OptimizationRunner(sql, ai, env.MAILBOX_KEY, env.CONTENT_ENCRYPTION_KEY);
  const payments = env.STRIPE_SECRET_KEY ? stripeClient(env.STRIPE_SECRET_KEY, { webOrigin: env.WEB_ORIGIN, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) }) : fakeStripe(env.WEB_ORIGIN);
  const billing = new BillingService(sql, payments, env.STRIPE_WEBHOOK_SECRET);
  return { sql, env, config, auth, ai, runner, billing, mailer };
}
