import type { SpanLine } from '@jmo/shared';
import { normalizeWhitespace } from '@jmo/shared';
import { ParseError, type ParsedDocument, spanId } from './types';

export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder('utf-8').decode(data.subarray(3));
  return new TextDecoder('utf-8').decode(data);
}

export function textToLines(text: string, opts: { docVersion: string; kind?: 'txt' | 'paste' }): ParsedDocument {
  const clean = normalizeWhitespace(text);
  if (clean.length < 50) throw new ParseError('empty', 'This text is too short to be a resume.');
  const lines: SpanLine[] = [];
  let n = 0;
  for (const raw of clean.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    n++;
    lines.push({
      span_id: spanId(opts.docVersion, 1, n),
      text: t,
      page: 1,
      line: n,
      style: { caps: t === t.toUpperCase() && /[A-Z]{3}/.test(t) },
      hidden: false,
      region: 'body',
    });
  }
  return {
    kind: opts.kind ?? 'txt',
    lines,
    pages: 1,
    warnings: [],
    columns_detected: false,
    hidden_text_found: false,
    contact_in_header_only: false,
    tables_or_textboxes: false,
    text_extractable: true,
    links: [],
  };
}
