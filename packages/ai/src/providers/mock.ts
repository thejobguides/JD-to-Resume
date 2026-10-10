import { newNumbers } from '@jmo/evidence';
import { analyzeJobText } from '@jmo/job-extraction';
import { structureResume } from '@jmo/resume';
import { containsTerm, type SpanLine } from '@jmo/shared';
import { findSkills, lookupSkill, maxVerbRank, sameSkill, textMentionsSkill, tokenCoverage } from '@jmo/taxonomy';
import type { JdExtractOutput, MatchMapOutput, OptimizeOutput, OptimizePromptInput, RepairOutput, ResumeExtractOutput, ValidateEntailOutput } from '../prompts';
import { type AIProvider, type GenerateArgs, type GenerateResult, ProviderError } from '../types';
import { estimateTokens } from './http';

// Deterministic "mock" provider: rule-based answers for every task so the whole product works locally
// without API keys, and so tests are reproducible. It follows the same evidence rules as the real prompts.

type OptResumeIn = {
  roles: Array<{ role_id: string; bullets: Array<{ bullet_id: string; text: string; claim_ids: string[] }> }>;
  summary?: { summary_id: string; text: string; claim_ids: string[] };
  skills: Array<{ skill_id: string; name: string; evidence_level: 'demonstrated' | 'listed_only' }>;
};
type ClaimIn = { claim_id: string; type: string; value: unknown; text: string; role_id?: string };

function jd(input: { jd_text: string; hint?: Record<string, unknown> }): JdExtractOutput {
  const hint = input.hint ?? {};
  const a = analyzeJobText(input.jd_text, {
    ...(typeof hint.title === 'string' ? { title: hint.title } : {}),
    ...(typeof hint.company === 'string' ? { company: hint.company } : {}),
    ...(Array.isArray(hint.location) ? { location: hint.location as string[] } : {}),
  });
  return {
    title: a.title,
    company: a.company,
    location: a.location,
    employment_type: a.employment_type ?? null,
    work_mode: a.work_mode,
    salary: a.salary ? { min: a.salary.min ?? null, max: a.salary.max ?? null, currency: a.salary.currency ?? null, interval: a.salary.interval ?? null } : null,
    requirements: a.requirements.map((r) => ({ req_id: r.req_id, type: r.type, hard: r.hard, text: r.text, skills: r.skills, years_min: r.years_min ?? null, years_max: r.years_max ?? null, quote: r.quote })),
    keywords: a.keywords,
    injection_suspected: a.flags.injection_suspected,
  };
}

function resume(input: { lines: SpanLine[] }): ResumeExtractOutput {
  const r = structureResume(
    { kind: 'txt', lines: input.lines.map((l) => ({ ...l, style: l.style ?? {}, hidden: false, region: 'body' })), pages: 1, warnings: [], columns_detected: false, hidden_text_found: false, contact_in_header_only: false, tables_or_textboxes: false, text_extractable: true, links: [] },
    { resumeId: 'mock', versionId: 'mock' },
  );
  const c = (f?: { value: unknown; prov: { span_ids: string[] } }) => (f ? { value: String(typeof f.value === 'object' && f.value && 'url' in f.value ? (f.value as { url: string }).url : f.value), span_ids: f.prov.span_ids } : null);
  return {
    full_name: c(r.personal.full_name),
    headline: c(r.personal.headline),
    emails: r.personal.emails.map((e) => c(e)!),
    phones: r.personal.phones.map((e) => c(e)!),
    location: c(r.personal.location),
    links: r.personal.links.map((e) => c(e)!),
    summary: c(r.summary),
    roles: r.experience.map((x) => ({ employer: c(x.employer)!, title: c(x.title)!, location: c(x.location), start: c(x.start), end: c(x.end), bullets: x.bullets.map((b) => ({ text: b.text, span_ids: b.prov.span_ids })) })),
    education: r.education.map((e) => ({ institution: c(e.institution)!, degree: c(e.degree), field_of_study: c(e.field_of_study), start: c(e.start), end: c(e.end) })),
    skills: r.skills.map((s) => c(s.name)!),
    certifications: r.certifications.map((x) => ({ name: c(x.name)!, issuer: c(x.issuer), date: c(x.date) })),
    projects: r.projects.map((p) => ({ name: c(p.name)!, bullets: p.bullets.map((b) => ({ text: b.text, span_ids: b.prov.span_ids })) })),
  };
}

