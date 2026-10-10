import { z } from 'zod';

// ── ExtractedJob (architecture.md §4.5) ──────────────────────────────────────────────
export const ExtractionLayer = z.enum(['L1', 'L2', 'L3', 'L4', 'L5']);
export type ExtractionLayer = z.infer<typeof ExtractionLayer>;

export const Salary = z.object({
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
  currency: z.string().max(8).optional(),
  interval: z.enum(['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR']).optional(),
  stated: z.boolean().default(true),
});
export type Salary = z.infer<typeof Salary>;

export const ExtractedJob = z.object({
  source: z.object({
    url: z.string().max(2048).optional(),
    host: z.string().max(255).optional(),
    adapter: z.string().max(64).default('generic'),
    layers_used: z.array(ExtractionLayer).default([]),
    extracted_at: z.string(),
    confidence: z.number().min(0).max(1),
  }),
  fields: z.object({
    title: z.string().max(300).optional(),
    company: z.string().max(300).optional(),
    location: z.array(z.string().max(200)).max(20).default([]),
    employment_type: z.string().max(64).optional(),
    salary: Salary.optional(),
    date_posted: z.string().max(64).optional(),
  }),
  description_text: z.string().max(200_000),
  sections: z.array(z.object({ heading: z.string(), start: z.number().int(), end: z.number().int() })).default([]),
  warnings: z.array(z.string()).default([]),
  jd_hash: z.string(),
});
export type ExtractedJob = z.infer<typeof ExtractedJob>;

// ── JobAnalysis (jd_extract@v1 output; api-design.md §6.4) ───────────────────────────
export const RequirementType = z.enum([
  'must',
  'preferred',
  'responsibility',
  'education',
  'certification',
  'experience',
  'location',
  'other',
]);
export type RequirementType = z.infer<typeof RequirementType>;

export const Requirement = z.object({
  req_id: z.string().regex(/^req_[A-Za-z0-9_]+$/),
  type: RequirementType,
  /** true when the JD says "required"/"must" (used by the hard-missing gate, architecture.md §7.4) */
  hard: z.boolean().default(false),
  text: z.string().min(1).max(600),
  skills: z.array(z.string().max(80)).max(12).default([]),
  years_min: z.number().min(0).max(40).optional(),
  years_max: z.number().min(0).max(50).optional(),
  /** Verbatim quote; MUST be a substring of the JD description text (validated by code). */
  quote: z.string().min(1).max(800),
  section: z.string().max(120).optional(),
});
export type Requirement = z.infer<typeof Requirement>;

export const WorkMode = z.enum(['remote', 'hybrid', 'onsite', 'unknown']);

export const JobAnalysis = z.object({
  schema_version: z.literal('1.0'),
  title: z.string().max(300).default(''),
  company: z.string().max(300).default(''),
  location: z.array(z.string().max(200)).default([]),
  work_mode: WorkMode.default('unknown'),
  employment_type: z.string().max(64).optional(),
  salary: Salary.optional(),
  requirements: z.array(Requirement).max(120),
  keywords: z.array(z.string().max(80)).max(25).default([]),
  flags: z
    .object({ injection_suspected: z.boolean().default(false), truncated: z.boolean().default(false) })
    .default({ injection_suspected: false, truncated: false }),
  /** JD extraction quality q_jd ∈ [0,1] used by the confidence formula (architecture.md §7.7). */
  quality: z.number().min(0).max(1).default(0.8),
  prompt_version: z.string().default('deterministic@v1'),
});
export type JobAnalysis = z.infer<typeof JobAnalysis>;
