import type { Db } from '@jmo/db';
import { PLAN_RANK, type PlanId } from '@jmo/shared';

// Effective plan = the higher of (active subscription plan, active complimentary grant) (admin-panel.md §7.8).

export interface EffectivePlan {
  plan: PlanId;
  source: 'free' | 'subscription' | 'grant';
  subscription: { status: string; current_period_end: string | null; cancel_at_period_end: boolean; plan_id: string } | null;
  grant: { plan: PlanId; ends_at: string } | null;
}

export async function effectivePlan(db: Db, userId: string, now = new Date()): Promise<EffectivePlan> {
  const [sub] = await db<Array<{ plan_id: PlanId; status: string; current_period_end: Date | null; cancel_at_period_end: boolean }>>`
    SELECT plan_id, status, current_period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ${userId}`;
  const [grant] = await db<Array<{ plan_id: PlanId; ends_at: Date }>>`
    SELECT plan_id, ends_at FROM entitlement_grants
    WHERE user_id = ${userId} AND revoked_at IS NULL AND starts_at <= ${now} AND ends_at > ${now}
    ORDER BY ends_at DESC LIMIT 1`;
  const subActive = sub && ['active', 'trialing', 'past_due'].includes(sub.status) && (!sub.current_period_end || sub.current_period_end > now || sub.status === 'past_due');
  const subPlan: PlanId = subActive ? sub.plan_id : 'free';
  const grantPlan: PlanId | null = grant?.plan_id ?? null;
  const useGrant = grantPlan && PLAN_RANK[grantPlan] > PLAN_RANK[subPlan];
  return {
    plan: useGrant ? grantPlan! : subPlan,
    source: useGrant ? 'grant' : subActive ? 'subscription' : 'free',
    subscription: sub ? { status: sub.status, current_period_end: sub.current_period_end?.toISOString() ?? null, cancel_at_period_end: sub.cancel_at_period_end, plan_id: sub.plan_id } : null,
    grant: grant ? { plan: grant.plan_id, ends_at: grant.ends_at.toISOString() } : null,
  };
}

export async function hasPriorPaidTransaction(db: Db, userId: string): Promise<boolean> {
  const [r] = await db<Array<{ n: number }>>`
    SELECT (SELECT count(*) FROM coupon_redemptions WHERE user_id = ${userId} AND status IN ('completed','refunded'))
         + (SELECT count(*) FROM subscription_events WHERE user_id = ${userId} AND event_type = 'checkout.session.completed') AS n`;
  return Number(r?.n ?? 0) > 0;
}
