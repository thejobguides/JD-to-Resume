import { basicHidden, elementToText, type HiddenCheck } from './html';

// L3 generic readability-style extractor (architecture.md §4.2).

export const JD_HEADINGS =
  /^(about (the )?(role|job|position|team|you)|the role|role overview|overview|job description|description|responsibilities|key responsibilities|what you('|’)ll do|what you will do|your impact|day[- ]to[- ]day|duties|requirements|qualifications|minimum qualifications|basic qualifications|preferred qualifications|required (skills|qualifications)|what you('|’)ll bring|what we('|’)re looking for|who you are|you (have|bring)|must[- ]haves?|nice[- ]to[- ]haves?|bonus( points)?|pluses|skills|experience|education|benefits|perks|compensation|what we offer|about us|about (the )?company)\b/i;

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[aria-hidden="true"]',
  '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
  '[class*="similar-jobs" i]', '[class*="similarjobs" i]', '[class*="related-jobs" i]', '[class*="recommend" i]',
  '[class*="job-card" i]', '[class*="jobs-list" i]', '[class*="share" i]', '[class*="social" i]',
];

function countHeadings(text: string): number {
  return text.split('\n').filter((l) => l.length < 60 && JD_HEADINGS.test(l.replace(/[:：]$/, '').trim())).length;
}

function scoreBlock(el: Element, isHidden: HiddenCheck): { el: Element; score: number; text: string } {
  const { text } = elementToText(el, isHidden);
  const len = text.length;
  const bullets = (text.match(/^• /gm) ?? []).length;
  const headings = countHeadings(text);
  const links = el.querySelectorAll('a').length;
  const linkDensity = links / Math.max(1, len / 100);
  const score = Math.min(len, 12_000) / 100 + headings * 25 + Math.min(bullets, 40) * 2 - linkDensity * 8;
  return { el, score, text };
}

export interface GenericResult {
  text: string;
  hiddenRemoved: boolean;
  confidence: number;
}

/** Picks the most JD-like block. Works on a detached clone so the page is never modified. */
export function genericExtract(doc: Document, isHidden: HiddenCheck = basicHidden): GenericResult | null {
  const body = doc.body;
  if (!body) return null;
  // Evaluate visibility on the live DOM (computed styles), then strip noise from a clone.
  const hiddenMarks: Element[] = [];
  body.querySelectorAll('*').forEach((el) => {
    if (isHidden(el)) hiddenMarks.push(el);
  });
  const clone = body.cloneNode(true) as Element;
  const liveAll = Array.from(body.querySelectorAll('*'));
  const cloneAll = Array.from(clone.querySelectorAll('*'));
  const hiddenSet = new Set(hiddenMarks);
  let hiddenRemoved = false;
  liveAll.forEach((el, i) => {
    if (hiddenSet.has(el) && cloneAll[i]) {
      if ((cloneAll[i]!.textContent ?? '').trim()) hiddenRemoved = true;
      cloneAll[i]!.setAttribute('data-jmo-hidden', '1');
    }
  });
  clone.querySelectorAll('[data-jmo-hidden]').forEach((el) => el.remove());
  for (const sel of NOISE_SELECTORS) {
    try {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    } catch {
      /* selector unsupported in this DOM implementation */
    }
  }
  const candidates = Array.from(clone.querySelectorAll('main, article, section, div, [role="main"]')).filter((el) => (el.textContent ?? '').trim().length > 300);
  if (!candidates.length) candidates.push(clone);
  const scored = candidates.map((el) => scoreBlock(el, () => false)).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.text.length < 150) return null;
  // Prefer the smallest descendant that keeps ≥ 85% of the best block's score (drops page chrome).
  let chosen = best;
  for (const c of scored) {
    if (c.el !== best.el && best.el.contains(c.el) && c.score >= best.score * 0.85 && c.text.length < chosen.text.length) chosen = c;
  }
  const text = dedupeParagraphs(chosen.text);
  const headings = countHeadings(text);
  const confidence = Math.max(0.3, Math.min(0.85, 0.4 + headings * 0.1 + (text.length > 1200 ? 0.1 : 0)));
  return { text, hiddenRemoved, confidence };
}

/** Removes repeated paragraphs (mobile/desktop duplicates). */
export function dedupeParagraphs(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const key = line.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (key.length > 40) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
