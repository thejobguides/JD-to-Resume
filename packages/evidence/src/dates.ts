// Date parsing for roles ("Mar 2021 – Present", "03/2021 - 2023", "2019–2021").

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const PART = `(?:(?:${MONTH_NAMES})\\.?\\s+\\d{4}|\\d{1,2}\\s*/\\s*\\d{4}|\\d{4}\\s*-\\s*\\d{2}(?!\\d)|\\d{4})`;
const END = `(?:${PART}|present|current|now|today|ongoing)`;
export const DATE_RANGE_RE = new RegExp(`(${PART})\\s*(?:[-–—~]|to|until|through)\\s*(${END})`, 'i');
export const SINGLE_DATE_RE = new RegExp(`\\b(${PART})\\b`, 'i');

/** Parses one date expression to an ISO partial ("2021" | "2021-03") or "present". */
export function parseDatePart(s: string): { iso: string; precision: 'year' | 'month' } | 'present' | null {
  const t = s.trim().toLowerCase().replace(/\.$/, '');
  if (/^(present|current|now|today|ongoing)$/.test(t)) return 'present';
  let m = t.match(new RegExp(`^(${MONTH_NAMES})\\.?\\s+(\\d{4})$`));
  if (m) return { iso: `${m[2]}-${String(MONTHS[m[1]!]).padStart(2, '0')}`, precision: 'month' };
  m = t.match(/^(\d{1,2})\s*\/\s*(\d{4})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { iso: `${m[2]}-${m[1]!.padStart(2, '0')}`, precision: 'month' };
  m = t.match(/^(\d{4})\s*-\s*(\d{2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { iso: `${m[1]}-${m[2]}`, precision: 'month' };
  m = t.match(/^(\d{4})$/);
  if (m) return { iso: m[1]!, precision: 'year' };
  return null;
}

export interface ParsedRange {
  start: string;
  end: string; // ISO partial or "present"
  precision: 'year' | 'month';
  match: string;
  index: number;
}

export function findDateRange(text: string): ParsedRange | null {
  const m = DATE_RANGE_RE.exec(text);
  if (!m) return null;
  const a = parseDatePart(m[1]!);
  const b = parseDatePart(m[2]!);
  if (!a || a === 'present' || !b) return null;
  return {
    start: a.iso,
    end: b === 'present' ? 'present' : b.iso,
    precision: a.precision === 'month' && (b === 'present' || b.precision === 'month') ? 'month' : 'year',
    match: m[0],
    index: m.index,
  };
}

/** Month index (months since year 0) for an ISO partial; year-only dates map to January (start) or December (end). */
export function monthIndex(iso: string | undefined, now: Date, isEnd: boolean): number | null {
  if (!iso) return null;
  if (iso === 'present') return now.getUTCFullYear() * 12 + now.getUTCMonth();
  const m = iso.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) - 1 : isEnd ? 11 : 0;
  return year * 12 + month;
}

export function endYear(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  if (iso === 'present') return now.getUTCFullYear();
  const m = iso.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** Total years across ranges with overlaps merged (architecture.md §7.2 experience requirements). */
export function totalYears(ranges: Array<{ start?: string; end?: string }>, now: Date): number | null {
  const spans: Array<[number, number]> = [];
  for (const r of ranges) {
    const s = monthIndex(r.start, now, false);
    const e = monthIndex(r.end ?? 'present', now, true);
    if (s === null || e === null || e < s) continue;
    spans.push([s, e + 1]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = spans[0]!;
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      [cs, ce] = [s, e];
    }
  }
  total += ce - cs;
  return Math.round((total / 12) * 10) / 10;
}
