import { totalYears } from '@jmo/evidence';
import type { CanonicalResume, Claim, JobAnalysis, Mapping, Requirement } from '@jmo/shared';
import { SCORING_VERSION, containsTerm, normTerm } from '@jmo/shared';
import { areSiblings, degreeLevel, findSkills, lookupSkill, sameSkill, textMentionsSkill, titleSimilarity, tokenCoverage } from '@jmo/taxonomy';
import {
  aggregate,
  CATEGORY_LABELS,
  CATEGORY_WEIGHTS,
  type CategoryInput,
  type CategoryKey,
  confidence,
  creditOf,
  DEFAULT_CREDITS,
  itemCredit,
  type ScoredItem,
  scoreRange,
  type State,
} from './formula';

// Deterministic, explainable Job Match Score (architecture.md §7). Runs in the extension and in tests.

export type DecidedBy = 'exact' | 'alias' | 'structured' | 'taxonomy' | 'lexical' | 'llm' | 'none';

export interface RequirementResult {
  req_id: string;
  category: CategoryKey | 'eligibility' | 'ignored';
  type: Requirement['type'];
  text: string;
  quote: string;
  hard: boolean;
  weight: number;
  state: State;
  components?: State[];
  credit: number;
  decided_by: DecidedBy;
  claim_ids: string[];
  reason: string;
  /** evidence exists but is not surfaced in JD wording or in a bullet — optimization target */
  not_surfaced: boolean;
  /** deterministic rules couldn't decide: candidate for match_map@v1 */
  ambiguous: boolean;
}

export interface EligibilityFlag {
  kind: 'location' | 'work_authorization' | 'clearance';
  status: 'match' | 'mismatch' | 'unknown';
  detail: string;
}

export interface CategoryResult {
  key: CategoryKey;
  label: string;
  weight: number;
  value: number | null; // null = not present in this JD
  requirement_ids: string[];
  detail?: string;
}

export interface KeywordResult {
  term: string;
  credit: 0 | 0.5 | 1;
  where: 'bullet' | 'skills_or_summary' | 'missing';
}

export interface StructureCheck {
  id: string;
  label: string;
  pass: boolean;
}

export interface ScoreResult {
  scoring_version: string;
  score: number;
  base: number;
  gate: number;
  range: [number, number];
  confidence: { value: number; label: 'High' | 'Medium' | 'Low' };
  ceiling: number;
  categories: CategoryResult[];
  requirements: RequirementResult[];
  keywords: KeywordResult[];
  structure: StructureCheck[];
  eligibility: EligibilityFlag[];
  title: { target: string; best_match: string | null; value: number };
}

export interface ScoreInput {
  analysis: JobAnalysis;
  resume: CanonicalResume;
  claims: Claim[];
  mappings?: Mapping[];
  now?: Date;
  /** true when the output uses our ATS-safe template (structure checks for layout pass) */
  useTemplate?: boolean;
  /** per-requirement credit caps (used for the after-score so it can never exceed the ceiling) */
  capStates?: Record<string, State>;
}

const BASE_TYPE: Partial<Record<Requirement['type'], number>> = { must: 1, preferred: 0.5, responsibility: 0.8 };
const OR_RE = /\b(or|either|such as|e\.g\.|for example|including|one of)\b|\//i;
const STATE_ORDER: State[] = ['none', 'weak', 'partial', 'strong'];

function maxState(a: State, b: State): State {
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return STATE_ORDER.indexOf(a) >= STATE_ORDER.indexOf(b) ? a : b;
}
function minState(a: State, cap: State): State {
  if (a === 'unknown') return a;
  return STATE_ORDER.indexOf(a) <= STATE_ORDER.indexOf(cap) ? a : cap;
}

function categoryFor(r: Requirement): CategoryKey | 'eligibility' | 'ignored' {
  if (r.type === 'location') return 'eligibility';
  if (r.years_min !== undefined || r.type === 'experience') return 'experience';
  switch (r.type) {
    case 'must':
      return 'required';
    case 'preferred':
      return 'preferred';
    case 'responsibility':
      return 'responsibilities';
    case 'education':
      return 'education';
    case 'certification':
      return 'certifications';
    default:
      return 'ignored';
  }
}

