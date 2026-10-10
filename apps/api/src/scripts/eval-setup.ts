// Local testing on free or trial models (development only, synthetic data only):
//   pnpm nvidia:setup       NVIDIA API Catalog trial models (NVIDIA_API_KEY)
//   pnpm openrouter:setup   OpenRouter free ":free" models (OPENROUTER_API_KEY)
//
// 1. Probes candidate models with a tiny synthetic request and keeps the ones that return valid JSON.
// 2. Registers them as eval-only models (trial and free terms forbid production use and personal data).
// 3. Points the *eval* routing at them; run the API with AI_ROUTING=eval to use it.
// 4. Runs the built-in smoke eval (synthetic job + synthetic resume) end to end and prints the result.
//
// Choose models yourself with: pnpm openrouter:setup --cheap <model id> --strong <model id>

import { DEFAULT_ROUTING, extractJson, openAICompatibleProvider, type RoutingConfig } from '@jmo/ai';
import { createSql } from '@jmo/db';
import { activateVersion, audit, createDraft, createServices, loadEnv, runSmokeEval } from '@jmo/server';

const MODES = ['json_schema_strict', 'json_mode', 'none'] as const;
type Mode = (typeof MODES)[number];
interface Candidate {
  model: string;
  modes: readonly Mode[];
}

interface Source {
  /** Inserted with every policy flag closed if the database doesn't have it yet. */
  provider: { id: string; name: string; base_url: string; trains: 'yes' | 'unknown'; terms: string; note: string };
  envKey: 'NVIDIA_API_KEY' | 'OPENROUTER_API_KEY';
  getKey: string;
  modelsUrl: string;
  /** Probe every cheap candidate and keep the fastest. Off where each probe uses up a small daily quota. */
  fastestCheap: boolean;
  candidates(): Promise<{ cheap: Candidate[]; strong: Candidate[]; known: Map<string, Candidate> }>;
}

const NVIDIA_CHEAP = ['nvidia/nemotron-3.5-lightning-30b-a3b', 'z-ai/glm-5.3-flash', 'deepseek-ai/deepseek-v4.1-flash', 'openai/gpt-oss-20b', 'nvidia/nemotron-nano-3-30b-a3b'];
const NVIDIA_STRONG = ['nvidia/nemotron-3-super-120b-a12b', 'z-ai/glm-5.3', 'moonshotai/kimi-k3', 'deepseek-ai/deepseek-v4.1-flash', 'nvidia/nemotron-3-ultra-550b-a55b'];

// OpenRouter's free models change often, so candidates come from its public model list: these first (checked
// 2026-10-09), then any other free model with JSON output. The listing says which structured-output mode a model
// supports; when that mode fails we retry once with the schema in the prompt instead ("none"), because the listing
// can be wrong and forced schemas break some reasoning models (free Nemotron 3 Super wrote its reasoning into the
// JSON fields with a strict schema, but answers cleanly without one). Free keys get about 50 requests a day.
const OPENROUTER_PREFER = {
  cheap: ['google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free'],
  strong: ['nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free'],
};

