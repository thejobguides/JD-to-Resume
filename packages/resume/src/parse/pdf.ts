import type { SpanLine } from '@jmo/shared';
import { LIMITS, ParseError, type ParsedDocument, spanId } from './types';

// PDF layout pass (architecture.md §5.2). pdf.js is injected so the same code runs in the extension
// (pdfjs-dist/build, bundled worker) and in Node tests (pdfjs-dist/legacy/build).

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

export interface PdfjsLike {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocLike>; destroy?: () => Promise<void> };
}
interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  cleanup?: () => Promise<void>;
}
interface PdfPageLike {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[]; styles: Record<string, { fontFamily?: string }> }>;
  getAnnotations(): Promise<Array<{ subtype?: string; url?: string }>>;
}

interface RawLine {
  y: number;
  row: number;
  x0: number;
  x1: number;
  size: number;
  bold: boolean;
  text: string;
  hidden: boolean;
}

function itemSize(i: TextItem): number {
  return Math.abs(i.transform[3]!) || i.height || 10;
}

function segmentToLine(its: TextItem[], row: number, y: number, styles: Record<string, { fontFamily?: string }>, pageW: number, pageH: number): RawLine {
  let text = '';
  let prevEnd: number | null = null;
  for (const it of its) {
    const x = it.transform[4]!;
    const size = itemSize(it);
    if (prevEnd !== null && x - prevEnd > size * 0.25 && !text.endsWith(' ')) text += x - prevEnd > size * 2 ? '   ' : ' ';
    text += it.str;
    prevEnd = x + it.width;
  }
  const sizes = its.map(itemSize);
  const size = sizes.reduce((s, x) => s + x, 0) / sizes.length;
  const bold = its.some((i) => /bold|black|heavy|semibold|medium/i.test(`${i.fontName} ${styles[i.fontName]?.fontFamily ?? ''}`));
  const x0 = its[0]!.transform[4]!;
  const x1 = Math.max(...its.map((i) => i.transform[4]! + i.width));
  const hidden = size < 4 || x1 < 0 || x0 > pageW || y < -5 || y > pageH + 5;
  return { y, row, x0, x1, size, bold, text: text.replace(/\s+$/, ''), hidden };
}

/** Rows by baseline, then split each row into segments at large horizontal gaps (columns, right-aligned dates). */
function groupSegments(items: TextItem[], styles: Record<string, { fontFamily?: string }>, pageW: number, pageH: number): RawLine[] {
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!);
  const rows: Array<{ y: number; items: TextItem[] }> = [];
  for (const it of sorted) {
    const y = it.transform[5]!;
    const row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, itemSize(it) * 0.35));
    if (row) row.items.push(it);
    else rows.push({ y, items: [it] });
  }
  const segs: RawLine[] = [];
  rows.forEach((r, ri) => {
    const its = r.items.sort((a, b) => a.transform[4]! - b.transform[4]!);
    let cur: TextItem[] = [];
    let prevEnd: number | null = null;
    for (const it of its) {
      const x = it.transform[4]!;
      if (prevEnd !== null && x - prevEnd > Math.max(itemSize(it) * 2.5, 18) && cur.length) {
        segs.push(segmentToLine(cur, ri, r.y, styles, pageW, pageH));
        cur = [];
      }
      cur.push(it);
      prevEnd = x + it.width;
    }
    if (cur.length) segs.push(segmentToLine(cur, ri, r.y, styles, pageW, pageH));
  });
  return segs;
}

/** Joins segments that share a row back into one line ("Title — Employer   Mar 2021 – Present"). */
function mergeRows(segs: RawLine[]): RawLine[] {
  const byRow = new Map<number, RawLine[]>();
  for (const s of segs) byRow.set(s.row, [...(byRow.get(s.row) ?? []), s]);
  return [...byRow.values()].map((parts) => {
    const p = parts.sort((a, b) => a.x0 - b.x0);
    return { ...p[0]!, x1: Math.max(...p.map((x) => x.x1)), text: p.map((x) => x.text).join('   '), bold: p.some((x) => x.bold), hidden: p.every((x) => x.hidden) };
  });
}

/** Finds a vertical gutter that splits ≥ 60% of the page height into two substantial text columns. */
function detectGutter(lines: RawLine[], pageW: number): number | null {
  const visible = lines.filter((l) => !l.hidden);
  if (visible.length < 8) return null;
  const ys = visible.map((l) => l.y);
  const span = Math.max(...ys) - Math.min(...ys);
  if (span <= 0) return null;
  const totalChars = visible.reduce((s, l) => s + l.text.length, 0);
  let best: { x: number; score: number } | null = null;
  for (let x = pageW * 0.22; x <= pageW * 0.78; x += pageW / 100) {
    const crossing = visible.filter((l) => l.x0 < x - 2 && l.x1 > x + 2).length;
    const left = visible.filter((l) => l.x1 <= x + 2);
    const right = visible.filter((l) => l.x0 >= x - 2);
    if (left.length < 4 || right.length < 4) continue;
    if (crossing > visible.length * 0.08) continue;
    const chars = (arr: RawLine[]) => arr.reduce((s, l) => s + l.text.length, 0);
    // Both sides must carry real text: right-aligned dates alone are not a column.
    if (Math.min(chars(left), chars(right)) < totalChars * 0.15) continue;
    const covered = (arr: RawLine[]) => {
      const yy = arr.map((l) => l.y);
      return (Math.max(...yy) - Math.min(...yy)) / span;
    };
    if (covered(left) < 0.6 || covered(right) < 0.6) continue;
    const score = Math.min(left.length, right.length) - crossing * 3;
    if (!best || score > best.score) best = { x, score };
  }
  return best?.x ?? null;
}