interface EvidenceView {
  bulletTexts: Array<{ text: string; role_id?: string; bullet_id: string }>;
  demonstratedSkills: Map<string, string[]>; // canonical → claim_ids
  listedSkills: Map<string, string[]>;
  claimsById: Map<string, Claim>;
}

function buildEvidence(resume: CanonicalResume, claims: Claim[]): EvidenceView {
  const bulletTexts = [
    ...resume.experience.flatMap((r) => r.bullets.map((b) => ({ text: b.text, role_id: r.role_id, bullet_id: b.bullet_id }))),
    ...resume.projects.flatMap((p) => p.bullets.map((b) => ({ text: b.text, bullet_id: b.bullet_id }))),
  ];
  const demonstratedSkills = new Map<string, string[]>();
  const listedSkills = new Map<string, string[]>();
  for (const c of claims) {
    if ((c.type !== 'tool' && c.type !== 'skill') || typeof c.value !== 'string') continue;
    const canon = lookupSkill(c.value)?.canonical ?? c.value;
    const target = c.location === 'bullet' || c.location === 'project' ? demonstratedSkills : listedSkills;
    target.set(canon, [...(target.get(canon) ?? []), c.claim_id]);
  }
  return { bulletTexts, demonstratedSkills, listedSkills, claimsById: new Map(claims.map((c) => [c.claim_id, c])) };
}

interface SkillEval {
  state: State;
  decided: DecidedBy;
  claim_ids: string[];
  notSurfaced: boolean;
  why: string;
}

function evalSkill(skill: string, ev: EvidenceView): SkillEval {
  const canon = lookupSkill(skill)?.canonical ?? skill;
  for (const [s, ids] of ev.demonstratedSkills) {
    if (sameSkill(s, canon)) {
      // alias (e.g. "k8s") in the resume but the JD says "Kubernetes": strong, but worth surfacing in JD wording
      const wordedAsJd = ev.bulletTexts.some((b) => containsTerm(b.text, skill) || containsTerm(b.text, canon));
      return { state: 'strong', decided: wordedAsJd ? 'exact' : 'alias', claim_ids: ids, notSurfaced: !wordedAsJd, why: `${canon} appears in your experience` };
    }
  }
  if (!lookupSkill(skill)) {
    // Unknown term: literal search in bullets.
    const b = ev.bulletTexts.find((x) => containsTerm(x.text, skill));
    if (b) return { state: 'strong', decided: 'exact', claim_ids: [], notSurfaced: false, why: `"${skill}" appears in your experience` };
  }
  for (const [s, ids] of ev.listedSkills) {
    if (sameSkill(s, canon)) return { state: 'partial', decided: 'structured', claim_ids: ids, notSurfaced: true, why: `${canon} is in your skills or summary but not shown in a role` };
  }
  for (const [s, ids] of ev.demonstratedSkills) {
    if (areSiblings(s, canon)) return { state: 'partial', decided: 'taxonomy', claim_ids: ids, notSurfaced: false, why: `Related: ${s} (similar to ${canon})` };
  }
  for (const [s, ids] of ev.listedSkills) {
    if (areSiblings(s, canon)) return { state: 'weak', decided: 'taxonomy', claim_ids: ids, notSurfaced: false, why: `Related skill listed: ${s}` };
  }
  return { state: 'none', decided: 'none', claim_ids: [], notSurfaced: false, why: `No evidence of ${canon}` };
}

function lexicalState(cov: number): State {
  if (cov >= 0.7) return 'strong';
  if (cov >= 0.5) return 'partial';
  if (cov >= 0.3) return 'weak';
  return 'none';
}

function reqSkills(r: Requirement): string[] {
  const listed = r.skills.filter((s) => s.trim());
  if (listed.length) return listed;
  return findSkills(r.text).map((h) => h.skill.canonical);
}

function emphasis(r: Requirement, analysis: JobAnalysis): number {
  let e = 1;
  const skills = reqSkills(r);
  if (skills.some((s) => textMentionsSkill(analysis.title, s))) e += 0.25;
  const mentions = analysis.requirements.filter((o) => o.req_id !== r.req_id && skills.some((s) => o.skills.some((x) => sameSkill(x, s)) || textMentionsSkill(o.text, s))).length;
  if (mentions >= 1) e += 0.25;
  return Math.min(1.5, e);
}

