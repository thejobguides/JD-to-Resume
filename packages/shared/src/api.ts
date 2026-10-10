import { z } from 'zod';
import { ClaimLite } from './claims';
import { JobAnalysis, Requirement } from './job';
import { CanonicalResume, SpanLine } from './resume';
import { PlanId } from './plans';

// Request/response DTOs for the public API (api-design.md §6). One source of truth for API, extension and tests.

// ── Auth (api-design.md §3) ──
export const OtpRequest = z.object({ email: z.string().email().max(254), turnstile_token: z.string().max(4096).optional() });
export const OtpVerify = z.object({ email: z.string().email().max(254), code: z.string().regex(/^\d{6}$/) });
export const RefreshRequest = z.object({ refresh_token: z.string().min(20).max(512) });
export const TokenPair = z.object({
  access_token: z.string(),
  access_expires_at: z.string(),
  refresh_token: z.string(),
  refresh_expires_at: z.string(),
  user: z.object({ id: z.string(), email: z.string(), plan: PlanId }),
});
export type TokenPair = z.infer<typeof TokenPair>;

// ── Me / usage ──
export const MeResponse = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().nullable(),
  plan: PlanId,
  subscription: z
    .object({ status: z.string(), current_period_end: z.string().nullable(), cancel_at_period_end: z.boolean() })
    .nullable(),
  grant: z.object({ plan: PlanId, ends_at: z.string() }).nullable(),
  settings: z.object({ history_opt_in: z.boolean(), telemetry_opt_in: z.boolean(), content_opt_in: z.boolean() }),
  consent_version: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const UsageResponse = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  optimizations: z.object({
    used: z.number(),
    limit: z.number(),
    daily_used: z.number(),
    daily_limit: z.number(),
    credits_remaining: z.number(),
  }),
  analyses: z.object({ used: z.number(), limit: z.number() }),
  ai_budget: z.object({ used_usd: z.number(), limit_usd: z.number() }),
});
export type UsageResponse = z.infer<typeof UsageResponse>;

// ── Jobs ──
export const AnalyzeJobRequest = z.object({
  jd_text: z.string().min(40).max(20_000),
  jd_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source: z
    .object({
      host: z.string().max(255).optional(),
      adapter: z.string().max(64).optional(),
      layers_used: z.array(z.string()).max(8).optional(),
    })
    .optional(),
  structured_hint: z
    .object({
      title: z.string().max(300).optional(),
      company: z.string().max(300).optional(),
      location: z.array(z.string().max(200)).max(20).optional(),
      employment_type: z.string().max(64).optional(),
    })
    .optional(),
  locale: z.string().max(16).default('en'),
});
export type AnalyzeJobRequest = z.infer<typeof AnalyzeJobRequest>;

export const AnalyzeJobResponse = z.object({
  job_analysis_id: z.string(),
  cache: z.enum(['hit', 'miss']),
  analysis: JobAnalysis,
});
export type AnalyzeJobResponse = z.infer<typeof AnalyzeJobResponse>;

// ── Resumes ──
export const StructureResumeRequest = z.object({
  version_id: z.string().max(64),
  lines: z.array(SpanLine).min(1).max(1500),
  locale: z.string().max(16).default('en'),
});
export type StructureResumeRequest = z.infer<typeof StructureResumeRequest>;

export const StructureResumeResponse = z.object({
  resume: CanonicalResume,
  dropped: z.array(z.object({ path: z.string(), value: z.string(), reason: z.string() })),
  prompt_version: z.string(),
});
export type StructureResumeResponse = z.infer<typeof StructureResumeResponse>;

// ── Matching ──
export const MatchState = z.enum(['strong', 'partial', 'weak', 'none', 'unknown']);
export type MatchState = z.infer<typeof MatchState>;

export const MatchMapRequest = z.object({
  job_analysis_id: z.string().optional(),
  requirements: z.array(Requirement.pick({ req_id: true, text: true, type: true })).min(1).max(40),
  evidence: z.array(ClaimLite).max(300),
});
export type MatchMapRequest = z.infer<typeof MatchMapRequest>;

export const Mapping = z.object({
  req_id: z.string(),
  state: MatchState,
  claim_ids: z.array(z.string()).default([]),
  rationale: z.string().max(400).default(''),
});
export type Mapping = z.infer<typeof Mapping>;

export const MatchMapResponse = z.object({ mappings: z.array(Mapping), prompt_version: z.string() });
export type MatchMapResponse = z.infer<typeof MatchMapResponse>;

// ── Optimization (api-design.md §6.7–6.10) ──
export const OptBullet = z.object({ bullet_id: z.string(), text: z.string().max(1200), claim_ids: z.array(z.string()).default([]) });
export const OptRole = z.object({
  role_id: z.string(),
  employer: z.string().max(300),
  title: z.string().max(300),
  start: z.string().max(16).optional(),
  end: z.string().max(16).optional(),
  bullets: z.array(OptBullet).max(40),
});
export type OptRole = z.infer<typeof OptRole>;

export const OptResume = z.object({
  version_id: z.string(),
  roles: z.array(OptRole).max(30),
  summary: z.object({ summary_id: z.string(), text: z.string().max(2000), claim_ids: z.array(z.string()).default([]) }).optional(),
  skills: z
    .array(z.object({ skill_id: z.string(), name: z.string().max(80), evidence_level: z.enum(['demonstrated', 'listed_only']) }))
    .max(150),
});
export type OptResume = z.infer<typeof OptResume>;

