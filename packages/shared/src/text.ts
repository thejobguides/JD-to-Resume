// Text normalization shared by the extension, the API and tests.

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** Removes zero-width and bidi control characters (prompt-injection and spoofing vectors). */
export function stripInvisible(s: string): string {
  return s.replace(ZERO_WIDTH, '').replace(BIDI_CONTROLS, '');
}

/** Collapses runs of spaces/tabs, trims each line and collapses 3+ blank lines to 2. */
export function normalizeWhitespace(s: string): string {
  return stripInvisible(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t  -   　]+/g, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Normalization used only to compute jd_hash (architecture.md §12 / ai-model-comparison.md §12). */
export function normalizeForHash(s: string): string {
  return normalizeWhitespace(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function sha256Hex(text: string | Uint8Array): Promise<string> {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function jdHash(jdText: string): Promise<string> {
  return `sha256:${await sha256Hex(normalizeForHash(jdText))}`;
}

/** Lowercase, strip punctuation at the edges, collapse spaces: used for term comparison. */
export function normTerm(s: string): string {
  return stripInvisible(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}+#./' -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary-safe containment test that also works for terms like "C++", "C#", ".NET", "Node.js". */
export function containsTerm(haystack: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}+#])${escapeRegExp(t)}(?=$|[^\\p{L}\\p{N}+#])`, 'iu');
  return re.test(haystack);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
