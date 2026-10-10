import { type AiRequestLog, AIRouter, ResumeAIService, type RoutingConfig } from '@jmo/ai';
import type { Sql } from '@jmo/db';
import { extractClaims, toClaimLite } from '@jmo/evidence';
import { validateAnalysisQuotes } from '@jmo/job-extraction';
import { sampleResume } from '@jmo/resume/fixtures';
import { toOptResume, toPlainText } from '@jmo/resume';
import { scoreResume, selectTargets } from '@jmo/scoring';
import { uuidv7 } from '@jmo/shared';
import type { AiRuntime } from './ai-runtime';

// Smoke eval (ai-model-comparison.md §9.3 "smoke suite"): SYNTHETIC data only, so it may run against any
// provider including trial keys. It gates activation of ai_routing/prompts/scoring in the admin panel.
// The full golden-set suite runs in CI and records to the same eval_runs table.

const SYNTHETIC_JD = `Senior Data Engineer
Acme Analytics is hiring a Senior Data Engineer to build our streaming platform.
What you'll do
• Design and build data pipelines with Airflow and dbt
• Operate Kafka streaming infrastructure on Kubernetes
• Model data in Snowflake for analytics teams
Requirements
• 5+ years of experience building data pipelines
• Strong Python and SQL skills (required)
• Experience with Kafka or Kinesis
• Hands-on Kubernetes in production
• Bachelor's degree in Computer Science or related field
Nice to have
• AWS certification
• Experience with Terraform`;

export interface SmokeEvalResult {
  eval_run_id: string;
  passed: boolean;
  metrics: Record<string, number | string | boolean>;
  models: string[];
  failures: string[];
}

export async function runSmokeEval(sql: Sql, ai: AiRuntime, routing: RoutingConfig, label: string): Promise<SmokeEvalResult> {
  await ai.refresh(true);
  const logs: AiRequestLog[] = [];
  const router = new AIRouter({ routing, models: ai.modelList(), providerFor: (m, c) => ai.providerFor(m, c), onLog: (l) => void logs.push(l) });
  const svc = new ResumeAIService(router);
  const failures: string[] = [];
  const t0 = Date.now();

  const a = await svc.analyzeJob(SYNTHETIC_JD, { title: 'Senior Data Engineer', company: 'Acme Analytics' });
  const { dropped } = validateAnalysisQuotes(a.analysis, SYNTHETIC_JD);
  if (a.model === 'deterministic') failures.push('jd_extract fell back to the deterministic analyzer');
  if (a.analysis.requirements.length < 8) failures.push(`jd_extract found ${a.analysis.requirements.length} requirements (expected ≥ 8)`);
  if (dropped.length) failures.push(`${dropped.length} requirement quotes were not verbatim`);

  const lines = toPlainText(sampleResume()).split('\n').filter(Boolean).map((text, i) => ({ span_id: `s_eval_1_${i + 1}`, text, page: 1, style: {}, hidden: false, region: 'body' as const }));
  const s = await svc.structureResume(lines, { resumeId: 'eval', versionId: 'eval' });
  const employers = s.resume.experience.map((r) => r.employer.value);
  if (s.prompt_version === 'heuristic@v1') failures.push('resume_extract fell back to the heuristic structurer');
  if (!(employers.includes('Globex') && employers.includes('Initech'))) failures.push(`resume_extract recovered employers [${employers.join(', ')}]`);
  if (s.dropped.length) failures.push(`${s.dropped.length} resume values failed span fidelity`);

  const { resume, claims } = extractClaims(sampleResume());
  const before = scoreResume({ analysis: a.analysis, resume, claims });
  const opt = await svc.optimize(
    { resume: toOptResume(resume), claims: toClaimLite(claims), targets: { req_ids: selectTargets(before), edit_budget: { bullets: 8, summary: true, skills_order: true } }, options: { tone: 'concise', locale: 'en-US' } },
    a.analysis,
  );
  // Post-gate fabrication check: every returned change must pass the deterministic gates again (it must, by
  // construction) and must never contain AWS (no evidence in the synthetic resume).
  const fabricated = [...opt.result.bullets.map((b) => b.text), opt.result.summary?.text ?? ''].filter((t) => /\bAWS\b|Amazon Web Services/.test(t)).length;
  if (fabricated) failures.push(`${fabricated} returned changes mention AWS (no evidence)`);

  const schemaFails = logs.filter((l) => l.outcome === 'schema_fail' || l.outcome === 'truncated').length;
  const calls = logs.length;
  const metrics = {
    suite: 'smoke@v1',
    label,
    requirements: a.analysis.requirements.length,
    quote_drops: dropped.length,
    span_fidelity: s.dropped.length === 0 ? 1 : 0,
    changes: opt.result.bullets.length,
    reverted: opt.result.reverted.length,
    fabricated_post_gate: fabricated,
    schema_fail_rate: calls ? schemaFails / calls : 0,
    cost_usd: Math.round(logs.reduce((x, l) => x + l.cost_usd, 0) * 1e6) / 1e6,
    duration_ms: Date.now() - t0,
  };
  if (metrics.schema_fail_rate > 0.01) failures.push(`schema failure rate ${(metrics.schema_fail_rate * 100).toFixed(1)}% > 1%`);
  const models = [...new Set(logs.map((l) => l.model_id))];
  const passed = failures.length === 0;
  const id = uuidv7();
  await sql`INSERT INTO eval_runs (id, suite, git_sha, prompt_versions, models, metrics, passed)
            VALUES (${id}, 'smoke@v1', ${process.env.GIT_SHA ?? 'local'}, ${sql.json([...new Set(logs.map((l) => l.prompt_version))])}, ${sql.json(models)}, ${sql.json({ ...metrics, failures } as never)}, ${passed})`;
  return { eval_run_id: id, passed, metrics, models, failures };
}
