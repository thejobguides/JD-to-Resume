import { describe, expect, it } from 'vitest';
import { buildPublicConfig, defaultConfig, diffPaths, generateSigningKeys, signConfig, snapshotId, validateNamespace, verifyConfig, type ValidationContext } from './index';

const policy: ValidationContext = {
  env: 'production',
  providers: [
    { id: 'openai', production_allowed: true, personal_data_allowed: true, trains_on_inputs: 'no', active: true },
    { id: 'nvidia_trial', production_allowed: false, personal_data_allowed: false, trains_on_inputs: 'yes', active: true },
    { id: 'mock', production_allowed: true, personal_data_allowed: true, trains_on_inputs: 'no', active: true },
  ],
  models: [
    { id: 'openai:gpt-6-luna', provider_id: 'openai', status: 'approved', approved_tasks: ['jd_extract', 'resume_extract', 'match_map', 'validate_entail'] },
    { id: 'openai:gpt-6-sol', provider_id: 'openai', status: 'approved', approved_tasks: ['optimize', 'repair'] },
    { id: 'nvidia_trial:meta/llama', provider_id: 'nvidia_trial', status: 'eval_only', approved_tasks: [] },
  ],
  credentials: [
    { id: 'cred_openai_prod_1', provider_id: 'openai', scope: 'production', status: 'active' },
    { id: 'cred_nvidia_trial', provider_id: 'nvidia_trial', scope: 'non_production', status: 'active' },
  ],
};

describe('config validation', () => {
  it('accepts the default config', () => {
    const d = defaultConfig({ useMockAi: false });
    for (const ns of ['plans', 'budgets', 'scoring', 'extraction', 'features', 'kill_switches', 'limits', 'coupons_policy', 'insights', 'retention', 'announcements', 'prompts'] as const) {
      expect(validateNamespace(ns, d[ns], policy)).toMatchObject({ ok: true });
    }
  });

  it('enforces bounds and the AI budget ≤ 50% of price rule', () => {
    const d = defaultConfig({ useMockAi: false });
    const tooMuch = structuredClone(d.plans);
    tooMuch.limits.pro_monthly!.monthly_ai_budget_usd = 12;
    const r = validateNamespace('plans', tooMuch, policy);
    expect(r.ok).toBe(false);
    const r2 = validateNamespace('plans', { ...d.plans, limits: { ...d.plans.limits, free: { ...d.plans.limits.free!, monthly_optimizations: 10_000 } } }, policy);
    expect(r2.ok).toBe(false);
  });

  it('scoring weights must sum to 100', () => {
    const d = defaultConfig({ useMockAi: false });
    expect(validateNamespace('scoring', { ...d.scoring, weights: { ...d.scoring.weights, required: 35 } }, policy).ok).toBe(false);
  });

  it('blocks NVIDIA trial keys and personal-data-unsafe providers in production, allows them in eval', () => {
    const d = defaultConfig({ useMockAi: false });
    const routing = structuredClone(d.ai_routing);
    for (const t of Object.keys(routing.routes) as Array<keyof typeof routing.routes>) routing.routes[t] = { primary: { model: 'nvidia_trial:meta/llama', credential: 'cred_nvidia_trial' } };
    const r = validateNamespace('ai_routing', routing, policy);
    expect(r.ok).toBe(false);
    const msgs = !r.ok ? r.errors.map((e) => e.message).join('\n') : '';
    expect(msgs).toMatch(/not allowed in production/);
    expect(msgs).toMatch(/sends resume content/);
    expect(msgs).toMatch(/cannot serve production traffic/);
    expect(validateNamespace('ai_routing', routing, { ...policy, env: 'eval' }).ok).toBe(true);
  });

  it('accepts a compliant production routing with vault keys', () => {
    const d = defaultConfig({ useMockAi: false });
    const routing = structuredClone(d.ai_routing);
    for (const t of Object.keys(routing.routes) as Array<keyof typeof routing.routes>) {
      const strong = t === 'optimize' || t === 'repair';
      routing.routes[t] = { primary: { model: strong ? 'openai:gpt-6-sol' : 'openai:gpt-6-luna', credential: 'cred_openai_prod_1' } };
    }
    expect(validateNamespace('ai_routing', routing, policy)).toMatchObject({ ok: true });
  });
});

describe('public config', () => {
  it('signs and verifies; tampering fails verification', async () => {
    const d = defaultConfig({ useMockAi: true });
    const pub = buildPublicConfig(d, { version: 1, snapshot: await snapshotId(['a', 'b']) });
    const { privateJwk, publicJwk } = await generateSigningKeys();
    const signed = await signConfig(pub, privateJwk, 'k1');
    expect(await verifyConfig(signed, publicJwk)).toBe(true);
    const tampered = { ...signed, config: { ...signed.config, extractors: [{ ...signed.config.extractors[0]!, selectors: { description: 'body' } }] } };
    expect(await verifyConfig(tampered, publicJwk)).toBe(false);
  });

  it('snapshot ids are order-independent and diffs list changed paths', async () => {
    expect(await snapshotId(['x', 'y'])).toBe(await snapshotId(['y', 'x']));
    expect(diffPaths({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toEqual([{ path: 'b.c', before: 2, after: 3 }]);
  });
});
