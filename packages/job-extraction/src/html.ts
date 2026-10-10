// DOM → plain text that keeps headings and bullets. Works in the browser and with linkedom in tests.

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'TR', 'TABLE', 'HEADER', 'MAIN', 'BLOCKQUOTE', 'PRE', 'DL', 'DT', 'DD']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM']);

export type HiddenCheck = (el: Element) => boolean;

/** Inline-style / attribute based hidden check; the injected script supplies a computed-style version. */
export const basicHidden: HiddenCheck = (el) => {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const style = (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  if (/display:none|visibility:hidden|opacity:0(?![.\d])|font-size:0|font-size:[0-3]px|height:0[^.]*overflow:hidden|clip:rect\(0/.test(style)) return true;
  if (/position:absolute/.test(style) && /(left|top):-\d{3,}/.test(style)) return true;
  const cls = `${el.getAttribute('class') ?? ''}`.toLowerCase();
  return /\b(sr-only|visually-hidden|screen-reader-only|hidden)\b/.test(cls);
};

export interface TextResult {
  text: string;
  hiddenRemoved: boolean;
}

export function elementToText(root: Element, isHidden: HiddenCheck = basicHidden): TextResult {
  const out: string[] = [];
  let hiddenRemoved = false;
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push((node.textContent ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (isHidden(el)) {
      if ((el.textContent ?? '').trim()) hiddenRemoved = true;
      return;
    }
    const block = BLOCK.has(tag);
    if (block) out.push('\n');
    if (tag === 'LI') out.push('• ');
    if (/^H[1-6]$/.test(tag)) out.push('\n');
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) out.push('\n');
  };
  walk(root);
  const text = out
    .join('')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l, i, arr) => l || (arr[i - 1] ?? '') !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^•\s*$/gm, '')
    .trim();
  return { text, hiddenRemoved };
}

/** HTML string (e.g. JSON-LD description) → text, using a provided DOMParser-like function. */
export function htmlStringToText(html: string, parse: (html: string) => Document): string {
  if (!/[<&]/.test(html)) return html.trim();
  const doc = parse(`<div id="__root">${html}</div>`);
  const root = doc.getElementById('__root') ?? doc.body ?? doc.documentElement;
  return elementToText(root as Element, () => false).text;
}
