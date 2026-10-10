// Pure scoring formula (architecture.md §7.4, §7.7). No I/O, no LLM. Deterministic.

export type CategoryKey =
  | 'required'
  | 'experience'
  | 'responsibilities'
  | 'preferred'
  | 'title'
  | 'keywords'
  | 'education'
  | 'certifications'
  | 'structure';

export const CATEGORY_WEIGHTS: Record<CategoryKey, number> = {
  required: 30,
  experience: 15,
  responsibilities: 15,
  preferred: 10,
  title: 8,
  keywords: 7,
  education: 5,
  certifications: 5,
  structure: 5,
};

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  required: 'Required skills',
  experience: 'Experience',
  responsibilities: 'Responsibilities',
  preferred: 'Preferred skills',
  title: 'Title fit',
  keywords: 'Keywords',
  education: 'Education',
  certifications: 'Certifications',
  structure: 'Resume structure',
};

export type State = 'strong' | 'partial' | 'weak' | 'none' | 'unknown';

export interface CreditParams {
  partial: number;
  weak: number;
}
export const DEFAULT_CREDITS: CreditParams = { partial: 0.6, weak: 0.3 };

export function creditOf(state: State, p: CreditParams = DEFAULT_CREDITS): number {
  switch (state) {
    case 'strong':
      return 1;
    case 'partial':
      return p.partial;
    case 'weak':
      return p.weak;
    default:
      return 0;
  }
}

/** One requirement's contribution. `components` (AND of several skills) average their credits. */
export interface ScoredItem {
  weight: number;
  state: State;
  components?: State[];
  hardMust?: boolean;
  deterministic?: boolean;
}

export function itemCredit(it: ScoredItem, p: CreditParams): number {
  if (it.components?.length) return it.components.reduce((s, c) => s + creditOf(c, p), 0) / it.components.length;
  return creditOf(it.state, p);
}

/** C_k over known (non-unknown) requirements; null when the category has no known requirement. */
export function categoryScore(items: ScoredItem[], p: CreditParams = DEFAULT_CREDITS): number | null {
  const known = items.filter((i) => i.state !== 'unknown');
  const denom = known.reduce((s, i) => s + i.weight, 0);
  if (denom <= 0) return null;
  return known.reduce((s, i) => s + i.weight * itemCredit(i, p), 0) / denom;
}

export interface CategoryInput {
  key: CategoryKey;
  /** requirement-based categories */
  items?: ScoredItem[];
  /** directly scored categories (title bucket, keywords, structure) */
  value?: number | null;
}

export interface Aggregate {
  base: number;
  gate: number;
  score: number;
  nHardMissing: number;
  categories: Array<{ key: CategoryKey; weight: number; value: number }>;
}

export function aggregate(cats: CategoryInput[], p: CreditParams = DEFAULT_CREDITS): Aggregate {
  const present: Array<{ key: CategoryKey; weight: number; value: number }> = [];
  for (const c of cats) {
    const v = c.items ? categoryScore(c.items, p) : (c.value ?? null);
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    present.push({ key: c.key, weight: CATEGORY_WEIGHTS[c.key], value: Math.max(0, Math.min(1, v)) });
  }
  const wsum = present.reduce((s, c) => s + c.weight, 0);
  const base = wsum ? (100 * present.reduce((s, c) => s + c.weight * c.value, 0)) / wsum : 0;
  const nHardMissing = cats.flatMap((c) => c.items ?? []).filter((i) => i.hardMust && i.state === 'none').length;
  const gate = Math.max(0.6, 1 - 0.07 * nHardMissing);
  return { base, gate, score: Math.round(base * gate), nHardMissing, categories: present };
}

export interface ConfidenceInput {
  qJd: number;
  qResume: number;
  /** unknown-requirement weight share */
  u: number;
  /** deterministic share */
  d: number;
}

export function confidence(c: ConfidenceInput): { value: number; label: 'High' | 'Medium' | 'Low' } {
  const value = 0.35 * c.qJd + 0.25 * c.qResume + 0.25 * (1 - c.u) + 0.15 * c.d;
  const v = Math.round(value * 1000) / 1000;
  return { value: v, label: v >= 0.8 ? 'High' : v >= 0.6 ? 'Medium' : 'Low' };
}

/** Score range from alternative partial/weak credits (architecture.md §7.7). */
export function scoreRange(cats: CategoryInput[]): [number, number] {
  const scores: number[] = [];
  for (const partial of [0.5, 0.6, 0.7]) for (const weak of [0.2, 0.3, 0.4]) scores.push(aggregate(cats, { partial, weak }).score);
  return [Math.min(...scores), Math.max(...scores)];
}
