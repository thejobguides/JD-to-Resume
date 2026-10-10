import type { CanonicalResume } from '@jmo/shared';
import { toRenderModel } from './model';

/** Plain-text export (fallback when DOCX/PDF generation fails; architecture.md §18 #30). */
export function toPlainText(resume: CanonicalResume): string {
  const m = toRenderModel(resume);
  const out: string[] = [m.name, m.contact.join(' | '), ''];
  for (const s of m.sections) {
    out.push(s.heading.toUpperCase());
    for (const e of s.entries) {
      if (e.text) out.push(e.text);
      if (e.left || e.right) out.push([e.left, e.right].filter(Boolean).join('   '));
      if (e.sub) out.push(e.sub);
      for (const b of e.bullets ?? []) out.push(`• ${b}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/** JSON Resume export for interoperability (architecture.md §5.4). */
export function toJsonResume(r: CanonicalResume): Record<string, unknown> {
  return {
    $schema: 'https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json',
    basics: {
      name: r.personal.full_name?.value,
      label: r.personal.headline?.value,
      email: r.personal.emails[0]?.value,
      phone: r.personal.phones[0]?.value,
      summary: r.summary?.value,
      location: r.personal.location ? { address: r.personal.location.value } : undefined,
      profiles: r.personal.links.map((l) => ({ network: l.value.network, url: l.value.url })),
    },
    work: r.experience.map((w) => ({
      name: w.employer.value,
      position: w.title.value,
      startDate: w.start?.value,
      endDate: w.end?.value === 'present' ? undefined : w.end?.value,
      highlights: w.bullets.map((b) => b.text),
    })),
    education: r.education.map((e) => ({ institution: e.institution.value, studyType: e.degree?.value, area: e.field_of_study?.value, startDate: e.start?.value, endDate: e.end?.value, score: e.gpa?.value })),
    skills: r.skills.map((s) => ({ name: s.name.value })),
    projects: r.projects.map((p) => ({ name: p.name.value, highlights: p.bullets.map((b) => b.text) })),
    certificates: r.certifications.map((c) => ({ name: c.name.value, issuer: c.issuer?.value, date: c.date?.value })),
    languages: r.languages.map((l) => ({ language: l.language.value, fluency: l.proficiency?.value })),
  };
}
