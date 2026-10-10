import { z } from 'zod';

// Evidence Store entities (architecture.md §6.2).

export const ClaimType = z.enum([
  'skill',
  'tool',
  'metric',
  'employer',
  'title',
  'date_range',
  'responsibility',
  'achievement',
  'certification',
  'education',
  'project',
  'scope',
  'team_size',
  'domain',
  'years',
]);
export type ClaimType = z.infer<typeof ClaimType>;

export const MetricValue = z.object({ number: z.number(), unit: z.string().default(''), raw: z.string() });
export type MetricValue = z.infer<typeof MetricValue>;

export const Claim = z.object({
  claim_id: z.string(),
  type: ClaimType,
  /** Normalized value: canonical skill name, metric object, employer name, etc. */
  value: z.union([z.string(), z.number(), MetricValue]),
  raw_text: z.string(),
  span_ids: z.array(z.string()).default([]),
  role_id: z.string().optional(),
  project_id: z.string().optional(),
  bullet_id: z.string().optional(),
  /** where the evidence lives: a bullet (demonstrated), the skills list (listed), etc. */
  location: z.enum(['bullet', 'skills_list', 'summary', 'header', 'education', 'certifications', 'project']).default('bullet'),
  source: z.enum(['parser', 'user_attested']).default('parser'),
  confidence: z.number().min(0).max(1).default(1),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type Claim = z.infer<typeof Claim>;

export const UserAttestation = z.object({
  attestation_id: z.string(),
  claim_id: z.string(),
  statement: z.string().min(3).max(500),
  role_id: z.string().optional(),
  confirmed_true: z.literal(true),
  attested_at: z.string(),
});
export type UserAttestation = z.infer<typeof UserAttestation>;

/** Minimized claim sent to the server (no contact data). */
export const ClaimLite = z.object({
  claim_id: z.string(),
  type: ClaimType,
  value: z.union([z.string(), z.number(), MetricValue]),
  text: z.string().max(1200),
  role_id: z.string().optional(),
});
export type ClaimLite = z.infer<typeof ClaimLite>;
