// The on-device half of the pipeline: evidence extraction, scoring (before / after / ceiling), target selection,
// re-validation of user edits, and — for bring-your-own-key users — the full optimize pipeline with the same
// gates the server runs. Nothing in here talks to our servers.

import { AIRouter, anthropicProvider, DEFAULT_MODELS, DEFAULT_ROUTING, googleProvider, type ModelInfo, openAIProvider, ResumeAIService, type RoutingConfig } from '@jmo/ai';
import { buildGateContext, checkBullet, extractClaims, type GateReport, toClaimLite } from '@jmo/evidence';
import { type Acceptance, applyOptimization, toOptResume } from '@jmo/resume';
import { type ScoreResult, scoreAfter, scoreResume, selectTargets } from '@jmo/scoring';
import type { CanonicalResume, ChangedBullet, Claim, JobAnalysis, Mapping, OptimizationResult, OptimizeRequest } from '@jmo/shared';
import { uuidv7 } from '@jmo/shared';

export interface Scored {
  resume: CanonicalResume; // with claim ids filled in
  claims: Claim[];
  result: ScoreResult;
}

export function score(analysis: JobAnalysis, resume: CanonicalResume, mappings?: Mapping[]): Scored {
  const { resume: withClaims, claims } = extractClaims(resume);
  return { resume: withClaims, claims, result: scoreResume({ analysis, resume: withClaims, claims, ...(mappings?.length ? { mappings } : {}) }) };
}

/** Requirements the deterministic matcher couldn't decide; worth one cheap match_map call. */
export function ambiguous(analysis: JobAnalysis, s: Scored) {
  const ids = new Set(s.result.requirements.filter((r) => r.ambiguous).map((r) => r.req_id));
  return analysis.requirements.filter((r) => ids.has(r.req_id)).slice(0, 40).map((r) => ({ req_id: r.req_id, text: r.text, type: r.type }));
}

export function buildOptimizeRequest(s: Scored, analysis: JobAnalysis, jobAnalysisId?: string): OptimizeRequest {
  return {
    ...(jobAnalysisId ? { job_analysis_id: jobAnalysisId } : { job_analysis: analysis }),
    resume: toOptResume(s.resume),
    claims: toClaimLite(s.claims),
    targets: { req_ids: selectTargets(s.result), edit_budget: { bullets: 8, summary: true, skills_order: true } },
    options: { tone: 'concise', locale: 'en-US' },
  };
}

/** A user's own edit is held to the same deterministic gates as the model's text. */
export function checkUserEdit(req: OptimizeRequest, change: ChangedBullet, text: string): GateReport {
  const ctx = buildGateContext({
    roles: req.resume.roles.map((r) => ({ role_id: r.role_id, employer: r.employer, title: r.title, start: r.start, end: r.end, bullets: r.bullets })),
    claims: req.claims.map((c) => ({ claim_id: c.claim_id, type: c.type, value: c.value, text: c.text, ...(c.role_id ? { role_id: c.role_id } : {}) })),
    skills: req.resume.skills,
  });
  return checkBullet({ bullet_id: change.bullet_id, role_id: change.role_id, source_bullet_ids: change.source_bullet_ids, text, claim_ids: change.claim_ids }, ctx);
}

export interface Applied {
  resume: CanonicalResume;
  after: ScoreResult;
}

/** Applies the accepted changes and re-scores with the same engine, capped at the evidence ceiling. */
export function applyAndRescore(base: Scored, analysis: JobAnalysis, result: OptimizationResult, accept: Acceptance, mappings?: Mapping[]): Applied {
  const next = applyOptimization(base.resume, result, accept, `v_${uuidv7().slice(0, 8)}`);
  const { resume, claims } = extractClaims(next);
  return { resume, after: scoreAfter(base.result, { analysis, resume, claims, ...(mappings?.length ? { mappings } : {}) }) };
}

// ── Bring your own key ──

export type ByokProvider = 'openai' | 'anthropic' | 'google';

export interface ByokSettings {
  provider: ByokProvider;
  key: string;
  cheap_model: string;
  strong_model: string;
  enabled: boolean;
}

export const BYOK_HOSTS: Record<ByokProvider, string> = {
  openai: 'https://api.openai.com/*',
  anthropic: 'https://api.anthropic.com/*',
  google: 'https://generativelanguage.googleapis.com/*',
};

export function byokModels(provider: ByokProvider): ModelInfo[] {
  return DEFAULT_MODELS.filter((m) => m.kind === provider);
}

const CHEAP_STEPS = ['jd_extract', 'resume_extract', 'match_map', 'validate_entail'] as const;
const STRONG_STEPS = ['optimize', 'repair'] as const;

export function byokService(s: ByokSettings): ResumeAIService {
  const f: typeof fetch = (...a) => fetch(...a);
  const provider = s.provider === 'openai' ? openAIProvider(s.key, f) : s.provider === 'anthropic' ? anthropicProvider(s.key, f, { browser: true }) : googleProvider(s.key, f);
  const routes = {} as RoutingConfig['routes'];
  for (const t of CHEAP_STEPS) routes[t] = { ...DEFAULT_ROUTING.routes[t], primary: { model: s.cheap_model, credential: 'byok' }, fallbacks: [] };
  for (const t of STRONG_STEPS) routes[t] = { ...DEFAULT_ROUTING.routes[t], primary: { model: s.strong_model, credential: 'byok' }, fallbacks: [] };
  const router = new AIRouter({ routing: { routes }, models: byokModels(s.provider), providerFor: async () => provider });
  return new ResumeAIService(router);
}

const SYNTHETIC_JD =
  'Data Analyst — Northwind Traders (synthetic test posting). Requirements: 3+ years of SQL; experience with Python and pandas; build dashboards in Tableau or Power BI; communicate findings to stakeholders. Nice to have: dbt, Snowflake. Responsibilities: own weekly reporting, partner with finance on forecasting.';

/** Verifies a key with a tiny synthetic request (no personal data). */
export async function testByok(s: ByokSettings): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await byokService(s).analyzeJob(SYNTHETIC_JD, { title: 'Data Analyst' });
    return r.fallback ? { ok: false, detail: 'The provider did not return a usable answer.' } : { ok: true, detail: `Working — ${r.model}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