export function scoreResume(input: ScoreInput): ScoreResult {
  const { analysis, resume, claims } = input;
  const now = input.now ?? new Date();
  const ev = buildEvidence(resume, claims);
  const mappingById = new Map((input.mappings ?? []).map((m) => [m.req_id, m]));
  const roleRanges = resume.experience.map((r) => ({ start: r.start?.value, end: r.end?.value ?? 'present' }));
  const totalYrs = totalYears(roleRanges, now);
  const resumeDegree = Math.max(0, ...resume.education.map((e) => degreeLevel(`${e.degree?.value ?? ''} ${e.field_of_study?.value ?? ''}`)));
  const requirements: RequirementResult[] = [];

  for (const r of analysis.requirements) {
    const category = categoryFor(r);
    const weight = (BASE_TYPE[r.type] ?? 1) * emphasis(r, analysis);
    const res: RequirementResult = {
      req_id: r.req_id,
      category,
      type: r.type,
      text: r.text,
      quote: r.quote,
      hard: r.hard && r.type === 'must',
      weight,
      state: 'none',
      credit: 0,
      decided_by: 'none',
      claim_ids: [],
      reason: '',
      not_surfaced: false,
      ambiguous: false,
    };

    if (category === 'experience') {
      const min = r.years_min ?? 0;
      const skills = reqSkills(r);
      let years: number | null = totalYrs;
      let why = 'total experience';
      let cap: State = 'strong';
      if (skills.length) {
        // Tools must be named; generic domain skills ("data pipelines") may match on word overlap.
        const mentions = (text: string, s: string) =>
          textMentionsSkill(text, s) || ((lookupSkill(s)?.category ?? 'domain') === 'domain' && tokenCoverage(s, text) >= 0.5);
        const roles = resume.experience.filter((role) => role.bullets.some((b) => skills.some((s) => mentions(b.text, s))) || skills.some((s) => mentions(role.title.value, s)));
        if (roles.length) {
          years = totalYears(roles.map((x) => ({ start: x.start?.value, end: x.end?.value ?? 'present' })), now);
          why = `experience with ${skills.join(', ')}`;
        } else {
          cap = 'partial';
          why = `total experience (no role mentions ${skills.join(', ')})`;
        }
      }
      if (years === null || !min) {
        res.state = years === null ? 'unknown' : 'strong';
        res.reason = years === null ? 'Role dates could not be read' : 'No minimum stated';
      } else {
        const st: State = years >= min ? 'strong' : years >= 0.75 * min ? 'partial' : years >= 0.5 * min ? 'weak' : 'none';
        res.state = minState(st, cap);
        res.reason = `${years} years of ${why} vs ${min}+ required`;
      }
      res.decided_by = 'structured';
    } else if (category === 'education') {
      const needed = degreeLevel(r.text) || 2;
      const equivalent = /equivalent|or related experience/i.test(r.text);
      const fieldWords = r.text.match(/\b(computer science|engineering|mathematics|statistics|physics|economics|finance|business|data science|information technology|design|marketing)\b/gi) ?? [];
      const fieldOk = !fieldWords.length || resume.education.some((e) => fieldWords.some((f) => normTerm(`${e.field_of_study?.value ?? ''} ${e.degree?.value ?? ''}`).includes(normTerm(f))));
      if (!resume.education.length) {
        res.state = equivalent && (totalYrs ?? 0) >= 4 ? 'partial' : 'none';
        res.reason = res.state === 'partial' ? 'No degree listed; equivalent experience accepted' : 'No education listed';
      } else if (resumeDegree >= needed) {
        res.state = fieldOk ? 'strong' : 'partial';
        res.reason = fieldOk ? 'Degree level matches' : 'Degree level matches; field differs';
      } else {
        res.state = equivalent ? 'partial' : resumeDegree > 0 ? 'weak' : 'none';
        res.reason = 'Degree level below the requirement';
      }
      res.decided_by = 'structured';
    } else if (category === 'certifications') {
      const hit = resume.certifications.find((c) => tokenCoverage(r.text, c.name.value) >= 0.5 || reqSkills(r).some((s) => textMentionsSkill(c.name.value, s)));
      res.state = hit ? 'strong' : 'none';
      res.reason = hit ? `Certification: ${hit.name.value}` : 'Certification not listed';
      res.decided_by = 'structured';
    } else if (category === 'eligibility' || category === 'ignored') {
      res.state = 'unknown';
      res.reason = category === 'eligibility' ? 'Shown as an eligibility flag, not scored' : 'Not scored';
    } else {
      // required / preferred / responsibilities
      const skills = reqSkills(r);
      let state: State = 'none';
      if (skills.length) {
        const evals = skills.map((s) => evalSkill(s, ev));
        const isOr = OR_RE.test(r.text) || OR_RE.test(r.quote);
        if (isOr || evals.length === 1) {
          const best = evals.reduce((a, b) => (STATE_ORDER.indexOf(b.state) > STATE_ORDER.indexOf(a.state) ? b : a));
          state = best.state;
          res.decided_by = best.decided;
          res.claim_ids = best.claim_ids;
          res.not_surfaced = best.notSurfaced;
          res.reason = best.why;
        } else {
          res.components = evals.map((e) => e.state);
          const avg = evals.reduce((s, e) => s + creditOf(e.state), 0) / evals.length;
          state = avg >= 0.95 ? 'strong' : avg >= 0.5 ? 'partial' : avg > 0 ? 'weak' : 'none';
          res.decided_by = evals.every((e) => e.decided === 'exact' || e.decided === 'alias' || e.decided === 'structured') ? 'exact' : 'taxonomy';
          res.claim_ids = evals.flatMap((e) => e.claim_ids);
          res.not_surfaced = evals.some((e) => e.notSurfaced);
          res.reason = evals.map((e) => e.why).join('; ');
        }
      }
      if (r.type === 'responsibility' || !skills.length) {
        let best = 0;
        let bestBullet: string | null = null;
        for (const b of ev.bulletTexts) {
          const cov = tokenCoverage(r.text, b.text);
          if (cov > best) {
            best = cov;
            bestBullet = b.bullet_id;
          }
        }
        const lex = lexicalState(best);
        if (STATE_ORDER.indexOf(lex) > STATE_ORDER.indexOf(state)) {
          state = lex;
          res.components = undefined;
          res.decided_by = 'lexical';
          res.reason = `Closest experience overlaps ${Math.round(best * 100)}% of this requirement`;
          res.claim_ids = bestBullet ? claims.filter((c) => c.bullet_id === bestBullet && c.type === 'responsibility').map((c) => c.claim_id) : [];
          res.not_surfaced = lex !== 'strong';
        }
        if (state === 'none' || state === 'weak') res.ambiguous = true;
      }
      const m = mappingById.get(r.req_id);
      if (m && res.ambiguous && m.state !== 'unknown') {
        const valid = m.claim_ids.filter((id) => ev.claimsById.has(id));
        state = maxState(state, valid.length || m.state === 'none' ? m.state : 'none');
        if (state === m.state) {
          res.decided_by = 'llm';
          res.claim_ids = valid;
          res.reason = m.rationale || res.reason;
          res.components = undefined;
        }
      }
      res.state = state;
      if (!res.reason) res.reason = 'No evidence found';
    }
    const cap = input.capStates?.[r.req_id];
    if (cap) {
      res.state = minState(res.state, cap);
      if (res.components) res.components = res.components.map((c) => minState(c, cap));
    }
    res.credit = res.state === 'unknown' ? 0 : itemCredit({ weight, state: res.state, ...(res.components ? { components: res.components } : {}) }, DEFAULT_CREDITS);
    requirements.push(res);
  }

  // Title alignment.
  const recentTitles = [...resume.experience].slice(0, 2).map((r) => r.title.value);
  let titleValue: number | null = null;
  let bestTitle: string | null = null;
  if (analysis.title.trim() && recentTitles.length) {
    titleValue = 0;
    for (const t of recentTitles) {
      const s = titleSimilarity(analysis.title, t);
      if (s > titleValue) {
        titleValue = s;
        bestTitle = t;
      }
    }
  }

  // Keyword coverage with saturation (§7.5).
  const keywords: KeywordResult[] = analysis.keywords.slice(0, 25).map((term) => {
    const inBullet = ev.bulletTexts.some((b) => textMentionsSkill(b.text, term));
    if (inBullet) return { term, credit: 1, where: 'bullet' };
    const inSkills = resume.skills.some((s) => sameSkill(s.name.value, term) || textMentionsSkill(s.name.value, term)) || (resume.summary ? textMentionsSkill(resume.summary.value, term) : false);
    return inSkills ? { term, credit: 0.5, where: 'skills_or_summary' } : { term, credit: 0, where: 'missing' };
  });
  const kwValue = keywords.length ? Math.min(1, keywords.reduce((s, k) => s + k.credit, 0) / keywords.length / 0.8) : null;

  // Structure & parseability (§7.6).
  const pq = resume.parse_quality;
  const datesOk = resume.experience.length ? resume.experience.filter((r) => r.start?.value).length / resume.experience.length >= 0.9 : false;
  const size = resume.source_documents[0]?.size_bytes;
  const structure: StructureCheck[] = [
    { id: 'text_layer', label: 'Text can be extracted', pass: pq.text_extractable },
    { id: 'single_column', label: 'Single-column reading order', pass: input.useTemplate || !pq.columns_detected },
    { id: 'headings', label: 'Standard section headings', pass: resume.experience.length > 0 && (resume.skills.length > 0 || resume.education.length > 0) },
    { id: 'contact_body', label: 'Contact details in the body', pass: input.useTemplate || (!pq.contact_in_header_only && resume.personal.emails.length > 0) },
    { id: 'dates', label: 'Role dates readable', pass: datesOk },
    { id: 'no_tables', label: 'No tables or text boxes', pass: input.useTemplate || !pq.tables_or_textboxes },
    { id: 'file_size', label: 'File size ≤ 2.5 MB', pass: size === undefined || size <= 2.5 * 1024 * 1024 },
    { id: 'no_image_text', label: 'No text inside images', pass: input.useTemplate || !pq.warnings.includes('image_text') },
  ];
  const structureValue = structure.filter((c) => c.pass).length / structure.length;

  const items = (key: CategoryKey): ScoredItem[] =>
    requirements
      .filter((r) => r.category === key)
      .map((r) => ({
        weight: r.weight,
        state: r.state,
        ...(r.components ? { components: r.components } : {}),
        hardMust: r.hard,
        deterministic: r.decided_by === 'exact' || r.decided_by === 'alias' || r.decided_by === 'structured',
      }));

  const cats: CategoryInput[] = [
    { key: 'required', items: items('required') },
    { key: 'experience', items: items('experience') },
    { key: 'responsibilities', items: items('responsibilities') },
    { key: 'preferred', items: items('preferred') },
    { key: 'title', value: titleValue },
    { key: 'keywords', value: kwValue },
    { key: 'education', items: items('education') },
    { key: 'certifications', items: items('certifications') },
    { key: 'structure', value: structureValue },
  ];
  const agg = aggregate(cats);

  // Confidence (§7.7).
  const scored = requirements.filter((r) => r.category !== 'eligibility' && r.category !== 'ignored');
  const wAll = scored.reduce((s, r) => s + r.weight, 0) || 1;
  const u = scored.filter((r) => r.state === 'unknown').reduce((s, r) => s + r.weight, 0) / wAll;
  const known = scored.filter((r) => r.state !== 'unknown');
  const wKnown = known.reduce((s, r) => s + r.weight, 0) || 1;
  const d = known.filter((r) => r.decided_by === 'exact' || r.decided_by === 'alias' || r.decided_by === 'structured').reduce((s, r) => s + r.weight, 0) / wKnown;
  const conf = confidence({ qJd: analysis.quality, qResume: pq.score, u, d });

  // Evidence ceiling (§8.3): anything with any evidence → strong; skills-only keywords → covered; our template.
  const ceilingCats: CategoryInput[] = cats.map((c) => {
    if (c.key === 'keywords') return { key: c.key, value: keywords.length ? Math.min(1, keywords.reduce((s, k) => s + (k.credit > 0 ? 1 : 0), 0) / keywords.length / 0.8) : null };
    if (c.key === 'structure') {
      const tmpl = structure.map((s) => (['single_column', 'contact_body', 'no_tables', 'no_image_text'].includes(s.id) ? true : s.pass));
      return { key: c.key, value: tmpl.filter(Boolean).length / tmpl.length };
    }
    if (c.items && (c.key === 'required' || c.key === 'preferred' || c.key === 'responsibilities')) {
      return { key: c.key, items: c.items.map((i) => ({ ...i, components: undefined, state: i.state === 'none' || i.state === 'unknown' ? i.state : 'strong' })) };
    }
    return c;
  });
  const ceiling = Math.max(agg.score, aggregate(ceilingCats).score);

  // Eligibility flags (never reduce the score).
  const eligibility: EligibilityFlag[] = [];
  const resumeLoc = resume.personal.location?.value ?? '';
  if (analysis.location.length || analysis.work_mode !== 'unknown') {
    let status: EligibilityFlag['status'] = 'unknown';
    if (resumeLoc) {
      const tokens = analysis.location.flatMap((l) => normTerm(l).split(/[^a-z]+/)).filter((t) => t.length > 1 && !['remote', 'hybrid', 'onsite', 'on', 'site'].includes(t));
      status = !tokens.length || tokens.some((t) => normTerm(resumeLoc).includes(t)) ? 'match' : 'mismatch';
    }
    eligibility.push({ kind: 'location', status, detail: resumeLoc ? `Your location: ${resumeLoc}` : 'Location not stated on your resume' });
  }
  const authReq = analysis.requirements.find((r) => /authori[sz]ed to work|sponsorship|work permit|citizen/i.test(r.text));
  if (authReq) eligibility.push({ kind: 'work_authorization', status: resume.personal.work_authorization ? 'match' : 'unknown', detail: authReq.text });
  const clearance = analysis.requirements.find((r) => /clearance/i.test(r.text));
  if (clearance) eligibility.push({ kind: 'clearance', status: 'unknown', detail: clearance.text });

  const categories: CategoryResult[] = (Object.keys(CATEGORY_WEIGHTS) as CategoryKey[]).map((key) => {
    const present = agg.categories.find((c) => c.key === key);
    return {
      key,
      label: CATEGORY_LABELS[key],
      weight: CATEGORY_WEIGHTS[key],
      value: present ? present.value : null,
      requirement_ids: requirements.filter((r) => r.category === key).map((r) => r.req_id),
    };
  });

  return {
    scoring_version: SCORING_VERSION,
    score: agg.score,
    base: Math.round(agg.base * 10) / 10,
    gate: Math.round(agg.gate * 100) / 100,
    range: scoreRange(cats),
    confidence: conf,
    ceiling,
    categories,
    requirements,
    keywords,
    structure,
    eligibility,
    title: { target: analysis.title, best_match: bestTitle, value: titleValue ?? 0 },
  };
}

