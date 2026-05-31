/**
 * Code similarity primitives.
 *
 * Mirrors the normalization + character shingling used by the Python
 * preprocessor in packages/dataset/codeclone_dataset/dedupe.py so the
 * dashboard's interactive compare page reports the same shape of score
 * the offline dedupe pipeline does.
 *
 * Three exact (non-sketched) metrics are computed:
 *   - tokenJaccard:   set Jaccard over identifier/number/punct tokens.
 *   - shingleJaccard: set Jaccard over 5-char shingles of whitespace-normalized text.
 *   - containment:    |A ∩ B| / min(|A|, |B|) on the shingle sets.
 */

const WS_RE = /\s+/g;

export function normalize(text: string): string {
  return text.trim().replace(WS_RE, " ");
}

export function tokenize(s: string): string[] {
  return s.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\sA-Za-z0-9]/g) ?? [];
}

export function charShingles(text: string, k = 5): Set<string> {
  const t = normalize(text);
  if (t.length <= k) return new Set([t]);
  const out = new Set<string>();
  for (let i = 0; i <= t.length - k; i++) out.add(t.slice(i, i + k));
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  for (const v of small) if (big.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function containment<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const small = a.size <= b.size ? a : b;
  const big = small === a ? b : a;
  let inter = 0;
  for (const v of small) if (big.has(v)) inter++;
  return inter / Math.min(a.size, b.size);
}

export interface SimilarityScores {
  tokenJaccard: number;
  shingleJaccard: number;
  containment: number;
  shared: { tokens: number; shingles: number };
  size: { aTokens: number; bTokens: number; aShingles: number; bShingles: number };
  matchedTokens: string[];
}

export function compareCode(a: string, b: string): SimilarityScores {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let interTok = 0;
  const matched: string[] = [];
  for (const t of ta) {
    if (tb.has(t)) {
      interTok++;
      if (t.length >= 3 && !/^[0-9]+$/.test(t)) matched.push(t);
    }
  }
  const tokenJ = ta.size + tb.size - interTok === 0
    ? 0
    : interTok / (ta.size + tb.size - interTok);

  const sa = charShingles(a);
  const sb = charShingles(b);
  let interSh = 0;
  for (const s of sa) if (sb.has(s)) interSh++;
  const shingleJ = sa.size + sb.size - interSh === 0
    ? 0
    : interSh / (sa.size + sb.size - interSh);
  const cont = (sa.size === 0 || sb.size === 0) ? 0 : interSh / Math.min(sa.size, sb.size);

  // Stable-sorted, capped matched-token list for the UI.
  matched.sort((x, y) => (y.length - x.length) || x.localeCompare(y));

  return {
    tokenJaccard: tokenJ,
    shingleJaccard: shingleJ,
    containment: cont,
    shared: { tokens: interTok, shingles: interSh },
    size: {
      aTokens: ta.size, bTokens: tb.size,
      aShingles: sa.size, bShingles: sb.size,
    },
    matchedTokens: matched.slice(0, 64),
  };
}

export function labelForScore(s: number): { label: string; tone: "pos" | "warn" | "neutral" | "neg" } {
  if (s >= 0.85) return { label: "near-duplicate", tone: "pos" };
  if (s >= 0.6)  return { label: "highly similar", tone: "pos" };
  if (s >= 0.35) return { label: "partial overlap", tone: "warn" };
  if (s >= 0.15) return { label: "weakly related", tone: "neutral" };
  return { label: "distinct", tone: "neg" };
}

// Re-export so callers don't have to also import `_internal` symbols.
export { jaccard, containment };