function match(input: { requirements: Array<{ req_id: string; text: string; type: string }>; evidence: ClaimIn[] }): MatchMapOutput {
  return {
    mappings: input.requirements.map((r) => {
      if (r.type === 'location') return { req_id: r.req_id, state: 'unknown' as const, claim_ids: [], rationale: 'Cannot be judged from a resume' };
      let best: { c: ClaimIn; s: number } | null = null;
      for (const c of input.evidence) {
        const s = tokenCoverage(r.text, c.text);
        if (!best || s > best.s) best = { c, s };
      }
      const s = best?.s ?? 0;
      const state = s >= 0.6 ? 'strong' : s >= 0.4 ? 'partial' : s >= 0.25 ? 'weak' : 'none';
      return { req_id: r.req_id, state, claim_ids: state === 'none' || !best ? [] : [best.c.claim_id], rationale: state === 'none' ? 'No related evidence' : `Overlaps "${best!.c.text.slice(0, 60)}"` };
    }),
  };
}

function optimize(input: OptimizePromptInput): OptimizeOutput {
  const r = input.resume as OptResumeIn;
  const claims = input.claims as ClaimIn[];
  const changed = new Map<string, OptimizeOutput['bullets'][number]>();
  const notAddressable: OptimizeOutput['not_addressable'] = [];
  const budget = input.edit_budget.bullets;
  const allBullets = r.roles.flatMap((role) => role.bullets.map((b) => ({ role, b })));

  for (const t of input.targets) {
    // Use the job's own wording ("Kafka", not "Apache Kafka") for each skill the requirement mentions.
    const worded = new Map<string, string>();
    for (const h of findSkills(t.text)) worded.set(h.skill.canonical, h.matched);
    for (const s of t.skills) {
      const c = lookupSkill(s)?.canonical ?? s;
      if (!worded.has(c)) worded.set(c, s);
    }
    let addressed = false;
    for (const [canonical, jdWord] of worded) {
      // Evidence in a bullet worded differently from the job (alias) → use the job's term.
      for (const { role, b } of allBullets) {
        const cur = changed.get(b.bullet_id)?.text ?? b.text;
        if (containsTerm(cur, jdWord) || containsTerm(cur, canonical)) {
          addressed = true;
          continue;
        }
        const hit = findSkills(cur).find((h) => sameSkill(h.skill.canonical, canonical));
        if (!hit) continue;
        if (!changed.has(b.bullet_id) && changed.size >= budget) break;
        const text = cur.replace(hit.matched, jdWord);
        const prev = changed.get(b.bullet_id);
        changed.set(b.bullet_id, {
          bullet_id: b.bullet_id,
          role_id: role.role_id,
          source_bullet_ids: [b.bullet_id],
          text,
          claim_ids: b.claim_ids,
          emphasized_req_ids: [...new Set([...(prev?.emphasized_req_ids ?? []), t.req_id])],
          why: `Uses the job's term "${jdWord}" for your existing ${hit.matched} experience`,
        });
        addressed = true;
      }
      if (!addressed && r.skills.some((x) => sameSkill(x.name, canonical))) addressed = true; // listed: surfaced via skills order
    }
    if (!addressed && worded.size) notAddressable.push({ req_id: t.req_id, reason: 'no_evidence' });
  }

  // Summary: mention up to three demonstrated, job-relevant skills using the job's wording.
  let summary: OptimizeOutput['summary'] = null;
  if (input.edit_budget.summary && r.summary) {
    const targetSkills = [...new Set(input.targets.flatMap((t) => { const hits = findSkills(t.text).map((h) => h.matched); return hits.length ? hits : t.skills; }))];
    const demonstrated = targetSkills.filter((s) => allBullets.some(({ b }) => textMentionsSkill(changed.get(b.bullet_id)?.text ?? b.text, s)) && !textMentionsSkill(r.summary!.text, s)).slice(0, 3);
    if (demonstrated.length) {
      const list = demonstrated.length === 1 ? demonstrated[0] : `${demonstrated.slice(0, -1).join(', ')} and ${demonstrated[demonstrated.length - 1]}`;
      const base = r.summary.text.replace(/\s+$/, '');
      const cited = claims.filter((c) => (c.type === 'tool' || c.type === 'skill') && typeof c.value === 'string' && demonstrated.some((s) => sameSkill(String(c.value), s)) && c.role_id).map((c) => c.claim_id);
      summary = { text: `${base}${/[.!?]$/.test(base) ? '' : '.'} Hands-on experience with ${list}.`, claim_ids: [...new Set(cited)].slice(0, 6) };
    }
  }

  // Skills order: job-relevant first (demonstrated before listed), then the rest.
  const relevant = (name: string) => input.targets.some((t) => t.skills.some((s) => sameSkill(s, name)) || textMentionsSkill(t.text, name));
  const skills_order = input.edit_budget.skills_order
    ? [...r.skills.filter((s) => relevant(s.name) && s.evidence_level === 'demonstrated'), ...r.skills.filter((s) => relevant(s.name) && s.evidence_level !== 'demonstrated'), ...r.skills.filter((s) => !relevant(s.name))].map((s) => s.skill_id)
    : [];

  return { summary, bullets: [...changed.values()].slice(0, budget), skills_order, not_addressable: notAddressable };
}

