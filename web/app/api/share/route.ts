import { NextResponse } from "next/server";
import { createShare, listSharesPage, MAX_SNIPPET_BYTES } from "../../../lib/share";
import { compareCode, alignLines, classifyClone } from "../../../lib/similarity";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { emitNotification } from "../../../lib/notifications";
import { tryRecordAudit } from "../../../lib/audit";

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
  const sp = url.searchParams;
  const limitParam = sp.get("limit");
  const offsetParam = sp.get("offset");
  const q = sp.get("q") ?? undefined;
  const tag = sp.get("tag") ?? undefined;
  const language = sp.get("language") ?? undefined;
  const cloneLabel = sp.get("label") ?? undefined;
  const minScoreRaw = sp.get("minScore");
  const maxScoreRaw = sp.get("maxScore");
  let limit = 25;
  if (limitParam) {
    const n = Number.parseInt(limitParam, 10);
    if (Number.isFinite(n) && n > 0 && n <= 200) limit = n;
  }
  let offset = 0;
  if (offsetParam) {
    const n = Number.parseInt(offsetParam, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) offset = n;
  }
  const parseScore = (raw: string | null): number | undefined => {
    if (raw === null || raw === "") return undefined;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return undefined;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  };
  const minScore = parseScore(minScoreRaw);
  const maxScore = parseScore(maxScoreRaw);
  try {
    const page = await listSharesPage({
      limit,
      offset,
      q,
      tag,
      language,
      cloneLabel,
      minScore,
      maxScore,
    });
    return NextResponse.json({
      items: page.items,
      count: page.items.length,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      facets: page.facets,
    });
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
    // Best-effort: log this in the signed-in user's inbox.
    const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
    if (user) {
      const pct = (scores.shingleJaccard * 100).toFixed(1);
      const titleText = (typeof raw.title === "string" && raw.title.trim()) || "Untitled comparison";
      await emitNotification({
        userId: user.id,
        kind: "share.created",
        title: `Saved "${titleText}"`,
        body: `${clone.label} match at ${pct}% on ${language}. Public link is ready to copy.`,
        href: `/r/${rec.id}`,
        meta: { language, shingleJaccard: scores.shingleJaccard },
      });
    }
    await tryRecordAudit(req, {
      action: "share.create",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      target: { type: "share", id: rec.id, label: typeof raw.title === "string" ? raw.title : undefined },
      diff: { after: { language, bytes: { a: a.length, b: b.length }, score: scores.shingleJaccard } },
    });
    return NextResponse.json({ id: rec.id, url: `/r/${rec.id}` }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
