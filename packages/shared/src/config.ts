import { z } from 'zod';

// Public, signed, flat config served by GET /v1/config (api-design.md §6.1). Data only — no code (MV3 rule).

export const ExtractorAdapter = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  hosts: z.array(z.string().max(255)).max(20),
  selectors: z
    .object({
      title: z.string().max(300).optional(),
      company: z.string().max(300).optional(),
      location: z.string().max(300).optional(),
      description: z.string().max(300).optional(),
    })
    .default({}),
  layers: z.array(z.enum(['L1', 'L2', 'L3'])).default(['L1', 'L3']),
  enabled: z.boolean().default(true),
});
export type ExtractorAdapter = z.infer<typeof ExtractorAdapter>;

export const Announcement = z.object({
  id: z.string(),
  text: z.string().max(280),
  plans: z.array(z.string()).default(['all']),
  until: z.string().optional(),
});

export const PublicConfig = z.object({
  version: z.number().int(),
  config_snapshot: z.string(),
  min_extension_version: z.string(),
  scoring_version: z.string(),
  kill_switches: z.object({ hosted_ai: z.boolean(), checkout: z.boolean(), coupons: z.boolean() }),
  announcements: z.array(Announcement).default([]),
  features: z.record(z.string(), z.boolean()),
  extractors: z.array(ExtractorAdapter).default([]),
  limits: z.object({ jd_max_chars: z.number().int(), resume_max_pages: z.number().int() }),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

export const SignedConfig = z.object({ config: PublicConfig, signature: z.string(), key_id: z.string() });
export type SignedConfig = z.infer<typeof SignedConfig>;
