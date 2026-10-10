import type { JobAnalysis, Requirement, RequirementType, Salary } from '@jmo/shared';
import { normalizeWhitespace } from '@jmo/shared';
import { degreeLevel, findSkills } from '@jmo/taxonomy';
import { JD_HEADINGS } from './generic';

// Deterministic JD analysis: the local-mode path and the no-key fallback for jd_extract@v1.
// Every requirement's `quote` is a verbatim substring of the description text.

type SectionKind = 'must' | 'preferred' | 'responsibility' | 'skip' | 'neutral';

function sectionKind(heading: string): SectionKind {
  const h = heading.toLowerCase();
  if (/benefit|perk|compensation|what we offer|about us|about (the )?company|equal opportunity|eeo|salary/.test(h)) return 'skip';
  if (/nice[- ]to[- ]have|preferred|bonus|plus(es)?\b|desired/.test(h)) return 'preferred';
  if (/responsibil|what you('|’)ll do|what you will do|your impact|day[- ]to[- ]day|duties|the role|role overview|in this role/.test(h)) return 'responsibility';
  if (/requirement|qualification|what you('|’)ll bring|looking for|who you are|you (have|bring)|must[- ]have|skills|experience|education/.test(h)) return 'must';
  if (/about (the )?(role|job|position|team|you)|overview|job description|description/.test(h)) return 'neutral';
  return 'neutral';
}

const INJECTION = /(ignore (all |any )?(previous|prior|above) (instructions|prompts)|disregard (the|all) (above|previous)|system prompt|you are (chatgpt|an ai|a language model)|assistant\s*:|### ?instruction|<\s*\/?\s*system\s*>|score (this|the) (resume|candidate) (as )?100)/i;
const YEARS = /(\d{1,2})\s*(?:\+|plus)?\s*(?:-|–|to)?\s*(\d{1,2})?\s*\+?\s*(?:years?|yrs?)/i;
const PREFERRED_HINT = /\b(preferred|a plus|nice to have|bonus|ideally|desirable|advantageous|is a plus|are a plus)\b/i;
const HARD_HINT = /\b(required|must|minimum|mandatory|essential)\b/i;
const CERT_HINT = /\b(certif(ied|ication|icate)|license[d]?|licence[d]?)\b/i;
const LOCATION_HINT = /\b(authori[sz]ed to work|work authori[sz]ation|visa|sponsorship|relocat|must (be )?(located|based|reside)|on-?site in|security clearance|clearance)\b/i;
const EDU_HINT = /\b(bachelor|master|phd|doctorate|degree|b\.?s\.?c?|m\.?s\.?c?|mba|diploma)\b/i;

function isHeading(line: string): boolean {
  const clean = line.replace(/[:：]$/, '').trim();
  if (!clean || clean.length > 60) return false;
  if (JD_HEADINGS.test(clean)) return true;
  return /[:：]$/.test(line.trim()) && clean.split(/\s+/).length <= 6;
}

function detectWorkMode(text: string, locations: string[]): JobAnalysis['work_mode'] {
  const t = `${locations.join(' ')} ${text}`.toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\b(fully remote|remote[- ]first|100% remote|remote\b)/.test(t)) return 'remote';
  if (/\b(on-?site|in[- ]office|in the office)\b/.test(t)) return 'onsite';
  return 'unknown';
}

const SALARY_RE = /([$€£₹])\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK])\s*(?:-|–|to)\s*[$€£₹]?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK])/;
const CURRENCY: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };

function parseSalary(text: string): Salary | undefined {
  const m = text.match(SALARY_RE);
  if (!m) return undefined;
  const num = (s: string) => (/k$/i.test(s.trim()) ? Number(s.replace(/[^\d.]/g, '')) * 1000 : Number(s.replace(/[^\d.]/g, '')));
  const min = num(m[2]!);
  const max = num(m[3]!);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1000) return undefined;
  return { min, max, currency: CURRENCY[m[1]!] ?? 'USD', interval: 'YEAR', stated: true };
}

export interface AnalyzeHints {
  title?: string;
  company?: string;
  location?: string[];
  employment_type?: string;
  salary?: Salary;
  structured?: boolean;
  truncated?: boolean;
}

