import { findSkills, maxVerbRank, releaseYear, sameSkill, textMentionsSkill, VERB_LADDER } from '@jmo/taxonomy';
import { endYear, totalYears } from './dates';
import { newNumbers } from './numbers';

// Deterministic validation gates G1–G6 (+G8 style flags), architecture.md §6.4.
// Used server-side in the optimization workflow and again in the extension (defence in depth, BYOK).

export interface EvidenceClaim {
  claim_id: string;
  type: string;
  value: unknown;
  text: string;
  role_id?: string | undefined;
}

export interface GateRole {
  role_id: string;
  employer: string;
  title: string;
  start?: string | undefined;
  end?: string | undefined;
  bullets: Array<{ bullet_id: string; text: string; claim_ids: string[] }>;
}

export interface GateContext {
  roles: GateRole[];
  claims: Map<string, EvidenceClaim>;
  skills: Array<{ skill_id: string; name: string; evidence_level: 'demonstrated' | 'listed_only' }>;
  now: Date;
}

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G8';

export interface Violation {
  gate: GateId;
  code: string;
  detail: string;
  /** soft violations need an "entailed" G7 verdict to pass; hard ones always fail */
  soft?: boolean;
}

export interface GateReport {
  ok: boolean;
  violations: Violation[];
  style: Violation[];
}

export interface ProposedBullet {
  bullet_id: string;
  role_id: string;
  source_bullet_ids: string[];
  text: string;
  claim_ids: string[];
}

const COMMON_CAPS = new Set(
  'I A An The And Or Of In On For To With By At From As Our My We Team Teams Company Q1 Q2 Q3 Q4 Jan Feb Mar Apr May Jun Jul Aug Sep Sept Oct Nov Dec January February March April June July August September October November December Monday Tuesday Wednesday Thursday Friday Senior Junior Lead Principal Staff'.split(
    ' ',
  ),
);

const PROFICIENCY_UP = /\b(expert|expertise|advanced|proficient|mastery|deep (?:knowledge|expertise)|authority|guru|ninja)\b/i;

