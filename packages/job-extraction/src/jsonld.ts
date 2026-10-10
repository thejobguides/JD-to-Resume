import type { Salary } from '@jmo/shared';

// L1 structured data: JSON-LD JobPosting and microdata (architecture.md §4.2).

export interface StructuredJob {
  title?: string;
  company?: string;
  location: string[];
  employment_type?: string;
  salary?: Salary;
  description_html?: string;
  date_posted?: string;
  valid_through?: string;
  closed?: boolean;
}

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function findJobPosting(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findJobPosting(n);
      if (f) return f;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const type = asArray(obj['@type'] as string | string[]).map(String);
  if (type.some((t) => t.toLowerCase() === 'jobposting')) return obj;
  if (obj['@graph']) return findJobPosting(obj['@graph']);
  return null;
}

function locationToString(loc: unknown): string | null {
  if (!loc || typeof loc !== 'object') return typeof loc === 'string' ? loc : null;
  const l = loc as Record<string, unknown>;
  const addr = (l.address ?? l) as Record<string, unknown>;
  if (typeof addr === 'string') return addr;
  const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry && typeof addr.addressCountry === 'object' ? (addr.addressCountry as Record<string, unknown>).name : addr.addressCountry]
    .filter((x) => typeof x === 'string' && x.trim())
    .map(String);
  if (!parts.length && typeof l.name === 'string' && l.name.trim()) return l.name.trim();
  return parts.length ? parts.join(', ') : null;
}

export function parseJobPostingJsonLd(scriptTexts: string[], now: Date = new Date()): StructuredJob | null {
  for (const raw of scriptTexts) {
    let data: unknown;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const jp = findJobPosting(data);
    if (!jp) continue;
    const org = jp.hiringOrganization as Record<string, unknown> | string | undefined;
    const locations = asArray(jp.jobLocation as unknown).map(locationToString).filter((x): x is string => !!x);
    const remote = String(jp.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE';
    if (remote) {
      const req = asArray(jp.applicantLocationRequirements as unknown).map(locationToString).filter(Boolean);
      locations.unshift(req.length ? `Remote (${req.join(', ')})` : 'Remote');
    }
    let salary: Salary | undefined;
    const bs = jp.baseSalary as Record<string, unknown> | undefined;
    if (bs && typeof bs === 'object') {
      const v = (bs.value ?? {}) as Record<string, unknown>;
      const min = Number(v.minValue ?? v.value);
      const max = Number(v.maxValue ?? v.value);
      const unit = String(v.unitText ?? '').toUpperCase();
      salary = {
        ...(Number.isFinite(min) ? { min } : {}),
        ...(Number.isFinite(max) ? { max } : {}),
        ...(typeof bs.currency === 'string' ? { currency: bs.currency } : {}),
        ...(['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'].includes(unit) ? { interval: unit as Salary['interval'] } : {}),
        stated: true,
      };
    }
    const validThrough = typeof jp.validThrough === 'string' ? jp.validThrough : undefined;
    return {
      ...(typeof jp.title === 'string' ? { title: jp.title.trim() } : {}),
      ...(typeof org === 'string' ? { company: org } : org && typeof org.name === 'string' ? { company: org.name.trim() } : {}),
      location: locations,
      ...(jp.employmentType ? { employment_type: asArray(jp.employmentType as string).join(', ') } : {}),
      ...(salary ? { salary } : {}),
      ...(typeof jp.description === 'string' ? { description_html: jp.description } : {}),
      ...(typeof jp.datePosted === 'string' ? { date_posted: jp.datePosted } : {}),
      ...(validThrough ? { valid_through: validThrough, closed: new Date(validThrough).getTime() < now.getTime() } : {}),
    };
  }
  return null;
}

/** Microdata itemtype=schema.org/JobPosting (SmartRecruiters). */
export function parseJobPostingMicrodata(doc: Document): StructuredJob | null {
  const root = doc.querySelector('[itemtype*="schema.org/JobPosting" i]');
  if (!root) return null;
  const prop = (name: string) => {
    const el = root.querySelector(`[itemprop="${name}"]`);
    if (!el) return undefined;
    return (el.getAttribute('content') ?? el.textContent ?? '').trim() || undefined;
  };
  const descEl = root.querySelector('[itemprop="description"]');
  const title = prop('title');
  const company = root.querySelector('[itemprop="hiringOrganization"] [itemprop="name"]')?.textContent?.trim() ?? prop('hiringOrganization');
  const loc = root.querySelector('[itemprop="jobLocation"]')?.textContent?.replace(/\s+/g, ' ').trim();
  return {
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    location: loc ? [loc] : [],
    ...(descEl ? { description_html: descEl.innerHTML } : {}),
  };
}
