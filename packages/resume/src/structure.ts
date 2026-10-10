import { findDateRange, SINGLE_DATE_RE, parseDatePart } from '@jmo/evidence';
import type { Bullet, CanonicalResume, Certification, Education, Project, Role, Skill, SourceDocument, SpanLine } from '@jmo/shared';
import { field } from '@jmo/shared';
import { degreeLevel, findSkills, leadingVerbRank, lookupSkill, titleFamily } from '@jmo/taxonomy';
import { EMAIL_RE, type ParsedDocument, PHONE_RE } from './parse/types';

// Heuristic structurer: SpanLine[] → CanonicalResume with span provenance on every value.
// Used for local mode, as the fallback when resume_extract@v1 fails validation, and by the mock provider.

type SectionKey = 'summary' | 'experience' | 'education' | 'skills' | 'projects' | 'certifications' | 'awards' | 'publications' | 'volunteering' | 'languages' | 'other';

const SECTION_SYNONYMS: Array<[SectionKey, RegExp]> = [
  ['summary', /^(professional |career )?(summary|profile|about( me)?|objective|overview)$/i],
  ['experience', /^((professional|work|relevant|employment|career) )?(experience|history|employment)( history)?$|^work$|^employment$/i],
  ['education', /^(education|academic background|academics|education (&|and) training)$/i],
  ['skills', /^((technical|core|key) )?(skills|competencies|expertise|technologies|tech stack|tools)( (&|and) (tools|technologies))?$/i],
  ['projects', /^((selected|personal|key|academic) )?projects$/i],
  ['certifications', /^(certifications?|licen[cs]es( (&|and) certifications)?|certificates)$/i],
  ['awards', /^(awards|honou?rs|achievements|awards (&|and) honou?rs)$/i],
  ['publications', /^(publications|papers|talks)$/i],
  ['volunteering', /^(volunteer(ing)?( experience)?|community)$/i],
  ['languages', /^languages$/i],
];

const TITLE_WORDS = /\b(engineer|developer|manager|analyst|designer|scientist|intern|lead|director|consultant|specialist|architect|administrator|associate|coordinator|officer|assistant|executive|representative|head|vp|president|founder|owner|researcher|technician|writer|editor|teacher|nurse|accountant|recruiter|product|marketing|sales|support|operations)\b/i;
const BULLET_RE = /^[•▪◦\-–*·●■►➤✓]\s*/;
const LOCATION_LINE = /^([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z.]+(,\s*[A-Z][A-Za-z .]+)?|(fully )?remote( \(.+\))?|hybrid( \(.+\))?)$/i;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?(linkedin\.com\/in\/[\w-]+|github\.com\/[\w-]+|[\w-]+\.(?:dev|io|me|com|ca)\/?[\w/-]*)/i;

function sectionOf(line: SpanLine): SectionKey | null {
  const t = line.text.replace(/[:：]$/, '').trim();
  if (t.length > 45 || t.split(/\s+/).length > 5) return null;
  for (const [k, re] of SECTION_SYNONYMS) if (re.test(t)) return k;
  return null;
}

function splitHeader(text: string): string[] {
  return text
    .split(/\s+[—–|]\s+|\s+-\s+|\s{3,}|,\s+(?=[A-Z])|\s+at\s+|\s+@\s+/)
    .map((s) => s.replace(/[()]/g, '').trim())
    .filter(Boolean);
}

