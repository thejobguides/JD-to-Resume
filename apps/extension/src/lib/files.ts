// Resume files in and out, entirely on the device. Heavy libraries load on first use.

import { docxToLines, type ParsedDocument, ParseError, pdfToLines, structureResume, textToLines, validateCitations, decodeText } from '@jmo/resume';
import { buildDocx, buildPdfDefinition, exportFileName, type TemplateId, toPlainText } from '@jmo/resume/generate';
import type { CanonicalResume } from '@jmo/shared';
import { sha256Hex, uuidv7 } from '@jmo/shared';

export interface LoadedResume {
  resume: CanonicalResume;
  doc: ParsedDocument;
  file_name: string;
  loaded_at: string;
}

async function pdfjs() {
  const lib = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  lib.GlobalWorkerOptions.workerSrc = worker;
  return lib;
}

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

export async function parseResumeFile(file: File): Promise<LoadedResume> {
  // Checked before reading: parsing a huge PDF would freeze the panel.
  if (file.size > MAX_RESUME_BYTES) throw new ParseError('too_large', `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Use a resume under 10 MB.`);
  const data = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  const versionId = `v_${uuidv7().slice(0, 8)}`;
  let doc: ParsedDocument;
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    doc = await pdfToLines((await pdfjs()) as never, data, { docVersion: versionId });
  } else if (name.endsWith('.docx') || file.type.includes('wordprocessingml')) {
    const mammoth = (await import('mammoth')).default;
    doc = await docxToLines(mammoth, data, { docVersion: versionId });
  } else if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/')) {
    doc = textToLines(decodeText(data), { docVersion: versionId, kind: 'txt' });
  } else if (name.endsWith('.doc')) {
    throw new ParseError('unsupported', 'Old .doc files aren’t supported. Save it as .docx or PDF and try again.');
  } else {
    throw new ParseError('unsupported', 'Use a PDF, DOCX or TXT file.');
  }
  return finish(doc, file.name, versionId, await sha256Hex(data), data.byteLength);
}

export async function parseResumeText(text: string): Promise<LoadedResume> {
  const versionId = `v_${uuidv7().slice(0, 8)}`;
  const data = new TextEncoder().encode(text);
  return finish(textToLines(text, { docVersion: versionId, kind: 'paste' }), 'pasted text', versionId, await sha256Hex(data), data.byteLength);
}

function finish(doc: ParsedDocument, fileName: string, versionId: string, sha256: string, size: number): LoadedResume {
  const source = { kind: doc.kind, file_name: fileName, sha256, pages: doc.pages, size_bytes: size, imported_at: new Date().toISOString() };
  const structured = structureResume(doc, { resumeId: `r_${uuidv7().slice(0, 8)}`, versionId, source });
  // Every value must cite a real span; anything that doesn't is dropped rather than trusted.
  const { resume } = validateCitations(structured, doc.lines);
  return { resume, doc, file_name: fileName, loaded_at: new Date().toISOString() };
}

// ── Export ──

let pdfMakeReady: Promise<typeof import('pdfmake/build/pdfmake').default> | null = null;
function pdfMake() {
  pdfMakeReady ??= (async () => {
    const pm = (await import('pdfmake/build/pdfmake')).default;
    const vfs = (await import('pdfmake/build/vfs_fonts')).default;
    pm.addVirtualFileSystem(vfs);
    pm.setUrlAccessPolicy(() => false); // never fetch remote resources while rendering
    return pm;
  })();
  return pdfMakeReady;
}

export type ExportFormat = 'pdf' | 'docx' | 'txt';

export async function exportResume(resume: CanonicalResume, format: ExportFormat, template: TemplateId, company?: string): Promise<{ blob: Blob; name: string }> {
  const name = exportFileName(resume, company, format);
  if (format === 'pdf') return { blob: await (await pdfMake()).createPdf(buildPdfDefinition(resume, template)).getBlob(), name };
  if (format === 'docx') {
    const { Packer } = await import('docx');
    return { blob: await Packer.toBlob(buildDocx(resume, template)), name };
  }
  return { blob: new Blob([toPlainText(resume)], { type: 'text/plain;charset=utf-8' }), name };
}

/** Downloads without the `downloads` permission: a Blob URL and an <a download> click from the extension page. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