/** Per-requirement ceiling states from a before-score: the after-score is computed with these caps. */
export function ceilingCaps(before: ScoreResult): Record<string, State> {
  const caps: Record<string, State> = {};
  for (const r of before.requirements) {
    if (r.category === 'required' || r.category === 'preferred' || r.category === 'responsibilities') {
      caps[r.req_id] = r.state === 'none' || r.state === 'unknown' ? r.state === 'unknown' ? 'strong' : 'none' : 'strong';
    } else {
      caps[r.req_id] = r.state === 'unknown' ? 'strong' : r.state;
    }
  }
  return caps;
}

/** After-score: same engine, same analysis, capped so it can never exceed the evidence ceiling. */
export function scoreAfter(before: ScoreResult, input: ScoreInput): ScoreResult {
  const after = scoreResume({ ...input, capStates: ceilingCaps(before), useTemplate: true });
  return { ...after, score: Math.min(after.score, before.ceiling), ceiling: before.ceiling };
}

export interface Gaps {
  missing: RequirementResult[];
  weak: RequirementResult[];
  not_surfaced: RequirementResult[];
}

export function gaps(result: ScoreResult): Gaps {
  const scored = result.requirements.filter((r) => r.category !== 'eligibility' && r.category !== 'ignored');
  return {
    missing: scored.filter((r) => r.state === 'none'),
    weak: scored.filter((r) => (r.state === 'partial' || r.state === 'weak') && !r.not_surfaced),
    not_surfaced: scored.filter((r) => r.not_surfaced && r.state !== 'none'),
  };
}

/** Optimization targets (architecture.md §8.1): evidence exists but isn't surfaced. */
export function selectTargets(result: ScoreResult, max = 12): string[] {
  const order = { required: 0, responsibilities: 1, preferred: 2, experience: 3, education: 4, certifications: 5 } as Record<string, number>;
  return result.requirements
    .filter((r) => r.state !== 'none' && r.state !== 'unknown' && (r.not_surfaced || r.state === 'partial' || r.state === 'weak'))
    .sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || b.weight - a.weight)
    .slice(0, max)
    .map((r) => r.req_id);
}