function looksLikeName(t: string): boolean {
  const words = t.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 5 && words.every((w) => /^[A-Z][A-Za-z'’.-]*$/.test(w)) && !TITLE_WORDS.test(t) && !sectionOf({ text: t } as SpanLine);
}

interface Block {
  key: SectionKey;
  lines: SpanLine[];
}

export interface StructureOptions {
  resumeId: string;
  versionId: string;
  source?: Omit<SourceDocument, 'doc_id'> & { doc_id?: string };
  locale?: string;
}

export function structureResume(doc: ParsedDocument, opts: StructureOptions): CanonicalResume {
  const lines = doc.lines.filter((l) => !l.hidden && l.text.trim());
  const blocks: Block[] = [];
  const preamble: SpanLine[] = [];
  let cur: Block | null = null;
  for (const l of lines) {
    const sec = sectionOf(l);
    if (sec) {
      cur = { key: sec, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (cur) cur.lines.push(l);
    else preamble.push(l);
  }

  // ── Personal (preamble + header/footer lines) ──
  const contactPool = [...preamble, ...lines.filter((l) => l.region === 'header' || l.region === 'footer')];
  const personal: CanonicalResume['personal'] = { emails: [], phones: [], links: [] };
  const nameLine = [...preamble].sort((a, b) => (b.style.size ?? 0) - (a.style.size ?? 0)).find((l) => looksLikeName(l.text)) ?? preamble.find((l) => looksLikeName(l.text));
  if (nameLine) personal.full_name = field(nameLine.text.trim(), [nameLine.span_id], 0.9);
  for (const l of contactPool) {
    const email = l.text.match(EMAIL_RE);
    if (email && !personal.emails.some((e) => e.value === email[0])) personal.emails.push(field(email[0], [l.span_id]));
    const phone = l.text.replace(EMAIL_RE, '').match(PHONE_RE);
    if (phone && phone[0].replace(/\D/g, '').length >= 9 && !personal.phones.some((p) => p.value === phone[0].trim())) personal.phones.push(field(phone[0].trim(), [l.span_id]));
    const url = l.text.match(URL_RE);
    if (url) {
      const u = url[1]!;
      const network = /linkedin/i.test(u) ? 'linkedin' : /github/i.test(u) ? 'github' : 'portfolio';
      if (!personal.links.some((x) => x.value.url === u)) personal.links.push(field({ network, url: u }, [l.span_id]));
    }
    if (!personal.location) {
      const loc = l.text.split(/\s*[|•·]\s*/).find((p) => /^[A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .]+(,\s*[A-Z][A-Za-z .]+)?$/.test(p.trim()) && !EMAIL_RE.test(p));
      if (loc) personal.location = field(loc.trim(), [l.span_id], 0.8);
    }
  }
  const headline = preamble.find((l) => l !== nameLine && TITLE_WORDS.test(l.text) && !EMAIL_RE.test(l.text) && l.text.length < 80 && !findDateRange(l.text));
  if (headline) personal.headline = field(headline.text.trim(), [headline.span_id], 0.7);

  const resume: CanonicalResume = {
    schema_version: '1.0',
    resume_id: opts.resumeId,
    version_id: opts.versionId,
    locale: opts.locale ?? 'en-US',
    source_documents: opts.source ? [{ doc_id: opts.source.doc_id ?? `doc_${opts.versionId}`, ...opts.source }] : [],
    personal,
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    awards: [],
    publications: [],
    volunteering: [],
    languages: [],
    additional_sections: [],
    parse_quality: { score: 1, warnings: [...doc.warnings], columns_detected: doc.columns_detected, hidden_text_found: doc.hidden_text_found, contact_in_header_only: doc.contact_in_header_only, tables_or_textboxes: doc.tables_or_textboxes, text_extractable: doc.text_extractable },
  };

  let roleN = 0;
  let projN = 0;
  for (const b of blocks) {
    switch (b.key) {
      case 'summary': {
        const text = b.lines.map((l) => l.text.replace(BULLET_RE, '')).join(' ').trim();
        if (text) resume.summary = { ...field(text, b.lines.map((l) => l.span_id)), summary_id: 'sum_1' };
        break;
      }
      case 'experience':
      case 'volunteering': {
        const roles = parseRoles(b.lines, () => `role_${++roleN}`);
        (b.key === 'experience' ? resume.experience : resume.volunteering).push(...roles);
        break;
      }
      case 'projects':
        resume.projects.push(...parseProjects(b.lines, () => `proj_${++projN}`));
        break;
      case 'education':
        resume.education.push(...parseEducation(b.lines));
        break;
      case 'skills':
        resume.skills.push(...parseSkills(b.lines, resume.skills.length));
        break;
      case 'certifications':
        resume.certifications.push(...parseCerts(b.lines));
        break;
      case 'languages':
        for (const l of b.lines) for (const part of l.text.split(/[,;|•]/).map((x) => x.trim()).filter(Boolean)) {
          const [lang, prof] = part.split(/\s*[(:–-]\s*/);
          resume.languages.push({ language: field(lang!.trim(), [l.span_id]), ...(prof ? { proficiency: field(prof.replace(/\)$/, '').trim(), [l.span_id]) } : {}) });
        }
        break;
      default: {
        const items = b.lines.map((l) => field(l.text.replace(BULLET_RE, ''), [l.span_id]));
        if (b.key === 'awards' || b.key === 'publications') {
          resume[b.key].push(...items.map((it, i) => ({ item_id: `${b.key}_${i + 1}`, title: it })));
        } else resume.additional_sections.push({ heading: b.key, items });
      }
    }
  }

  // Parse quality (architecture.md §5.2 quality gate).
  let score = 1;
  if (!resume.experience.length) {
    score -= 0.25;
    resume.parse_quality.warnings.push('no_experience_found');
  }
  if (doc.columns_detected) score -= 0.1;
  if (doc.contact_in_header_only) score -= 0.1;
  if (doc.tables_or_textboxes) score -= 0.1;
  if (!personal.emails.length) score -= 0.05;
  const undated = resume.experience.filter((r) => !r.start?.value).length;
  if (resume.experience.length && undated / resume.experience.length > 0.1) {
    score -= 0.1;
    resume.parse_quality.warnings.push('dates_missing');
  }
  resume.parse_quality.score = Math.max(0.1, Math.round(score * 100) / 100);
  return resume;
}

function parseRoles(lines: SpanLine[], nextId: () => string): Role[] {
  const roles: Role[] = [];
  let pending: SpanLine[] = []; // header lines without a date yet
  let role: Role | null = null;
  let bn = 0;

  const startRole = (headerLines: SpanLine[], dateLine: SpanLine | null) => {
    const range = dateLine ? findDateRange(dateLine.text) : null;
    const headerText = headerLines
      .map((l) => (range && l === dateLine ? l.text.replace(range.match, '') : l.text))
      .join(' | ')
      .replace(/\s*[|,–—-]\s*$/, '')
      .trim();
    const parts = splitHeader(headerText).filter((p) => !SINGLE_DATE_RE.test(p) || p.length > 12);
    let title = parts.find((p) => TITLE_WORDS.test(p) || titleFamily(p)) ?? parts[0] ?? 'Role';
    let employer = parts.find((p) => p !== title && !/^(remote|hybrid|on-?site)$/i.test(p)) ?? '';
    const location = parts.find((p) => p !== title && p !== employer && (/,\s*[A-Z]{2}\b/.test(p) || /^(remote|hybrid)/i.test(p)));
    if (!employer && parts.length === 1) {
      employer = title;
      title = 'Role';
    }
    const spans = headerLines.map((l) => l.span_id);
    const r: Role = {
      role_id: nextId(),
      employer: field(employer, spans, employer ? 0.8 : 0.3),
      title: field(title, spans, 0.8),
      ...(location ? { location: field(location, spans, 0.6) } : {}),
      ...(range ? { start: field(range.start, [dateLine!.span_id]), end: field(range.end, [dateLine!.span_id]) } : {}),
      date_precision: range?.precision ?? 'month',
      bullets: [],
      technologies: [],
    };
    bn = 0;
    return r;
  };

  let headerIndent: number | undefined;
  // A glyph-less line is a bullet when it is indented past the role header, starts with an action verb,
  // or reads like a sentence (PDF generators often draw bullet markers as shapes, not text).
  const bulletLike = (l: SpanLine) =>
    BULLET_RE.test(l.text) ||
    (headerIndent !== undefined && l.style.indent !== undefined && l.style.indent > headerIndent + 6) ||
    leadingVerbRank(l.text) !== undefined ||
    /[.;]$/.test(l.text.trim());

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const isBullet = BULLET_RE.test(l.text);
    const range = findDateRange(l.text);
    if (range && !isBullet) {
      // Header line(s): the pending non-bullet lines plus this dated line.
      const header = [...pending, l];
      pending = [];
      if (role) roles.push(role);
      role = startRole(header, l);
      headerIndent = l.style.indent;
      continue;
    }
    if (!isBullet && !bulletLike(l)) {
      const next = lines[i + 1];
      const nextHasDate = next && !BULLET_RE.test(next.text) && findDateRange(next.text);
      const looksHeader = l.text.length < 90 && (l.style.bold || TITLE_WORDS.test(l.text) || /^[A-Z]/.test(l.text));
      if (nextHasDate || (looksHeader && (!role || role.bullets.length > 0) && next && (BULLET_RE.test(next.text) || findDateRange(next.text)) && pending.length < 2)) {
        pending.push(l);
        continue;
      }
    }
    if (pending.length && !role) {
      role = startRole(pending, null);
      pending = [];
    }
    if (!role) {
      pending.push(l);
      continue;
    }
    const text = l.text.replace(BULLET_RE, '').trim();
    // A short location line right under the role header ("Toronto, ON", "Remote") is not a bullet.
    if (!isBullet && !role.bullets.length && !role.location && text.length <= 45 && LOCATION_LINE.test(text)) {
      role.location = field(text, [l.span_id], 0.7);
      continue;
    }
    const last = role.bullets[role.bullets.length - 1];
    const continues = last && !isBullet && (/^[a-z(]/.test(text) || /([,;–-]|\b(and|or|with|of|to|the|for|in))$/i.test(last.text)) && last.text.length < 240;
    if (continues) {
      last.text = `${last.text} ${text}`;
      last.prov.span_ids.push(l.span_id);
    } else if (text) {
      const b: Bullet = { bullet_id: `${role.role_id}.b_${++bn}`, text, prov: { span_ids: [l.span_id], source: 'parser' }, claim_ids: [] };
      role.bullets.push(b);
    }
  }
  if (pending.length && !role) role = startRole(pending, null);
  if (role) roles.push(role);
  return roles.filter((r) => r.bullets.length || r.start?.value);
}

function parseProjects(lines: SpanLine[], nextId: () => string): Project[] {
  const projects: Project[] = [];
  let p: Project | null = null;
  let bn = 0;
  for (const l of lines) {
    const isBullet = BULLET_RE.test(l.text);
    if (!isBullet && (l.style.bold || !p || l.text.length < 70) && !/[.;]$/.test(l.text)) {
      if (p) projects.push(p);
      const range = findDateRange(l.text);
      const name = (range ? l.text.replace(range.match, '') : l.text).replace(/[|–—-]\s*$/, '').trim();
      p = { project_id: nextId(), name: field(name, [l.span_id]), bullets: [], technologies: [], ...(range ? { start: field(range.start, [l.span_id]), end: field(range.end, [l.span_id]) } : {}) };
      bn = 0;
      continue;
    }
    if (!p) continue;
    p.bullets.push({ bullet_id: `${p.project_id}.b_${++bn}`, text: l.text.replace(BULLET_RE, '').trim(), prov: { span_ids: [l.span_id], source: 'parser' }, claim_ids: [] });
  }
  if (p) projects.push(p);
  return projects;
}

function parseEducation(lines: SpanLine[]): Education[] {
  const out: Education[] = [];
  let cur: Education | null = null;
  for (const l of lines) {
    const t = l.text.replace(BULLET_RE, '').trim();
    const range = findDateRange(t);
    const single = !range ? t.match(SINGLE_DATE_RE) : null;
    const clean = (range ? t.replace(range.match, '') : single ? t.replace(single[0], '') : t).replace(/[|,–—-]\s*$/, '').trim();
    const isInstitution = /\b(university|college|institute|school|academy|polytechnic|universit[eé])\b/i.test(clean);
    const degree = degreeLevel(clean) > 0 && /\b(b\.?s|b\.?a|m\.?s|m\.?a|mba|ph\.?d|bachelor|master|doctor|associate|diploma|b\.?sc|m\.?sc|b\.?eng|b\.?tech|degree)\b/i.test(clean);
    if (isInstitution && (!cur || cur.institution.value)) {
      if (cur) out.push(cur);
      const parts = splitHeader(clean);
      const inst = parts.find((p) => /\b(university|college|institute|school|academy|polytechnic)\b/i.test(p)) ?? clean;
      cur = { education_id: `edu_${out.length + 1}`, institution: field(inst, [l.span_id]), honors: [] };
      const deg = parts.find((p) => p !== inst && degreeLevel(p) > 0);
      if (deg) setDegree(cur, deg, l.span_id);
    } else if (degree) {
      if (!cur) cur = { education_id: `edu_${out.length + 1}`, institution: field('', []), honors: [] };
      setDegree(cur, clean, l.span_id);
    } else if (cur && /gpa|honou?rs|cum laude|dean/i.test(t)) {
      const gpa = t.match(/gpa[:\s]*([\d.]+(?:\s*\/\s*[\d.]+)?)/i);
      if (gpa) cur.gpa = field(gpa[1]!, [l.span_id]);
      else cur.honors.push(field(t, [l.span_id]));
    }
    if (cur && (range || single)) {
      if (range) {
        cur.start = field(range.start, [l.span_id]);
        cur.end = field(range.end, [l.span_id]);
      } else {
        const d = parseDatePart(single![1]!);
        if (d && d !== 'present') cur.end = field(d.iso, [l.span_id]);
      }
    }
  }
  if (cur) out.push(cur);
  return out.filter((e) => e.institution.value || e.degree?.value);
}

function setDegree(e: Education, text: string, span: string) {
  const m = text.match(/^(.*?)(?:\s+(?:in|of)\s+|,\s*)(.+)$/i);
  if (m && degreeLevel(m[1]!) > 0) {
    e.degree = field(m[1]!.trim(), [span]);
    e.field_of_study = field(m[2]!.replace(/[|,]\s*$/, '').trim(), [span]);
  } else e.degree = field(text.trim(), [span]);
}

function parseSkills(lines: SpanLine[], offset: number): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const body = l.text.replace(BULLET_RE, '').replace(/^[A-Za-z &/]{2,30}:\s*/, '');
    for (const raw of body.split(/[,;|•·]|\s{2,}|\s\/\s/)) {
      const name = raw.replace(/\(.*?\)/g, '').replace(/[.:]$/, '').trim();
      if (!name || name.length > 40 || name.split(/\s+/).length > 4) continue;
      const entry = lookupSkill(name) ?? findSkills(name)[0]?.skill;
      const canonical = entry?.canonical ?? name;
      if (seen.has(canonical.toLowerCase())) continue;
      seen.add(canonical.toLowerCase());
      out.push({
        skill_id: `sk_${offset + out.length + 1}`,
        name: field(name, [l.span_id]),
        normalized: { canonical, ...(entry ? { taxonomy_id: entry.id } : {}), aliases: entry?.aliases ?? [] },
        ...(entry ? { category: (['language', 'framework', 'tool', 'platform', 'database', 'cloud', 'domain', 'soft'].includes(entry.category) ? entry.category : 'other') as Skill['category'] } : {}),
        evidence_level: 'listed_only',
        claim_ids: [],
      });
    }
  }
  return out;
}

function parseCerts(lines: SpanLine[]): Certification[] {
  return lines
    .map((l, i) => {
      const t = l.text.replace(BULLET_RE, '').trim();
      const d = t.match(SINGLE_DATE_RE);
      const name = (d ? t.replace(d[0], '') : t).replace(/[|,–—(-]\s*$/, '').replace(/\(\s*\)/, '').trim();
      const parts = name.split(/\s+[—–|-]\s+|,\s+/);
      const date = d ? parseDatePart(d[1]!) : null;
      return {
        cert_id: `cert_${i + 1}`,
        name: field(parts[0]!.trim(), [l.span_id]),
        ...(parts[1] ? { issuer: field(parts[1].trim(), [l.span_id]) } : {}),
        ...(date && date !== 'present' ? { date: field(date.iso, [l.span_id]) } : {}),
      };
    })
    .filter((c) => c.name.value.length > 2);
}
