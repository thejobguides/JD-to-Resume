import { containsTerm, normTerm } from '@jmo/shared';
import { SENIORITY_WORDS, SKILLS, TITLE_FAMILIES } from './skills-data';

export { SKILLS, TITLE_FAMILIES } from './skills-data';

export interface SkillEntry {
  id: string;
  canonical: string;
  category: string;
  aliases: string[];
  family: string;
  year?: number;
}

export interface SkillHit {
  skill: SkillEntry;
  matched: string;
  index: number;
}

// Common English words that are also tool names: match them only with exact capitalization.
const CASE_SENSITIVE = new Set(['Go', 'R', 'C', 'Rust', 'Swift', 'Dart', 'Ruby', 'Spark', 'Hive', 'Helm', 'Flask', 'Express', 'Spring', 'Lambda', 'Oracle', 'Looker', 'Sketch', 'Prefect', 'Pulsar', 'Flink', 'Excel', 'Git', 'Agile', 'REST', 'Node', 'Security', 'Statistics', 'Leadership', 'Communication', 'Mentoring']);

function slug(s: string): string {
  return normTerm(s).replace(/[^a-z0-9+#.]+/g, '-');
}

export const SKILL_ENTRIES: SkillEntry[] = SKILLS.map(([canonical, category, aliases, family, year]) => ({
  id: `sk:${slug(canonical)}`,
  canonical,
  category,
  aliases: [...aliases],
  family,
  ...(year ? { year } : {}),
}));

const byNorm = new Map<string, SkillEntry>();
for (const e of SKILL_ENTRIES) {
  byNorm.set(normTerm(e.canonical), e);
  for (const a of e.aliases) if (!byNorm.has(normTerm(a))) byNorm.set(normTerm(a), e);
}

interface Pattern {
  entry: SkillEntry;
  form: string;
  re: RegExp;
}

function buildPattern(entry: SkillEntry, form: string): Pattern {
  const esc = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
  const sensitive = CASE_SENSITIVE.has(form) || form.length <= 2;
  const flags = sensitive ? 'gu' : 'giu';
  if (form.length === 1) {
    // "C", "R": not in "C-suite", "R&D", "Series C." etc.
    return { entry, form, re: new RegExp(`(^|[\\s,(/;:])(${esc})(?=$|[\\s,)/;:])`, flags) };
  }
  return { entry, form, re: new RegExp(`(^|[^\\p{L}\\p{N}+#])(${esc})(?=$|[^\\p{L}\\p{N}+#])`, flags) };
}

// Longest forms first so "Apache Kafka" wins over "Kafka", "React Native" over "React".
const PATTERNS: Pattern[] = SKILL_ENTRIES.flatMap((e) => [e.canonical, ...e.aliases].map((f) => buildPattern(e, f))).sort(
  (a, b) => b.form.length - a.form.length,
);

/** Finds known skills in free text (deduplicated by skill, keeping the first occurrence). */
export function findSkills(text: string): SkillHit[] {
  const taken: Array<[number, number]> = [];
  const hits = new Map<string, SkillHit>();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const start = m.index + m[1]!.length;
      const end = start + m[2]!.length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      const prev = hits.get(p.entry.id);
      if (!prev || start < prev.index) hits.set(p.entry.id, { skill: p.entry, matched: m[2]!, index: start });
    }
  }
  return [...hits.values()].sort((a, b) => a.index - b.index);
}

export function lookupSkill(name: string): SkillEntry | undefined {
  return byNorm.get(normTerm(name));
}

/** Canonical display name for a skill string; unknown skills keep their original text. */
export function canonicalSkill(name: string): string {
  return lookupSkill(name)?.canonical ?? name.trim();
}

const NON_SIBLING_FAMILIES = new Set(['lang', 'soft', 'web', 'office', 'process', 'api']);

/** Taxonomy siblings (e.g. Kafka ~ Kinesis) earn partial credit (architecture.md §7.2). */
export function areSiblings(a: string, b: string): boolean {
  const ea = lookupSkill(a);
  const eb = lookupSkill(b);
  if (!ea || !eb || ea.id === eb.id) return false;
  return ea.family === eb.family && !NON_SIBLING_FAMILIES.has(ea.family);
}

export function sameSkill(a: string, b: string): boolean {
  const ea = lookupSkill(a);
  const eb = lookupSkill(b);
  if (ea && eb) return ea.id === eb.id;
  return normTerm(a) === normTerm(b);
}

export function releaseYear(name: string): number | undefined {
  return lookupSkill(name)?.year;
}

/** Text mention check that honours aliases ("k8s" counts for "Kubernetes"). */
export function textMentionsSkill(text: string, skill: string): boolean {
  const e = lookupSkill(skill);
  if (!e) return containsTerm(text, skill);
  return [e.canonical, ...e.aliases].some((f) => buildPattern(e, f).re.test(text));
}

// ── Titles ──
const SENIORITY = new Set(SENIORITY_WORDS);

