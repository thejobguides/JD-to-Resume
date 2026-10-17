import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const PROD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'prod-0123456789abcdef0123456789abcdef',
  STRIPE_WEBHOOK_SECRET: 'whsec_live',
  STRIPE_SECRET_KEY: 'sk_live_x',
  MAILBOX_KEY: 'mailbox-0123456789abcdef0123456789abcdef',
  CONTENT_ENCRYPTION_KEY: 'content-0123456789abcdef0123456789abcdef',
  RESEND_API_KEY: 're_live',
  INTERNAL_TOKEN: 'internal',
};

describe('loadEnv', () => {
  it('refuses development fallbacks in production (fake payments, codes in logs)', () => {
    expect(() => loadEnv(PROD)).not.toThrow();
    for (const k of ['STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'INTERNAL_TOKEN', 'JWT_SECRET', 'MAILBOX_KEY', 'CONTENT_ENCRYPTION_KEY'] as const) {
      expect(() => loadEnv({ ...PROD, [k]: undefined }), k).toThrow(new RegExp(k));
    }
  });

  it('runs on the eval routing (trial models) only outside production', () => {
    expect(loadEnv({ AI_ROUTING: 'eval' }).AI_ROUTING_ENV).toBe('eval');
    expect(loadEnv({}).AI_ROUTING_ENV).toBe('production');
    expect(() => loadEnv({ ...PROD, AI_ROUTING: 'eval' })).toThrow(/local testing only/);
  });

  it('refuses the development JWT secret and short encryption keys in production', () => {
    expect(() => loadEnv({ ...PROD, JWT_SECRET: 'dev-only-change-me-0123456789abcdef0123456789abcdef' })).toThrow(/development placeholder/);
    expect(() => loadEnv({ ...PROD, CONTENT_ENCRYPTION_KEY: 'too-short' })).toThrow(/CONTENT_ENCRYPTION_KEY/);
    expect(loadEnv({ ...PROD }).CONTENT_ENCRYPTION_KEY).toBe(PROD.CONTENT_ENCRYPTION_KEY);
  });

  it('lets the admin API run without Cloudflare Access only when explicitly set to "true"', () => {
    expect(loadEnv(PROD).ADMIN_ALLOW_WITHOUT_ACCESS).toBe(false);
    expect(loadEnv({ ...PROD, ADMIN_ALLOW_WITHOUT_ACCESS: '1' }).ADMIN_ALLOW_WITHOUT_ACCESS).toBe(false);
    expect(loadEnv({ ...PROD, ADMIN_ALLOW_WITHOUT_ACCESS: 'true' }).ADMIN_ALLOW_WITHOUT_ACCESS).toBe(true);
  });

  it('treats `KEY=` from an .env file as unset', () => {
    expect(() => loadEnv({ ...PROD, STRIPE_SECRET_KEY: '' })).toThrow(/STRIPE_SECRET_KEY/);
    const dev = loadEnv({ DATABASE_URL: '', STRIPE_WEBHOOK_SECRET: '  ', VAULT_PUBLIC_KEY_JWK: '' });
    expect(dev.DATABASE_URL).toBe('postgres://jmo:jmo@localhost:54329/jmo');
    expect(dev.STRIPE_WEBHOOK_SECRET).toBe('dev-stripe-webhook-secret');
    expect(dev.VAULT_PUBLIC_KEY_JWK).toBeUndefined();
  });
});
