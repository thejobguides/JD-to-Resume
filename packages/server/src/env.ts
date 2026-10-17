// Server configuration from the environment. Secrets never come from runtime config (admin-panel.md §2).

export interface ServerEnv {
  ENV: 'development' | 'test' | 'production';
  DATABASE_URL: string;
  JWT_SECRET: string;
  MAILBOX_KEY: string; // 32+ chars; AES-GCM key material for the transient result mailbox
  /** 32+ chars; AES-GCM key material for opted-in users' saved job posts, resumes and results (content store). */
  CONTENT_ENCRYPTION_KEY: string;
  PUBLIC_API_URL: string;
  WEB_ORIGIN: string;
  ADMIN_ORIGIN: string;
  EXTENSION_ORIGINS: string[];
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  /** OpenRouter free models: eval routing only (AI_ROUTING=eval), synthetic data only. */
  OPENROUTER_API_KEY?: string;
  VAULT_PUBLIC_KEY_JWK?: JsonWebKey;
  VAULT_PRIVATE_KEY_JWK?: JsonWebKey;
  VAULT_KEY_VERSION: number;
  CONFIG_SIGNING_PRIVATE_KEY_JWK?: JsonWebKey;
  CONFIG_SIGNING_KEY_ID: string;
  /** sk_test_… (test mode) or sk_live_…; unset = the fake gateway (local development and tests). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  ADMIN_DEV_LOGIN: boolean;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /**
   * Production only: let the admin API run without Cloudflare Access, for hosting where Access can't sit in front of
   * it. Admins are then protected by emailed sign-in codes, step-up re-authentication and the audit log alone.
   * Off unless exactly "true".
   */
  ADMIN_ALLOW_WITHOUT_ACCESS: boolean;
  INTERNAL_TOKEN: string; // admin-api → api service-binding substitute on Node
  /** OAuth client IDs whose Google ID tokens we accept (one Web client serves the extension and the website). */
  GOOGLE_OAUTH_CLIENT_IDS: string[];
  /** Development/test only: a stand-in identity provider for end-to-end tests. Ignored in production. */
  GOOGLE_ISSUER_OVERRIDE?: string;
  GOOGLE_JWKS_URL_OVERRIDE?: string;
  /**
   * Which AI routing the app uses. "eval" (development only, AI_ROUTING=eval) runs the whole app on the eval
   * routing, where trial providers such as NVIDIA are allowed. Synthetic data only.
   */
  AI_ROUTING_ENV: 'production' | 'eval';
}

const DEV_JWT_SECRET = 'dev-only-change-me-0123456789abcdef0123456789abcdef';

function json(v?: string): JsonWebKey | undefined {
  if (!v) return undefined;
  try {
    return JSON.parse(v) as JsonWebKey;
  } catch {
    throw new Error('Invalid JWK JSON in environment');
  }
}

