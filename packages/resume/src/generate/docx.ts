import type { CanonicalResume } from '@jmo/shared';
import { AlignmentType, BorderStyle, Document, ExternalHyperlink, LevelFormat, Paragraph, TabStopType, TextRun } from 'docx';
import { type TemplateId, toRenderModel } from './model';

// DOCX via `docx` (architecture.md §9.2): real Word paragraphs and list styles; no tables or text boxes;
// contact details in the body (never in the header); dates right-aligned with a tab stop.

const CONTENT_WIDTH_TWIPS = 9360; // 6.5" on US Letter with 1" margins

export function buildDocx(resume: CanonicalResume, template: TemplateId = 'classic'): Document {
  const m = toRenderModel(resume);
  const modern = template === 'modern';
  const font = modern ? 'Calibri' : 'Georgia';
  const accent = modern ? '1F4E79' : '000000';
  const children: Paragraph[] = [];

  children.push(new Paragraph({ alignment: modern ? AlignmentType.LEFT : AlignmentType.CENTER, children: [new TextRun({ text: m.name, bold: true, size: modern ? 36 : 32, font })] }));
  if (m.contact.length) {
    const runs: Array<TextRun | ExternalHyperlink> = [];
    m.contact.forEach((c, i) => {
      const link = m.links.find((l) => l.text === c);
      runs.push(link ? new ExternalHyperlink({ link: link.url, children: [new TextRun({ text: c, style: 'Hyperlink', size: 19, font })] }) : new TextRun({ text: c, size: 19, font }));
      if (i < m.contact.length - 1) runs.push(new TextRun({ text: '  |  ', size: 19, font }));
    });
    children.push(new Paragraph({ alignment: modern ? AlignmentType.LEFT : AlignmentType.CENTER, spacing: { after: 160 }, children: runs }));
  }

  for (const s of m.sections) {
    children.push(
      new Paragraph({
        spacing: { before: 200, after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: accent, space: 1 } },
        children: [new TextRun({ text: modern ? s.heading : s.heading.toUpperCase(), bold: true, size: 22, color: accent, font })],
      }),
    );
    for (const e of s.entries) {
      if (e.text) children.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: e.text, size: 20, font })] }));
      if (e.left || e.right) {
        children.push(
          new Paragraph({
            spacing: { before: 80 },
            tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH_TWIPS }],
            children: [new TextRun({ text: e.left ?? '', bold: true, size: 21, font }), ...(e.right ? [new TextRun({ text: `\t${e.right}`, size: 20, font })] : [])],
          }),
        );
      }
      if (e.sub) children.push(new Paragraph({ children: [new TextRun({ text: e.sub, italics: true, size: 19, font })] }));
      for (const b of e.bullets ?? []) {
        children.push(new Paragraph({ numbering: { reference: 'jmo-bullets', level: 0 }, children: [new TextRun({ text: b, size: 20, font })] }));
      }
    }
  }

  return new Document({
    creator: 'Job Match Optimizer',
    title: `${m.name} — Resume`,
    styles: { default: { document: { run: { font, size: 20 } } } },
    numbering: {
      config: [
        {
          reference: 'jmo-bullets',
          levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360, hanging: 260 } } } }],
        },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } }, children }],
  });
}
