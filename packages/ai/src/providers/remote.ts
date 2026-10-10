import { type AIProvider, type GenerateArgs, type GenerateResult, ProviderError } from '../types';
import { estimateTokens, type FetchLike, postJson } from './http';

// Direct provider adapters over fetch (no SDK dependency; runs in Workers, Node and extension pages).
// Request shapes follow each provider's public HTTP API; verify field names when upgrading API versions.

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

// ── OpenAI Responses API (store:false, strict json_schema) ──
export function openAIProvider(apiKey: string, fetchFn: FetchLike = fetch, baseUrl = 'https://api.openai.com/v1'): AIProvider {
  return {
    kind: 'openai',
    async generate(a: GenerateArgs): Promise<GenerateResult> {
      const body: Record<string, unknown> = {
        model: a.model,
        store: false,
        input: [
          { role: 'system', content: a.system },
          { role: 'user', content: a.user },
        ],
        text: { format: { type: 'json_schema', name: a.schemaName, schema: a.jsonSchema, strict: true } },
        max_output_tokens: a.maxOutputTokens,
      };
      if (a.reasoning) body.reasoning = { effort: a.reasoning === 'none' ? 'minimal' : a.reasoning };
      const { json, requestId } = await postJson(fetchFn, `${baseUrl}/responses`, { authorization: `Bearer ${apiKey}` }, body, 'openai', a.signal);
      let text = '';
      let refusal = false;
      for (const item of (json.output as Array<Record<string, unknown>>) ?? []) {
        if (item.type !== 'message') continue;
        for (const c of (item.content as Array<Record<string, unknown>>) ?? []) {
          if (c.type === 'output_text') text += String(c.text ?? '');
          if (c.type === 'refusal') refusal = true;
        }
      }
      const usage = (json.usage ?? {}) as Record<string, Record<string, unknown> | number>;
      const incomplete = json.status === 'incomplete';
      return {
        text,
        stopReason: refusal ? 'refusal' : incomplete ? 'max_tokens' : 'end',
        usage: {
          inputTokens: num(usage.input_tokens),
          cachedInputTokens: num((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens),
          outputTokens: num(usage.output_tokens),
          reasoningTokens: num((usage.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens),
          estimated: !usage.input_tokens,
        },
        ...(requestId ? { providerRequestId: requestId } : {}),
      };
    },
  };
}

// ── Anthropic Messages API (JSON outputs via output_config.format; falls back to instruction-only JSON) ──
export function anthropicProvider(apiKey: string, fetchFn: FetchLike = fetch, opts: { browser?: boolean } = {}): AIProvider {
  return {
    kind: 'anthropic',
    async generate(a: GenerateArgs): Promise<GenerateResult> {
      const headers: Record<string, string> = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
      if (opts.browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
      const base = { model: a.model, max_tokens: a.maxOutputTokens, system: a.system, messages: [{ role: 'user', content: a.user }] };
      let res;
      try {
        res = await postJson(fetchFn, 'https://api.anthropic.com/v1/messages', headers, { ...base, output_config: { format: { type: 'json_schema', schema: a.jsonSchema } } }, 'anthropic', a.signal);
      } catch (e) {
        if (!(e instanceof ProviderError) || e.cls !== 'invalid_request') throw e;
        res = await postJson(fetchFn, 'https://api.anthropic.com/v1/messages', headers, { ...base, system: `${a.system}\nRespond with a single JSON object matching this JSON Schema:\n${JSON.stringify(a.jsonSchema)}` }, 'anthropic', a.signal);
      }
      const { json, requestId } = res;
      const text = ((json.content as Array<Record<string, unknown>>) ?? []).filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('');
      const usage = (json.usage ?? {}) as Record<string, unknown>;
      const stop = String(json.stop_reason ?? '');
      return {
        text,
        stopReason: stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'end',
        usage: { inputTokens: num(usage.input_tokens) + num(usage.cache_read_input_tokens), cachedInputTokens: num(usage.cache_read_input_tokens), outputTokens: num(usage.output_tokens), reasoningTokens: 0, estimated: !usage.input_tokens },
        ...(requestId ? { providerRequestId: requestId } : {}),
      };
    },
  };
}

// ── Google Gemini generateContent (paid tier only; the free tier forbids personal data) ──
export function googleProvider(apiKey: string, fetchFn: FetchLike = fetch): AIProvider {
  return {
    kind: 'google',
    async generate(a: GenerateArgs): Promise<GenerateResult> {
      const { json } = await postJson(
        fetchFn,
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: a.system }] },
          contents: [{ role: 'user', parts: [{ text: a.user }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: a.jsonSchema, maxOutputTokens: a.maxOutputTokens },
        },
        'google',
        a.signal,
      );
      const cand = ((json.candidates as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      const parts = ((cand.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>>) ?? [];
      const text = parts.map((p) => String(p.text ?? '')).join('');
      const u = (json.usageMetadata ?? {}) as Record<string, unknown>;
      const finish = String(cand.finishReason ?? '');
      return {
        text,
        stopReason: finish === 'MAX_TOKENS' ? 'max_tokens' : finish === 'SAFETY' || finish === 'RECITATION' ? 'refusal' : 'end',
        usage: { inputTokens: num(u.promptTokenCount), cachedInputTokens: num(u.cachedContentTokenCount), outputTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount), reasoningTokens: num(u.thoughtsTokenCount), estimated: !u.promptTokenCount },
      };
    },
  };
}

// ── OpenAI-compatible chat completions (NVIDIA API Catalog, Workers AI, Groq, vLLM, …) ──
export function openAICompatibleProvider(apiKey: string, baseUrl: string, fetchFn: FetchLike = fetch, structured: 'json_schema_strict' | 'json_mode' | 'none' = 'json_mode'): AIProvider {
  return {
    kind: 'openai_compatible',
    async generate(a: GenerateArgs): Promise<GenerateResult> {
      const responseFormat =
        structured === 'json_schema_strict'
          ? { type: 'json_schema', json_schema: { name: a.schemaName, schema: a.jsonSchema, strict: true } }
          : structured === 'json_mode'
            ? { type: 'json_object' }
            : undefined;
      const system = structured === 'json_schema_strict' ? a.system : `${a.system}\nRespond with a single JSON object matching this JSON Schema:\n${JSON.stringify(a.jsonSchema)}`;
      const { json, requestId } = await postJson(
        fetchFn,
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        { model: a.model, messages: [{ role: 'system', content: system }, { role: 'user', content: a.user }], max_tokens: a.maxOutputTokens, temperature: a.temperature ?? 0.2, ...(responseFormat ? { response_format: responseFormat } : {}) },
        'openai_compatible',
        a.signal,
      );
      const choice = ((json.choices as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      const text = String(((choice.message as Record<string, unknown> | undefined)?.content as string) ?? '');
      const u = json.usage as Record<string, unknown> | undefined;
      const estimated = !u || !u.prompt_tokens;
      return {
        text,
        stopReason: choice.finish_reason === 'length' ? 'max_tokens' : 'end',
        usage: {
          inputTokens: estimated ? estimateTokens(system + a.user) : num(u!.prompt_tokens),
          cachedInputTokens: num((u?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens),
          outputTokens: estimated ? estimateTokens(text) : num(u!.completion_tokens),
          reasoningTokens: 0,
          estimated,
        },
        ...(requestId ? { providerRequestId: requestId } : {}),
      };
    },
  };
}
