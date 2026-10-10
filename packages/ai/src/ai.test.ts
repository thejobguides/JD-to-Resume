import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractClaims, toClaimLite } from '@jmo/evidence';
import { analyzeJobText } from '@jmo/job-extraction';
import { toOptResume } from '@jmo/resume';
import { sampleResume } from '@jmo/resume/fixtures';
import { scoreAfter, scoreResume, selectTargets } from '@jmo/scoring';
import { describe, expect, it, vi } from 'vitest';
import {
  AIRouter,
  type AiRequestLog,
  type AIProvider,
  anthropicProvider,
  DEFAULT_MODELS,
  jdExtract,
  MOCK_ROUTING,
  mockProvider,
  openAICompatibleProvider,
  openAIProvider,
  ProviderError,
  ResumeAIService,
  type RoutingConfig,
  strictJsonSchema,
} from './index';

const now = new Date('2026-09-30T00:00:00Z');

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('strictJsonSchema', () => {
  it('marks every property required and forbids extra properties, recursively', () => {
    const s = strictJsonSchema(jdExtract.output) as Record<string, any>;
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(s.properties));
    const req = s.properties.requirements.items;
    expect(req.additionalProperties).toBe(false);
    expect(req.required).toContain('quote');
  });
});

describe('provider adapters', () => {
  it('parses OpenAI Responses output and usage; sends store:false and strict schema', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      expect(body.store).toBe(false);
      expect(body.text.format.strict).toBe(true);
      return jsonResponse({
        status: 'completed',
        output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] }],
        usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } },
      });
    });
    const p = openAIProvider('sk-test', fetchFn as unknown as typeof fetch);
    const r = await p.generate({ model: 'gpt-6-luna', system: 's', user: 'u', jsonSchema: {}, schemaName: 'x', maxOutputTokens: 100, reasoning: 'low' });
    expect(r.text).toBe('{"a":1}');
    expect(r.usage).toMatchObject({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 50, reasoningTokens: 30, estimated: false });
  });

  it('classifies spend caps as non-retryable', async () => {
    const p = openAIProvider('sk', (async () => jsonResponse({ error: { code: 'insufficient_quota' } }, 429)) as unknown as typeof fetch);
    await expect(p.generate({ model: 'm', system: '', user: '', jsonSchema: {}, schemaName: 'x', maxOutputTokens: 10 })).rejects.toMatchObject({ cls: 'spend_cap' });
  });

  it('Anthropic falls back to instruction-only JSON when output_config is rejected', async () => {
    let calls = 0;
    const fetchFn = async (_u: string, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init!.body));
      if (body.output_config) return jsonResponse({ error: { type: 'invalid_request_error' } }, 400);
      return jsonResponse({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    };
    const r = await anthropicProvider('k', fetchFn as unknown as typeof fetch).generate({ model: 'claude', system: 's', user: 'u', jsonSchema: { type: 'object' }, schemaName: 'x', maxOutputTokens: 10 });
    expect(calls).toBe(2);
    expect(r.text).toBe('{"ok":true}');
  });

  it('OpenAI-compatible hosts without usage get estimated tokens', async () => {
    const fetchFn = async () => jsonResponse({ choices: [{ message: { content: '{"x":1}' }, finish_reason: 'stop' }] });
    const r = await openAICompatibleProvider('nvapi-test', 'https://integrate.api.nvidia.com/v1', fetchFn as unknown as typeof fetch).generate({ model: 'meta/some-model', system: 'sys', user: 'user text', jsonSchema: {}, schemaName: 'x', maxOutputTokens: 10 });
    expect(r.usage.estimated).toBe(true);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
  });
});

describe('AIRouter', () => {
  const models = [...DEFAULT_MODELS];
  const routing: RoutingConfig = {
    ...MOCK_ROUTING,
    routes: { ...MOCK_ROUTING.routes, jd_extract: { primary: { model: 'openai:gpt-6-luna', credential: 'env:OPENAI_API_KEY' }, fallbacks: [{ model: 'mock:deterministic', credential: 'none' }] } },
  };

  it('retries transient errors, then falls back on a spend cap, logging each attempt', async () => {
    const logs: AiRequestLog[] = [];
    let n = 0;
    const flaky: AIProvider = {
      kind: 'openai',
      async generate() {
        n++;
        if (n === 1) throw new ProviderError('server', '500');
        throw new ProviderError('spend_cap', 'cap');
      },
    };
    const router = new AIRouter({ routing, models, providerFor: async (m) => (m.kind === 'mock' ? mockProvider() : flaky), onLog: (l) => void logs.push(l), sleep: async () => undefined });
    const r = await router.run(jdExtract, { jd_text: 'Requirements:\n• 3+ years of Python\n• SQL and dbt' });
    expect(r.model.id).toBe('mock:deterministic');
    expect(r.fallbackUsed).toBe(true);
    expect(logs.map((l) => l.outcome)).toEqual(['server_error', 'spend_cap', 'ok']);
    expect(logs[2]!.fallback_used).toBe(true);
  });

  it('retries once with the validation errors when output fails the schema', async () => {
    let n = 0;
    const sloppy: AIProvider = {
      kind: 'openai',
      async generate(a) {
        n++;
        if (n === 1) return { text: '{"title": 5}', stopReason: 'end', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, estimated: false } };
        expect(a.user).toContain('failed validation');
        return mockProvider().generate({ ...a, task: 'jd_extract' });
      },
    };
    const router = new AIRouter({ routing, models, providerFor: async () => sloppy });
    const r = await router.run(jdExtract, { jd_text: 'Requirements:\n• 3+ years of Python' });
    expect(n).toBe(2);
    expect(r.output.requirements.length).toBeGreaterThan(0);
  });

  it('routes a stable share of users to the canary', () => {
    const router = new AIRouter({ routing: { ...routing, canary: { optimize: { model: 'anthropic:claude-sonnet-5-5', credential: 'x', pct: 30 } } }, models, providerFor: async () => mockProvider() });
    let canary = 0;
    for (let i = 0; i < 1000; i++) if (router.targetsFor('optimize', { bucketKey: `user_${i}` })[0]!.model.startsWith('anthropic')) canary++;
    expect(canary).toBeGreaterThan(220);
    expect(canary).toBeLessThan(380);
    expect(router.targetsFor('optimize', { bucketKey: 'user_7' })[0]).toEqual(router.targetsFor('optimize', { bucketKey: 'user_7' })[0]);
  });
});

