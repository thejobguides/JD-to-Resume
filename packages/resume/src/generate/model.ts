import type { CanonicalResume } from '@jmo/shared';

// A flat, template-agnostic view of the resume used by every renderer (PDF, DOCX, TXT).
// Single column, contact in the body, standard headings (architecture.md §9.3).

export type TemplateId = 'classic' | 'modern';

export interface RenderSection {
  heading: 'Summary' | 'Experience' | 'Education' | 'Skills' | 'Projects' | 'Certifications' | 'Languages' | 'Awards' | 'Volunteering';
  entries: RenderEntry[];
}

export interface RenderEntry {
  left?: string; // e.g. "Data Engineer — Globex"
  right?: string; // e.g. "Mar 2021 – Present"
  sub?: string; // e.g. location or degree details
  bullets?: string[];
  text?: string; // paragraph (summary, skills line)
}

export interface RenderModel {
  name: string;
  contact: string[]; // email, phone, location, links (visible text)
  links: Array<{ text: string; url: string }>;
  sections: RenderSection[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso?: string): string {
  if (!iso) return '';
  if (iso === 'present') return 'Present';
  const m = iso.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return iso;
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1]!;
}

export function formatRange(start?: string, end?: string): string {
  const a = formatDate(start);
  const b = formatDate(end);
  if (a && b) return `${a} – ${b}`;
  return a || b;
}

function withProtocol(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export function toRenderModel(r: CanonicalResume): RenderModel {
  const contact: string[] = [];
  const links: RenderModel['links'] = [];
  for (const e of r.personal.emails) contact.push(e.value);
  for (const p of r.personal.phones) contact.push(p.value);
  if (r.personal.location?.value) contact.push(r.personal.location.value);
  for (const l of r.personal.links) {
    const text = l.value.display_text ?? l.value.url.replace(/^https?:\/\/(www\.)?/i, '');
    contact.push(text);
    links.push({ text, url: withProtocol(l.value.url) });
  }

  const sections: RenderSection[] = [];
  if (r.summary?.value) sections.push({ heading: 'Summary', entries: [{ text: r.summary.value }] });
  if (r.experience.length) {
    sections.push({
      heading: 'Experience',
      entries: r.experience.map((role) => ({
        left: [role.title.value, role.employer.value].filter((x) => x && x !== 'Role').join(' — '),
        right: formatRange(role.start?.value, role.end?.value),
        ...(role.location?.value ? { sub: role.location.value } : {}),
        bullets: role.bullets.map((b) => b.text),
      })),
    });
  }
  if (r.projects.length) {
    sections.push({
      heading: 'Projects',
      entries: r.projects.map((p) => ({ left: p.name.value, right: formatRange(p.start?.value, p.end?.value), bullets: p.bullets.map((b) => b.text) })),
    });
  }
  if (r.education.length) {
    sections.push({
      heading: 'Education',
      entries: r.education.map((e) => ({
        left: [e.degree?.value && e.field_of_study?.value ? `${e.degree.value} in ${e.field_of_study.value}` : (e.degree?.value ?? e.field_of_study?.value), e.institution.value].filter(Boolean).join(' — '),
        right: formatRange(e.start?.value, e.end?.value),
        ...(e.gpa?.value ? { sub: `GPA: ${e.gpa.value}` } : {}),
      })),
    });
  }
  if (r.skills.length) sections.push({ heading: 'Skills', entries: [{ text: r.skills.map((s) => s.name.value).join(', ') }] });
  if (r.certifications.length) {
    sections.push({
      heading: 'Certifications',
      entries: r.certifications.map((c) => ({ left: [c.name.value, c.issuer?.value].filter(Boolean).join(' — '), right: formatDate(c.date?.value) })),
    });
  }
  if (r.languages.length) sections.push({ heading: 'Languages', entries: [{ text: r.languages.map((l) => (l.proficiency?.value ? `${l.language.value} (${l.proficiency.value})` : l.language.value)).join(', ') }] });
  if (r.awards.length) sections.push({ heading: 'Awards', entries: r.awards.map((a) => ({ left: a.title.value, right: formatDate(a.date?.value) })) });
  return { name: r.personal.full_name?.value ?? 'Your Name', contact, links, sections };
}

/** File naming (architecture.md §9.3): FirstName-LastName-Resume-<Company>.ext */
export function exportFileName(r: CanonicalResume, company: string | undefined, ext: 'pdf' | 'docx' | 'txt' | 'json'): string {
  const clean = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  const name = clean(r.personal.full_name?.value ?? 'Resume') || 'Resume';
  const co = company ? `-${clean(company)}` : '';
  return `${name}-Resume${co}.${ext}`;
}
