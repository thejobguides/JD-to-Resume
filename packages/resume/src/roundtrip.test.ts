import { createRequire } from 'node:module';
import { Document, Header, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth';
import { beforeAll, describe, expect, it } from 'vitest';
import { sampleResume } from './fixtures';
import { buildDocx, buildPdfDefinition, toPlainText } from './generate/index';
import { applyOptimization, docxToLines, pdfToLines, ParseError, structureResume, textToLines, toOptResume, validateCitations } from './index';

const require = createRequire(import.meta.url);
let pdfjs: Parameters<typeof pdfToLines>[0];
let pdfmake: { addFonts(f: unknown): void; setUrlAccessPolicy(f: unknown): void; setLocalAccessPolicy(f: unknown): void; createPdf(dd: unknown): { getBuffer(): Promise<Buffer> } };

beforeAll(async () => {
  pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as typeof pdfjs;
  pdfmake = require('pdfmake');
  pdfmake.addFonts(require('pdfmake/fonts/Roboto'));
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((p: string) => p.includes('pdfmake'));
});

async function renderPdf(dd: unknown): Promise<Uint8Array> {
  return new Uint8Array(await pdfmake.createPdf(dd).getBuffer());
}

describe('PDF round trip (generate → pdf.js → structure)', () => {
  it('recovers contact, sections, titles, dates and bullets in order', async () => {
    const src = sampleResume();
    for (const template of ['classic', 'modern'] as const) {
      const pdf = await renderPdf(buildPdfDefinition(src, template));
      expect(pdf.byteLength).toBeLessThan(1024 * 1024);
      const parsed = await pdfToLines(pdfjs, pdf, { docVersion: 'v2' });
      expect(parsed.columns_detected).toBe(false);
      const r = structureResume(parsed, { resumeId: 'r', versionId: 'v2' });
      expect(r.personal.full_name?.value).toBe('Asha Rao');
      expect(r.personal.emails[0]?.value).toBe('asha.rao@example.com');
      expect(r.experience.map((x) => x.employer.value)).toEqual(['Globex', 'Initech']);
      expect(r.experience.map((x) => x.title.value)).toEqual(['Data Engineer', 'Data Analyst']);
      expect(r.experience[0]!.start?.value).toBe('2021-03');
      expect(r.experience[0]!.end?.value).toBe('present');
      expect(r.experience[0]!.bullets.map((b) => b.text)).toEqual(src.experience[0]!.bullets.map((b) => b.text));
      expect(r.experience[1]!.bullets).toHaveLength(2);
      expect(r.education[0]?.institution.value).toBe('University of Toronto');
      expect(r.skills.map((s) => s.name.value)).toEqual(expect.arrayContaining(['Python', 'Snowflake', 'Tableau']));
      expect(r.certifications[0]?.name.value).toContain('Google Data Analytics Certificate');
      expect(r.summary?.value).toContain('5 years');
      // every value is cited
      expect(validateCitations(r, parsed.lines).dropped).toEqual([]);
    }
  });

  it('detects a two-column layout and reads the main column first', async () => {
    const dd = {
      content: [
        { text: 'Jordan Lee', fontSize: 18, bold: true },
        {
          columns: [
            {
              width: 150,
              stack: ['SKILLS', 'Python', 'SQL', 'React', 'Docker', 'CONTACT', 'jordan@example.com', 'Vancouver, BC', 'LANGUAGES', 'English', 'French'],
            },
            {
              width: '*',
              stack: [
                'EXPERIENCE',
                'Software Engineer — Initrode   Jan 2020 – Present',
                '• Built React dashboards used by 40 analysts every day',
                '• Shipped Python services behind a REST API on Docker',
                '• Reduced page load time by 35% through code splitting',
                'Junior Developer — Hooli   Jun 2018 – Dec 2019',
                '• Maintained internal tools written in Python',
                '• Wrote SQL migrations for the billing database',
                'EDUCATION',
                'B.Sc. in Computer Science — University of British Columbia   2014 – 2018',
              ],
            },
          ],
          columnGap: 30,
        },
      ],
      defaultStyle: { font: 'Roboto', fontSize: 10 },
    };
    const parsed = await pdfToLines(pdfjs, await renderPdf(dd), { docVersion: 'v1' });
    expect(parsed.columns_detected).toBe(true);
    const texts = parsed.lines.map((l) => l.text);
    expect(texts.indexOf('EXPERIENCE')).toBeLessThan(texts.indexOf('SKILLS'));
    const r = structureResume(parsed, { resumeId: 'r', versionId: 'v1' });
    expect(r.experience.map((x) => x.employer.value)).toEqual(['Initrode', 'Hooli']);
    expect(r.experience[0]!.bullets).toHaveLength(3);
    expect(r.parse_quality.columns_detected).toBe(true);
  });

  it('rejects a PDF without a text layer as scanned', async () => {
    const dd = { content: [{ canvas: [{ type: 'rect', x: 0, y: 0, w: 400, h: 600, color: '#eeeeee' }] }], defaultStyle: { font: 'Roboto' } };
    await expect(pdfToLines(pdfjs, await renderPdf(dd), { docVersion: 'v1' })).rejects.toBeInstanceOf(ParseError);
  });
});

describe('DOCX round trip (generate → mammoth + OOXML → structure)', () => {
  it('recovers the resume from our DOCX template', async () => {
    const buf = new Uint8Array(await Packer.toBuffer(buildDocx(sampleResume(), 'modern')));
    const parsed = await docxToLines(mammoth, buf, { docVersion: 'v3' });
    expect(parsed.tables_or_textboxes).toBe(false);
    const r = structureResume(parsed, { resumeId: 'r', versionId: 'v3' });
    expect(r.personal.full_name?.value).toBe('Asha Rao');
    expect(r.experience.map((x) => `${x.title.value} @ ${x.employer.value}`)).toEqual(['Data Engineer @ Globex', 'Data Analyst @ Initech']);
    expect(r.experience[0]!.bullets[0]!.text).toBe('Built Kafka-based pipeline processing 2M events/day');
    expect(r.experience[0]!.start?.value).toBe('2021-03');
  });

  it('flags contact details that live only in the header', async () => {
    const doc = new Document({
      sections: [
        {
          headers: { default: new Header({ children: [new Paragraph('sam.taylor@example.com | +1 604 555 0199')] }) },
          children: [
            new Paragraph({ children: [new TextRun({ text: 'Sam Taylor', bold: true, size: 32 })] }),
            new Paragraph({ children: [new TextRun({ text: 'EXPERIENCE', bold: true })] }),
            new Paragraph('Product Manager — Pied Piper   Feb 2020 – Present'),
            new Paragraph({ text: 'Led pricing experiments across three product lines', bullet: { level: 0 } }),
            new Paragraph({ children: [new TextRun({ text: 'EDUCATION', bold: true })] }),
            new Paragraph('MBA — Rotman School of Management   2018 – 2020'),
          ],
        },
      ],
    });
    const parsed = await docxToLines(mammoth, new Uint8Array(await Packer.toBuffer(doc)), { docVersion: 'v1' });
    expect(parsed.contact_in_header_only).toBe(true);
    const r = structureResume(parsed, { resumeId: 'r', versionId: 'v1' });
    expect(r.personal.emails[0]?.value).toBe('sam.taylor@example.com');
    expect(r.parse_quality.contact_in_header_only).toBe(true);
    expect(r.experience[0]!.employer.value).toBe('Pied Piper');
  });

  it('rejects corrupt files', async () => {
    await expect(docxToLines(mammoth, new Uint8Array([1, 2, 3, 4]), { docVersion: 'v1' })).rejects.toBeInstanceOf(ParseError);
  });
});

describe('TXT, apply and pseudonymize', () => {
  it('structures plain text and applies accepted changes', () => {
    const text = toPlainText(sampleResume());
    const parsed = textToLines(text, { docVersion: 'v1', kind: 'paste' });
    const r = structureResume(parsed, { resumeId: 'r', versionId: 'v1' });
    expect(r.experience).toHaveLength(2);
    const updated = applyOptimization(
      r,
      {
        summary: null,
        bullets: [{ bullet_id: r.experience[0]!.bullets[1]!.bullet_id, role_id: 'role_1', source_bullet_ids: [r.experience[0]!.bullets[1]!.bullet_id], original_text: '', text: 'Deployed services to Kubernetes with Helm and Terraform', claim_ids: [], emphasized_req_ids: [], why: '', validation: 'entailed', repaired: false }],
        skills_order: [r.skills[4]!.skill_id],
        not_addressable: [],
        reverted: [],
      },
      { bullets: 'all_verified', summary: false, skillsOrder: true },
      'v2',
    );
    expect(updated.experience[0]!.bullets[1]!.text).toContain('Kubernetes');
    expect(updated.skills[0]!.name.value).toBe('Kafka');
    expect(updated.version_id).toBe('v2');
  });

  it('removes contact details from the optimization payload', () => {
    const r = sampleResume();
    r.summary!.value = 'Asha Rao is a data engineer (asha.rao@example.com).';
    const payload = JSON.stringify(toOptResume(r));
    expect(payload).not.toContain('Asha Rao');
    expect(payload).not.toContain('asha.rao@example.com');
  });
});
