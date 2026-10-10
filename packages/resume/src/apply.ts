import type { CanonicalResume, OptimizationResult, OptResume } from '@jmo/shared';

// Applies the user's accepted changes to a canonical resume, producing a new version.

export interface Acceptance {
  bullets: Set<string> | 'all_verified';
  summary: boolean;
  skillsOrder: boolean;
  /** user-edited text per bullet (already re-validated locally) */
  edits?: Record<string, string>;
}

export function applyOptimization(resume: CanonicalResume, result: OptimizationResult, accept: Acceptance, newVersionId: string): CanonicalResume {
  const next: CanonicalResume = structuredClone(resume);
  next.version_id = newVersionId;
  const isAccepted = (id: string, validation: string) =>
    accept.bullets === 'all_verified' ? validation === 'entailed' : accept.bullets.has(id);

  for (const change of result.bullets) {
    if (!isAccepted(change.bullet_id, change.validation) && !accept.edits?.[change.bullet_id]) continue;
    for (const role of next.experience) {
      const idx = role.bullets.findIndex((b) => b.bullet_id === change.bullet_id);
      if (idx < 0) continue;
      const b = role.bullets[idx]!;
      const merged = change.source_bullet_ids.filter((id) => id !== change.bullet_id);
      b.text = accept.edits?.[change.bullet_id] ?? change.text;
      b.prov = { span_ids: [...b.prov.span_ids, ...role.bullets.filter((x) => merged.includes(x.bullet_id)).flatMap((x) => x.prov.span_ids)], source: accept.edits?.[change.bullet_id] ? 'user_edit' : 'llm' };
      // Bullets merged into this one are removed.
      role.bullets = role.bullets.filter((x) => !merged.includes(x.bullet_id));
    }
  }
  if (accept.summary && result.summary && next.summary) {
    next.summary = { ...next.summary, value: result.summary.text, prov: { span_ids: next.summary.prov.span_ids, source: 'llm' } };
  } else if (accept.summary && result.summary && !next.summary) {
    next.summary = { summary_id: 'sum_1', value: result.summary.text, prov: { span_ids: [], source: 'llm' }, confidence: 1, user_confirmed: false };
  }
  if (accept.skillsOrder && result.skills_order.length) {
    const byId = new Map(next.skills.map((s) => [s.skill_id, s]));
    const ordered = result.skills_order.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
    const rest = next.skills.filter((s) => !result.skills_order.includes(s.skill_id));
    next.skills = [...ordered, ...rest];
  }
  return next;
}

/** Minimized, pseudonymized payload for POST /v1/optimizations (no contact data). */
export function toOptResume(r: CanonicalResume): OptResume {
  return {
    version_id: r.version_id,
    roles: r.experience.map((role) => ({
      role_id: role.role_id,
      employer: role.employer.value,
      title: role.title.value,
      ...(role.start?.value ? { start: role.start.value } : {}),
      ...(role.end?.value ? { end: role.end.value } : {}),
      bullets: role.bullets.map((b) => ({ bullet_id: b.bullet_id, text: b.text, claim_ids: b.claim_ids })),
    })),
    ...(r.summary ? { summary: { summary_id: r.summary.summary_id, text: pseudonymize(r.summary.value, r), claim_ids: [] } } : {}),
    skills: r.skills.map((s) => ({ skill_id: s.skill_id, name: s.name.value, evidence_level: s.evidence_level })),
  };
}

/** Replace the user's name, email, phone and profile URLs with placeholders (architecture.md §17). */
export function pseudonymize(text: string, r: CanonicalResume): string {
  let t = text;
  const repl: Array<[string | undefined, string]> = [
    [r.personal.full_name?.value, '{{NAME}}'],
    ...r.personal.emails.map((e) => [e.value, '{{EMAIL}}'] as [string, string]),
    ...r.personal.phones.map((p) => [p.value, '{{PHONE}}'] as [string, string]),
    ...r.personal.links.map((l) => [l.value.url, '{{URL}}'] as [string, string]),
  ];
  for (const [v, ph] of repl) if (v && v.length > 2) t = t.split(v).join(ph);
  return t;
}
