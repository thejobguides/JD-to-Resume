import type { Bullet, CanonicalResume, Claim, ClaimLite, Skill } from '@jmo/shared';
import { findSkills, leadingVerbRank, lookupSkill, sameSkill } from '@jmo/taxonomy';
import { extractNumbers } from './numbers';

// Deterministic claim extraction (architecture.md §6.2). Runs in the extension after parsing and again
// in tests; the server only ever receives minimized claims.

export interface ExtractedEvidence {
  resume: CanonicalResume; // copy with claim_ids filled in on bullets and skills, evidence_level recomputed
  claims: Claim[];
}

const TEAM_RE = /\b(?:team|group|squad|org(?:anization)?)\s+of\s+(\d{1,4})\b|\b(\d{1,4})\s*[- ]?(?:person|people|member|engineers?|developers?|analysts?|reports?)\b/i;
const YEARS_RE = /\b(\d{1,2})\+?\s*(?:years?|yrs?)\b/i;

export function extractClaims(input: CanonicalResume): ExtractedEvidence {
  const resume: CanonicalResume = structuredClone(input);
  const claims: Claim[] = [];
  let n = 0;
  const add = (c: Omit<Claim, 'claim_id' | 'attributes' | 'confidence' | 'source'> & Partial<Pick<Claim, 'attributes' | 'confidence' | 'source'>>): string => {
    const claim_id = `claim_${++n}`;
    claims.push({ claim_id, attributes: {}, confidence: 1, source: 'parser', ...c });
    return claim_id;
  };

  const bulletClaims = (b: Bullet, ctx: { role_id?: string; project_id?: string; location: Claim['location'] }) => {
    const ids: string[] = [];
    const base = { span_ids: b.prov.span_ids, bullet_id: b.bullet_id, location: ctx.location, ...(ctx.role_id ? { role_id: ctx.role_id } : {}), ...(ctx.project_id ? { project_id: ctx.project_id } : {}) };
    const verb = leadingVerbRank(b.text);
    ids.push(add({ ...base, type: 'responsibility', value: b.text, raw_text: b.text, attributes: verb !== undefined ? { verb_rank: verb } : {} }));
    for (const hit of findSkills(b.text)) {
      ids.push(add({ ...base, type: hit.skill.category === 'domain' ? 'skill' : 'tool', value: hit.skill.canonical, raw_text: b.text, attributes: { matched: hit.matched } }));
    }
    for (const num of extractNumbers(b.text)) {
      if (num.kind === 'year') continue;
      ids.push(add({ ...base, type: 'metric', value: { number: num.value, unit: num.kind === 'plain' ? '' : num.kind, raw: num.raw }, raw_text: b.text }));
    }
    const team = b.text.match(TEAM_RE);
    if (team) ids.push(add({ ...base, type: 'team_size', value: Number(team[1] ?? team[2]), raw_text: b.text }));
    b.claim_ids = ids;
  };

  for (const role of resume.experience) {
    const span = (f?: { prov: { span_ids: string[] } }) => f?.prov.span_ids ?? [];
    add({ type: 'employer', value: role.employer.value, raw_text: role.employer.value, span_ids: span(role.employer), role_id: role.role_id, location: 'header' });
    add({ type: 'title', value: role.title.value, raw_text: role.title.value, span_ids: span(role.title), role_id: role.role_id, location: 'header' });
    if (role.start?.value) {
      add({ type: 'date_range', value: `${role.start.value}..${role.end?.value ?? 'present'}`, raw_text: `${role.start.value} – ${role.end?.value ?? 'present'}`, span_ids: span(role.start), role_id: role.role_id, location: 'header' });
    }
    for (const b of role.bullets) bulletClaims(b, { role_id: role.role_id, location: 'bullet' });
  }
  for (const p of resume.projects) {
    add({ type: 'project', value: p.name.value, raw_text: p.name.value, span_ids: p.name.prov.span_ids, project_id: p.project_id, location: 'project' });
    for (const b of p.bullets) bulletClaims(b, { project_id: p.project_id, location: 'project' });
  }
  for (const e of resume.education) {
    const text = [e.degree?.value, e.field_of_study?.value, e.institution.value].filter(Boolean).join(', ');
    add({ type: 'education', value: text, raw_text: text, span_ids: [...(e.degree?.prov.span_ids ?? []), ...e.institution.prov.span_ids], location: 'education', attributes: { degree: e.degree?.value ?? '', field: e.field_of_study?.value ?? '' } });
  }
  for (const c of resume.certifications) {
    add({ type: 'certification', value: c.name.value, raw_text: [c.name.value, c.issuer?.value].filter(Boolean).join(' — '), span_ids: c.name.prov.span_ids, location: 'certifications' });
  }
  if (resume.summary) {
    const years = resume.summary.value.match(YEARS_RE);
    if (years) add({ type: 'years', value: Number(years[1]), raw_text: resume.summary.value, span_ids: resume.summary.prov.span_ids, location: 'summary' });
    for (const hit of findSkills(resume.summary.value)) {
      add({ type: 'skill', value: hit.skill.canonical, raw_text: resume.summary.value, span_ids: resume.summary.prov.span_ids, location: 'summary' });
    }
  }

  // Skills section: listed_only unless a role/project bullet demonstrates the same skill.
  const demonstrated = claims.filter((c) => (c.location === 'bullet' || c.location === 'project') && (c.type === 'tool' || c.type === 'skill'));
  for (const s of resume.skills) {
    const canon = lookupSkill(s.name.value)?.canonical ?? s.normalized.canonical ?? s.name.value;
    s.normalized.canonical = canon;
    const shown = demonstrated.filter((c) => sameSkill(String(c.value), canon));
    s.evidence_level = shown.length ? 'demonstrated' : 'listed_only';
    const listedId = add({ type: 'skill', value: canon, raw_text: s.name.value, span_ids: s.name.prov.span_ids, location: 'skills_list' });
    s.claim_ids = [listedId, ...shown.map((c) => c.claim_id)];
  }
  // Skills demonstrated in bullets but missing from the skills list are still evidence (no Skill row added).
  return { resume, claims };
}

export function claimText(c: Claim): string {
  if (typeof c.value === 'object') return c.value.raw;
  return c.type === 'responsibility' ? c.raw_text : String(c.value);
}

/** Minimized claims for the server (no contact data, only in-scope text). */
export function toClaimLite(claims: Claim[]): ClaimLite[] {
  return claims
    .filter((c) => c.type !== 'date_range')
    .map((c) => ({
      claim_id: c.claim_id,
      type: c.type,
      value: c.value,
      text: c.type === 'responsibility' || c.type === 'metric' || c.type === 'tool' || c.type === 'skill' ? c.raw_text.slice(0, 1200) : String(typeof c.value === 'object' ? c.value.raw : c.value).slice(0, 1200),
      ...(c.role_id ? { role_id: c.role_id } : {}),
    }));
}

export function skillIsDemonstrated(skill: Skill): boolean {
  return skill.evidence_level === 'demonstrated';
}
