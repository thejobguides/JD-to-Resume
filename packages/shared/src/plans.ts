import { z } from 'zod';

export const PlanId = z.enum(['free', 'pro_monthly', 'pro_quarterly', 'byok_annual', 'credit_pack']);
export type PlanId = z.infer<typeof PlanId>;

export const PlanLimits = z.object({
  monthly_optimizations: z.number().int().min(0),
  daily_optimizations: z.number().int().min(0),
  monthly_analyses: z.number().int().min(0),
  monthly_ai_budget_usd: z.number().min(0),
  hosted_ai: z.boolean(),
  history_sync: z.boolean(),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

/** Defaults = version 1 of the `plans` config namespace (cost-analysis.md §11.2, §13). */
export const DEFAULT_PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    monthly_optimizations: 3,
    daily_optimizations: 3,
    monthly_analyses: 15,
    monthly_ai_budget_usd: 0.5,
    hosted_ai: true,
    history_sync: false,
  },
  pro_monthly: {
    monthly_optimizations: 150,
    daily_optimizations: 25,
    monthly_analyses: 500,
    monthly_ai_budget_usd: 8,
    hosted_ai: true,
    history_sync: true,
  },
  pro_quarterly: {
    monthly_optimizations: 150,
    daily_optimizations: 25,
    monthly_analyses: 500,
    // $45/quarter = $15/month → AI budget capped at 50% of the monthly price (config bound).
    monthly_ai_budget_usd: 7.5,
    hosted_ai: true,
    history_sync: true,
  },
  byok_annual: {
    monthly_optimizations: 0,
    daily_optimizations: 0,
    monthly_analyses: 0,
    monthly_ai_budget_usd: 0,
    hosted_ai: false,
    history_sync: false,
  },
  // Not a tier: caps that apply when a user spends pack credits (credits add to their plan's allowance).
  credit_pack: {
    monthly_optimizations: 0,
    daily_optimizations: 25,
    monthly_analyses: 0,
    monthly_ai_budget_usd: 2,
    hosted_ai: true,
    history_sync: false,
  },
};

/** Plan rank used to pick the "higher" of subscription vs complimentary grant. */
export const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  credit_pack: 1,
  byok_annual: 1,
  pro_monthly: 2,
  pro_quarterly: 2,
};
