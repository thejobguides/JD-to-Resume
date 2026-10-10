// Reads the job posting from the active tab after a user action (activeTab + scripting; no content scripts).
// The page is snapshotted by a self-contained injected function and parsed here with DOMParser, so no page
// script ever runs in the extension and nothing in the page is modified.

import { analyzeJobText, basicHidden, DEFAULT_ADAPTERS, extractJobFromDocument, extractJobFromText, validateAnalysisQuotes } from '@jmo/job-extraction';
import type { ExtractedJob, ExtractorAdapter, JobAnalysis } from '@jmo/shared';

const MAX_HTML = 3_000_000;
const HIDDEN_ATTR = 'data-jmo-hidden';

/**
 * Injected into the page (serialized — must not reference anything outside itself). Marks elements that are
 * invisible with computed styles on a CLONE of the DOM (hidden text is a prompt-injection vector), strips scripts
 * except JSON-LD, and returns the HTML plus the current selection.
 */
function snapshotPage(maxChars: number, hiddenAttr: string) {
  const live = Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, 40_000);
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const cloneBody = clone.querySelector('body');
  const cloned = Array.from(cloneBody ? cloneBody.querySelectorAll('*') : []).slice(0, 40_000);
  if (cloned.length === live.length) {
    for (let i = 0; i < live.length; i++) {
      const el = live[i]!;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const tiny = r.width <= 1 && r.height <= 1 && cs.overflow === 'hidden';
      const offscreen = cs.position !== 'static' && (r.right < -1000 || r.bottom < -1000);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || parseFloat(cs.fontSize) < 3 || tiny || offscreen) {
        cloned[i]!.setAttribute(hiddenAttr, '1');
      }
    }
  }
  clone.querySelectorAll('script:not([type="application/ld+json"]), style, noscript, svg, img, picture, video, audio, canvas, iframe, link').forEach((e) => e.remove());
  const html = clone.outerHTML;
  return {
    html: html.length > maxChars ? html.slice(0, maxChars) : html,
    url: location.href,
    title: document.title,
    selection: String(getSelection() ?? '').slice(0, 20_000),
  };
}

export class PageAccessError extends Error {
  constructor(
    readonly reason: 'no_permission' | 'restricted_page' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

async function activeTabId(): Promise<number> {
  // sidepanel.html?tab=<id> binds the panel to one tab (used when the panel is opened as a full tab, and by E2E tests).
  // Web pages can't open extension pages, so this parameter can only come from the extension or the user.
  const pinned = Number(new URLSearchParams(location.search).get('tab'));
  if (Number.isInteger(pinned) && pinned > 0) return pinned;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new PageAccessError('not_found', 'No active tab.');
  return tab.id;
}

export async function extractFromActiveTab(adapters: ExtractorAdapter[] = DEFAULT_ADAPTERS): Promise<ExtractedJob> {
  const tabId = await activeTabId();
  let results: chrome.scripting.InjectionResult<Awaited<ReturnType<typeof snapshotPage>>>[];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func: snapshotPage, args: [MAX_HTML, HIDDEN_ATTR] });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/chrome:\/\/|chrome-extension:|extensions gallery|webstore|cannot be scripted/i.test(msg)) throw new PageAccessError('restricted_page', 'This page can’t be read by extensions. Open the job posting in a normal tab.');
    throw new PageAccessError('no_permission', 'Click the Job Match Optimizer toolbar icon (or press Alt+J) while the job page is open, then try again — that lets us read that one page.');
  }
  const snap = results[0]?.result;
  if (!snap) throw new PageAccessError('not_found', 'We couldn’t read this page.');

  // A deliberate selection wins: the user is telling us exactly where the job description is.
  if (snap.selection.trim().length >= 200) return extractJobFromText(snap.selection, { url: snap.url, title: snap.title });

  const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  const doc = parseHtml(snap.html);
  const job = await extractJobFromDocument(doc, {
    url: snap.url,
    adapters,
    parseHtml,
    isHidden: (el) => el.hasAttribute(HIDDEN_ATTR) || basicHidden(el),
  });
  if (!job) throw new PageAccessError('not_found', 'We couldn’t find a job description on this page. Select the description text and right-click → “Analyze selected text”, or paste it.');
  return job;
}

export function jobFromText(text: string, meta: { url?: string; title?: string } = {}) {
  return extractJobFromText(text, meta);
}

/** Deterministic, on-device analysis: used when signed out, offline, or when hosted AI is switched off. */
export function analyzeLocally(job: ExtractedJob): JobAnalysis {
  const analysis = analyzeJobText(job.description_text, {
    ...(job.fields.title ? { title: job.fields.title } : {}),
    ...(job.fields.company ? { company: job.fields.company } : {}),
    location: job.fields.location,
    ...(job.fields.employment_type ? { employment_type: job.fields.employment_type } : {}),
    truncated: job.warnings.includes('truncated'),
  });
  return validateAnalysisQuotes(analysis, job.description_text).analysis;
}