/** Capitalized n-grams that are not sentence-initial (candidate proper nouns: orgs, products, certs). */
export function properNouns(text: string): string[] {
  const out: string[] = [];
  const sentences = text.split(/(?<=[.!?;:])\s+|\n+/);
  for (const s of sentences) {
    const words = s.replace(/^[\s•▪\-–*·]+/, '').split(/\s+/);
    let cur: string[] = [];
    words.forEach((raw, i) => {
      const w = raw.replace(/^[("'“]+|[)"'”,.;:!?]+$/g, '');
      const isCap = /^[A-Z][A-Za-z0-9&.+#/-]*$/.test(w);
      if (isCap && i > 0 && !COMMON_CAPS.has(w)) cur.push(w);
      else {
        if (cur.length) out.push(cur.join(' '));
        cur = [];
      }
    });
    if (cur.length) out.push(cur.join(' '));
  }
  return out;
}

function evidenceTextsFor(p: ProposedBullet, ctx: GateContext): { texts: string[]; sourceTexts: string[]; role?: GateRole } {
  const role = ctx.roles.find((r) => r.role_id === p.role_id);
  const sourceTexts = role ? role.bullets.filter((b) => p.source_bullet_ids.includes(b.bullet_id)).map((b) => b.text) : [];
  const cited = p.claim_ids.map((id) => ctx.claims.get(id)).filter((c): c is EvidenceClaim => !!c);
  const texts = [...sourceTexts, ...cited.map((c) => c.text), ...(role ? [role.title, role.employer] : [])];
  return { texts, sourceTexts, ...(role ? { role } : {}) };
}

export function styleFlags(text: string): Violation[] {
  const flags: Violation[] = [];
  if (/\b(I|my|me|I'm|I've)\b/.test(text)) flags.push({ gate: 'G8', code: 'first_person', detail: 'Uses first person' });
  if (text.length > 260) flags.push({ gate: 'G8', code: 'too_long', detail: `${text.length} characters (≈ more than 2 lines)` });
  const parts = text.split(',').map((x) => x.trim());
  if (parts.length >= 5 && parts.filter((x) => x.split(/\s+/).length <= 2).length >= 5) {
    flags.push({ gate: 'G8', code: 'keyword_list', detail: 'Looks like a keyword list inside a bullet' });
  }
  return flags;
}

/** Runs G1–G6 on one proposed bullet. */
export function checkBullet(p: ProposedBullet, ctx: GateContext): GateReport {
  const violations: Violation[] = [];
  const role = ctx.roles.find((r) => r.role_id === p.role_id);

  // G1 referential integrity + cross-role transplant.
  if (!role) violations.push({ gate: 'G1', code: 'unknown_role', detail: p.role_id });
  if (!p.source_bullet_ids.length) violations.push({ gate: 'G1', code: 'no_source_bullet', detail: p.bullet_id });
  for (const id of p.source_bullet_ids) {
    if (!role?.bullets.some((b) => b.bullet_id === id)) violations.push({ gate: 'G1', code: 'unknown_or_foreign_bullet', detail: id });
  }
  for (const id of p.claim_ids) {
    const c = ctx.claims.get(id);
    if (!c) violations.push({ gate: 'G1', code: 'unknown_claim', detail: id });
    else if (c.role_id && c.role_id !== p.role_id) violations.push({ gate: 'G1', code: 'cross_role_transplant', detail: `${id} belongs to ${c.role_id}` });
    else if (!c.role_id && (c.type === 'skill' || c.type === 'tool')) {
      violations.push({ gate: 'G4', code: 'listed_only_promoted', detail: `${String(c.value)} is only in the skills list`, soft: true });
    }
  }

  const { texts, sourceTexts } = evidenceTextsFor(p, ctx);

  // G2 numbers.
  for (const n of newNumbers(p.text, texts)) violations.push({ gate: 'G2', code: 'new_number', detail: n.raw });

  // G3 entities: skills/tools by canonical identity, then remaining proper nouns by text.
  const evidenceSkills = new Set<string>();
  for (const t of texts) for (const h of findSkills(t)) evidenceSkills.add(h.skill.canonical);
  for (const id of p.claim_ids) {
    const c = ctx.claims.get(id);
    if (c && (c.type === 'tool' || c.type === 'skill') && typeof c.value === 'string') evidenceSkills.add(c.value);
  }
  const outSkills = findSkills(p.text);
  for (const h of outSkills) {
    if (![...evidenceSkills].some((s) => sameSkill(s, h.skill.canonical))) {
      violations.push({ gate: 'G3', code: 'new_skill_or_tool', detail: h.matched });
    }
  }
  const evidenceBlob = texts.join(' \n ').toLowerCase();
  const skillForms = new Set(outSkills.map((h) => h.matched.toLowerCase()));
  for (const pn of properNouns(p.text)) {
    const words = pn.split(/\s+/).filter((w) => !skillForms.has(w.toLowerCase()) && ![...evidenceSkills].some((s) => textMentionsSkill(w, s)));
    const missing = words.filter((w) => !evidenceBlob.includes(w.toLowerCase().replace(/[.,]+$/, '')));
    if (missing.length) violations.push({ gate: 'G3', code: 'new_entity', detail: missing.join(' ') });
  }

  // G5 ownership/scope ladder and proficiency upgrades.
  const outRank = maxVerbRank(p.text);
  const evRanks = sourceTexts.map(maxVerbRank).filter((x): x is number => x !== undefined);
  const evRank = evRanks.length ? Math.max(...evRanks) : VERB_LADDER.indexOf('built');
  if (outRank !== undefined && outRank > evRank) {
    violations.push({ gate: 'G5', code: 'ownership_upgrade', detail: `${VERB_LADDER[outRank]} > ${VERB_LADDER[evRank]}` });
  }
  if (PROFICIENCY_UP.test(p.text) && !sourceTexts.some((t) => PROFICIENCY_UP.test(t))) {
    violations.push({ gate: 'G5', code: 'proficiency_upgrade', detail: p.text.match(PROFICIENCY_UP)?.[0] ?? '' });
  }

  // G6 anachronism: a tool newer than the role, introduced by the rewrite.
  const roleEnd = endYear(role?.end ?? 'present', ctx.now);
  if (roleEnd) {
    for (const h of outSkills) {
      const y = releaseYear(h.skill.canonical);
      const alreadyThere = sourceTexts.some((t) => textMentionsSkill(t, h.skill.canonical));
      if (y && y > roleEnd && !alreadyThere) violations.push({ gate: 'G6', code: 'anachronism', detail: `${h.skill.canonical} (${y}) in a role ending ${roleEnd}` });
    }
  }

  return { ok: violations.length === 0, violations, style: styleFlags(p.text) };
}

const YEARS_CLAIM = /\b(\d{1,2})\+?\s*(?:years?|yrs?)\b/i;

/** Summary may use claims from anywhere in the resume, but no new numbers/entities and no years inflation. */
export function checkSummary(text: string, claimIds: string[], ctx: GateContext, originalSummary: string | null): GateReport {
  const violations: Violation[] = [];
  const cited = claimIds.map((id) => ctx.claims.get(id));
  cited.forEach((c, i) => {
    if (!c) violations.push({ gate: 'G1', code: 'unknown_claim', detail: claimIds[i]! });
  });
  const allTexts = [...ctx.claims.values()].map((c) => c.text);
  const evidence = [...cited.filter(Boolean).map((c) => c!.text), ...(originalSummary ? [originalSummary] : [])];
  for (const n of newNumbers(text.replace(YEARS_CLAIM, ''), evidence)) violations.push({ gate: 'G2', code: 'new_number', detail: n.raw });

  const anySkills = new Set<string>();
  for (const t of [...allTexts, ...ctx.skills.map((s) => s.name)]) for (const h of findSkills(t)) anySkills.add(h.skill.canonical);
  for (const h of findSkills(text)) {
    if (![...anySkills].some((s) => sameSkill(s, h.skill.canonical))) violations.push({ gate: 'G3', code: 'new_skill_or_tool', detail: h.matched });
  }
  const blob = [...allTexts, ...ctx.roles.flatMap((r) => [r.title, r.employer]), originalSummary ?? ''].join(' \n ').toLowerCase();
  for (const pn of properNouns(text)) {
    const missing = pn.split(/\s+/).filter((w) => !blob.includes(w.toLowerCase()) && !findSkills(w).length);
    if (missing.length) violations.push({ gate: 'G3', code: 'new_entity', detail: missing.join(' ') });
  }
  const years = text.match(YEARS_CLAIM);
  if (years) {
    const claimed = Number(years[1]);
    const actual = totalYears(ctx.roles.map((r) => ({ start: r.start, end: r.end })), ctx.now);
    const originalYears = originalSummary?.match(YEARS_CLAIM);
    const allowed = Math.max(actual ?? 0, originalYears ? Number(originalYears[1]) : 0);
    if (claimed > Math.floor(allowed + 0.5)) violations.push({ gate: 'G5', code: 'years_inflation', detail: `${claimed} years claimed, evidence supports ${allowed}` });
  }
  if (PROFICIENCY_UP.test(text) && !(originalSummary && PROFICIENCY_UP.test(originalSummary))) {
    violations.push({ gate: 'G5', code: 'proficiency_upgrade', detail: text.match(PROFICIENCY_UP)?.[0] ?? '' });
  }
  return { ok: violations.length === 0, violations, style: /\b(I|my|me)\b/.test(text) ? [{ gate: 'G8', code: 'first_person', detail: 'Uses first person' }] : [] };
}

/** G4: the skills order may only reorder/subset existing skills. */
export function checkSkillsOrder(order: string[], ctx: GateContext): GateReport {
  const known = new Set(ctx.skills.map((s) => s.skill_id));
  const violations: Violation[] = order.filter((id) => !known.has(id)).map((id) => ({ gate: 'G4' as const, code: 'unknown_skill', detail: id }));
  if (new Set(order).size !== order.length) violations.push({ gate: 'G4', code: 'duplicate_skill', detail: 'duplicates in skills_order' });
  return { ok: violations.length === 0, violations, style: [] };
}

/** Helper to build a GateContext from the optimization payload. */
export function buildGateContext(input: {
  roles: GateRole[];
  claims: EvidenceClaim[];
  skills: GateContext['skills'];
  now?: Date;
}): GateContext {
  return { roles: input.roles, claims: new Map(input.claims.map((c) => [c.claim_id, c])), skills: input.skills, now: input.now ?? new Date() };
}