const SOURCES: Record<string, Source> = {
  nvidia: {
    provider: {
      id: 'nvidia_trial',
      name: 'NVIDIA API Catalog (trial)',
      base_url: 'https://integrate.api.nvidia.com/v1',
      trains: 'yes',
      terms: 'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf',
      note: 'Trial terms v.2025-09-19: §1.2 no production use; §2.6(a) no personal data; §3.3 content may improve NVIDIA models. Evals with synthetic data only.',
    },
    envKey: 'NVIDIA_API_KEY',
    getKey: 'Get a free key at build.nvidia.com (docs/setup-checklist.md §4)',
    modelsUrl: 'https://build.nvidia.com/models',
    fastestCheap: true,
    async candidates() {
      const all = (ids: string[]) => ids.map((model) => ({ model, modes: MODES }));
      return { cheap: all(NVIDIA_CHEAP), strong: all(NVIDIA_STRONG), known: new Map() };
    },
  },
  openrouter: {
    provider: {
      id: 'openrouter_free',
      name: 'OpenRouter (free models)',
      base_url: 'https://openrouter.ai/api/v1',
      trains: 'unknown',
      terms: 'https://openrouter.ai/terms',
      note: 'Free ":free" endpoints: some upstream providers log or train on prompts (see OpenRouter privacy settings); daily request cap. Evals with synthetic data only.',
    },
    envKey: 'OPENROUTER_API_KEY',
    getKey: 'Create a key at openrouter.ai/keys',
    modelsUrl: 'https://openrouter.ai/models?max_price=0',
    fastestCheap: false,
    async candidates() {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error(`Could not list OpenRouter models (${res.status}).`);
      const list = ((await res.json()) as { data: Array<{ id: string; supported_parameters?: string[]; context_length?: number }> }).data.filter((m) => m.id.endsWith(':free') && (m.context_length ?? 0) >= 32_000);
      const known = new Map(
        list.map((m) => {
          const p = m.supported_parameters ?? [];
          const listed: Mode = p.includes('structured_outputs') ? 'json_schema_strict' : p.includes('response_format') ? 'json_mode' : 'none';
          return [m.id, { model: m.id, modes: listed === 'none' ? (['none'] as const) : ([listed, 'none'] as const) }];
        }),
      );
      const withJson = list.filter((m) => m.supported_parameters?.some((p) => p === 'structured_outputs' || p === 'response_format')).map((m) => m.id);
      const ordered = (prefer: string[]) => [...new Set([...prefer, ...withJson])].flatMap((id) => (known.has(id) ? [known.get(id)!] : [])).slice(0, 4);
      return { cheap: ordered(OPENROUTER_PREFER.cheap), strong: ordered(OPENROUTER_PREFER.strong), known };
    },
  },
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const source = SOURCES[arg('provider') ?? 'nvidia'];
if (!source) throw new Error(`Unknown --provider; use one of: ${Object.keys(SOURCES).join(', ')}`);
const env = loadEnv({ ...process.env, AI_ROUTING: 'production' });
if (env.ENV === 'production') throw new Error('eval setup is for local testing only.');
const apiKey = env[source.envKey];
if (!apiKey) {
  console.error(`\n  ${source.envKey} is empty. ${source.getKey} and put it in .env.\n`);
  process.exit(1);
}
const sql = createSql(env.DATABASE_URL, { max: 2 });
const p = source.provider;
await sql`INSERT INTO ai_providers (id, name, kind, base_url, production_allowed, personal_data_allowed, trains_on_inputs, retention_note, terms_url, terms_reviewed_on)
          VALUES (${p.id}, ${p.name}, 'openai_compatible', ${p.base_url}, false, false, ${p.trains}, ${p.note}, ${p.terms}, current_date) ON CONFLICT (id) DO NOTHING`;
const [prov] = await sql<Array<{ base_url: string }>>`SELECT base_url FROM ai_providers WHERE id = ${p.id}`;

// A tiny synthetic extraction, the same shape of task the pipeline runs.
const PROBE = {
  system: 'You extract requirements from job text. Reply with JSON only.',
  user: 'Job text: "You have 5+ years of Python and SQL, and you have built pipelines with Airflow." List the skills and the minimum years.',
  schemaName: 'probe',
  jsonSchema: { type: 'object', properties: { skills: { type: 'array', items: { type: 'string' } }, years: { type: 'integer' } }, required: ['skills', 'years'], additionalProperties: false },
};

type ProbeResult = { mode: Mode; ms: number } | { error: string };
const probed = new Map<string, ProbeResult>();

async function probe(c: Candidate): Promise<ProbeResult> {
  const cached = probed.get(c.model);
  if (cached) return cached;
  let last = 'no response';
  let result: ProbeResult | null = null;
  for (const mode of c.modes) {
    const provider = openAICompatibleProvider(apiKey!, prov!.base_url, fetch, mode);
    const t0 = Date.now();
    try {
      const r = await provider.generate({ ...PROBE, model: c.model, maxOutputTokens: 800, temperature: 0, signal: AbortSignal.timeout(60_000) });
      const j = extractJson(r.text) as { skills?: unknown; years?: unknown };
      // Exact items, not just the shape: a model leaking its reasoning into the fields must not pass.
      const skills = Array.isArray(j.skills) ? j.skills.map((x) => String(x).trim().toLowerCase()) : [];
      if (skills.includes('python') && skills.includes('sql') && j.years === 5) {
        result = { mode, ms: Date.now() - t0 };
        break;
      }
      last = 'JSON without the expected fields';
    } catch (e) {
      last = (e as Error).message.slice(0, 160);
      if (/401|403|auth/i.test(last)) {
        result = { error: `key rejected (${last})` };
        break;
      }
      if (/data policy/i.test(last)) last += ' → allow free endpoints in openrouter.ai/settings/privacy';
    }
  }
  result ??= { error: last };
  probed.set(c.model, result);
  return result;
}

async function pick(label: string, candidates: Candidate[], forced: string | undefined, fastest: boolean, known: Map<string, Candidate>) {
  const list = forced ? [known.get(forced) ?? { model: forced, modes: MODES }] : candidates;
  const ok: Array<{ model: string; mode: Mode; ms: number }> = [];
  for (const c of list) {
    process.stdout.write(`  ${label.padEnd(6)} ${c.model.padEnd(46)} `);
    const r = await probe(c);
    if ('error' in r) {
      console.log(`✗ ${r.error}`);
      if (r.error.startsWith('key rejected')) break;
    } else {
      console.log(`✓ ${r.mode}, ${(r.ms / 1000).toFixed(1)} s`);
      ok.push({ model: c.model, ...r });
      if (!fastest) break;
    }
  }
  if (!ok.length) throw new Error(`No ${label} model worked. Try another with --${label} <model id> (list: ${source!.modelsUrl}).`);
  return fastest ? ok.sort((a, b) => a.ms - b.ms)[0]! : ok[0]!;
}

console.log(`\nProbing ${p.name} models with a synthetic request…`);
const { cheap: cheapList, strong: strongList, known } = await source.candidates();
const cheap = await pick('cheap', cheapList, arg('cheap'), source.fastestCheap, known);
const strong = await pick('strong', strongList, arg('strong'), false, known);

const [owner] = await sql<Array<{ id: string }>>`SELECT user_id AS id FROM admin_members WHERE role = 'owner' AND revoked_at IS NULL LIMIT 1`;
if (!owner) throw new Error('No owner admin in the database.');
const actor = { id: owner.id, role: 'owner' };

for (const m of [{ ...cheap, tier: 'cheap' }, { ...strong, tier: 'strong' }]) {
  const id = `${p.id}:${m.model}`;
  await sql.begin(async (tx) => {
    const [existing] = await tx`SELECT 1 FROM ai_models WHERE id = ${id}`;
    await tx`INSERT INTO ai_models (id, provider_id, provider_model_id, tier, capabilities, status, approved_tasks, input_per_mtok, cached_input_per_mtok, output_per_mtok, token_factor, effective_from, source_url, checked_on)
             VALUES (${id}, ${p.id}, ${m.model}, ${m.tier}, ${tx.json({ structured: m.mode, reasoning_control: false })}, 'eval_only', '{}', 0, 0, 0, 1, current_date, ${source.modelsUrl}, current_date)
             ON CONFLICT (id) DO UPDATE SET capabilities = EXCLUDED.capabilities, checked_on = current_date`;
    if (!existing) await audit(tx, { actor_type: 'admin', actor_id: actor.id, actor_role: 'owner', action: 'model.create', target_type: 'model', target_id: id, after: { structured: m.mode, status: 'eval_only' }, reason: `Local testing on ${p.name} (eval setup)` });
  });
}

const target = (model: string) => ({ model: `${p.id}:${model}`, credential: `env:${source.envKey}` });
const routing: RoutingConfig = {
  routes: Object.fromEntries(
    (Object.keys(DEFAULT_ROUTING.routes) as Array<keyof RoutingConfig['routes']>).map((task) => {
      const isStrong = task === 'optimize' || task === 'repair';
      return [task, { ...DEFAULT_ROUTING.routes[task], primary: target(isStrong ? strong.model : cheap.model), fallbacks: [], reasoning: 'none', timeout_ms: isStrong ? 150_000 : 90_000 }];
    }),
  ) as unknown as RoutingConfig['routes'],
};
const draft = await createDraft(sql, 'ai_routing', 'eval', routing, `Local testing: ${cheap.model} + ${strong.model} (synthetic data only)`, actor);
await activateVersion(sql, draft.id, actor, { reason: `eval setup for local testing on ${p.name}` });
console.log(`\nEval routing v${draft.version} is active: extraction and checks → ${cheap.model}, rewriting → ${strong.model}`);

console.log('\nRunning the smoke eval (synthetic job + synthetic resume, end to end)…');
const services = createServices(env, { sql });
const t0 = Date.now();
const res = await runSmokeEval(sql, services.ai, routing, `${arg('provider') ?? 'nvidia'}:setup`);
console.log(`  ${res.passed ? '✓ passed' : '✗ failed'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const f of res.failures) console.log(`    - ${f}`);
console.log(`  metrics: ${JSON.stringify(res.metrics)}`);

console.log(`
Next:
  1. Make sure .env has AI_ROUTING=eval, then (re)start the API: pnpm dev:api
  2. In the extension, use a MADE-UP resume (e.g. samples/sample-resume.pdf), never a real one:
     these models' terms forbid personal data or may keep prompts.
`);
await sql.end({ timeout: 2 });
process.exit(0);
