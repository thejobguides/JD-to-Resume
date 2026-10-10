import type { SpanLine } from '@jmo/shared';
import JSZip from 'jszip';
import { EMAIL_RE, LIMITS, ParseError, type ParsedDocument, PHONE_RE, spanId } from './types';

// DOCX: mammoth for the body + a custom OOXML pass for headers/footers/text boxes (architecture.md §5.1).
// mammoth "performs no sanitisation" — we never render its HTML; we only read text from it.

export interface MammothLike {
  // Browser build takes {arrayBuffer}; the Node build takes {buffer}.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  convertToHtml(input: any): Promise<{ value: string }>;
}

function xmlText(xml: string): string[] {
  const paras = xml.split(/<\/w:p>/);
  return paras
    .map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decodeXml(m[1]!)).join(''))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Converts mammoth HTML to lines, keeping heading/bold/bullet hints (never rendered as HTML). */
function htmlToLines(html: string): Array<{ text: string; bold: boolean; heading: boolean; bullet: boolean }> {
  const out: Array<{ text: string; bold: boolean; heading: boolean; bullet: boolean }> = [];
  const blocks = html.match(/<(h[1-6]|p|li)[^>]*>[\s\S]*?<\/\1>/g) ?? [];
  for (const b of blocks) {
    const tag = b.match(/^<(h[1-6]|p|li)/)![1]!;
    const inner = b.replace(/^<[^>]+>|<\/[^>]+>$/g, '');
    const text = decodeXml(inner.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const bold = /^<strong>[\s\S]*<\/strong>$/.test(inner.trim()) || tag.startsWith('h');
    out.push({ text, bold, heading: tag.startsWith('h'), bullet: tag === 'li' });
  }
  return out;
}

export async function docxToLines(mammoth: MammothLike, data: Uint8Array, opts: { docVersion: string }): Promise<ParsedDocument> {
  if (data.byteLength > LIMITS.maxBytes) throw new ParseError('too_large', 'This file is too large to process safely.');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new ParseError('corrupt', 'This DOCX file is damaged or not a Word document.');
  }
  // Zip-bomb guard: sum of declared uncompressed sizes.
  let uncompressed = 0;
  zip.forEach((_, f) => {
    uncompressed += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  });
  if (uncompressed > LIMITS.maxDocxUncompressed) throw new ParseError('too_large', 'This document expands to an unsafe size.');
  if (zip.file('word/vbaProject.bin')) throw new ParseError('unsupported', 'Documents with macros are not supported. Save as a regular .docx.');
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new ParseError('corrupt', 'This DOCX file has no document body.');

  const warnings: string[] = [];
  const tables = /<w:tbl[ >]/.test(documentXml);
  const textboxes = /<w:txbxContent/.test(documentXml);
  if (tables) warnings.push('tables_detected');
  if (textboxes) warnings.push('textboxes_detected');

  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const NodeBuffer = (globalThis as { Buffer?: { from(a: ArrayBuffer): Uint8Array } }).Buffer;
  const input = NodeBuffer && typeof (globalThis as { window?: unknown }).window === 'undefined' ? { buffer: NodeBuffer.from(ab) } : { arrayBuffer: ab };
  const { value: html } = await mammoth.convertToHtml(input);
  const bodyLines = htmlToLines(html);

  const headerFooter: Array<{ text: string; region: 'header' | 'footer' }> = [];
  for (const name of Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort()) {
    const xml = await zip.file(name)!.async('string');
    for (const t of xmlText(xml)) headerFooter.push({ text: t, region: name.includes('header') ? 'header' : 'footer' });
  }
  const bodyText = bodyLines.map((l) => l.text).join('\n');
  const textboxLines = textboxes
    ? [...documentXml.matchAll(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g)].flatMap((m) => xmlText(m[1]!)).filter((t) => !bodyText.includes(t))
    : [];

  const links = [...documentXml.matchAll(/<w:hyperlink [^>]*r:id="([^"]+)"/g)].map((m) => m[1]!);
  const rels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  const urls = links.map((id) => rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))?.[1]).filter((u): u is string => !!u);

  const lines: SpanLine[] = [];
  let n = 0;
  const push = (text: string, style: SpanLine['style'], region: SpanLine['region']) => {
    n++;
    lines.push({ span_id: spanId(opts.docVersion, 1, n), text, page: 1, line: n, style, hidden: false, region });
  };
  // Header content first (contact info usually lives there), then body, then text boxes, then footer.
  for (const h of headerFooter.filter((x) => x.region === 'header')) push(h.text, { bold: false }, 'header');
  for (const l of bodyLines) push(l.bullet ? `• ${l.text}` : l.text, { bold: l.bold, caps: l.text === l.text.toUpperCase() && /[A-Z]{3}/.test(l.text), size: l.heading ? 14 : 11 }, 'body');
  for (const t of textboxLines) push(t, { bold: false }, 'textbox');
  for (const f of headerFooter.filter((x) => x.region === 'footer')) push(f.text, { bold: false }, 'footer');

  if (!lines.some((l) => l.region === 'body')) throw new ParseError('empty', 'This document has no readable text.');
  const hasContact = (region: SpanLine['region']) => lines.some((l) => l.region === region && (EMAIL_RE.test(l.text) || PHONE_RE.test(l.text)));
  const contactHeaderOnly = !hasContact('body') && (hasContact('header') || hasContact('footer'));
  if (contactHeaderOnly) warnings.push('contact_in_header');

  return {
    kind: 'docx',
    lines,
    pages: 1,
    warnings,
    columns_detected: false,
    hidden_text_found: false,
    contact_in_header_only: contactHeaderOnly,
    tables_or_textboxes: tables || textboxes,
    text_extractable: true,
    links: [...new Set(urls)],
  };
}
