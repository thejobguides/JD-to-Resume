import { extractClaims } from '@jmo/evidence';
import { type CanonicalResume, field, type JobAnalysis } from '@jmo/shared';
import { describe, expect, it } from 'vitest';
import { aggregate, confidence, gaps, scoreAfter, scoreResume, selectTargets, type ScoredItem } from './index';

const s = (state: ScoredItem['state'], weight = 1, hardMust = false): ScoredItem => ({ state, weight, hardMust });

describe('formula — worked example (architecture.md §7.8)', () => {
  it('reproduces score 69 and High confidence', () => {
    const agg = aggregate([
      { key: 'required', items: [s('strong'), s('strong'), s('strong'), s('partial'), s('partial'), s('none', 1, true)] },
      { key: 'experience', items: [s('strong')] },
      { key: 'responsibilities', items: [s('strong', 0.8), s('strong', 0.8), s('partial', 0.8), s('partial', 0.8), s('weak', 0.8)] },
      { key: 'preferred', items: [s('strong', 0.5), s('none', 0.5), s('none', 0.5), s('partial', 0.5)] },
      { key: 'title', value: 0.6 },
      { key: 'keywords', value: Math.min(1, 12 / 18 / 0.8) },
      { key: 'education', items: [s('strong')] },
      { key: 'certifications', items: [] },
      { key: 'structure', value: 7 / 8 },
    ]);
    expect(agg.base).toBeCloseTo(74.2, 0);
    expect(agg.gate).toBeCloseTo(0.93, 5);
    expect(agg.score).toBe(69);
    expect(agg.categories.map((c) => c.key)).not.toContain('certifications');
    const conf = confidence({ qJd: 0.95, qResume: 0.9, u: 0.05, d: 0.7 });
    expect(conf.value).toBeCloseTo(0.9, 3);
    expect(conf.label).toBe('High');
  });

  it('gate floors at 0.60', () => {
    const agg = aggregate([{ key: 'required', items: Array.from({ length: 10 }, () => s('none', 1, true)) }]);
    expect(agg.gate).toBe(0.6);
  });
});

function resumeFixture(): CanonicalResume {
  return {
    schema_version: '1.0',
    resume_id: 'r1',
    version_id: 'v1',
    locale: 'en-US',
    source_documents: [],
    personal: { full_name: field('Asha Rao'), emails: [field('asha@example.com')], phones: [], links: [], location: field('Toronto, ON, Canada') },
    summary: { ...field('Data engineer with 5 years building data pipelines.'), summary_id: 'sum_1' },
    experience: [
      {
        role_id: 'role_1',
        employer: field('Globex'),
        title: field('Data Engineer'),
        start: field('2021-03'),
        end: field('present'),
        date_precision: 'month',
        bullets: [
          { bullet_id: 'role_1.b_1', text: 'Built Kafka-based pipeline processing 2M events/day', prov: { span_ids: ['s1'], source: 'parser' }, claim_ids: [] },
          { bullet_id: 'role_1.b_2', text: 'Deployed services to k8s with Helm and Terraform', prov: { span_ids: ['s2'], source: 'parser' }, claim_ids: [] },
          { bullet_id: 'role_1.b_3', text: 'Wrote Airflow DAGs orchestrating Python and SQL transformations', prov: { span_ids: ['s3'], source: 'parser' }, claim_ids: [] },
        ],
        technologies: [],
      },
      {
        role_id: 'role_2',
        employer: field('Initech'),
        title: field('Data Analyst'),
        start: field('2019-01'),
        end: field('2021-02'),
        date_precision: 'month',
        bullets: [{ bullet_id: 'role_2.b_1', text: 'Built dashboards in Tableau for the finance team', prov: { span_ids: ['s4'], source: 'parser' }, claim_ids: [] }],
        technologies: [],
      },
    ],
    education: [{ education_id: 'e1', institution: field('University of Toronto'), degree: field('B.Sc.'), field_of_study: field('Computer Science'), honors: [] }],
    skills: ['Python', 'SQL', 'Snowflake', 'dbt', 'Kafka'].map((n, i) => ({ skill_id: `sk_${i}`, name: field(n), normalized: { canonical: n, aliases: [] }, evidence_level: 'listed_only' as const, claim_ids: [] })),
    projects: [],
    certifications: [],
    awards: [],
    publications: [],
    volunteering: [],
    languages: [],
    additional_sections: [],
    parse_quality: { score: 0.9, warnings: [], columns_detected: false, hidden_text_found: false, contact_in_header_only: false, tables_or_textboxes: false, text_extractable: true },
  };
}

