import { ApiError } from '@jmo/shared';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { AdminEnv } from './context';

export async function parse<S extends z.ZodType>(c: Context<AdminEnv>, schema: S): Promise<z.infer<S>> {
  let json: unknown = {};
  const text = await c.req.text();
  if (text.length > 512 * 1024) throw new ApiError('payload_too_large', 'Request body is too large.');
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError('invalid_request', 'Malformed JSON body.');
    }
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new ApiError('invalid_request', 'Request validation failed.', { issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
}

export function range(c: Context<AdminEnv>): { from: string; to: string } {
  const to = c.req.query('to') ? new Date(c.req.query('to')!) : new Date();
  const from = c.req.query('from') ? new Date(c.req.query('from')!) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new ApiError('invalid_request', 'Invalid date range.');
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * One CSV document. Every cell is quoted (commas, quotes, newlines) and cells that a spreadsheet would run as a
 * formula (= + - @, tab, CR) get a leading apostrophe: exports contain admin- and user-entered text (CSV injection).
 */
export function toCsv(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
}
