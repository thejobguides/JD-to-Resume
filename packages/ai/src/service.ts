import { buildGateContext, checkBullet, checkSkillsOrder, checkSummary, type EvidenceClaim, type GateContext, type ProposedBullet, type Violation } from '@jmo/evidence';
import { analyzeJobText, validateAnalysisQuotes } from '@jmo/job-extraction';
import { structureResume, validateCitations } from '@jmo/resume';
import type { CanonicalResume, ChangedBullet, ClaimLite, JobAnalysis, MatchMapResponse, OptimizationResult, OptimizeRequest, SpanLine, Verdict } from '@jmo/shared';
import { field } from '@jmo/shared';
import { findSkills } from '@jmo/taxonomy';
import { jdExtract, matchMap, optimize, repair, resumeExtract, type ResumeExtractOutput, validateEntail } from './prompts';
import type { AIRouter } from './router';
import type { RunContext } from './types';

// ResumeAIService facade (api-design.md §10): used by the API workflow (hosted) and the side panel (BYOK).

export type ProgressFn = (e: { status: 'running' | 'validating' | 'repairing'; step: string; progress: number }) => void | Promise<void>;

export interface OptimizeOutcome {
  result: OptimizationResult;
  meta: { models: string[]; prompt_versions: string[]; gates: Record<string, number>; duration_ms: number; cost_usd: number };
}

export class ResumeAIService {
  constructor(
    private router: AIRouter,
    private now: () => Date = () => new Date(),
  ) {}

  /** S1: jd_extract@v1 + verbatim-quote validation; falls back to the deterministic analyzer. */
  async analyzeJob(jdText: string, hint: { title?: string; company?: string; location?: string[]; host?: string } = {}, ctx: RunContext = {}): Promise<{ analysis: JobAnalysis; model: string; cost_usd: number; fallback: boolean }> {
    try {
      const r = await this.router.run(jdExtract, { jd_text: jdText, ...(hint.host ? { host: hint.host } : {}), hint }, ctx);
      const o = r.output;
      const analysis: JobAnalysis = {
        schema_version: '1.0',
        title: o.title || hint.title || '',
        company: o.company || hint.company || '',
        location: o.location.length ? o.location : (hint.location ?? []),
        work_mode: o.work_mode,
        ...(o.employment_type ? { employment_type: o.employment_type } : {}),
        ...(o.salary && (o.salary.min || o.salary.max)
          ? { salary: { ...(o.salary.min ? { min: o.salary.min } : {}), ...(o.salary.max ? { max: o.salary.max } : {}), ...(o.salary.currency ? { currency: o.salary.currency } : {}), ...(o.salary.interval ? { interval: o.salary.interval } : {}), stated: true } }
          : {}),
        requirements: o.requirements.map((q, i) => ({
          req_id: /^req_[A-Za-z0-9_]+$/.test(q.req_id) ? q.req_id : `req_${i + 1}`,
          type: q.type,
          hard: q.hard,
          text: q.text.slice(0, 600),
          skills: q.skills.slice(0, 12),
          ...(q.years_min !== null ? { years_min: q.years_min } : {}),
          ...(q.years_max !== null ? { years_max: q.years_max } : {}),
          quote: q.quote.slice(0, 800),
        })),
        keywords: o.keywords.slice(0, 25),
        flags: { injection_suspected: o.injection_suspected, truncated: false },
        quality: 0.9,
        prompt_version: r.promptVersion,
      };
      const { analysis: validated, dropped } = validateAnalysisQuotes(analysis, jdText);
      validated.quality = Math.max(0.5, 0.95 - dropped.length * 0.05);
      if (validated.requirements.length === 0) throw new Error('no valid requirements');
      return { analysis: validated, model: r.model.id, cost_usd: r.costUsd, fallback: r.fallbackUsed };
    } catch {
      const analysis = analyzeJobText(jdText, hint);
      return { analysis, model: 'deterministic', cost_usd: 0, fallback: true };
    }
  }