export const EditBudget = z.object({
  bullets: z.number().int().min(0).max(12).default(8),
  summary: z.boolean().default(true),
  skills_order: z.boolean().default(true),
});

export const OptimizeRequest = z.object({
  job_analysis_id: z.string().optional(),
  job_analysis: JobAnalysis.optional(),
  resume: OptResume,
  claims: z.array(ClaimLite).max(600),
  targets: z.object({ req_ids: z.array(z.string()).max(40), edit_budget: EditBudget.default({ bullets: 8, summary: true, skills_order: true }) }),
  options: z
    .object({
      tone: z.enum(['concise', 'standard']).default('concise'),
      locale: z.string().max(16).default('en-US'),
    })
    .default({ tone: 'concise', locale: 'en-US' }),
});
export type OptimizeRequest = z.infer<typeof OptimizeRequest>;

export const OptimizationStatus = z.enum(['queued', 'running', 'validating', 'repairing', 'succeeded', 'partial', 'failed', 'canceled']);
export type OptimizationStatus = z.infer<typeof OptimizationStatus>;

export const Verdict = z.enum(['entailed', 'embellished', 'contradicted', 'unsupported', 'unverified']);
export type Verdict = z.infer<typeof Verdict>;

export const ChangedBullet = z.object({
  bullet_id: z.string(),
  role_id: z.string(),
  source_bullet_ids: z.array(z.string()),
  original_text: z.string(),
  text: z.string(),
  claim_ids: z.array(z.string()),
  emphasized_req_ids: z.array(z.string()).default([]),
  why: z.string().default(''),
  validation: Verdict,
  repaired: z.boolean().default(false),
});
export type ChangedBullet = z.infer<typeof ChangedBullet>;

export const OptimizationResult = z.object({
  summary: z
    .object({ original_text: z.string().nullable(), text: z.string(), claim_ids: z.array(z.string()), validation: Verdict, why: z.string().default('') })
    .nullable(),
  bullets: z.array(ChangedBullet),
  skills_order: z.array(z.string()),
  not_addressable: z.array(z.object({ req_id: z.string(), reason: z.string() })),
  reverted: z.array(z.object({ bullet_id: z.string(), reason: z.string(), violations: z.array(z.string()).default([]) })),
});
export type OptimizationResult = z.infer<typeof OptimizationResult>;

export const OptimizationMeta = z.object({
  models: z.array(z.string()),
  prompt_versions: z.array(z.string()),
  gates: z.record(z.string(), z.number()),
  duration_ms: z.number(),
  cost_usd: z.number().default(0),
});

export const OptimizationResponse = z.object({
  optimization_id: z.string(),
  status: OptimizationStatus,
  result: OptimizationResult.nullable(),
  meta: OptimizationMeta.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
});
export type OptimizationResponse = z.infer<typeof OptimizationResponse>;

export const OptimizationEvent = z.object({
  status: OptimizationStatus,
  step: z.string().optional(),
  progress: z.number().min(0).max(1),
});
export type OptimizationEvent = z.infer<typeof OptimizationEvent>;

export const OptimizationScores = z.object({
  before_score: z.number().int().min(0).max(100),
  after_score: z.number().int().min(0).max(100),
  ceiling_score: z.number().int().min(0).max(100),
});

// ── Validations ──
export const ValidationRequest = z.object({
  pairs: z
    .array(z.object({ bullet_id: z.string(), text: z.string().max(1200), evidence_texts: z.array(z.string().max(1200)).max(10) }))
    .min(1)
    .max(30),
});
export const ValidationResponse = z.object({
  results: z.array(z.object({ bullet_id: z.string(), verdict: Verdict, issues: z.array(z.string()) })),
});
export type ValidationResponse = z.infer<typeof ValidationResponse>;

// ── Billing (api-design.md §6.16) ──
export const BillingPlan = z.object({
  plan_id: PlanId,
  name: z.string(),
  price: z.object({ currency: z.string(), amount: z.string(), interval: z.string().nullable() }).nullable(),
  features: z.array(z.string()),
  badge: z.string().nullable(),
});
export const BillingPlansResponse = z.object({ plans: z.array(BillingPlan) });

export const CouponPreviewRequest = z.object({ code: z.string().min(3).max(40), plan_id: PlanId });
export const CouponPreviewResponse = z.object({
  valid: z.literal(true),
  plan_id: PlanId,
  percent_off: z.number(),
  duration: z.enum(['first_period', 'repeating', 'forever']),
  duration_periods: z.number().nullable(),
  price: z.object({ currency: z.string(), list: z.string(), discounted: z.string() }),
  summary: z.string(),
});
export type CouponPreviewResponse = z.infer<typeof CouponPreviewResponse>;

export const CheckoutRequest = z.object({ plan_id: PlanId, coupon_code: z.string().min(3).max(40).optional() });
export const CheckoutResponse = z.object({ checkout_url: z.string(), transaction_id: z.string(), coupon_redemption_id: z.string().nullable() });

// ── Feedback ──
export const FeedbackRequest = z.object({
  optimization_id: z.string().optional(),
  target: z.enum(['score', 'bullet', 'summary', 'export', 'extraction', 'general']),
  target_ref: z.string().max(120).optional(),
  rating: z.number().int().min(-1).max(5).optional(),
  reason_code: z.string().max(40).optional(),
  comment: z.string().max(2000).optional(),
  content_shared: z.boolean().default(false),
});
