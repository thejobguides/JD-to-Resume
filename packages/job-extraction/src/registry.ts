import type { ExtractorAdapter } from '@jmo/shared';

// L0 site detection (architecture.md §4.4). Selectors are data and can be overridden by signed remote config.

export const DEFAULT_ADAPTERS: ExtractorAdapter[] = [
  { id: 'greenhouse', hosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io'], selectors: { title: 'h1', company: '.company-name', description: '.job__description, #content' }, layers: ['L1', 'L2', 'L3'], enabled: true },
  { id: 'lever', hosts: ['jobs.lever.co'], selectors: { title: '.posting-headline h2', description: '.section-wrapper.page-full-width, .posting-page' }, layers: ['L1', 'L2', 'L3'], enabled: true },
  { id: 'ashby', hosts: ['jobs.ashbyhq.com'], selectors: {}, layers: ['L1', 'L3'], enabled: true },
  { id: 'smartrecruiters', hosts: ['jobs.smartrecruiters.com'], selectors: { description: '.job-sections' }, layers: ['L1', 'L2', 'L3'], enabled: true },
  { id: 'workday', hosts: ['*.myworkdayjobs.com'], selectors: { description: '[data-automation-id="jobPostingDescription"]' }, layers: ['L1', 'L2', 'L3'], enabled: true },
  { id: 'icims', hosts: ['*.icims.com'], selectors: { description: '.iCIMS_JobContent, #iCIMS_Content' }, layers: ['L1', 'L2', 'L3'], enabled: true },
];

/** Tier B (product-requirements.md §6): generic, user-initiated reading only; no site-specific code. */
export const TIER_B_HOSTS = [/(^|\.)linkedin\.com$/, /(^|\.)indeed\.[a-z.]+$/, /(^|\.)glassdoor\.[a-z.]+$/, /(^|\.)ziprecruiter\.com$/, /(^|\.)wellfound\.com$/, /(^|\.)naukri\.com$/];

export function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === pattern;
}

export function detectAdapter(url: string, adapters: ExtractorAdapter[] = DEFAULT_ADAPTERS): { adapter: ExtractorAdapter | null; tierB: boolean; host: string } {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { adapter: null, tierB: false, host };
  }
  const tierB = TIER_B_HOSTS.some((re) => re.test(host));
  if (tierB) return { adapter: null, tierB, host };
  const hasGh = /[?&]gh_jid=/.test(url);
  const adapter = adapters.find((a) => a.enabled && a.hosts.some((h) => hostMatches(host, h))) ?? (hasGh ? (adapters.find((a) => a.id === 'greenhouse') ?? null) : null);
  return { adapter, tierB, host };
}