  /** S2: resume_extract@v1 + span-fidelity validation; falls back to the heuristic structurer. */
  async structureResume(lines: SpanLine[], ids: { resumeId: string; versionId: string }, ctx: RunContext = {}): Promise<{ resume: CanonicalResume; dropped: Array<{ path: string; value: string; reason: string }>; prompt_version: string; cost_usd: number }> {
    const doc = { kind: 'txt' as const, lines, pages: Math.max(1, ...lines.map((l) => l.page)), warnings: [], columns_detected: false, hidden_text_found: false, contact_in_header_only: false, tables_or_textboxes: false, text_extractable: true, links: [] };
    try {
      const r = await this.router.run(resumeExtract, { lines: lines.filter((l) => !l.hidden).map((l) => ({ span_id: l.span_id, text: l.text, page: l.page })) }, ctx);
      const resume = fromExtract(r.output, ids);
      const v = validateCitations(resume, lines);
      if (!v.resume.experience.length && structureResume(doc, ids).experience.length) throw new Error('LLM lost roles');
      return { resume: v.resume, dropped: v.dropped, prompt_version: r.promptVersion, cost_usd: r.costUsd };
    } catch {
      const resume = structureResume(doc, ids);
      return { resume, dropped: [], prompt_version: 'heuristic@v1', cost_usd: 0 };
    }
  }

  /** S3: map ambiguous requirements; drops any claim id that was not provided. */
  async mapMatches(requirements: Array<{ req_id: string; text: string; type: string }>, evidence: ClaimLite[], ctx: RunContext = {}): Promise<MatchMapResponse & { cost_usd: number }> {
    const r = await this.router.run(matchMap, { requirements, evidence: evidence.map((e) => ({ claim_id: e.claim_id, type: e.type, text: e.text, ...(e.role_id ? { role_id: e.role_id } : {}) })) }, ctx);
    const known = new Set(evidence.map((e) => e.claim_id));
    const reqIds = new Set(requirements.map((q) => q.req_id));
    return {
      mappings: r.output.mappings.filter((m) => reqIds.has(m.req_id)).map((m) => ({ req_id: m.req_id, state: m.state, claim_ids: m.claim_ids.filter((id) => known.has(id)), rationale: m.rationale.slice(0, 400) })),
      prompt_version: r.promptVersion,
      cost_usd: r.costUsd,
    };
  }

  /** G7 for user-edited bullets (POST /v1/validations). */
  async validateEdits(pairs: Array<{ bullet_id: string; text: string; evidence_texts: string[] }>, ctx: RunContext = {}) {
    const r = await this.router.run(validateEntail, { pairs: pairs.map((p) => ({ bullet_id: p.bullet_id, rewritten: p.text, evidence_texts: p.evidence_texts })) }, ctx);
    return { results: r.output.results.map((x) => ({ bullet_id: x.bullet_id, verdict: x.verdict as Verdict, issues: x.issues })), cost_usd: r.costUsd };
  }

