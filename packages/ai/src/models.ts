import type { ModelInfo, RoutingConfig } from './types';

// Price book v1 (cost-analysis.md §2.1, checked 2026-09-29). Effective-dated copies live in the ai_models table;
// the admin panel edits them. Prices are USD per 1M tokens.
export const DEFAULT_MODELS: ModelInfo[] = [
  { id: 'openai:gpt-6-luna', provider_id: 'openai', kind: 'openai', provider_model_id: 'gpt-6-luna', structured: 'json_schema_strict', reasoning_control: true, input_per_mtok: 0.1, cached_input_per_mtok: 0.01, output_per_mtok: 0.5, token_factor: 1 },
  { id: 'openai:gpt-6-sol', provider_id: 'openai', kind: 'openai', provider_model_id: 'gpt-6-sol', structured: 'json_schema_strict', reasoning_control: true, input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 10, token_factor: 1 },
  { id: 'anthropic:claude-sonnet-5-5', provider_id: 'anthropic', kind: 'anthropic', provider_model_id: 'claude-sonnet-5-5', structured: 'json_schema_strict', reasoning_control: false, input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 10, token_factor: 1.3 },
  { id: 'google:gemini-3.1-flash-lite', provider_id: 'google', kind: 'google', provider_model_id: 'gemini-3.1-flash-lite', structured: 'json_schema_strict', reasoning_control: false, input_per_mtok: 0.25, cached_input_per_mtok: 0.025, output_per_mtok: 1.5, token_factor: 1 },
  { id: 'mock:deterministic', provider_id: 'mock', kind: 'mock', provider_model_id: 'deterministic', structured: 'json_schema_strict', reasoning_control: false, input_per_mtok: 0, cached_input_per_mtok: 0, output_per_mtok: 0, token_factor: 1 },
];

/** ai_routing v1 (admin-panel.md §6.5.3). */
export const DEFAULT_ROUTING: RoutingConfig = {
  routes: {
    jd_extract: { primary: { model: 'openai:gpt-6-luna', credential: 'env:OPENAI_API_KEY' }, fallbacks: [{ model: 'google:gemini-3.1-flash-lite', credential: 'env:GOOGLE_API_KEY' }], max_output_tokens: 3000, reasoning: 'none', timeout_ms: 30_000 },
    resume_extract: { primary: { model: 'openai:gpt-6-luna', credential: 'env:OPENAI_API_KEY' }, max_output_tokens: 6000, reasoning: 'none', timeout_ms: 45_000 },
    match_map: { primary: { model: 'openai:gpt-6-luna', credential: 'env:OPENAI_API_KEY' }, max_output_tokens: 1500, reasoning: 'none', timeout_ms: 30_000 },
    optimize: { primary: { model: 'openai:gpt-6-sol', credential: 'env:OPENAI_API_KEY' }, fallbacks: [{ model: 'anthropic:claude-sonnet-5-5', credential: 'env:ANTHROPIC_API_KEY' }], max_output_tokens: 4000, reasoning: 'low', timeout_ms: 90_000 },
    validate_entail: { primary: { model: 'openai:gpt-6-luna', credential: 'env:OPENAI_API_KEY' }, max_output_tokens: 1500, reasoning: 'none', timeout_ms: 30_000 },
    repair: { primary: { model: 'openai:gpt-6-sol', credential: 'env:OPENAI_API_KEY' }, fallbacks: [{ model: 'anthropic:claude-sonnet-5-5', credential: 'env:ANTHROPIC_API_KEY' }], max_output_tokens: 1500, reasoning: 'low', timeout_ms: 60_000 },
  },
};

/** Local development routing: the deterministic mock for every step. */
export const MOCK_ROUTING: RoutingConfig = {
  routes: Object.fromEntries(
    (['jd_extract', 'resume_extract', 'match_map', 'optimize', 'validate_entail', 'repair'] as const).map((t) => [t, { primary: { model: 'mock:deterministic', credential: 'none' }, max_output_tokens: 4000 }]),
  ) as RoutingConfig['routes'],
};

export function costOf(model: ModelInfo, u: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }): number {
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens);
  const out = u.outputTokens; // reasoning tokens are billed as output and included in outputTokens by OpenAI
  return (uncached * model.input_per_mtok + u.cachedInputTokens * model.cached_input_per_mtok + out * model.output_per_mtok) / 1_000_000;
}
