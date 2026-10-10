import {
  type AiRequestLog,
  AIRouter,
  type AIProvider,
  anthropicProvider,
  googleProvider,
  mockProvider,
  type ModelInfo,
  openAICompatibleProvider,
  openAIProvider,
  ProviderError,
  ResumeAIService,
  type RoutingConfig,
  type RunContext,
} from '@jmo/ai';
import type { ActiveConfig } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { uuidv7 } from '@jmo/shared';
import { decryptSecret } from '@jmo/vault';
import type { ServerEnv } from './env';

// Builds the AI router from the active `ai_routing` config, the model registry and the key sources:
//   env:NAME  → environment variable (bootstrap / local dev)
//   cred_*    → write-only vault entry, decrypted here only (admin-panel.md §6.5.2)
//   none      → the deterministic mock provider

interface ProviderRow {
  id: string;
  kind: ModelInfo['kind'];
  base_url: string | null;
  active: boolean;
}

export class AiRuntime {
  private models: ModelInfo[] = [];
  private providers = new Map<string, ProviderRow>();
  private keyCache = new Map<string, { key: string; at: number }>();
  private loadedAt = 0;
  private router: AIRouter;
  private service: ResumeAIService;
  private spend = new Map<string, number>(); // credential → USD this month (in-memory view, refreshed with models)

