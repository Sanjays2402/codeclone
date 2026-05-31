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

// ---------------------------------------------------------------------------
// Clone-type classification.
//
// Implements the canonical Bellon/Roy/Cordy software-clone taxonomy on top of
// the lexical signals already computed above. We add a structural pass that
// replaces identifiers/numbers/strings with type-anonymous placeholders so we
// can distinguish Type-2 (renamed identifiers, same structure) from Type-3
// (near-miss with edits) and Type-4 (semantic / dissimilar tokens).
//
//   Type-1  Exact clone modulo whitespace and comments
//   Type-2  Same structure, identifiers and literals renamed
//   Type-3  Type-2 plus small additions, deletions, or modifications
//   Type-4  Functionally similar but lexically and structurally different
// ---------------------------------------------------------------------------

const LINE_COMMENT_RE = /(\/\/[^\n]*|#[^\n]*)/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const STRING_RE = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;

const RESERVED = new Set([
  // JS/TS
  "function","const","let","var","return","if","else","for","while","do",
  "switch","case","break","continue","new","this","class","extends","super",
  "import","from","export","default","async","await","try","catch","finally",
  "throw","typeof","instanceof","in","of","yield","void","delete","true","false","null","undefined",
  // Python
  "def","lambda","pass","yield","with","as","raise","global","nonlocal","None","True","False",
  "and","or","not","is","elif","print",
  // common type/keyword spillover
  "int","float","str","bool","list","dict","set","tuple","public","private","protected","static",
  "void","struct","enum","interface","type","namespace",
]);

function stripCommentsAndStrings(src: string): string {
  return src
    .replace(BLOCK_COMMENT_RE, " ")
    .replace(LINE_COMMENT_RE, " ")
    .replace(STRING_RE, " 'S' ");
}

/**
 * Anonymize identifiers and numeric literals so two snippets that differ only
 * by names produce identical token streams. Keeps reserved keywords and
 * punctuation intact so the structure is preserved.
 */
export function structuralTokens(src: string): string[] {
  const cleaned = stripCommentsAndStrings(src);
  const toks = cleaned.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[^\sA-Za-z0-9]/g) ?? [];
  const out: string[] = [];
  for (const t of toks) {
    if (/^[0-9]/.test(t)) out.push("N");
    else if (/^[A-Za-z_]/.test(t)) out.push(RESERVED.has(t) ? t : "ID");
    else out.push(t);
  }
  return out;
}

function nGramSet(arr: string[], n: number): Set<string> {
  if (arr.length < n) return new Set(arr.length ? [arr.join(" ")] : []);
  const out = new Set<string>();
  for (let i = 0; i <= arr.length - n; i++) out.add(arr.slice(i, i + n).join(" "));
  return out;
}

export type CloneType = "type-1" | "type-2" | "type-3" | "type-4" | "none";

export interface CloneClassification {
  type: CloneType;
  confidence: number;          // 0..1, how strongly the signals fit the chosen type
  structuralSim: number;       // Jaccard over 4-grams of anonymized token stream
  rawTokenSim: number;         // mirror of compareCode.tokenJaccard for context
  rationale: string[];         // short, human readable reasons
  label: string;               // display label, e.g. "Type-2 clone (renamed)"
}

function normalizedExact(a: string, b: string): boolean {
  // Whitespace + comments + string-literal insensitive byte equality.
  const norm = (s: string) =>
    stripCommentsAndStrings(s).replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

export function classifyClone(
  a: string,
  b: string,
  scores: SimilarityScores,
): CloneClassification {
  const sa = structuralTokens(a);
  const sb = structuralTokens(b);
  const ga = nGramSet(sa, 4);
  const gb = nGramSet(sb, 4);
  const structural = jaccard(ga, gb);
  const rawTok = scores.tokenJaccard;
  const shingle = scores.shingleJaccard;

  const rationale: string[] = [];
  let type: CloneType = "none";
  let confidence = 0;
  let label = "not a clone";

  // Type-1: exact modulo whitespace/comments/strings.
  if (normalizedExact(a, b)) {
    type = "type-1";
    confidence = 1;
    label = "Type-1 clone (exact)";
    rationale.push("Byte-equal after stripping comments, strings, and whitespace.");
    return { type, confidence, structuralSim: structural, rawTokenSim: rawTok, rationale, label };
  }

  // Type-2: structural tokens match very closely, raw tokens diverge.
  if (structural >= 0.85) {
    type = rawTok >= 0.85 ? "type-1" : "type-2";
    if (type === "type-1") {
      label = "Type-1 clone (near-exact)";
      rationale.push("Both raw and structural token streams match above 0.85.");
    } else {
      label = "Type-2 clone (renamed)";
      rationale.push(`Structural Jaccard ${structural.toFixed(2)} with identifiers anonymized.`);
      rationale.push(`Raw token Jaccard only ${rawTok.toFixed(2)} suggests identifier or literal renaming.`);
    }
    confidence = Math.min(1, structural);
    return { type, confidence, structuralSim: structural, rawTokenSim: rawTok, rationale, label };
  }

  // Type-3: structurally similar with edits (additions, deletions, tweaks).
  if (structural >= 0.5 || (rawTok >= 0.45 && shingle >= 0.45)) {
    type = "type-3";
    label = "Type-3 clone (near-miss)";
    confidence = Math.min(1, Math.max(structural, (rawTok + shingle) / 2));
    rationale.push(`Structural Jaccard ${structural.toFixed(2)} indicates shared skeleton.`);
    rationale.push(`Lexical overlap ${rawTok.toFixed(2)} tokens / ${shingle.toFixed(2)} shingles points to edited regions.`);
    return { type, confidence, structuralSim: structural, rawTokenSim: rawTok, rationale, label };
  }

  // Type-4: low surface similarity but non-trivial token overlap, possibly
  // semantic. Flag conservatively. Without execution we cannot prove behavior.
  if (rawTok >= 0.25 && structural < 0.5 && structural >= 0.15) {
    type = "type-4";
    label = "Type-4 candidate (semantic)";
    confidence = Math.min(1, (rawTok + structural) / 2);
    rationale.push(`Low structural overlap ${structural.toFixed(2)} but shared vocabulary ${rawTok.toFixed(2)}.`);
    rationale.push("Possible reimplementation of the same task. Verify with tests or execution traces.");
    return { type, confidence, structuralSim: structural, rawTokenSim: rawTok, rationale, label };
  }

  rationale.push(`Structural Jaccard ${structural.toFixed(2)} and token Jaccard ${rawTok.toFixed(2)} are below clone thresholds.`);
  return {
    type: "none",
    confidence: 1 - Math.max(structural, rawTok),
    structuralSim: structural,
    rawTokenSim: rawTok,
    rationale,
    label: "not a clone",
  };
}

// Re-export so callers don't have to also import `_internal` symbols.
export { jaccard, containment };