export function loadEnv(raw: Record<string, string | undefined>): ServerEnv {
  // `KEY=` in an .env file means "not set", not "set to the empty string".
  const src = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== '')) as Record<string, string | undefined>;
  const env = (src.NODE_ENV === 'production' || src.ENV === 'production' ? 'production' : src.ENV === 'test' ? 'test' : 'development') as ServerEnv['ENV'];
  const secret = src.JWT_SECRET ?? (env === 'production' ? undefined : DEV_JWT_SECRET);
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be set (≥ 32 chars)');
  if (env === 'production' && (secret === DEV_JWT_SECRET || /change-me/i.test(secret))) throw new Error('JWT_SECRET is the development placeholder; generate a real secret for production');
  if (env === 'production' && src.AI_ROUTING === 'eval') throw new Error('AI_ROUTING=eval is for local testing only and cannot be used in production');
  if (env === 'production') {
    // Development fallbacks that must never run in production: fake payments, sign-in codes printed to logs.
    for (const k of ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'INTERNAL_TOKEN']) {
      if (!src[k]) throw new Error(`${k} must be set in production`);
    }
    // Encryption keys must be their own secrets in production, not derived from JWT_SECRET (key separation).
    for (const k of ['MAILBOX_KEY', 'CONTENT_ENCRYPTION_KEY']) {
      if (!src[k] || src[k]!.length < 32) throw new Error(`${k} must be set in production (≥ 32 chars)`);
    }
  }
  return {
    ENV: env,
    DATABASE_URL: src.DATABASE_URL ?? 'postgres://jmo:jmo@localhost:54329/jmo',
    JWT_SECRET: secret,
    MAILBOX_KEY: src.MAILBOX_KEY ?? `${secret}-mailbox`,
    CONTENT_ENCRYPTION_KEY: src.CONTENT_ENCRYPTION_KEY ?? `${secret}-content`,
    PUBLIC_API_URL: src.PUBLIC_API_URL ?? 'http://localhost:8787',
    WEB_ORIGIN: src.WEB_ORIGIN ?? 'http://localhost:5175',
    ADMIN_ORIGIN: src.ADMIN_ORIGIN ?? 'http://localhost:5174',
    EXTENSION_ORIGINS: (src.EXTENSION_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ...(src.OPENAI_API_KEY ? { OPENAI_API_KEY: src.OPENAI_API_KEY } : {}),
    ...(src.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: src.ANTHROPIC_API_KEY } : {}),
    ...(src.GOOGLE_API_KEY ? { GOOGLE_API_KEY: src.GOOGLE_API_KEY } : {}),
    ...(src.NVIDIA_API_KEY ? { NVIDIA_API_KEY: src.NVIDIA_API_KEY } : {}),
    ...(src.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: src.OPENROUTER_API_KEY } : {}),
    ...(json(src.VAULT_PUBLIC_KEY_JWK) ? { VAULT_PUBLIC_KEY_JWK: json(src.VAULT_PUBLIC_KEY_JWK)! } : {}),
    ...(json(src.VAULT_PRIVATE_KEY_JWK) ? { VAULT_PRIVATE_KEY_JWK: json(src.VAULT_PRIVATE_KEY_JWK)! } : {}),
    VAULT_KEY_VERSION: Number(src.VAULT_KEY_VERSION ?? 1),
    ...(json(src.CONFIG_SIGNING_PRIVATE_KEY_JWK) ? { CONFIG_SIGNING_PRIVATE_KEY_JWK: json(src.CONFIG_SIGNING_PRIVATE_KEY_JWK)! } : {}),
    CONFIG_SIGNING_KEY_ID: src.CONFIG_SIGNING_KEY_ID ?? 'k1',
    ...(src.STRIPE_SECRET_KEY ? { STRIPE_SECRET_KEY: src.STRIPE_SECRET_KEY } : {}),
    STRIPE_WEBHOOK_SECRET: src.STRIPE_WEBHOOK_SECRET ?? 'dev-stripe-webhook-secret',
    ...(src.RESEND_API_KEY ? { RESEND_API_KEY: src.RESEND_API_KEY } : {}),
    EMAIL_FROM: src.EMAIL_FROM ?? 'Job Match Optimizer <no-reply@example.com>',
    ADMIN_DEV_LOGIN: env !== 'production' && src.ADMIN_DEV_LOGIN !== 'false',
    ...(src.CF_ACCESS_TEAM_DOMAIN ? { CF_ACCESS_TEAM_DOMAIN: src.CF_ACCESS_TEAM_DOMAIN } : {}),
    ...(src.CF_ACCESS_AUD ? { CF_ACCESS_AUD: src.CF_ACCESS_AUD } : {}),
    ADMIN_ALLOW_WITHOUT_ACCESS: src.ADMIN_ALLOW_WITHOUT_ACCESS === 'true',
    AI_ROUTING_ENV: src.AI_ROUTING === 'eval' ? 'eval' : 'production',
    GOOGLE_OAUTH_CLIENT_IDS: (src.GOOGLE_OAUTH_CLIENT_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ...(env !== 'production' && src.GOOGLE_ISSUER_OVERRIDE ? { GOOGLE_ISSUER_OVERRIDE: src.GOOGLE_ISSUER_OVERRIDE } : {}),
    ...(env !== 'production' && src.GOOGLE_JWKS_URL_OVERRIDE ? { GOOGLE_JWKS_URL_OVERRIDE: src.GOOGLE_JWKS_URL_OVERRIDE } : {}),
    INTERNAL_TOKEN: src.INTERNAL_TOKEN ?? (env === 'production' ? (() => { throw new Error('INTERNAL_TOKEN must be set in production'); })() : `${secret}-internal`),
  };
}
