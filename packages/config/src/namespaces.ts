import { DEFAULT_ROUTING, MOCK_ROUTING } from '@jmo/ai';
import { DEFAULT_ADAPTERS } from '@jmo/job-extraction';
import { CATEGORY_WEIGHTS } from '@jmo/scoring';
import { DEFAULT_PLAN_LIMITS, ExtractorAdapter, PlanLimits, SCORING_VERSION } from '@jmo/shared';
import { z } from 'zod';

// Runtime configuration namespaces (admin-panel.md §6.1). BOUNDS LIVE HERE, IN CODE: they are reviewed in PRs
// and are not themselves configurable. Invariants (gates on/off, privacy posture, score wording) are absent on purpose.

export const NAMESPACES = ['plans', 'ai_routing', 'budgets', 'prompts', 'scoring', 'extraction', 'features', 'kill_switches', 'limits', 'announcements', 'retention', 'coupons_policy', 'insights'] as const;
export type Namespace = (typeof NAMESPACES)[number];

const Task = z.enum(['jd_extract', 'resume_extract', 'match_map', 'optimize', 'validate_entail', 'repair']);
const Target = z.object({ model: z.string().min(3).max(120), credential: z.string().min(1).max(120) });
const Route = z.object({
  primary: Target,
  fallbacks: z.array(Target).max(4).optional(),
  max_output_tokens: z.number().int().min(200).max(8000).optional(),
  reasoning: z.enum(['none', 'low', 'medium', 'high']).optional(),
  timeout_ms: z.number().int().min(5_000).max(180_000).optional(),
});

const BoundedPlanLimits = PlanLimits.extend({
  monthly_optimizations: z.number().int().min(0).max(750),
  daily_optimizations: z.number().int().min(0).max(125),
  monthly_analyses: z.number().int().min(0).max(2500),
  monthly_ai_budget_usd: z.number().min(0).max(20),
});

export const SCHEMAS = {
  plans: z.object({
    limits: z.record(z.string(), BoundedPlanLimits),
    display: z.record(z.string(), z.object({ name: z.string().max(40), badge: z.string().max(24).nullable(), visible: z.boolean(), order: z.number().int(), features: z.array(z.string().max(80)).max(10) })),
  }),
  ai_routing: z.object({
    routes: z.record(Task, Route),
    canary: z.record(Task, Target.extend({ pct: z.number().int().min(1).max(50) })).optional(),
    credential_budgets_usd: z.record(z.string(), z.number().min(0).max(100_000)).optional(),
  }),
  budgets: z.object({
    downgrade_threshold: z.number().min(0.5).max(1),
    global_daily_ceiling_usd: z.number().min(1).max(5_000),
    free_tier_pause: z.boolean(),
  }),
  prompts: z.object({ live: z.record(Task, z.string().regex(/^[a-z_]+@v\d+$/)) }),
  scoring: z.object({
    version: z.string().regex(/^scoring@\d+\.\d+$/),
    weights: z.record(z.string(), z.number().min(0).max(40)),
    entailment_threshold: z.number().min(0.7).max(0.95),
  }),
  extraction: z.object({ adapters: z.array(ExtractorAdapter).max(50), jd_max_chars: z.number().int().min(5_000).max(30_000) }),
  features: z.object({ flags: z.record(z.string(), z.object({ enabled: z.boolean(), plans: z.array(z.string()).optional(), pct: z.number().int().min(0).max(100).optional(), users: z.array(z.string()).max(200).optional() })) }),
  kill_switches: z.object({
    hosted_ai: z.boolean(),
    signups: z.boolean(),
    checkout: z.boolean(),
    coupons: z.boolean(),
    sync: z.boolean(),
    maintenance: z.boolean(),
    providers: z.record(z.string(), z.boolean()),
    portals: z.record(z.string(), z.boolean()),
  }),
  limits: z.object({
    otp_per_hour: z.number().int().min(1).max(10),
    burst_per_minute: z.record(z.string(), z.number().int().min(1).max(600)),
    resume_max_pages: z.number().int().min(1).max(10),
    disposable_domains: z.array(z.string().max(100)).max(5000),
  }),
  announcements: z.object({
    items: z.array(z.object({ id: z.string().max(40), text: z.string().max(280), plans: z.array(z.string()).default(['all']), until: z.string().optional() })).max(5),
  }),
  retention: z.object({
    ai_requests_days: z.number().int().min(30).max(180),
    feedback_days: z.number().int().min(90).max(730),
    job_analyses_days: z.number().int().min(7).max(90),
    audit_user_days: z.number().int().min(30).max(365),
    audit_admin_days: z.number().int().min(365).max(1095),
  }),
  coupons_policy: z.object({
    max_shared_percent: z.number().min(1).max(100),
    max_validity_days: z.number().int().min(1).max(365),
    default_per_user: z.number().int().min(1).max(5),
    spike_multiplier: z.number().min(2).max(20),
    reservation_minutes: z.number().int().min(15).max(180),
  }),
  insights: z.object({
    cost_target_usd: z.number().min(0.005).max(1),
    reference_models: z.object({ cheap: z.string(), strong: z.string() }),
    thresholds: z.object({
      expensive_step_share: z.number().min(0.3).max(0.95),
      repair_rate: z.number().min(0.05).max(0.8),
      schema_fail_rate: z.number().min(0.001).max(0.2),
      fallback_rate: z.number().min(0.01).max(0.5),
      cached_share_min: z.number().min(0).max(0.9),
      heavy_tail_share: z.number().min(0.05).max(0.8),
      free_tier_share: z.number().min(0.1).max(0.95),
      token_drift: z.number().min(0.05).max(1),
      key_budget_share: z.number().min(0.5).max(1),
    }),
  }),
} satisfies Record<Namespace, z.ZodType>;

