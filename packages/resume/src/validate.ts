import type { CanonicalResume, SpanLine } from '@jmo/shared';
import { normalizeWhitespace } from '@jmo/shared';

// Span-fidelity validator for resume_extract@v1 output (architecture.md §5.3; eval hard gate = 1.00).
// Every value must be contained (normalized) in the text of its cited spans; failures are dropped.

export interface Dropped {
  path: string;
  value: string;
  reason: string;
}

function norm(s: string): string {
  return normalizeWhitespace(s).toLowerCase().replace(/[–—]/g, '-').replace(/[^\p{L}\p{N}@.+#%$/-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function dateSupported(value: string, text: string): boolean {
  if (value === 'present') return /present|current|now|today|ongoing/i.test(text);
  const year = value.match(/^(\d{4})/)?.[1];
  return !!year && text.includes(year);
}

export function validateCitations(resume: CanonicalResume, lines: SpanLine[]): { resume: CanonicalResume; dropped: Dropped[] } {
  const bySpan = new Map(lines.map((l) => [l.span_id, l.text]));
  const dropped: Dropped[] = [];
  const out: CanonicalResume = structuredClone(resume);

  const supported = (value: string, spans: string[], kind: 'text' | 'date' = 'text') => {
    const text = spans.map((s) => bySpan.get(s) ?? '').join(' \n ');
    if (!text.trim()) return false;
    if (kind === 'date') return dateSupported(value, text);
    return norm(text).includes(norm(value));
  };

  type F = { value: unknown; prov: { span_ids: string[] } } | undefined;
  const check = (path: string, f: F, kind: 'text' | 'date' = 'text'): boolean => {
    if (!f) return true;
    const v = typeof f.value === 'string' ? f.value : typeof f.value === 'object' && f.value && 'url' in f.value ? String((f.value as { url: string }).url) : String(f.value);
    if (!v) return true;
    if (supported(v, f.prov.span_ids, kind)) return true;
    dropped.push({ path, value: v.slice(0, 200), reason: f.prov.span_ids.length ? 'not_in_cited_spans' : 'no_citation' });
    return false;
  };

  const p = out.personal;
  if (!check('personal.full_name', p.full_name)) delete p.full_name;
  if (!check('personal.headline', p.headline)) delete p.headline;
  if (!check('personal.location', p.location)) delete p.location;
  p.emails = p.emails.filter((e, i) => check(`personal.emails[${i}]`, e));
  p.phones = p.phones.filter((e, i) => check(`personal.phones[${i}]`, e));
  p.links = p.links.filter((e, i) => check(`personal.links[${i}]`, e));
  if (out.summary && !check('summary', out.summary)) delete out.summary;

  out.experience = out.experience.filter((r, i) => {
    const base = `experience[${i}]`;
    if (!check(`${base}.employer`, r.employer) && !check(`${base}.title`, r.title)) return false;
    if (r.start && !check(`${base}.start`, r.start, 'date')) delete r.start;
    if (r.end && !check(`${base}.end`, r.end, 'date')) delete r.end;
    r.bullets = r.bullets.filter((b, j) => {
      const ok = supported(b.text, b.prov.span_ids);
      if (!ok) dropped.push({ path: `${base}.bullets[${j}]`, value: b.text.slice(0, 200), reason: 'not_in_cited_spans' });
      return ok;
    });
    return true;
  });
  out.education = out.education.filter((e, i) => check(`education[${i}].institution`, e.institution) || check(`education[${i}].degree`, e.degree));
  out.skills = out.skills.filter((s, i) => check(`skills[${i}]`, s.name));
  out.certifications = out.certifications.filter((c, i) => check(`certifications[${i}]`, c.name));
  return { resume: out, dropped };
}
