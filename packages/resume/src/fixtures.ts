import type { CanonicalResume } from '@jmo/shared';
import { field } from '@jmo/shared';

/** Synthetic resume used by tests, evals and the E2E demo (no real person). */
export function sampleResume(): CanonicalResume {
  const b = (id: string, text: string) => ({ bullet_id: id, text, prov: { span_ids: [], source: 'parser' as const }, claim_ids: [] });
  return {
    schema_version: '1.0',
    resume_id: 'res_demo',
    version_id: 'v1',
    locale: 'en-US',
    source_documents: [],
    personal: {
      full_name: field('Asha Rao'),
      headline: field('Data Engineer'),
      emails: [field('asha.rao@example.com')],
      phones: [field('+1 416 555 0134')],
      location: field('Toronto, ON, Canada'),
      links: [field({ network: 'linkedin' as const, url: 'linkedin.com/in/asha-rao-demo' })],
    },
    summary: { ...field('Data engineer with 5 years building data pipelines and analytics platforms.'), summary_id: 'sum_1' },
    experience: [
      {
        role_id: 'role_1',
        employer: field('Globex'),
        title: field('Data Engineer'),
        location: field('Toronto, ON'),
        start: field('2021-03'),
        end: field('present'),
        date_precision: 'month',
        bullets: [
          b('role_1.b_1', 'Built Kafka-based pipeline processing 2M events/day'),
          b('role_1.b_2', 'Deployed services to k8s with Helm and Terraform'),
          b('role_1.b_3', 'Wrote Airflow DAGs orchestrating Python and SQL transformations'),
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
        bullets: [b('role_2.b_1', 'Built dashboards in Tableau for the finance team'), b('role_2.b_2', 'Automated weekly reporting with SQL, saving 6 hours per week')],
        technologies: [],
      },
    ],
    education: [{ education_id: 'edu_1', institution: field('University of Toronto'), degree: field('B.Sc.'), field_of_study: field('Computer Science'), start: field('2014'), end: field('2018'), honors: [] }],
    skills: ['Python', 'SQL', 'Snowflake', 'dbt', 'Kafka', 'Airflow', 'Tableau'].map((n, i) => ({
      skill_id: `sk_${i + 1}`,
      name: field(n),
      normalized: { canonical: n, aliases: [] },
      evidence_level: 'listed_only' as const,
      claim_ids: [],
    })),
    projects: [],
    certifications: [{ cert_id: 'cert_1', name: field('Google Data Analytics Certificate'), issuer: field('Coursera'), date: field('2019-06') }],
    awards: [],
    publications: [],
    volunteering: [],
    languages: [],
    additional_sections: [],
    parse_quality: { score: 1, warnings: [], columns_detected: false, hidden_text_found: false, contact_in_header_only: false, tables_or_textboxes: false, text_extractable: true },
  };
}