// ── End-to-end pipeline with the deterministic provider ──
const jdText = readFileSync(resolve(__dirname, '../../../tests/fixtures/jd/lever-jsonld.html'), 'utf8');

async function setup(provider: (task: string) => AIProvider) {
  const logs: AiRequestLog[] = [];
  const router = new AIRouter({ routing: MOCK_ROUTING, models: DEFAULT_MODELS, providerFor: async () => ({ kind: 'mock', generate: (a) => provider(a.task!).generate(a) }), onLog: (l) => void logs.push(l) });
  const svc = new ResumeAIService(router, () => now);
  const text = jdText.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
  const description = text.slice(text.indexOf('Acme Analytics is hiring'), text.indexOf('© Acme'));
  const analysis = analyzeJobText(description, { title: 'Senior Data Engineer', company: 'Acme Analytics', location: ['Remote (Canada)'] });
  const { resume, claims } = extractClaims(sampleResume());
  const before = scoreResume({ analysis, resume, claims, now });
  const req = {
    resume: toOptResume(resume),
    claims: toClaimLite(claims),
    targets: { req_ids: selectTargets(before), edit_budget: { bullets: 8, summary: true, skills_order: true } },
    options: { tone: 'concise' as const, locale: 'en-US' },
  };
  return { svc, analysis, resume, claims, before, req, logs };
}

describe('ResumeAIService.optimize (mock)', () => {
  it('surfaces existing evidence, passes every gate, and raises the score within the ceiling', async () => {
    const { svc, analysis, resume, before, req, logs } = await setup(() => mockProvider());
    const progress: string[] = [];
    const out = await svc.optimize(req, analysis, {}, (e) => void progress.push(e.step));
    const k8s = out.result.bullets.find((b) => b.bullet_id === 'role_1.b_2');
    expect(k8s?.text).toBe('Deployed services to Kubernetes with Helm and Terraform');
    expect(k8s?.validation).toBe('entailed');
    expect(out.result.reverted).toEqual([]);
    // Requirements with no evidence (AWS) are never targets; they surface as "could not improve" from the local gaps.
    expect(JSON.stringify(out.result)).not.toMatch(/AWS/);
    expect(progress).toEqual(expect.arrayContaining(['rewrite', 'gates', 'entailment']));
    expect(logs.every((l) => l.outcome === 'ok')).toBe(true);

    const { applyOptimization } = await import('@jmo/resume');
    const optimized = applyOptimization(resume, out.result, { bullets: 'all_verified', summary: true, skillsOrder: true }, 'v2');
    const ex = extractClaims(optimized);
    const after = scoreAfter(before, { analysis, resume: ex.resume, claims: ex.claims, now });
    expect(after.score).toBeGreaterThanOrEqual(before.score);
    expect(after.score).toBeLessThanOrEqual(before.ceiling);
  });

  it('catches a lying model: fabricated metrics/tools are repaired or reverted, never returned', async () => {
    const liar: AIProvider = {
      kind: 'mock',
      async generate(a) {
        if (a.task !== 'optimize') return mockProvider().generate(a);
        const out = {
          summary: { text: 'Data engineer with 12 years of experience leading AWS platforms.', claim_ids: [] },
          bullets: [
            { bullet_id: 'role_1.b_1', role_id: 'role_1', source_bullet_ids: ['role_1.b_1'], text: 'Led Kafka migration on AWS processing 2M events/day, saving 40%', claim_ids: [], emphasized_req_ids: [], why: 'impact' },
            { bullet_id: 'role_2.b_1', role_id: 'role_2', source_bullet_ids: ['role_2.b_1'], text: 'Built dashboards in Tableau for the finance team', claim_ids: [], emphasized_req_ids: [], why: 'same' },
          ],
          skills_order: ['sk_1', 'sk_999'],
          not_addressable: [],
        };
        return { text: JSON.stringify(out), stopReason: 'end', usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0, estimated: true } };
      },
    };
    const { svc, analysis, req } = await setup(() => liar);
    const out = await svc.optimize(req, analysis);
    const texts = [out.result.summary?.text ?? '', ...out.result.bullets.map((b) => b.text)].join(' ');
    expect(texts).not.toMatch(/40%|AWS|Led|12 years/);
    // The fabricated bullet was repaired back to evidence (mock repair returns the original) → no change, so it is reverted.
    expect(out.result.bullets.find((b) => b.bullet_id === 'role_1.b_1')).toBeUndefined();
    expect(out.result.reverted.map((r) => r.bullet_id)).toContain('role_1.b_1');
    expect(out.result.summary).toBeNull();
    expect(out.result.skills_order).toEqual([]); // unknown skill id → whole order rejected
    expect(out.meta.gates.G2 ?? 0).toBeGreaterThan(0);
  });
});

describe('extractJson', () => {
  it('reads JSON from fenced replies and replies with reasoning blocks', async () => {
    const { extractJson } = await import('./router');
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('<think>maybe {"wrong":true}?</think>\n{"a":2}')).toEqual({ a: 2 });
    expect(() => extractJson('no json here')).toThrow();
  });
});
