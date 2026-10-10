import type { SpanLine } from '@jmo/shared';

export interface ParsedDocument {
  kind: 'pdf' | 'docx' | 'txt' | 'paste' | 'linkedin_export';
  lines: SpanLine[];
  pages: number;
  warnings: string[];
  columns_detected: boolean;
  hidden_text_found: boolean;
  contact_in_header_only: boolean;
  tables_or_textboxes: boolean;
  text_extractable: boolean;
  links: string[];
}

export class ParseError extends Error {
  constructor(
    readonly code: 'scanned' | 'encrypted' | 'too_large' | 'unsupported' | 'corrupt' | 'empty' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

export const LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPages: 10,
  maxDocxUncompressed: 50 * 1024 * 1024,
  minCharsPerPage: 200,
};

export function spanId(docVersion: string, page: number, line: number): string {
  return `s_${docVersion}_${page}_${line}`;
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
export const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;
