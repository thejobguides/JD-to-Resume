import type { ExtractedJob, ExtractionLayer, ExtractorAdapter } from '@jmo/shared';
import { jdHash, normalizeWhitespace, stripInvisible } from '@jmo/shared';
import { dedupeParagraphs, genericExtract, JD_HEADINGS } from './generic';
import { basicHidden, elementToText, type HiddenCheck, htmlStringToText } from './html';
import { parseJobPostingJsonLd, parseJobPostingMicrodata, type StructuredJob } from './jsonld';
import { DEFAULT_ADAPTERS, detectAdapter } from './registry';

export const JD_MAX_CHARS = 20_000;

export interface ExtractOptions {
  url: string;
  adapters?: ExtractorAdapter[];
  isHidden?: HiddenCheck;
  /** HTML string → Document (DOMParser in the browser; linkedom in tests). */
  parseHtml: (html: string) => Document;
  now?: Date;
}

function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

export function sectionsOf(text: string): Array<{ heading: string; start: number; end: number }> {
  const sections: Array<{ heading: string; start: number; end: number }> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const clean = line.replace(/[:：]$/, '').trim();
    if (clean && clean.length < 60 && JD_HEADINGS.test(clean)) {
      if (sections.length) sections[sections.length - 1]!.end = offset;
      sections.push({ heading: clean, start: offset, end: text.length });
    }
    offset += line.length + 1;
  }
  return sections;
}

/** Truncates at a section boundary when over the cap (architecture.md §4.3). */
export function capText(text: string, max = JD_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf('\n\n', max);
  return { text: text.slice(0, cut > max * 0.6 ? cut : max).trim(), truncated: true };
}

/** Runs L0–L5 on a Document and returns an ExtractedJob, or null if nothing JD-like was found. */
export async function extractJobFromDocument(doc: Document, opts: ExtractOptions): Promise<ExtractedJob | null> {
  const now = opts.now ?? new Date();
  const isHidden = opts.isHidden ?? basicHidden;
  const { adapter, host } = detectAdapter(opts.url, opts.adapters ?? DEFAULT_ADAPTERS);
  const layers: ExtractionLayer[] = [];
  const warnings: string[] = [];

  // L1 structured data
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent ?? '');
  let structured: StructuredJob | null = parseJobPostingJsonLd(scripts, now);
  if (!structured) structured = parseJobPostingMicrodata(doc);
  let l1Text = '';
  if (structured) {
    layers.push('L1');
    if (structured.description_html) l1Text = htmlStringToText(structured.description_html, opts.parseHtml);
    if (structured.closed) warnings.push('posting_closed');
  }

  // L2 adapter selectors
  let l2Text = '';
  const sel = adapter?.selectors;
  if (sel?.description) {
    const el = doc.querySelector(sel.description);
    if (el) {
      const r = elementToText(el, isHidden);
      l2Text = r.text;
      if (r.hiddenRemoved) warnings.push('hidden_text_removed');
      if (l2Text) layers.push('L2');
    }
  }

  // L3 generic
  let l3Text = '';
  let genericConfidence = 0;
  if (!l2Text || l2Text.length < 400) {
    const g = genericExtract(doc, isHidden);
    if (g) {
      l3Text = g.text;
      genericConfidence = g.confidence;
      if (g.hiddenRemoved) warnings.push('hidden_text_removed');
      layers.push('L3');
    }
  }

  // L5 reconciliation: prefer visible text when structured data disagrees (stale JSON-LD).
  const visible = l2Text.length >= 400 ? l2Text : l3Text;
  let chosen = visible || l1Text;
  let confidence = l2Text ? 0.85 : genericConfidence;
  if (l1Text && visible) {
    const sim = similarity(l1Text, visible);
    if (sim >= 0.6) {
      chosen = l1Text.length >= visible.length * 0.6 ? l1Text : visible;
      confidence = 0.95;
    } else {
      warnings.push('structured_visible_conflict');
      confidence = Math.min(confidence, 0.6);
    }
  } else if (l1Text) {
    confidence = 0.9;
  }
  if (!chosen || chosen.length < 150) return null;

  const cleaned = dedupeParagraphs(normalizeWhitespace(stripInvisible(chosen)));
  const { text, truncated } = capText(cleaned);
  if (truncated) warnings.push('truncated');

  const titleFromDom = sel?.title ? doc.querySelector(sel.title)?.textContent?.trim() : undefined;
  const h1 = doc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
  const title = structured?.title ?? titleFromDom ?? h1 ?? undefined;
  const company = structured?.company ?? (sel?.company ? doc.querySelector(sel.company)?.textContent?.trim() : undefined);

  return {
    source: { url: opts.url, host, adapter: adapter?.id ?? 'generic', layers_used: [...new Set(layers)], extracted_at: now.toISOString(), confidence: Math.round(confidence * 100) / 100 },
    fields: {
      ...(title ? { title: title.slice(0, 300) } : {}),
      ...(company ? { company: company.slice(0, 300) } : {}),
      location: structured?.location ?? [],
      ...(structured?.employment_type ? { employment_type: structured.employment_type } : {}),
      ...(structured?.salary ? { salary: structured.salary } : {}),
      ...(structured?.date_posted ? { date_posted: structured.date_posted } : {}),
    },
    description_text: text,
    sections: sectionsOf(text),
    warnings: [...new Set(warnings)],
    jd_hash: await jdHash(text),
  };
}

/** L4: user-selected or pasted text becomes an ExtractedJob. */
export async function extractJobFromText(raw: string, meta: { url?: string; title?: string; now?: Date } = {}): Promise<ExtractedJob> {
  const now = meta.now ?? new Date();
  const cleaned = dedupeParagraphs(normalizeWhitespace(stripInvisible(raw)));
  const { text, truncated } = capText(cleaned);
  let host: string | undefined;
  try {
    host = meta.url ? new URL(meta.url).hostname : undefined;
  } catch {
    host = undefined;
  }
  return {
    source: { ...(meta.url ? { url: meta.url } : {}), ...(host ? { host } : {}), adapter: 'selection', layers_used: ['L4'], extracted_at: now.toISOString(), confidence: 0.7 },
    fields: { ...(meta.title ? { title: meta.title } : {}), location: [] },
    description_text: text,
    sections: sectionsOf(text),
    warnings: truncated ? ['truncated'] : [],
    jd_hash: await jdHash(text),
  };
}