export async function pdfToLines(pdfjs: PdfjsLike, data: Uint8Array, opts: { docVersion: string }): Promise<ParsedDocument> {
  if (data.byteLength > LIMITS.maxBytes) throw new ParseError('too_large', 'This file is too large to process safely.');
  let doc: PdfDocLike;
  const task = pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string }).name ?? '';
    if (/Password/i.test(name)) throw new ParseError('encrypted', 'This PDF is password-protected.');
    throw new ParseError('corrupt', 'This PDF could not be read.');
  }
  try {
    if (doc.numPages > LIMITS.maxPages) throw new ParseError('too_large', `This PDF has ${doc.numPages} pages; the limit is ${LIMITS.maxPages}.`);
    const out: SpanLine[] = [];
    const links: string[] = [];
    const warnings: string[] = [];
    let columns = false;
    let hiddenFound = false;
    let totalChars = 0;
    let cidGlyphs = 0;
    let lineNo = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.filter((i): i is TextItem => typeof (i as TextItem).str === 'string');
      for (const a of await page.getAnnotations()) if (a.subtype === 'Link' && a.url) links.push(a.url);
      const segs = groupSegments(items, content.styles, vp.width, vp.height);
      const gutter = detectGutter(segs, vp.width);
      let ordered: Array<RawLine & { column?: 'main' | 'sidebar' }>;
      if (gutter !== null) {
        columns = true;
        const leftSegs = segs.filter((l) => l.x0 < gutter);
        const rightSegs = segs.filter((l) => l.x0 >= gutter);
        // Rows above the point where both columns start (name, contact banner) are read first.
        const colTop = Math.min(Math.max(...leftSegs.map((l) => l.y)), Math.max(...rightSegs.map((l) => l.y)));
        const header = mergeRows(segs.filter((l) => l.y > colTop + 2));
        const body = segs.filter((l) => l.y <= colTop + 2);
        const left = mergeRows(body.filter((l) => l.x0 < gutter));
        const right = mergeRows(body.filter((l) => l.x0 >= gutter));
        const leftChars = left.reduce((s, l) => s + l.text.length, 0);
        const rightChars = right.reduce((s, l) => s + l.text.length, 0);
        const [main, side] = leftChars >= rightChars ? [left, right] : [right, left];
        ordered = [...header, ...main.map((l) => ({ ...l, column: 'main' as const })), ...side.map((l) => ({ ...l, column: 'sidebar' as const }))];
      } else {
        ordered = mergeRows(segs);
      }
      const raw = ordered;
      const bodySize = median(raw.filter((l) => !l.hidden).map((l) => l.size)) || 10;
      for (const l of ordered) {
        totalChars += l.text.length;
        cidGlyphs += (l.text.match(/\(cid:\d+\)|[-]/g) ?? []).length;
        if (l.hidden) hiddenFound = true;
        lineNo++;
        out.push({
          span_id: spanId(opts.docVersion, p, lineNo),
          text: l.text.trim(),
          page: p,
          line: lineNo,
          style: {
            size: Math.round(l.size * 10) / 10,
            bold: l.bold,
            caps: /[A-Z]/.test(l.text) && l.text === l.text.toUpperCase() && l.text.replace(/[^A-Za-z]/g, '').length >= 3,
            indent: Math.round(l.x0),
            ...(l.column ? { column: l.column } : {}),
          },
          bbox: [Math.round(l.x0), Math.round(l.y), Math.round(l.x1), Math.round(l.y + l.size)],
          hidden: l.hidden,
          region: 'body',
        });
      }
      if (bodySize < 5) warnings.push('tiny_text');
    }
    const perPage = totalChars / Math.max(1, doc.numPages);
    if (!out.length || perPage < LIMITS.minCharsPerPage) throw new ParseError('scanned', 'This PDF looks like an image (no text layer).');
    if (cidGlyphs / Math.max(1, totalChars) > 0.05) throw new ParseError('scanned', 'Some text in this PDF cannot be read (unmapped fonts).');
    if (columns) warnings.push('columns_detected');
    if (hiddenFound) warnings.push('hidden_text_found');
    return {
      kind: 'pdf',
      lines: out,
      pages: doc.numPages,
      warnings,
      columns_detected: columns,
      hidden_text_found: hiddenFound,
      contact_in_header_only: false,
      tables_or_textboxes: false,
      text_extractable: true,
      links: [...new Set(links)],
    };
  } finally {
    await task.destroy?.().catch(() => undefined);
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