  /**
   * S4–S6 + gates: rewrite (optimize@v1) → G1–G6 → G7 entailment → one repair → revert on failure
   * (architecture.md §6.4, §8.1). Never returns a change that failed validation.
   */
  async optimize(req: OptimizeRequest, analysis: JobAnalysis, ctx: RunContext = {}, onProgress?: ProgressFn): Promise<OptimizeOutcome> {
    const t0 = this.now().getTime();
    const models = new Set<string>();
    const versions = new Set<string>();
    let cost = 0;
    const gates: Record<string, number> = {};
    const bump = (k: string, n = 1) => (gates[k] = (gates[k] ?? 0) + n);

    const gctx: GateContext = buildGateContext({
      now: this.now(),
      roles: req.resume.roles.map((r) => ({ role_id: r.role_id, employer: r.employer, title: r.title, start: r.start, end: r.end, bullets: r.bullets })),
      claims: req.claims.map((c): EvidenceClaim => ({ claim_id: c.claim_id, type: c.type, value: typeof c.value === 'object' ? c.value : c.value, text: c.text, ...(c.role_id ? { role_id: c.role_id } : {}) })),
      skills: req.resume.skills,
    });
    const bulletIndex = new Map(req.resume.roles.flatMap((r) => r.bullets.map((b) => [b.bullet_id, { role: r, b }] as const)));
    const targets = analysis.requirements
      .filter((r) => req.targets.req_ids.includes(r.req_id))
      .map((r) => ({ req_id: r.req_id, text: r.text, type: r.type, skills: r.skills.length ? r.skills : findSkills(r.text).map((h) => h.skill.canonical) }));

    await onProgress?.({ status: 'running', step: 'rewrite', progress: 0.15 });
    const rw = await this.router.run(
      optimize,
      { targets, resume: req.resume, claims: req.claims, edit_budget: req.targets.edit_budget, tone: req.options.tone },
      ctx,
    );
    models.add(rw.model.id);
    versions.add(rw.promptVersion);
    cost += rw.costUsd;
    const proposal = rw.output;

    // Enforce the edit budget and drop proposals for unknown bullets.
    const proposals = proposal.bullets.filter((b) => bulletIndex.has(b.bullet_id)).slice(0, req.targets.edit_budget.bullets);

    await onProgress?.({ status: 'validating', step: 'gates', progress: 0.45 });
    type Pending = { p: ProposedBullet & { emphasized_req_ids: string[]; why: string }; violations: Violation[]; repaired: boolean; firstIssue?: string };
    const evaluate = (p: Pending['p']) => checkBullet(p, gctx);
    let pending: Pending[] = proposals.map((b) => {
      const p = { bullet_id: b.bullet_id, role_id: bulletIndex.get(b.bullet_id)!.role.role_id, source_bullet_ids: b.source_bullet_ids.length ? b.source_bullet_ids : [b.bullet_id], text: b.text.trim(), claim_ids: b.claim_ids, emphasized_req_ids: b.emphasized_req_ids, why: b.why };
      return { p, violations: evaluate(p).violations, repaired: false };
    });
    // Unchanged "changes" are not changes.
    pending = pending.filter((x) => x.p.text && x.p.text !== bulletIndex.get(x.p.bullet_id)!.b.text);
    for (const x of pending) for (const v of x.violations) bump(v.gate);

    const evidenceTexts = (p: ProposedBullet) => {
      const role = req.resume.roles.find((r) => r.role_id === p.role_id);
      const src = role?.bullets.filter((b) => p.source_bullet_ids.includes(b.bullet_id)).map((b) => b.text) ?? [];
      const cited = p.claim_ids.map((id) => gctx.claims.get(id)?.text).filter((t): t is string => !!t);
      return [...new Set([...src, ...cited])];
    };

    const entailAll = async (items: Pending[]): Promise<Map<string, Verdict>> => {
      const verdicts = new Map<string, Verdict>();
      const toCheck = items.filter((x) => x.violations.every((v) => v.soft));
      if (!toCheck.length) return verdicts;
      try {
        const r = await this.router.run(validateEntail, { pairs: toCheck.map((x) => ({ bullet_id: x.p.bullet_id, rewritten: x.p.text, evidence_texts: evidenceTexts(x.p) })) }, ctx);
        models.add(r.model.id);
        versions.add(r.promptVersion);
        cost += r.costUsd;
        for (const v of r.output.results) verdicts.set(v.bullet_id, v.verdict);
      } catch {
        // G7 unavailable: deterministic gates still apply; changes are marked "unverified" (§10.2 prompt catalogue).
        for (const x of toCheck) verdicts.set(x.p.bullet_id, 'unverified');
      }
      return verdicts;
    };

    await onProgress?.({ status: 'validating', step: 'entailment', progress: 0.65 });
    let verdicts = await entailAll(pending);
    const passes = (x: Pending, v: Verdict | undefined) => {
      const hard = x.violations.filter((y) => !y.soft);
      if (hard.length) return false;
      if (x.violations.some((y) => y.soft)) return v === 'entailed';
      return v === 'entailed' || v === 'unverified';
    };
    for (const x of pending) {
      const v = verdicts.get(x.p.bullet_id);
      if (v && v !== 'entailed' && v !== 'unverified') bump(`G7_${v}`);
    }

    // S6: one repair attempt for failures.
    const failing = pending.filter((x) => !passes(x, verdicts.get(x.p.bullet_id)));
    if (failing.length) {
      await onProgress?.({ status: 'repairing', step: 'repair', progress: 0.8 });
      try {
        const r = await this.router.run(
          repair,
          {
            items: failing.map((x) => ({
              bullet_id: x.p.bullet_id,
              rewritten: x.p.text,
              violations: [...x.violations.map((v) => `${v.code}:${v.detail}`), ...(verdicts.get(x.p.bullet_id) ? [`entailment:${verdicts.get(x.p.bullet_id)}`] : [])],
              evidence_texts: evidenceTexts(x.p),
              claim_ids: x.p.claim_ids,
            })),
          },
          ctx,
        );
        models.add(r.model.id);
        versions.add(r.promptVersion);
        cost += r.costUsd;
        const fixed: Pending[] = [];
        for (const f of r.output.bullets) {
          const orig = failing.find((x) => x.p.bullet_id === f.bullet_id);
          if (!orig || !f.text.trim()) continue;
          const p = { ...orig.p, text: f.text.trim(), claim_ids: f.claim_ids.filter((id) => gctx.claims.has(id)) };
          const firstIssue = orig.violations.find((v) => !v.soft)?.code ?? `entailment_${verdicts.get(orig.p.bullet_id) ?? 'failed'}`;
          fixed.push({ p, violations: evaluate(p).violations, repaired: true, firstIssue });
        }
        const v2 = await entailAll(fixed);
        for (const f of fixed) {
          const idx = pending.findIndex((x) => x.p.bullet_id === f.p.bullet_id);
          if (idx >= 0) pending[idx] = f;
          verdicts.set(f.p.bullet_id, v2.get(f.p.bullet_id) ?? verdicts.get(f.p.bullet_id) ?? 'unsupported');
        }
      } catch {
        // repair unavailable → failing bullets are reverted below
      }
    }

    const bullets: ChangedBullet[] = [];
    const reverted: OptimizationResult['reverted'] = [];
    for (const x of pending) {
      const v = verdicts.get(x.p.bullet_id);
      const original = bulletIndex.get(x.p.bullet_id)!.b.text;
      if (passes(x, v) && x.p.text !== original) {
        bullets.push({
          bullet_id: x.p.bullet_id,
          role_id: x.p.role_id,
          source_bullet_ids: x.p.source_bullet_ids,
          original_text: original,
          text: x.p.text,
          claim_ids: x.p.claim_ids,
          emphasized_req_ids: x.p.emphasized_req_ids.filter((id) => req.targets.req_ids.includes(id)),
          why: x.p.why.slice(0, 200),
          validation: v ?? 'unverified',
          repaired: x.repaired,
        });
      } else {
        const hard = x.violations.filter((y) => !y.soft);
        // A bullet repaired back to its original wording is "kept original": report the first problem found.
        const reason = x.firstIssue ?? hard[0]?.code ?? (v ? `entailment_${v}` : 'validation_failed');
        reverted.push({ bullet_id: x.p.bullet_id, reason, violations: x.violations.map((y) => `${y.gate}:${y.code}`) });
      }
    }
    bump('reverted', reverted.length);

    // Summary: same evidence rules; no repair — an invalid summary change is simply dropped.
    let summary: OptimizationResult['summary'] = null;
    if (req.targets.edit_budget.summary && proposal.summary && proposal.summary.text.trim()) {
      const orig = req.resume.summary?.text ?? null;
      const rep = checkSummary(proposal.summary.text, proposal.summary.claim_ids.filter((id) => gctx.claims.has(id)), gctx, orig);
      if (rep.ok && proposal.summary.text.trim() !== orig) {
        summary = { original_text: orig, text: proposal.summary.text.trim(), claim_ids: proposal.summary.claim_ids.filter((id) => gctx.claims.has(id)), validation: 'entailed', why: 'Highlights your most relevant existing experience' };
      } else if (!rep.ok) {
        bump('summary_rejected');
        reverted.push({ bullet_id: req.resume.summary?.summary_id ?? 'summary', reason: rep.violations[0]?.code ?? 'summary_invalid', violations: rep.violations.map((y) => `${y.gate}:${y.code}`) });
      }
    }

    const order = req.targets.edit_budget.skills_order ? proposal.skills_order : [];
    const skills_order = checkSkillsOrder(order, gctx).ok ? order : [];

    const notAddressable = proposal.not_addressable.filter((n) => req.targets.req_ids.includes(n.req_id));
    return {
      result: { summary, bullets, skills_order, not_addressable: notAddressable, reverted },
      meta: { models: [...models], prompt_versions: [...versions], gates, duration_ms: this.now().getTime() - t0, cost_usd: Math.round(cost * 1e6) / 1e6 },
    };
  }
}

