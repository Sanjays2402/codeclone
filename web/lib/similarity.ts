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

// ---------------------------------------------------------------------------
// Line-level alignment.
//
// For each non-blank line in A, find the best matching non-blank line in B by
// token Jaccard on the same tokenizer used above. This produces a sparse map
// useful for two things in the UI: a heatmap of which A-line pairs to which
// B-line, and a "moved blocks" view (high score, different line index).
// Pure exact computation, no sketching, capped at 400 lines per side so the
// O(n*m) cost stays bounded for the 64 KiB request limit.
// ---------------------------------------------------------------------------

export interface LineMatch {
  a: number;          // 1-indexed line number in A
  b: number;          // 1-indexed line number in B (best match)
  score: number;      // token Jaccard in [0, 1]
  exact: boolean;     // true when normalized text is byte-equal
  moved: boolean;     // exact (or score >= 0.9) but b !== a
}

export interface LineAlignment {
  matches: LineMatch[];       // one entry per non-blank A line that has any overlap
  aLines: number;             // total non-blank lines in A
  bLines: number;             // total non-blank lines in B
  exactPairs: number;         // count where exact === true
  movedPairs: number;         // count where moved === true
  coverageA: number;          // fraction of A's non-blank lines with score >= 0.5
  coverageB: number;          // fraction of B's non-blank lines covered by some match >= 0.5
}

const MAX_ALIGN_LINES = 400;

function normalizeLine(s: string): string {
  return s.trim().replace(WS_RE, " ");
}

export function alignLines(a: string, b: string): LineAlignment {
  const rawA = a.split(/\r?\n/);
  const rawB = b.split(/\r?\n/);

  type L = { idx: number; norm: string; tokens: Set<string> };
  const buildSide = (raw: string[]): L[] => {
    const out: L[] = [];
    for (let i = 0; i < raw.length && out.length < MAX_ALIGN_LINES; i++) {
      const norm = normalizeLine(raw[i]);
      if (norm.length === 0) continue;
      out.push({ idx: i + 1, norm, tokens: new Set(tokenize(norm)) });
    }
    return out;
  };

  const A = buildSide(rawA);
  const B = buildSide(rawB);

  const matches: LineMatch[] = [];
  const bCovered = new Set<number>();

  for (const la of A) {
    let bestScore = 0;
    let bestB = -1;
    let bestExact = false;
    for (const lb of B) {
      if (la.norm === lb.norm) {
        bestScore = 1;
        bestB = lb.idx;
        bestExact = true;
        break;
      }
      if (la.tokens.size === 0 || lb.tokens.size === 0) continue;
      let inter = 0;
      const small = la.tokens.size <= lb.tokens.size ? la.tokens : lb.tokens;
      const big = small === la.tokens ? lb.tokens : la.tokens;
      for (const t of small) if (big.has(t)) inter++;
      const union = la.tokens.size + lb.tokens.size - inter;
      const s = union === 0 ? 0 : inter / union;
      if (s > bestScore) {
        bestScore = s;
        bestB = lb.idx;
      }
    }
    if (bestB === -1 || bestScore < 0.2) continue;
    const moved = (bestExact || bestScore >= 0.9) && bestB !== la.idx;
    matches.push({ a: la.idx, b: bestB, score: Number(bestScore.toFixed(4)), exact: bestExact, moved });
    if (bestScore >= 0.5) bCovered.add(bestB);
  }

  const aHit = matches.filter(m => m.score >= 0.5).length;
  const exactPairs = matches.filter(m => m.exact).length;
  const movedPairs = matches.filter(m => m.moved).length;

  return {
    matches,
    aLines: A.length,
    bLines: B.length,
    exactPairs,
    movedPairs,
    coverageA: A.length === 0 ? 0 : aHit / A.length,
    coverageB: B.length === 0 ? 0 : bCovered.size / B.length,
  };
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
