import { NextResponse } from "next/server";
import { compareCode, classifyClone, type CloneType, type SimilarityScores } from "../../../lib/similarity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SNIPPETS = 12;
const MAX_BYTES_EACH = 32 * 1024; // 32 KiB per snippet
const MAX_TOTAL_BYTES = 192 * 1024; // hard ceiling on the request

interface InSnippet {
  id?: unknown;
  label?: unknown;
  code?: unknown;
}

interface BatchBody {
  snippets?: unknown;
  language?: unknown;
}

interface ParsedSnippet { id: string; label: string; code: string }

function parseBody(body: BatchBody): { snippets: ParsedSnippet[]; language: string } | { error: string } {
  if (!Array.isArray(body.snippets)) {
    return { error: "'snippets' must be an array." };
  }
  if (body.snippets.length < 2) {
    return { error: "Provide at least 2 snippets to build a matrix." };
  }
  if (body.snippets.length > MAX_SNIPPETS) {
    return { error: `At most ${MAX_SNIPPETS} snippets per request.` };
  }
  const seen = new Set<string>();
  const out: ParsedSnippet[] = [];
  let total = 0;
  for (let i = 0; i < body.snippets.length; i++) {
    const raw = body.snippets[i] as InSnippet;
    const code = typeof raw.code === "string" ? raw.code : "";
    if (!code.trim()) return { error: `Snippet #${i + 1} is empty.` };
    const bytes = Buffer.byteLength(code, "utf-8");
    if (bytes > MAX_BYTES_EACH) return { error: `Snippet #${i + 1} exceeds ${MAX_BYTES_EACH} bytes.` };
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return { error: `Combined snippet size exceeds ${MAX_TOTAL_BYTES} bytes.` };
    let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `s${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;
    out.push({ id, label, code });
  }
  const language = typeof body.language === "string" && body.language.trim() ? body.language.trim() : "auto";
  return { snippets: out, language };
}

export interface MatrixCell {
  i: number;
  j: number;
  scores: SimilarityScores;
  clone: { type: CloneType; confidence: number; rationale: string[] };
}

export async function POST(req: Request) {
  let raw: BatchBody;
  try {
    raw = (await req.json()) as BatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { snippets, language } = parsed;
  const n = snippets.length;
  const started = performance.now();

  // Upper-triangular pairwise comparison; diagonal is self (1.0).
  const cells: MatrixCell[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const scores = compareCode(snippets[i].code, snippets[j].code);
      const clone = classifyClone(snippets[i].code, snippets[j].code, scores);
      cells.push({
        i,
        j,
        scores,
        clone: { type: clone.type, confidence: clone.confidence, rationale: clone.rationale },
      });
    }
  }

  // Build a flat NxN matrix of the primary metric (shingleJaccard) for the heatmap.
  const matrix: number[][] = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => (r === c ? 1 : 0))
  );
  for (const cell of cells) {
    matrix[cell.i][cell.j] = cell.scores.shingleJaccard;
    matrix[cell.j][cell.i] = cell.scores.shingleJaccard;
  }

  const latencyMs = performance.now() - started;
  return NextResponse.json({
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
    method: "pairwise · exact-jaccard+5gram-shingles+structural-4gram-clone-type",
  });
}
