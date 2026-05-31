import { NextResponse } from "next/server";
import { compareCode, alignLines } from "../../../lib/similarity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 64 * 1024; // 64 KiB per side keeps shingle work bounded

interface CompareBody {
  a?: unknown;
  b?: unknown;
  language?: unknown;
}

function parseBody(body: CompareBody): { a: string; b: string; language: string } | { error: string } {
  const a = typeof body.a === "string" ? body.a : "";
  const b = typeof body.b === "string" ? body.b : "";
  const language = typeof body.language === "string" && body.language.trim()
    ? body.language.trim()
    : "auto";
  if (!a.trim() || !b.trim()) {
    return { error: "Both 'a' and 'b' must be non-empty strings." };
  }
  if (Buffer.byteLength(a, "utf-8") > MAX_BYTES || Buffer.byteLength(b, "utf-8") > MAX_BYTES) {
    return { error: `Each snippet must be at most ${MAX_BYTES} bytes.` };
  }
  return { a, b, language };
}

export async function POST(req: Request) {
  let raw: CompareBody;
  try {
    raw = (await req.json()) as CompareBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const started = performance.now();
  const scores = compareCode(parsed.a, parsed.b);
  const alignment = alignLines(parsed.a, parsed.b);
  const latencyMs = performance.now() - started;
  return NextResponse.json({
    language: parsed.language,
    bytes: { a: Buffer.byteLength(parsed.a, "utf-8"), b: Buffer.byteLength(parsed.b, "utf-8") },
    scores,
    alignment,
    latency_ms: Number(latencyMs.toFixed(3)),
    method: "exact-jaccard+5gram-shingles+line-align",
  });
}