const analysis: JobAnalysis = {
  schema_version: '1.0',
  title: 'Senior Data Engineer',
  company: 'Acme',
  location: ['Remote (Canada)'],
  work_mode: 'remote',
  requirements: [
    { req_id: 'req_1', type: 'experience', hard: true, text: '5+ years building data pipelines', skills: [], years_min: 5, quote: '5+ years building data pipelines' },
    { req_id: 'req_2', type: 'must', hard: false, text: 'Kafka or Kinesis', skills: ['Kafka', 'Kinesis'], quote: 'experience with Kafka or Kinesis' },
    { req_id: 'req_3', type: 'must', hard: true, text: 'Kubernetes in production', skills: ['Kubernetes'], quote: 'Kubernetes in production' },
    { req_id: 'req_4', type: 'must', hard: true, text: 'Snowflake', skills: ['Snowflake'], quote: 'Snowflake' },
    { req_id: 'req_5', type: 'must', hard: true, text: 'AWS', skills: ['AWS'], quote: 'AWS' },
    { req_id: 'req_6', type: 'preferred', hard: false, text: 'dbt', skills: ['dbt'], quote: 'dbt a plus' },
    { req_id: 'req_7', type: 'responsibility', hard: false, text: 'Build and orchestrate data pipelines with Airflow', skills: [], quote: 'Build and orchestrate data pipelines with Airflow' },
    { req_id: 'req_8', type: 'education', hard: false, text: "Bachelor's in Computer Science or related field", skills: [], quote: "Bachelor's in Computer Science or related field" },
  ],
  keywords: ['Kafka', 'Airflow', 'dbt', 'Snowflake', 'Python', 'SQL', 'Kubernetes', 'AWS'],
  flags: { injection_suspected: false, truncated: false },
  quality: 0.9,
  prompt_version: 'test',
};

describe('engine', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  const { resume, claims } = extractClaims(resumeFixture());
  const result = scoreResume({ analysis, resume, claims, now });
  const byId = Object.fromEntries(result.requirements.map((r) => [r.req_id, r]));

  it('classifies requirement states from evidence', () => {
    expect(byId.req_2!.state).toBe('strong'); // Kafka demonstrated
    expect(byId.req_3!.state).toBe('strong'); // k8s alias
    expect(byId.req_3!.decided_by).toBe('alias');
    expect(byId.req_3!.not_surfaced).toBe(true);
    expect(byId.req_4!.state).toBe('partial'); // Snowflake listed only
    expect(byId.req_4!.not_surfaced).toBe(true);
    expect(byId.req_5!.state).toBe('none'); // AWS absent
    expect(byId.req_1!.state).toBe('strong'); // 7.6 years total ≥ 5
    expect(byId.req_8!.state).toBe('strong');
  });

  it('is deterministic and within bounds', () => {
    const again = scoreResume({ analysis, resume, claims, now });
    expect(again.score).toBe(result.score);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.range[0]).toBeLessThanOrEqual(result.score);
    expect(result.range[1]).toBeGreaterThanOrEqual(result.score);
    expect(result.ceiling).toBeGreaterThanOrEqual(result.score);
    expect(result.eligibility[0]?.status).toBe('match');
  });

  it('lists gaps and optimization targets', () => {
    const g = gaps(result);
    expect(g.missing.map((r) => r.req_id)).toContain('req_5');
    expect(g.not_surfaced.map((r) => r.req_id)).toEqual(expect.arrayContaining(['req_3', 'req_4']));
    expect(selectTargets(result)).toEqual(expect.arrayContaining(['req_3', 'req_4']));
  });

  it('after-score rises by surfacing evidence but never exceeds the ceiling', () => {
    const optimized = resumeFixture();
    optimized.experience[0]!.bullets[1]!.text = 'Deployed services to Kubernetes with Helm and Terraform';
    optimized.experience[0]!.bullets[2]!.text = 'Built Airflow DAGs orchestrating Python, SQL and dbt transformations in Snowflake';
    const ex = extractClaims(optimized);
    const after = scoreAfter(result, { analysis, resume: ex.resume, claims: ex.claims, now });
    expect(after.score).toBeGreaterThanOrEqual(result.score);
    expect(after.score).toBeLessThanOrEqual(result.ceiling);
    // AWS stays missing: cannot be improved without evidence.
    expect(after.requirements.find((r) => r.req_id === 'req_5')!.state).toBe('none');
  });

  it('does not credit fabricated evidence beyond the ceiling', () => {
    const fabricated = resumeFixture();
    fabricated.experience[0]!.bullets.push({ bullet_id: 'role_1.b_9', text: 'Architected AWS platform', prov: { span_ids: [], source: 'parser' }, claim_ids: [] });
    const ex = extractClaims(fabricated);
    const after = scoreAfter(result, { analysis, resume: ex.resume, claims: ex.claims, now });
    expect(after.requirements.find((r) => r.req_id === 'req_5')!.state).toBe('none');
    expect(after.score).toBeLessThanOrEqual(result.ceiling);
  });
});
