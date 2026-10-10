import type { CanonicalResume } from '@jmo/shared';
import { type TemplateId, toRenderModel } from './model';

// pdfmake document definition (architecture.md §9.2): real text, embedded fonts (Roboto), single column,
// no tables, dates right-aligned on the title line via columns (still one reading-order line).

type Content = Record<string, unknown> | string;

export function buildPdfDefinition(resume: CanonicalResume, template: TemplateId = 'classic'): Record<string, unknown> {
  const m = toRenderModel(resume);
  const modern = template === 'modern';
  const accent = modern ? '#1f4e79' : '#000000';
  const content: Content[] = [];

  content.push({ text: m.name, style: 'name', alignment: modern ? 'left' : 'center' });
  if (m.contact.length) {
    const parts: Content[] = [];
    m.contact.forEach((c, i) => {
      const link = m.links.find((l) => l.text === c);
      parts.push(link ? { text: c, link: link.url, color: accent } : c);
      if (i < m.contact.length - 1) parts.push('  |  ');
    });
    content.push({ text: parts, style: 'contact', alignment: modern ? 'left' : 'center' });
  }

  for (const s of m.sections) {
    content.push({ text: modern ? s.heading : s.heading.toUpperCase(), style: 'heading', color: accent });
    content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.6, lineColor: accent }], margin: [0, 1, 0, 4] });
    for (const e of s.entries) {
      if (e.text) content.push({ text: e.text, style: 'body', margin: [0, 0, 0, 4] });
      if (e.left || e.right) {
        content.push({
          columns: [
            { text: e.left ?? '', style: 'entryTitle', width: '*' },
            { text: e.right ?? '', style: 'entryDate', width: 'auto', alignment: 'right' },
          ],
          columnGap: 8,
          margin: [0, 2, 0, 0],
        });
      }
      if (e.sub) content.push({ text: e.sub, style: 'sub' });
      if (e.bullets?.length) content.push({ ul: e.bullets.map((b) => ({ text: b, style: 'body' })), margin: [6, 2, 0, 4] });
    }
  }

  return {
    pageSize: 'LETTER',
    pageMargins: [48, 42, 48, 42],
    info: { title: `${m.name} — Resume`, author: m.name, subject: 'Resume', creator: 'Job Match Optimizer' },
    content,
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.15 },
    styles: {
      name: { fontSize: modern ? 18 : 16, bold: true, margin: [0, 0, 0, 2] },
      contact: { fontSize: 9.5, margin: [0, 0, 0, 8] },
      heading: { fontSize: 11, bold: true, margin: [0, 8, 0, 0] },
      entryTitle: { fontSize: 10.5, bold: true },
      entryDate: { fontSize: 10 },
      sub: { fontSize: 9.5, italics: true, margin: [0, 0, 0, 1] },
      body: { fontSize: 10 },
    },
  };
}
