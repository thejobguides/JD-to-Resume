// Provider abstraction (ai-model-comparison.md §11.3) — interfaces shared by hosted and BYOK transports.

export type Task = 'jd_extract' | 'resume_extract' | 'match_map' | 'optimize' | 'validate_entail' | 'repair';

export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai_compatible' | 'mock';

export type ErrorClass = 'retryable_transport' | 'rate_limited' | 'spend_cap' | 'auth' | 'invalid_request' | 'refusal' | 'truncated' | 'schema' | 'server' | 'timeout';

export class ProviderError extends Error {
  constructor(
    readonly cls: ErrorClass,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimated: boolean;
}

export interface GenerateArgs {
  model: string; // provider model id
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxOutputTokens: number;
  reasoning?: 'none' | 'low' | 'medium' | 'high';
  temperature?: number;
  signal?: AbortSignal;
  /** only for the mock provider: the structured task input */
  task?: Task;
  input?: unknown;
}

export interface GenerateResult {
  text: string;
  usage: Usage;
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  providerRequestId?: string;
}

export interface AIProvider {
  kind: ProviderKind;
  generate(args: GenerateArgs): Promise<GenerateResult>;
}

export interface ModelInfo {
  id: string; // registry id "openai:gpt-6-luna"
  provider_id: string; // registry provider id "openai" | "nvidia_trial" …
  kind: ProviderKind;
  provider_model_id: string;
  structured: 'json_schema_strict' | 'json_mode' | 'none';
  reasoning_control: boolean;
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;
  token_factor: number;
}

export interface RouteTarget {
  model: string; // registry id
  credential: string; // credential id; "env:OPENAI_API_KEY" for env-based keys; "none" for mock
}

export interface Route {
  primary: RouteTarget;
  fallbacks?: RouteTarget[];
  max_output_tokens?: number;
  reasoning?: 'none' | 'low' | 'medium' | 'high';
  timeout_ms?: number;
}

export interface RoutingConfig {
  routes: Record<Task, Route>;
  canary?: Partial<Record<Task, RouteTarget & { pct: number }>>;
  credential_budgets_usd?: Record<string, number>;
}

export interface AiRequestLog {
  task: Task;
  prompt_version: string;
  model_id: string;
  provider_id: string;
  credential_id: string | null;
  attempt: number;
  fallback_used: boolean;
  usage: Usage;
  cost_usd: number;
  latency_ms: number;
  outcome: 'ok' | 'schema_fail' | 'refusal' | 'truncated' | 'rate_limited' | 'spend_cap' | 'timeout' | 'server_error' | 'auth_error' | 'invalid_request';
  provider_request_id?: string;
  cache_hit: boolean;
}

export interface RunContext {
  userId?: string | null;
  optimizationId?: string | null;
  jobAnalysisId?: string | null;
  requestId?: string;
  plan?: string;
  configSnapshotId?: string | null;
  /** stable per-user hash for canary bucketing */
  bucketKey?: string;
  signal?: AbortSignal;
}