export function normalizeTitle(t: string): string {
  return normTerm(t)
    .replace(/[,/()|-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !SENIORITY.has(w))
    .join(' ')
    .trim();
}

export function titleFamily(t: string): string | undefined {
  const n = normalizeTitle(t);
  for (const [fam, variants] of Object.entries(TITLE_FAMILIES)) {
    if (n === fam || n.includes(fam) || variants.some((v) => n === v || n.includes(v))) return fam;
  }
  return undefined;
}

function tokens(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Title alignment bucket (architecture.md §7.3): 1 identical, 0.6 same role different seniority
 * or same family, 0.3 partial token overlap, 0 unrelated.
 */
export function titleSimilarity(target: string, candidate: string): number {
  if (!target.trim() || !candidate.trim()) return 0;
  if (normTerm(target) === normTerm(candidate)) return 1;
  const a = normalizeTitle(target);
  const b = normalizeTitle(candidate);
  if (a && a === b) return 0.6;
  const fa = titleFamily(target);
  const fb = titleFamily(candidate);
  if (fa && fa === fb) return 0.6;
  const ta = new Set(tokens(a));
  const tb = tokens(b);
  const overlap = tb.filter((x) => ta.has(x)).length;
  if (overlap > 0 && overlap / Math.max(ta.size, 1) >= 0.5) return 0.3;
  return 0;
}

// ── Verb ladder for G5 (architecture.md §6.4) ──
export const VERB_LADDER = ['familiar', 'used', 'assisted', 'contributed', 'built', 'implemented', 'designed', 'led', 'owned'] as const;

const VERB_SYNONYMS: Record<string, (typeof VERB_LADDER)[number]> = {
  familiar: 'familiar', exposure: 'familiar', learned: 'familiar', studied: 'familiar',
  used: 'used', utilized: 'used', worked: 'used', applied: 'used', operated: 'used', maintained: 'used', supported: 'assisted',
  assisted: 'assisted', helped: 'assisted', aided: 'assisted',
  contributed: 'contributed', participated: 'contributed', collaborated: 'contributed', partnered: 'contributed',
  built: 'built', developed: 'built', created: 'built', wrote: 'built', coded: 'built', programmed: 'built', automated: 'built', produced: 'built', prepared: 'built', analyzed: 'built', analysed: 'built',
  implemented: 'implemented', deployed: 'implemented', delivered: 'implemented', shipped: 'implemented', launched: 'implemented', migrated: 'implemented', integrated: 'implemented', optimized: 'implemented', improved: 'implemented', reduced: 'implemented', increased: 'implemented',
  designed: 'designed', architected: 'designed', engineered: 'designed', modeled: 'designed', modelled: 'designed',
  led: 'led', managed: 'led', headed: 'led', directed: 'led', spearheaded: 'led', supervised: 'led', mentored: 'led', coordinated: 'contributed',
  owned: 'owned', founded: 'owned', established: 'owned', pioneered: 'owned',
};

export function verbRank(word: string): number | undefined {
  const base = VERB_SYNONYMS[word.toLowerCase().replace(/[^a-z]/g, '')];
  return base ? VERB_LADDER.indexOf(base) : undefined;
}

/** Highest-ranked ownership verb found in a bullet (first three words weigh most, but any verb counts). */
export function maxVerbRank(text: string): number | undefined {
  let best: number | undefined;
  for (const w of text.split(/[^A-Za-z]+/)) {
    const r = verbRank(w);
    if (r !== undefined && (best === undefined || r > best)) best = r;
  }
  return best;
}

export function leadingVerbRank(text: string): number | undefined {
  const first = text.replace(/^[\s•▪\-–*·]+/, '').split(/\s+/)[0] ?? '';
  return verbRank(first);
}

// ── Degrees ──
export function degreeLevel(text: string): number {
  const t = ` ${normTerm(text)} `;
  if (/\b(ph\.?d|doctorate|doctoral|d\.phil)\b/.test(t)) return 4;
  if (/\b(master'?s?|m\.?s\.?|m\.?sc|mba|m\.?eng|m\.?a\.?)\b/.test(t)) return 3;
  if (/\b(bachelor'?s?|b\.?s\.?|b\.?sc|b\.?a\.?|b\.?eng|b\.?tech|undergraduate degree|4-year degree)\b/.test(t)) return 2;
  if (/\b(associate'?s?|a\.?a\.?s?|diploma)\b/.test(t)) return 1;
  if (/\bdegree\b/.test(t)) return 2;
  return 0;
}

// ── Lexical helpers ──
export const STOPWORDS = new Set(
  (
    'a an and or the of to in on for with by at from as is are be been being this that these those it its our your you we they ' +
    'will would should can could may might must have has had do does did not no nor but if then than so such into over under ' +
    'about across within per via using use used experience experiences strong ability able excellent good great knowledge understanding ' +
    'work working team teams role job position candidate candidates including include includes etc other others new plus preferred required ' +
    'requirements responsibilities qualifications skills skill years year least minimum ideally also well both each any all more most'
  ).split(/\s+/),
);

/** Very small stemmer: enough to align "building/builds/built" and "pipelines/pipeline". */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith('es') && !s.endsWith('ses')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  return s;
}

export function contentTokens(text: string): string[] {
  return normTerm(text)
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/** Share of the requirement's content tokens present in the candidate text ∈ [0,1]. */
export function tokenCoverage(requirement: string, candidate: string): number {
  const req = [...new Set(contentTokens(requirement))];
  if (!req.length) return 0;
  const cand = new Set(contentTokens(candidate));
  return req.filter((t) => cand.has(t)).length / req.length;
}
