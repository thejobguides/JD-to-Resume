// Number normalization for gate G2 (architecture.md §6.4): "2M" = "2,000,000" = "2 million".

export interface NumberMention {
  value: number;
  kind: 'plain' | 'percent' | 'currency' | 'multiplier' | 'year';
  raw: string;
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, dozen: 12,
};

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};

const NUM_RE =
  /([$€£₹]\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(k|m|mm|mn|b|bn|t|thousand|million|billion|trillion)\b)?\s*(%|percent\b|x\b|×)?/gi;

export function extractNumbers(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  NUM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUM_RE.exec(text))) {
    const [raw, currency, digits, scale, suffix] = m;
    if (!digits) continue;
    let value = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (scale) value *= SCALE[scale.toLowerCase()] ?? 1;
    let kind: NumberMention['kind'] = 'plain';
    if (currency) kind = 'currency';
    else if (suffix && /%|percent/i.test(suffix)) kind = 'percent';
    else if (suffix && /x|×/i.test(suffix)) kind = 'multiplier';
    else if (!scale && /^(19[5-9]\d|20\d\d|2100)$/.test(digits)) kind = 'year';
    out.push({ value, kind, raw: raw.trim() });
  }
  const wordRe = new RegExp(`\\b(${Object.keys(WORDS).join('|')})\\b`, 'gi');
  let w: RegExpExecArray | null;
  while ((w = wordRe.exec(text))) {
    out.push({ value: WORDS[w[1]!.toLowerCase()]!, kind: 'plain', raw: w[0] });
  }
  return out;
}

function same(a: NumberMention, b: NumberMention): boolean {
  if (Math.abs(a.value - b.value) > 1e-9 * Math.max(1, Math.abs(a.value))) return false;
  // Percent must stay a percent; a plain number may match currency/plain/multiplier of the same value.
  if ((a.kind === 'percent') !== (b.kind === 'percent')) return false;
  return true;
}

/** Numbers in `output` that do not appear (normalized) anywhere in `evidenceTexts`. */
export function newNumbers(output: string, evidenceTexts: string[]): NumberMention[] {
  const evidence = evidenceTexts.flatMap(extractNumbers);
  return extractNumbers(output).filter((n) => !evidence.some((e) => same(n, e)));
}
