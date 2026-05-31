/**
 * Pure batch-compare helper shared by the internal /api/batch UI route and
 * the public /v1/batch API route. No I/O, no auth, no quota; the callers
 * own those concerns.
 */
import {
  compareCode,
  classifyClone,
  type CloneType,
  type SimilarityScores,
} from "./similarity.ts";

export const BATCH_LIMITS = {
  MAX_SNIPPETS: 12,
  MAX_BYTES_EACH: 32 * 1024,
  MAX_TOTAL_BYTES: 192 * 1024,
} as const;

export interface BatchInputSnippet {
  id?: unknown;
  label?: unknown;
  code?: unknown;
}

export interface ParsedSnippet {
  id: string;
  label: string;
  code: string;
}

export interface BatchInput {
  snippets?: unknown;
  language?: unknown;
}

export interface BatchParseOk {
  ok: true;
  snippets: ParsedSnippet[];
  language: string;
}

export interface BatchParseErr {
  ok: false;
  error: string;
}

export function parseBatch(body: BatchInput): BatchParseOk | BatchParseErr {
  if (!Array.isArray(body.snippets)) {
    return { ok: false, error: "'snippets' must be an array." };
  }
  if (body.snippets.length < 2) {
    return { ok: false, error: "Provide at least 2 snippets to build a matrix." };
  }
  if (body.snippets.length > BATCH_LIMITS.MAX_SNIPPETS) {
    return {
      ok: false,
      error: `At most ${BATCH_LIMITS.MAX_SNIPPETS} snippets per request.`,
    };
  }
  const seen = new Set<string>();
  const out: ParsedSnippet[] = [];
  let total = 0;
  for (let i = 0; i < body.snippets.length; i++) {
    const raw = body.snippets[i] as BatchInputSnippet;
    const code = typeof raw.code === "string" ? raw.code : "";
    if (!code.trim()) return { ok: false, error: `Snippet #${i + 1} is empty.` };
    const bytes = Buffer.byteLength(code, "utf-8");
    if (bytes > BATCH_LIMITS.MAX_BYTES_EACH) {
      return {
        ok: false,
        error: `Snippet #${i + 1} exceeds ${BATCH_LIMITS.MAX_BYTES_EACH} bytes.`,
      };
    }
    total += bytes;
    if (total > BATCH_LIMITS.MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: `Combined snippet size exceeds ${BATCH_LIMITS.MAX_TOTAL_BYTES} bytes.`,
      };
    }
    let id =
      typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `s${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const label =
      typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;
    out.push({ id, label, code });
  }
  const language =
    typeof body.language === "string" && body.language.trim()
      ? body.language.trim()
      : "auto";
  return { ok: true, snippets: out, language };
}

export interface MatrixCell {
  i: number;
  j: number;
  scores: SimilarityScores;
  clone: { type: CloneType; confidence: number; rationale: string[] };
}

export interface BatchResult {
  language: string;
  n: number;
  snippets: Array<{
    index: number;
    id: string;
    label: string;
    bytes: number;
    lines: number;
  }>;
  matrix: number[][];
  cells: MatrixCell[];
  latency_ms: number;
  method: string;
}

export function runBatch(
  snippets: ParsedSnippet[],
  language: string,
): BatchResult {
  const n = snippets.length;
  const started = performance.now();

  const cells: MatrixCell[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const scores = compareCode(snippets[i].code, snippets[j].code);
      const clone = classifyClone(snippets[i].code, snippets[j].code, scores);
      cells.push({
        i,
        j,
        scores,
        clone: {
          type: clone.type,
          confidence: clone.confidence,
          rationale: clone.rationale,
        },
      });
    }
  }

  const matrix: number[][] = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => (r === c ? 1 : 0)),
  );
  for (const cell of cells) {
    matrix[cell.i][cell.j] = cell.scores.shingleJaccard;
    matrix[cell.j][cell.i] = cell.scores.shingleJaccard;
  }

  const latencyMs = performance.now() - started;
  return {
    language,
    n,
    snippets: snippets.map((s, i) => ({
      index: i,
      id: s.id,
      label: s.label,
      bytes: Buffer.byteLength(s.code, "utf-8"),
      lines: s.code.split("\n").length,
    })),
    matrix,
    cells,
    latency_ms: Number(latencyMs.toFixed(3)),
    method:
      "pairwise · exact-jaccard+5gram-shingles+structural-4gram-clone-type",
  };
}