function entail(input: { pairs: Array<{ bullet_id: string; rewritten: string; evidence_texts: string[] }> }): ValidateEntailOutput {
  return {
    results: input.pairs.map((p) => {
      const ev = p.evidence_texts.join(' \n ');
      const issues: string[] = [];
      for (const n of newNumbers(p.rewritten, p.evidence_texts)) issues.push(`new_number:${n.raw}`);
      for (const h of findSkills(p.rewritten)) if (!p.evidence_texts.some((t) => textMentionsSkill(t, h.skill.canonical))) issues.push(`new_tool:${h.matched}`);
      const outRank = maxVerbRank(p.rewritten);
      const evRank = maxVerbRank(ev);
      if (outRank !== undefined && evRank !== undefined && outRank > evRank) issues.push('ownership_upgrade');
      const coverage = tokenCoverage(p.rewritten, ev);
      const verdict = issues.some((i) => i.startsWith('new_')) ? 'unsupported' : issues.length ? 'embellished' : coverage >= 0.6 ? 'entailed' : 'unsupported';
      return { bullet_id: p.bullet_id, verdict, issues };
    }),
  };
}

function repairFn(input: { items: Array<{ bullet_id: string; evidence_texts: string[]; claim_ids: string[] }> }): RepairOutput {
  return { bullets: input.items.map((i) => ({ bullet_id: i.bullet_id, text: i.evidence_texts[0] ?? '', claim_ids: i.claim_ids })) };
}

export function mockProvider(): AIProvider {
  return {
    kind: 'mock',
    async generate(a: GenerateArgs): Promise<GenerateResult> {
      let out: unknown;
      switch (a.task) {
        case 'jd_extract':
          out = jd(a.input as Parameters<typeof jd>[0]);
          break;
        case 'resume_extract':
          out = resume(a.input as Parameters<typeof resume>[0]);
          break;
        case 'match_map':
          out = match(a.input as Parameters<typeof match>[0]);
          break;
        case 'optimize':
          out = optimize(a.input as OptimizePromptInput);
          break;
        case 'validate_entail':
          out = entail(a.input as Parameters<typeof entail>[0]);
          break;
        case 'repair':
          out = repairFn(a.input as Parameters<typeof repairFn>[0]);
          break;
        default:
          throw new ProviderError('invalid_request', 'mock: unknown task');
      }
      const text = JSON.stringify(out);
      return { text, stopReason: 'end', usage: { inputTokens: estimateTokens(a.system + a.user), cachedInputTokens: 0, outputTokens: estimateTokens(text), reasoningTokens: 0, estimated: true } };
    },
  };
}