export function analyzeJobText(descriptionText: string, hints: AnalyzeHints = {}): JobAnalysis {
  const text = normalizeWhitespace(descriptionText);
  const lines = text.split('\n');
  const requirements: Requirement[] = [];
  let kind: SectionKind = 'neutral';
  let heading = '';
  let injection = false;
  let n = 0;
  let sectionsFound = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (INJECTION.test(line)) {
      injection = true;
      continue;
    }
    if (isHeading(line)) {
      heading = line.replace(/[:：]$/, '');
      kind = sectionKind(heading);
      sectionsFound++;
      continue;
    }
    if (kind === 'skip') continue;
    const isBullet = /^[•▪◦\-–*·●]\s*/.test(line) || /^\d+[.)]\s+/.test(line);
    const content = line.replace(/^[•▪◦\-–*·●]\s*|^\d+[.)]\s+/, '').trim();
    if (content.length < 8 || content.length > 600) continue;
    // Outside known sections, only bullets and lines with years/skills/degree count.
    const skills = findSkills(content).map((h) => h.skill.canonical);
    const years = content.match(YEARS);
    if (kind === 'neutral' && !isBullet && !years && !EDU_HINT.test(content)) continue;
    if (kind === 'neutral' && !skills.length && !years && !EDU_HINT.test(content) && !CERT_HINT.test(content)) continue;

    let type: RequirementType = kind === 'responsibility' ? 'responsibility' : kind === 'preferred' ? 'preferred' : 'must';
    if (type === 'must' && PREFERRED_HINT.test(content)) type = 'preferred';
    if (type !== 'responsibility') {
      if (LOCATION_HINT.test(content)) type = 'location';
      else if (CERT_HINT.test(content) && !years) type = 'certification';
      else if (EDU_HINT.test(content) && degreeLevel(content) > 0 && !years) type = 'education';
    }
    const req: Requirement = {
      req_id: `req_${++n}`,
      type,
      hard: type === 'must' && (HARD_HINT.test(content) || /required|minimum|basic/i.test(heading)),
      text: content.slice(0, 600),
      skills: [...new Set(skills)].slice(0, 12),
      quote: content,
      ...(heading ? { section: heading.slice(0, 120) } : {}),
    };
    if (years && type !== 'responsibility' && type !== 'education') {
      const a = Number(years[1]);
      const b = years[2] ? Number(years[2]) : undefined;
      if (a > 0 && a <= 40) {
        req.years_min = b && b > a ? a : a;
        if (b && b > a) req.years_max = b;
      }
    }
    requirements.push(req);
    if (requirements.length >= 60) break;
  }

  // Keywords: skills ranked by frequency, requirement sections counting double (≤ 25).
  const counts = new Map<string, number>();
  for (const h of findSkills(text)) counts.set(h.skill.canonical, (counts.get(h.skill.canonical) ?? 0) + 1);
  for (const r of requirements) for (const s of r.skills) counts.set(s, (counts.get(s) ?? 0) + (r.type === 'must' ? 2 : 1));
  const keywords = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k]) => k);

  const title = hints.title ?? lines.find((l) => l.trim() && !isHeading(l) && l.length < 90)?.trim() ?? '';
  const location = hints.location ?? [];
  const quality = Math.min(1, 0.45 + (hints.structured ? 0.2 : 0) + (sectionsFound >= 2 ? 0.2 : sectionsFound ? 0.1 : 0) + (requirements.length >= 5 ? 0.1 : 0) - (injection ? 0.1 : 0));
  const salary = hints.salary ?? parseSalary(text);

  return {
    schema_version: '1.0',
    title: title.slice(0, 300),
    company: (hints.company ?? '').slice(0, 300),
    location,
    work_mode: detectWorkMode(text, location),
    ...(hints.employment_type ? { employment_type: hints.employment_type } : {}),
    ...(salary ? { salary } : {}),
    requirements,
    keywords,
    flags: { injection_suspected: injection, truncated: !!hints.truncated },
    quality: Math.round(quality * 100) / 100,
    prompt_version: 'deterministic@v1',
  };
}

/** Drops requirements whose quote is not a verbatim substring of the JD (architecture.md §4.6). */
export function validateAnalysisQuotes(analysis: JobAnalysis, descriptionText: string): { analysis: JobAnalysis; dropped: string[] } {
  const norm = (s: string) => normalizeWhitespace(s).replace(/\s+/g, ' ').toLowerCase();
  const hay = norm(descriptionText);
  const dropped: string[] = [];
  const requirements = analysis.requirements.filter((r) => {
    const ok = r.quote.trim().length > 0 && hay.includes(norm(r.quote));
    if (!ok) dropped.push(r.req_id);
    return ok;
  });
  return { analysis: { ...analysis, requirements }, dropped };
}
