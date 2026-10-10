import { z } from 'zod';

// Canonical resume schema (architecture.md §5.4) — a superset of JSON Resume with IDs and provenance.

export const SpanLine = z.object({
  span_id: z.string().max(64),
  text: z.string().max(2000),
  page: z.number().int().min(0).default(1),
  line: z.number().int().min(0).optional(),
  style: z
    .object({
      size: z.number().optional(),
      bold: z.boolean().optional(),
      caps: z.boolean().optional(),
      indent: z.number().optional(),
      column: z.enum(['main', 'sidebar']).optional(),
    })
    .default({}),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  hidden: z.boolean().default(false),
  region: z.enum(['body', 'header', 'footer', 'textbox']).default('body'),
});
export type SpanLine = z.infer<typeof SpanLine>;

export const ProvenanceSource = z.enum(['parser', 'user_edit', 'user_attested', 'linkedin_export', 'llm']);
export const Provenance = z.object({
  span_ids: z.array(z.string()).default([]),
  source: ProvenanceSource.default('parser'),
});
export type Provenance = z.infer<typeof Provenance>;

export function fieldOf<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    prov: Provenance.default({ span_ids: [], source: 'parser' }),
    confidence: z.number().min(0).max(1).default(1),
    user_confirmed: z.boolean().default(false),
  });
}

export const StrField = fieldOf(z.string());
export type StrField = z.infer<typeof StrField>;

export const Bullet = z.object({
  bullet_id: z.string(),
  text: z.string().max(1200),
  prov: Provenance.default({ span_ids: [], source: 'parser' }),
  claim_ids: z.array(z.string()).default([]),
});
export type Bullet = z.infer<typeof Bullet>;

export const Role = z.object({
  role_id: z.string(),
  employer: StrField,
  title: StrField,
  location: StrField.optional(),
  employment_type: StrField.optional(),
  start: StrField.optional(),
  end: StrField.optional(), // ISO partial ("2021", "2021-03") or "present"
  date_precision: z.enum(['year', 'month', 'day']).default('month'),
  bullets: z.array(Bullet).default([]),
  technologies: z.array(z.object({ skill_id: z.string() })).default([]),
});
export type Role = z.infer<typeof Role>;

export const Education = z.object({
  education_id: z.string(),
  institution: StrField,
  degree: StrField.optional(),
  field_of_study: StrField.optional(),
  start: StrField.optional(),
  end: StrField.optional(),
  gpa: StrField.optional(),
  honors: z.array(StrField).default([]),
});
export type Education = z.infer<typeof Education>;

export const SkillCategory = z.enum(['language', 'framework', 'tool', 'platform', 'database', 'cloud', 'domain', 'soft', 'other']);

export const Skill = z.object({
  skill_id: z.string(),
  name: StrField,
  normalized: z.object({
    canonical: z.string(),
    taxonomy_id: z.string().optional(),
    aliases: z.array(z.string()).default([]),
  }),
  category: SkillCategory.optional(),
  evidence_level: z.enum(['demonstrated', 'listed_only']).default('listed_only'),
  claim_ids: z.array(z.string()).default([]),
});
export type Skill = z.infer<typeof Skill>;

export const Project = z.object({
  project_id: z.string(),
  name: StrField,
  role: StrField.optional(),
  start: StrField.optional(),
  end: StrField.optional(),
  url: StrField.optional(),
  bullets: z.array(Bullet).default([]),
  technologies: z.array(z.object({ skill_id: z.string() })).default([]),
});
export type Project = z.infer<typeof Project>;

export const Certification = z.object({
  cert_id: z.string(),
  name: StrField,
  issuer: StrField.optional(),
  date: StrField.optional(),
  expires: StrField.optional(),
  credential_id: StrField.optional(),
});
export type Certification = z.infer<typeof Certification>;

export const SimpleItem = z.object({
  item_id: z.string(),
  title: StrField,
  date: StrField.optional(),
  detail: StrField.optional(),
});

export const Language = z.object({ language: StrField, proficiency: StrField.optional() });

export const SourceDocument = z.object({
  doc_id: z.string(),
  kind: z.enum(['pdf', 'docx', 'txt', 'paste', 'linkedin_pdf', 'linkedin_export']),
  file_name: z.string().optional(),
  sha256: z.string(),
  pages: z.number().int().optional(),
  size_bytes: z.number().int().optional(),
  imported_at: z.string(),
});
export type SourceDocument = z.infer<typeof SourceDocument>;

export const LinkField = fieldOf(
  z.object({
    network: z.enum(['linkedin', 'github', 'portfolio', 'other']),
    url: z.string(),
    display_text: z.string().optional(),
  }),
);

export const ParseQuality = z.object({
  score: z.number().min(0).max(1),
  warnings: z.array(z.string()).default([]),
  columns_detected: z.boolean().default(false),
  hidden_text_found: z.boolean().default(false),
  contact_in_header_only: z.boolean().default(false),
  tables_or_textboxes: z.boolean().default(false),
  text_extractable: z.boolean().default(true),
});
export type ParseQuality = z.infer<typeof ParseQuality>;

export const CanonicalResume = z.object({
  schema_version: z.literal('1.0'),
  resume_id: z.string(),
  version_id: z.string(),
  locale: z.string().default('en-US'),
  source_documents: z.array(SourceDocument).default([]),
  personal: z.object({
    full_name: StrField.optional(),
    headline: StrField.optional(),
    emails: z.array(StrField).default([]),
    phones: z.array(StrField).default([]),
    location: StrField.optional(),
    links: z.array(LinkField).default([]),
    work_authorization: StrField.optional(),
  }),
  summary: StrField.extend({ summary_id: z.string() }).optional(),
  experience: z.array(Role).default([]),
  education: z.array(Education).default([]),
  skills: z.array(Skill).default([]),
  projects: z.array(Project).default([]),
  certifications: z.array(Certification).default([]),
  awards: z.array(SimpleItem).default([]),
  publications: z.array(SimpleItem).default([]),
  volunteering: z.array(Role).default([]),
  languages: z.array(Language).default([]),
  additional_sections: z.array(z.object({ heading: z.string(), items: z.array(StrField) })).default([]),
  parse_quality: ParseQuality,
});
export type CanonicalResume = z.infer<typeof CanonicalResume>;

/** Helper to build a Field value with provenance. */
export function field<T>(value: T, span_ids: string[] = [], confidence = 1, source: z.infer<typeof ProvenanceSource> = 'parser') {
  return { value, prov: { span_ids, source }, confidence, user_confirmed: false };
}
