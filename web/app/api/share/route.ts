import { NextResponse } from "next/server";
import { createShare, listShares, MAX_SNIPPET_BYTES } from "../../../lib/share";
import { compareCode, alignLines, classifyClone } from "../../../lib/similarity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ShareBody {
  a?: unknown;
  b?: unknown;
  language?: unknown;
  title?: unknown;
  tags?: unknown;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const q = url.searchParams.get("q") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  let limit = 200;
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0 && n <= 1000) limit = n;
  }
  try {
    const items = await listShares({ limit, q, tag });
    return NextResponse.json({ items, count: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let raw: ShareBody;
  try {
    raw = (await req.json()) as ShareBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const a = typeof raw.a === "string" ? raw.a : "";
  const b = typeof raw.b === "string" ? raw.b : "";
  const language =
    typeof raw.language === "string" && raw.language.trim()
      ? raw.language.trim()
      : "auto";
  if (!a.trim() || !b.trim()) {
    return NextResponse.json(
      { error: "Both 'a' and 'b' must be non-empty strings." },
      { status: 400 },
    );
  }
  if (
    Buffer.byteLength(a, "utf-8") > MAX_SNIPPET_BYTES ||
    Buffer.byteLength(b, "utf-8") > MAX_SNIPPET_BYTES
  ) {
    return NextResponse.json(
      { error: `Each snippet must be at most ${MAX_SNIPPET_BYTES} bytes.` },
      { status: 413 },
    );
  }
  // Recompute server-side so the link can't lie about the score.
  const started = performance.now();
  const scores = compareCode(a, b);
  const alignment = alignLines(a, b);
  const clone = classifyClone(a, b, scores);
  const latencyMs = performance.now() - started;
  try {
    const title = typeof raw.title === "string" ? raw.title : undefined;
    const tags = Array.isArray(raw.tags) ? (raw.tags as unknown[]).filter((t) => typeof t === "string") as string[] : undefined;
    const rec = await createShare({
      a,
      b,
      language,
      title,
      tags,
      result: {
        language,
        scores,
        alignment,
        clone,
        bytes: {
          a: Buffer.byteLength(a, "utf-8"),
          b: Buffer.byteLength(b, "utf-8"),
        },
        latency_ms: Number(latencyMs.toFixed(3)),
        method:
          "exact-jaccard+5gram-shingles+line-align+structural-4gram-clone-type",
      },
    });
    return NextResponse.json({ id: rec.id, url: `/r/${rec.id}` }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
