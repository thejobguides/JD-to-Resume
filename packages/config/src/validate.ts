import { type Namespace, type NamespaceData, PLAN_MONTHS, PLAN_PRICES_MINOR, SCHEMAS } from './namespaces';

// Validation = schema + bounds (namespaces.ts) + cross-field rules + the AI data-policy rule (admin-panel.md §6.5.3).

export interface PolicyProvider {
  id: string;
  production_allowed: boolean;
  personal_data_allowed: boolean;
  trains_on_inputs: 'yes' | 'no' | 'unknown';
  active: boolean;
}
export interface PolicyModel {
  id: string;
  provider_id: string;
  status: 'candidate' | 'eval_only' | 'approved' | 'retired';
  approved_tasks: string[];
}
export interface PolicyCredential {
  id: string;
  provider_id: string;
  scope: 'production' | 'non_production';
  status: 'active' | 'standby' | 'revoked';
}

export interface ValidationContext {
  env: 'production' | 'staging' | 'eval';
  providers?: PolicyProvider[];
  models?: PolicyModel[];
  credentials?: PolicyCredential[];
}

export interface ValidationError {
  path: string;
  message: string;
}

const RESUME_TASKS = new Set(['resume_extract', 'match_map', 'optimize', 'validate_entail', 'repair']);

export function validateNamespace<N extends Namespace>(ns: N, data: unknown, ctx: ValidationContext): { ok: true; data: NamespaceData<N> } | { ok: false; errors: ValidationError[] } {
  const parsed = SCHEMAS[ns].safeParse(data);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const errors: ValidationError[] = [];
  const d = parsed.data as NamespaceData<N>;

  if (ns === 'plans') {
    const p = d as NamespaceData<'plans'>;
    for (const [plan, l] of Object.entries(p.limits)) {
      const price = PLAN_PRICES_MINOR[plan];
      const months = PLAN_MONTHS[plan];
      if (price && months && l.monthly_ai_budget_usd > (price / 100 / months) * 0.5) {
        errors.push({ path: `limits.${plan}.monthly_ai_budget_usd`, message: `AI budget must be ≤ 50% of the plan's monthly price ($${((price / 100 / months) * 0.5).toFixed(2)})` });
      }
      if (l.daily_optimizations > l.monthly_optimizations && l.monthly_optimizations > 0) errors.push({ path: `limits.${plan}.daily_optimizations`, message: 'Daily cap cannot exceed the monthly cap' });
    }
  }

  if (ns === 'scoring') {
    const s = d as NamespaceData<'scoring'>;
    const sum = Object.values(s.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.001) errors.push({ path: 'weights', message: `Weights must sum to 100 (got ${sum})` });
  }

  if (ns === 'ai_routing') {
    const r = d as NamespaceData<'ai_routing'>;
    const targets = Object.entries(r.routes).flatMap(([task, route]) =>
      [route.primary, ...(route.fallbacks ?? [])].map((t, i) => ({ task, t, path: `routes.${task}.${i === 0 ? 'primary' : `fallbacks.${i - 1}`}` })),
    );
    for (const [task, c] of Object.entries(r.canary ?? {})) targets.push({ task, t: { model: c.model, credential: c.credential }, path: `canary.${task}` });
    for (const { task, t, path } of targets) errors.push(...checkTarget(task, t, path, ctx));
  }

  return errors.length ? { ok: false, errors } : { ok: true, data: d };
}

/** The data-policy rule: IN CODE, not configurable (admin-panel.md §6.5.3). */
export function checkTarget(task: string, t: { model: string; credential: string }, path: string, ctx: ValidationContext): ValidationError[] {
  const errors: ValidationError[] = [];
  const model = ctx.models?.find((m) => m.id === t.model);
  if (ctx.models && !model) return [{ path, message: `Unknown model ${t.model}` }];
  const providerId = model?.provider_id ?? t.model.split(':')[0]!;
  const provider = ctx.providers?.find((p) => p.id === providerId);
  if (ctx.providers && !provider) return [{ path, message: `Unknown provider ${providerId}` }];
  if (provider && !provider.active) errors.push({ path, message: `Provider ${provider.id} is disabled` });

  if (ctx.env === 'production') {
    if (provider && !provider.production_allowed) errors.push({ path, message: `Provider "${provider.id}" is not allowed in production by its terms (e.g. trial-only keys). Use it in the eval routing instead.` });
    if (RESUME_TASKS.has(task) && provider && (!provider.personal_data_allowed || provider.trains_on_inputs !== 'no')) {
      errors.push({ path, message: `Step "${task}" sends resume content; provider "${provider.id}" must allow personal data and must not train on inputs.` });
    }
    if (model && (model.status !== 'approved' || !model.approved_tasks.includes(task))) {
      errors.push({ path, message: `Model ${model.id} has no passing eval for "${task}" (status ${model.status}).` });
    }
    if (t.credential.startsWith('cred_')) {
      const cred = ctx.credentials?.find((c) => c.id === t.credential);
      if (!cred) errors.push({ path, message: `Unknown key ${t.credential}` });
      else {
        if (cred.scope !== 'production') errors.push({ path, message: `Key ${cred.id} has scope "${cred.scope}" and cannot serve production traffic.` });
        if (cred.status === 'revoked') errors.push({ path, message: `Key ${cred.id} is revoked` });
        if (cred.provider_id !== providerId) errors.push({ path, message: `Key ${cred.id} belongs to ${cred.provider_id}, not ${providerId}` });
      }
    }
  }
  return errors;
}

/** Namespaces whose activation requires a passing eval run (admin-panel.md §6.3). */
export const EVAL_GATED: ReadonlySet<Namespace> = new Set(['ai_routing', 'prompts', 'scoring']);
