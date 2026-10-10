import { DEFAULT_MODELS, PROMPTS, promptHash } from '@jmo/ai';
import { defaultConfig, NAMESPACES, PLAN_PRICES_MINOR } from '@jmo/config';
import { uuidv7 } from '@jmo/shared';
import type { Sql } from './client';

// Seed = version 1 of everything the admin panel manages later (database-design.md §8.3).

const PLANS = [
  { id: 'free', name: 'Free', kind: 'free', interval: null, freq: null, order: 0 },
  { id: 'pro_monthly', name: 'Pro monthly', kind: 'subscription', interval: 'month', freq: 1, order: 1 },
  { id: 'pro_quarterly', name: 'Pro quarterly', kind: 'subscription', interval: 'month', freq: 3, order: 2 },
  { id: 'credit_pack', name: 'Credit pack (25)', kind: 'one_time', interval: null, freq: null, order: 3 },
  { id: 'byok_annual', name: 'Bring your own key', kind: 'subscription', interval: 'year', freq: 1, order: 4 },
] as const;

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', kind: 'openai', base_url: null, prod: true, personal: true, trains: 'no', terms: 'https://openai.com/policies/business-terms/', note: 'API data not used for training by default; abuse logs up to 30 days; store:false' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', base_url: null, prod: true, personal: true, trains: 'no', terms: 'https://www.anthropic.com/legal/commercial-terms', note: 'No content retention by default except flagged content' },
  { id: 'google', name: 'Google Gemini (paid tier)', kind: 'google', base_url: null, prod: true, personal: true, trains: 'no', terms: 'https://ai.google.dev/gemini-api/terms', note: 'Paid tier only: the free tier forbids personal data' },
  { id: 'mock', name: 'Deterministic (local)', kind: 'mock', base_url: null, prod: true, personal: true, trains: 'no', terms: null, note: 'Runs inside our API; no data leaves the server' },
  {
    id: 'nvidia_trial',
    name: 'NVIDIA API Catalog (trial)',
    kind: 'openai_compatible',
    base_url: 'https://integrate.api.nvidia.com/v1',
    prod: false,
    personal: false,
    trains: 'yes',
    terms: 'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf',
    note: 'Trial terms v.2025-09-19: §1.2 no production use; §2.6(a) no personal data; §3.3 content may improve NVIDIA models. Evals with synthetic data only.',
  },
  {
    id: 'openrouter_free',
    name: 'OpenRouter (free models)',
    kind: 'openai_compatible',
    base_url: 'https://openrouter.ai/api/v1',
    prod: false,
    personal: false,
    trains: 'unknown',
    terms: 'https://openrouter.ai/terms',
    note: 'Free ":free" endpoints: some upstream providers log or train on prompts (see OpenRouter privacy settings); daily request cap. Evals with synthetic data only.',
  },
] as const;

export interface SeedOptions {
  ownerEmail: string;
  useMockAi: boolean;
}

export async function seed(sql: Sql, opts: SeedOptions, log: (s: string) => void = console.log): Promise<void> {
  await sql.begin(async (tx) => {
    for (const p of PLANS) {
      await tx`INSERT INTO plans (id, name, kind, billing_interval, billing_frequency, display_order)
               VALUES (${p.id}, ${p.name}, ${p.kind}, ${p.interval}, ${p.freq}, ${p.order}) ON CONFLICT (id) DO NOTHING`;
    }
    for (const [plan, minor] of Object.entries(PLAN_PRICES_MINOR)) {
      await tx`INSERT INTO plan_prices (id, plan_id, provider_price_id, currency, unit_amount_minor, status)
               VALUES (${uuidv7()}, ${plan}, ${`pri_dev_${plan}`}, 'USD', ${minor}, 'active') ON CONFLICT DO NOTHING`;
    }
    for (const p of PROVIDERS) {
      await tx`INSERT INTO ai_providers (id, name, kind, base_url, production_allowed, personal_data_allowed, trains_on_inputs, retention_note, terms_url, terms_reviewed_on, dpa_signed_at, zdr)
               VALUES (${p.id}, ${p.name}, ${p.kind}, ${p.base_url}, ${p.prod}, ${p.personal}, ${p.trains}, ${p.note}, ${p.terms}, '2026-09-29', ${p.prod && p.id !== 'mock' ? '2026-09-29' : null}, false)
               ON CONFLICT (id) DO NOTHING`;
    }
    const allTasks = Object.keys(PROMPTS);
    for (const m of DEFAULT_MODELS) {
      const tier = m.id.includes('sol') || m.id.includes('sonnet') ? 'strong' : m.kind === 'mock' ? 'any' : 'cheap';
      const approved = m.kind === 'mock' ? allTasks : tier === 'strong' ? ['optimize', 'repair', 'jd_extract', 'resume_extract', 'match_map', 'validate_entail'] : ['jd_extract', 'resume_extract', 'match_map', 'validate_entail'];
      await tx`INSERT INTO ai_models (id, provider_id, provider_model_id, tier, capabilities, status, approved_tasks, input_per_mtok, cached_input_per_mtok, output_per_mtok, token_factor, effective_from, source_url, checked_on)
               VALUES (${m.id}, ${m.provider_id}, ${m.provider_model_id}, ${tier}, ${tx.json({ structured: m.structured, reasoning_control: m.reasoning_control })}, 'approved', ${approved},
                       ${m.input_per_mtok}, ${m.cached_input_per_mtok}, ${m.output_per_mtok}, ${m.token_factor}, '2026-09-29',
                       ${m.kind === 'mock' ? 'internal' : 'research/cost-analysis.md §2.1'}, '2026-09-29')
               ON CONFLICT (id) DO NOTHING`;
    }
    for (const def of Object.values(PROMPTS)) {
      await tx`INSERT INTO prompt_versions (id, content_sha256, status, rollout_pct) VALUES (${def.version}, ${await promptHash(def)}, 'live', 100) ON CONFLICT (id) DO NOTHING`;
    }
    const cfg = defaultConfig({ useMockAi: opts.useMockAi });
    for (const env of ['production', 'eval'] as const) {
      for (const ns of NAMESPACES) {
        const exists = await tx`SELECT 1 FROM config_versions WHERE namespace = ${ns} AND env = ${env} LIMIT 1`;
        if (exists.length) continue;
        const data = env === 'eval' && ns === 'ai_routing' ? defaultConfig({ useMockAi: true }).ai_routing : cfg[ns];
        await tx`INSERT INTO config_versions (id, namespace, env, version, data, status, change_note, activated_at)
                 VALUES (${uuidv7()}, ${ns}, ${env}, 1, ${tx.json(data as never)}, 'active', 'Seed: version 1', now())`;
      }
    }
    const email = opts.ownerEmail.toLowerCase();
    const [owner] = await tx<{ id: string }[]>`
      INSERT INTO users (id, email, email_verified, display_name) VALUES (${uuidv7()}, ${email}, true, 'Owner')
      ON CONFLICT (email) DO UPDATE SET email_verified = true RETURNING id`;
    await tx`INSERT INTO admin_members (user_id, role) VALUES (${owner!.id}, 'owner') ON CONFLICT (user_id) DO NOTHING`;
    await tx`SELECT ensure_ai_requests_partition(now()::date)`;
    await tx`SELECT ensure_ai_requests_partition((now() + interval '1 month')::date)`;
  });
  log(`seeded (owner ${opts.ownerEmail}, AI routing: ${opts.useMockAi ? 'mock' : 'OpenAI/Anthropic/Google'})`);
}