export type NamespaceData<N extends Namespace> = z.infer<(typeof SCHEMAS)[N]>;

/** Version 1 of every namespace (seeded; later edits happen in the admin panel). */
export function defaultConfig(opts: { useMockAi: boolean }): { [N in Namespace]: NamespaceData<N> } {
  return {
    plans: {
      limits: DEFAULT_PLAN_LIMITS,
      display: {
        free: { name: 'Free', badge: null, visible: true, order: 0, features: ['Unlimited local match scores', '15 AI job analyses / month', '3 AI optimizations / month', 'DOCX + PDF export'] },
        pro_monthly: { name: 'Pro monthly', badge: null, visible: true, order: 1, features: ['150 optimizations / month', '500 job analyses', 'History sync'] },
        pro_quarterly: { name: 'Pro quarterly', badge: 'Best value', visible: true, order: 2, features: ['Everything in Pro', '≈ $15 / month billed quarterly'] },
        credit_pack: { name: 'Credit pack', badge: null, visible: true, order: 3, features: ['25 optimizations', 'No subscription', 'Credits never expire'] },
        byok_annual: { name: 'Bring your own key', badge: null, visible: true, order: 4, features: ['Use your own OpenAI, Anthropic or Gemini key', 'Resume and job text go only to your provider'] },
      },
    },
    ai_routing: (opts.useMockAi ? MOCK_ROUTING : DEFAULT_ROUTING) as NamespaceData<'ai_routing'>,
    budgets: { downgrade_threshold: 0.8, global_daily_ceiling_usd: 50, free_tier_pause: false },
    prompts: { live: { jd_extract: 'jd_extract@v1', resume_extract: 'resume_extract@v1', match_map: 'match_map@v1', optimize: 'optimize@v1', validate_entail: 'validate_entail@v1', repair: 'repair@v1' } },
    scoring: { version: SCORING_VERSION, weights: { ...CATEGORY_WEIGHTS }, entailment_threshold: 0.8 },
    extraction: { adapters: DEFAULT_ADAPTERS, jd_max_chars: 20_000 },
    features: { flags: { hosted_ai: { enabled: true }, byok: { enabled: true }, auto_detect_tier_a: { enabled: false }, coupons: { enabled: true } } },
    kill_switches: { hosted_ai: false, signups: false, checkout: false, coupons: false, sync: false, maintenance: false, providers: {}, portals: {} },
    limits: {
      otp_per_hour: 5,
      burst_per_minute: { ai: 20, optimizations: 3, auth: 20, coupons: 10, reads: 60 },
      resume_max_pages: 6,
      disposable_domains: ['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com'],
    },
    announcements: { items: [] },
    retention: { ai_requests_days: 90, feedback_days: 730, job_analyses_days: 30, audit_user_days: 90, audit_admin_days: 730 },
    coupons_policy: { max_shared_percent: 50, max_validity_days: 180, default_per_user: 1, spike_multiplier: 5, reservation_minutes: 60 },
    insights: {
      cost_target_usd: 0.06,
      reference_models: { cheap: 'openai:gpt-6-luna', strong: 'openai:gpt-6-sol' },
      thresholds: { expensive_step_share: 0.6, repair_rate: 0.2, schema_fail_rate: 0.01, fallback_rate: 0.1, cached_share_min: 0.2, heavy_tail_share: 0.2, free_tier_share: 0.5, token_drift: 0.2, key_budget_share: 0.8 },
    },
  };
}

export const PLAN_PRICES_MINOR: Record<string, number> = { pro_monthly: 1900, pro_quarterly: 4500, byok_annual: 3900, credit_pack: 1200 };
export const PLAN_MONTHS: Record<string, number> = { pro_monthly: 1, pro_quarterly: 3, byok_annual: 12, credit_pack: 1 };
