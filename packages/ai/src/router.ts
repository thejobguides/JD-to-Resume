import { costOf } from './models';
import type { PromptDef } from './prompts';
import { strictJsonSchema } from './prompts';
import { type AiRequestLog, type AIProvider, type ModelInfo, ProviderError, type RouteTarget, type RoutingConfig, type RunContext, type Usage } from './types';

// AIRouter (ai-model-comparison.md §11): route → provider → retries (transport/5xx only, max 2) → one schema
// retry → fallback chain. Every attempt is logged with tokens and cost; no prompt or response content is logged.

export interface RouterDeps {
  routing: RoutingConfig;
  models: ModelInfo[];
  /** Resolves a credential (env var, vault entry) and builds the provider; throws if unavailable. */
  providerFor(model: ModelInfo, credentialId: string): Promise<AIProvider>;
  onLog?(log: AiRequestLog, ctx: RunContext): void | Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface RunResult<O> {
  output: O;
  model: ModelInfo;
  credentialId: string;
  promptVersion: string;
  usage: Usage;
  costUsd: number;
  attempts: number;
  fallbackUsed: boolean;
}

export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly lastError?: ProviderError,
  ) {
    super(message);
  }
}

function bucket(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 100;
}

/** Pulls the JSON object out of a model reply (tolerates code fences and open models' <think>…</think> blocks). */
export function extractJson(text: string): unknown {
  const t = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in output');
  return JSON.parse(t.slice(start, end + 1));
}

const OUTCOME: Record<string, AiRequestLog['outcome']> = {
  rate_limited: 'rate_limited',
  spend_cap: 'spend_cap',
  timeout: 'timeout',
  auth: 'auth_error',
  invalid_request: 'invalid_request',
  refusal: 'refusal',
  truncated: 'truncated',
  schema: 'schema_fail',
  server: 'server_error',
  retryable_transport: 'server_error',
};

export class AIRouter {
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  constructor(private deps: RouterDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  setRouting(routing: RoutingConfig) {
    this.deps.routing = routing;
  }

  targetsFor(task: keyof RoutingConfig['routes'], ctx: RunContext): RouteTarget[] {
    const route = this.deps.routing.routes[task];
    const list = [route.primary, ...(route.fallbacks ?? [])];
    const canary = this.deps.routing.canary?.[task];
    if (canary && ctx.bucketKey && bucket(`${ctx.bucketKey}:${task}`) < canary.pct) return [{ model: canary.model, credential: canary.credential }, ...list];
    return list;
  }

  async run<I, O>(prompt: PromptDef<I, O>, input: I, ctx: RunContext = {}): Promise<RunResult<O>> {
    const route = this.deps.routing.routes[prompt.id];
    const targets = this.targetsFor(prompt.id, ctx);
    const schema = strictJsonSchema(prompt.output);
    const system = prompt.system;
    const baseUser = prompt.buildUser(input);
    let attempts = 0;
    let lastError: ProviderError | undefined;

    for (const [ti, target] of targets.entries()) {
      const model = this.deps.models.find((m) => m.id === target.model);
      if (!model) continue;
      let provider: AIProvider;
      try {
        provider = await this.deps.providerFor(model, target.credential);
      } catch (e) {
        lastError = e instanceof ProviderError ? e : new ProviderError('auth', (e as Error).message);
        continue;
      }
      let user = baseUser;
      let schemaRetried = false;
      for (let transportTry = 0; transportTry < 3; transportTry++) {
        attempts++;
        const started = this.now();
        const log = async (outcome: AiRequestLog['outcome'], usage: Usage, providerRequestId?: string) => {
          await this.deps.onLog?.(
            {
              task: prompt.id,
              prompt_version: prompt.version,
              model_id: model.id,
              provider_id: model.provider_id,
              credential_id: target.credential === 'none' ? null : target.credential,
              attempt: attempts,
              fallback_used: ti > 0,
              usage,
              cost_usd: costOf(model, usage),
              latency_ms: this.now() - started,
              outcome,
              ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
              cache_hit: false,
            },
            ctx,
          );
        };
        const zero: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, estimated: true };
        try {
          const gen = await provider.generate({
            model: model.provider_model_id,
            system,
            user,
            jsonSchema: schema,
            schemaName: prompt.schemaName,
            maxOutputTokens: route.max_output_tokens ?? 4000,
            ...(model.reasoning_control && route.reasoning ? { reasoning: route.reasoning } : {}),
            task: prompt.id,
            input,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          if (gen.stopReason === 'refusal') {
            await log('refusal', gen.usage, gen.providerRequestId);
            lastError = new ProviderError('refusal', 'model refused');
            break;
          }
          let parsed: unknown;
          try {
            parsed = extractJson(gen.text);
          } catch (e) {
            parsed = e;
          }
          const result = parsed instanceof Error ? null : prompt.output.safeParse(parsed);
          if (!result || !result.success) {
            const truncated = gen.stopReason === 'max_tokens';
            await log(truncated ? 'truncated' : 'schema_fail', gen.usage, gen.providerRequestId);
            lastError = new ProviderError(truncated ? 'truncated' : 'schema', truncated ? 'output truncated' : 'output failed schema validation');
            if (schemaRetried) break;
            schemaRetried = true;
            const issues = result && !result.success ? result.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'output was not valid JSON';
            user = `${baseUser}\n\nYour previous output failed validation (${issues}). Return valid JSON matching the schema.`;
            transportTry--; // a schema retry does not consume the transport retry budget
            continue;
          }
          await log('ok', gen.usage, gen.providerRequestId);
          return { output: result.data as O, model, credentialId: target.credential, promptVersion: prompt.version, usage: gen.usage, costUsd: costOf(model, gen.usage), attempts, fallbackUsed: ti > 0 };
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError('server', (e as Error).message);
          lastError = err;
          await log(OUTCOME[err.cls] ?? 'server_error', zero);
          const retryable = err.cls === 'retryable_transport' || err.cls === 'server' || err.cls === 'timeout' || (err.cls === 'rate_limited' && (err.retryAfterMs ?? 0) <= 5000);
          if (!retryable || transportTry >= 2 || ctx.signal?.aborted) break;
          await this.sleep(Math.min(err.retryAfterMs ?? 400 * 2 ** transportTry, 5000));
        }
      }
    }
    throw new AiUnavailableError(`All providers failed for ${prompt.id}`, lastError);
  }
}