/** Converts resume_extract@v1 output to the canonical schema with provenance. */
export function fromExtract(o: ResumeExtractOutput, ids: { resumeId: string; versionId: string }): CanonicalResume {
  const f = (c: { value: string; span_ids: string[] } | null | undefined, conf = 0.9) => (c ? { ...field(c.value, c.span_ids, conf), prov: { span_ids: c.span_ids, source: 'llm' as const } } : undefined);
  const date = (c: { value: string; span_ids: string[] } | null) => (c && /^(\d{4}(-\d{2})?|present)$/.test(c.value) ? f(c) : undefined);
  const resume: CanonicalResume = {
    schema_version: '1.0',
    resume_id: ids.resumeId,
    version_id: ids.versionId,
    locale: 'en-US',
    source_documents: [],
    personal: {
      ...(o.full_name ? { full_name: f(o.full_name)! } : {}),
      ...(o.headline ? { headline: f(o.headline)! } : {}),
      emails: o.emails.map((e) => f(e)!),
      phones: o.phones.map((e) => f(e)!),
      ...(o.location ? { location: f(o.location)! } : {}),
      links: o.links.map((l) => ({ ...field({ network: /linkedin/i.test(l.value) ? ('linkedin' as const) : /github/i.test(l.value) ? ('github' as const) : ('portfolio' as const), url: l.value }, l.span_ids), prov: { span_ids: l.span_ids, source: 'llm' as const } })),
    },
    ...(o.summary ? { summary: { ...f(o.summary)!, summary_id: 'sum_1' } } : {}),
    experience: o.roles.map((r, i) => {
      const role_id = `role_${i + 1}`;
      const start = date(r.start);
      const end = date(r.end);
      const loc = f(r.location);
      return {
        role_id,
        employer: f(r.employer)!,
        title: f(r.title)!,
        ...(loc ? { location: loc } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        date_precision: /^\d{4}$/.test(r.start?.value ?? '') ? ('year' as const) : ('month' as const),
        bullets: r.bullets.map((b, j) => ({ bullet_id: `${role_id}.b_${j + 1}`, text: b.text, prov: { span_ids: b.span_ids, source: 'llm' as const }, claim_ids: [] })),
        technologies: [],
      };
    }),
    education: o.education.map((e, i) => {
      const degree = f(e.degree);
      const fos = f(e.field_of_study);
      const start = date(e.start);
      const end = date(e.end);
      return { education_id: `edu_${i + 1}`, institution: f(e.institution)!, ...(degree ? { degree } : {}), ...(fos ? { field_of_study: fos } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}), honors: [] };
    }),
    skills: o.skills.map((s, i) => ({ skill_id: `sk_${i + 1}`, name: f(s)!, normalized: { canonical: s.value, aliases: [] }, evidence_level: 'listed_only' as const, claim_ids: [] })),
    projects: o.projects.map((p, i) => ({ project_id: `proj_${i + 1}`, name: f(p.name)!, bullets: p.bullets.map((b, j) => ({ bullet_id: `proj_${i + 1}.b_${j + 1}`, text: b.text, prov: { span_ids: b.span_ids, source: 'llm' as const }, claim_ids: [] })), technologies: [] })),
    certifications: o.certifications.map((c, i) => {
      const issuer = f(c.issuer);
      const d = date(c.date);
      return { cert_id: `cert_${i + 1}`, name: f(c.name)!, ...(issuer ? { issuer } : {}), ...(d ? { date: d } : {}) };
    }),
    awards: [],
    publications: [],
    volunteering: [],
    languages: [],
    additional_sections: [],
    parse_quality: { score: 0.9, warnings: [], columns_detected: false, hidden_text_found: false, contact_in_header_only: false, tables_or_textboxes: false, text_extractable: true },
  };
  return resume;
}