  constructor(
    private sql: Sql,
    private env: ServerEnv,
    private getConfig: () => Promise<{ config: ActiveConfig; snapshot: string }>,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.router = new AIRouter({
      routing: { routes: {} as RoutingConfig['routes'] },
      models: this.models,
      providerFor: (m, c) => this.providerFor(m, c),
      onLog: (l, ctx) => this.log(l, ctx),
    });
    this.service = new ResumeAIService(this.router);
  }

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < 30_000 && this.models.length) return;
    const rows = await this.sql<Array<{ id: string; provider_id: string; provider_model_id: string; capabilities: { structured?: ModelInfo['structured']; reasoning_control?: boolean }; input_per_mtok: string; cached_input_per_mtok: string | null; output_per_mtok: string; token_factor: string; kind: ModelInfo['kind'] }>>`
      SELECT m.id, m.provider_id, m.provider_model_id, m.capabilities, m.input_per_mtok, m.cached_input_per_mtok, m.output_per_mtok, m.token_factor, p.kind
      FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
      WHERE m.status <> 'retired' AND (m.effective_to IS NULL OR m.effective_to > now())`;
    this.models.splice(
      0,
      this.models.length,
      ...rows.map((r) => ({
        id: r.id,
        provider_id: r.provider_id,
        kind: r.kind,
        provider_model_id: r.provider_model_id,
        structured: r.capabilities.structured ?? 'json_mode',
        reasoning_control: !!r.capabilities.reasoning_control,
        input_per_mtok: Number(r.input_per_mtok),
        cached_input_per_mtok: Number(r.cached_input_per_mtok ?? r.input_per_mtok),
        output_per_mtok: Number(r.output_per_mtok),
        token_factor: Number(r.token_factor),
      })),
    );
    const provs = await this.sql<ProviderRow[]>`SELECT id, kind, base_url, active FROM ai_providers`;
    this.providers = new Map(provs.map((p) => [p.id, p]));
    const spend = await this.sql<Array<{ credential_id: string; usd: string }>>`
      SELECT credential_id, sum(cost_usd) AS usd FROM ai_requests WHERE credential_id IS NOT NULL AND created_at >= date_trunc('month', now()) GROUP BY credential_id`;
    this.spend = new Map(spend.map((s) => [s.credential_id, Number(s.usd)]));
    this.loadedAt = Date.now();
  }

  async ready(): Promise<{ service: ResumeAIService; snapshot: string; config: ActiveConfig }> {
    await this.refresh();
    const { config, snapshot } = await this.getConfig();
    this.router.setRouting(config.ai_routing as RoutingConfig);
    this.budgets = config.ai_routing.credential_budgets_usd ?? {};
    this.killed = config.kill_switches.providers;
    return { service: this.service, snapshot, config };
  }

  private budgets: Record<string, number> = {};
  private killed: Record<string, boolean> = {};

  private async resolveKey(credential: string): Promise<string> {
    if (credential.startsWith('env:')) {
      const name = credential.slice(4) as keyof ServerEnv;
      const v = this.env[name];
      if (typeof v !== 'string' || !v) throw new ProviderError('auth', `${name} is not configured`);
      return v;
    }
    const cached = this.keyCache.get(credential);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.key;
    const [row] = await this.sql<Array<{ ciphertext: Uint8Array; wrapped_dek: Uint8Array; iv: Uint8Array; status: string }>>`
      SELECT ciphertext, wrapped_dek, iv, status FROM provider_credentials WHERE id = ${credential}`;
    if (!row || row.status === 'revoked') throw new ProviderError('auth', `key ${credential} unavailable`);
    if (!this.env.VAULT_PRIVATE_KEY_JWK) throw new ProviderError('auth', 'vault private key not configured');
    const key = await decryptSecret(row, this.env.VAULT_PRIVATE_KEY_JWK);
    this.keyCache.set(credential, { key, at: Date.now() });
    return key;
  }

  forgetKey(credential: string) {
    this.keyCache.delete(credential);
  }

  forgetAllKeys() {
    this.keyCache.clear();
  }

  modelList(): ModelInfo[] {
    return this.models;
  }

  async providerFor(model: ModelInfo, credential: string): Promise<AIProvider> {
    const prov = this.providers.get(model.provider_id);
    if (!prov?.active || this.killed[model.provider_id]) throw new ProviderError('auth', `provider ${model.provider_id} disabled`);
    if (model.kind === 'mock') return mockProvider();
    const budget = this.budgets[credential];
    if (budget !== undefined && (this.spend.get(credential) ?? 0) >= budget) throw new ProviderError('spend_cap', `key ${credential} reached its soft budget`);
    const key = await this.resolveKey(credential);
    switch (model.kind) {
      case 'openai':
        return openAIProvider(key, this.fetchFn);
      case 'anthropic':
        return anthropicProvider(key, this.fetchFn);
      case 'google':
        return googleProvider(key, this.fetchFn);
      case 'openai_compatible':
        if (!prov.base_url) throw new ProviderError('invalid_request', 'missing base_url');
        return openAICompatibleProvider(key, prov.base_url, this.fetchFn, model.structured);
      default:
        throw new ProviderError('invalid_request', `unsupported provider kind ${model.kind}`);
    }
  }

  /** One ai_requests row per call + the per-user daily rollup (no content, ever). */
  private async log(l: AiRequestLog, ctx: RunContext) {
    const id = uuidv7();
    const credential = l.credential_id && !l.credential_id.startsWith('env:') ? l.credential_id : (l.credential_id ?? null);
    await this.sql`
      INSERT INTO ai_requests (id, user_id, optimization_id, job_analysis_id, task, prompt_version_id, model_id, provider_id, config_snapshot_id, request_id, credential_id, plan_id,
                               provider_request_id, attempt, fallback_used, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, tokens_estimated, cost_usd, latency_ms, outcome, cache_hit)
      VALUES (${id}, ${ctx.userId ?? null}, ${ctx.optimizationId ?? null}, ${ctx.jobAnalysisId ?? null}, ${l.task}, ${l.prompt_version}, ${l.model_id}, ${l.provider_id}, ${ctx.configSnapshotId ?? null},
              ${ctx.requestId ?? null}, ${credential}, ${ctx.plan ?? null}, ${l.provider_request_id ?? null}, ${l.attempt}, ${l.fallback_used}, ${l.usage.inputTokens}, ${l.usage.cachedInputTokens},
              ${l.usage.outputTokens}, ${l.usage.reasoningTokens}, ${l.usage.estimated}, ${l.cost_usd}, ${l.latency_ms}, ${l.outcome}, ${l.cache_hit})`;
    if (credential) this.spend.set(credential, (this.spend.get(credential) ?? 0) + l.cost_usd);
    if (credential?.startsWith('cred_')) await this.sql`UPDATE provider_credentials SET last_used_at = now() WHERE id = ${credential}`;
    if (ctx.userId) {
      const step = { [l.task]: { calls: 1, in: l.usage.inputTokens, cached: l.usage.cachedInputTokens, out: l.usage.outputTokens, reasoning: l.usage.reasoningTokens, usd: l.cost_usd } };
      await this.sql`
        INSERT INTO ai_usage_daily (user_id, day, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, cost_usd, by_step)
        VALUES (${ctx.userId}, current_date, ${l.usage.inputTokens}, ${l.usage.cachedInputTokens}, ${l.usage.outputTokens}, ${l.usage.reasoningTokens}, ${l.cost_usd}, ${this.sql.json(step)})
        ON CONFLICT (user_id, day) DO UPDATE SET
          input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
          cached_input_tokens = ai_usage_daily.cached_input_tokens + EXCLUDED.cached_input_tokens,
          output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
          reasoning_tokens = ai_usage_daily.reasoning_tokens + EXCLUDED.reasoning_tokens,
          cost_usd = ai_usage_daily.cost_usd + EXCLUDED.cost_usd,
          by_step = jsonb_set(ai_usage_daily.by_step, ${[l.task]}::text[],
            jsonb_build_object(
              'calls', COALESCE((ai_usage_daily.by_step->${l.task}->>'calls')::int, 0) + 1,
              'in', COALESCE((ai_usage_daily.by_step->${l.task}->>'in')::bigint, 0) + ${l.usage.inputTokens},
              'cached', COALESCE((ai_usage_daily.by_step->${l.task}->>'cached')::bigint, 0) + ${l.usage.cachedInputTokens},
              'out', COALESCE((ai_usage_daily.by_step->${l.task}->>'out')::bigint, 0) + ${l.usage.outputTokens},
              'reasoning', COALESCE((ai_usage_daily.by_step->${l.task}->>'reasoning')::bigint, 0) + ${l.usage.reasoningTokens},
              'usd', COALESCE((ai_usage_daily.by_step->${l.task}->>'usd')::numeric, 0) + ${l.cost_usd}), true)`;
    }
  }

  /** Synthetic test call for a vault key (admin "Test key"); never sends user data. */
  async testCredential(credentialId: string): Promise<{ ok: boolean; latency_ms: number; error_class?: string; json_mode_ok?: boolean }> {
    await this.refresh(true);
    const [c] = await this.sql<Array<{ provider_id: string }>>`SELECT provider_id FROM provider_credentials WHERE id = ${credentialId}`;
    if (!c) return { ok: false, latency_ms: 0, error_class: 'not_found' };
    const model = this.models.find((m) => m.provider_id === c.provider_id);
    const started = Date.now();
    try {
      if (!model) throw new ProviderError('invalid_request', 'no model registered for this provider');
      this.keyCache.delete(credentialId);
      const p = await this.providerFor(model, credentialId);
      const r = await p.generate({ model: model.provider_model_id, system: 'Reply with JSON only.', user: 'Return {"ok": true}.', jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, schemaName: 'ping', maxOutputTokens: 50 });
      let json = false;
      try {
        json = JSON.parse(r.text.replace(/^```(json)?|```$/g, '').trim()).ok === true;
      } catch {
        json = false;
      }
      return { ok: true, latency_ms: Date.now() - started, json_mode_ok: json };
    } catch (e) {
      return { ok: false, latency_ms: Date.now() - started, error_class: e instanceof ProviderError ? e.cls : 'error' };
    }
  }
}
