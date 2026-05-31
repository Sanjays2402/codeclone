import { NextResponse } from "next/server";
import { compareCode, alignLines, classifyClone } from "../../../lib/similarity";
import { tryRecordAudit } from "../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { instrument } from "../../../lib/instrument";
import {
  enforceSession,
  tooManyRequestsResponse,
} from "../../../lib/session-rate-limit";

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

export const POST = instrument("/api/compare", async function POST(req) {
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
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  const limit = await enforceSession(req, user?.id ?? null, "compare");
  if (!limit.decision.allowed) {
    await tryRecordAudit(req, {
      action: "compare.rate_limited",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      target: { type: "compare" },
      meta: {
        bucket: limit.bucket,
        subject_kind: limit.kind,
        limit: limit.decision.limit,
        retry_after_seconds: limit.decision.retryAfter,
      },
    });
    return tooManyRequestsResponse(limit);
  }
  const started = performance.now();
  const scores = compareCode(parsed.a, parsed.b);
  const alignment = alignLines(parsed.a, parsed.b);
  const clone = classifyClone(parsed.a, parsed.b, scores);
  const latencyMs = performance.now() - started;
  await tryRecordAudit(req, {
    action: "compare.run",
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    target: { type: "compare" },
    meta: {
      language: parsed.language,
      bytes_a: Buffer.byteLength(parsed.a, "utf-8"),
      bytes_b: Buffer.byteLength(parsed.b, "utf-8"),
      jaccard: scores.tokenJaccard,
      clone_type: clone.type,
    },
  });
  return NextResponse.json(
    {
      language: parsed.language,
      bytes: { a: Buffer.byteLength(parsed.a, "utf-8"), b: Buffer.byteLength(parsed.b, "utf-8") },
      scores,
      alignment,
      clone,
      latency_ms: Number(latencyMs.toFixed(3)),
      method: "exact-jaccard+5gram-shingles+line-align+structural-4gram-clone-type",
    },
    { headers: limit.headers },
  );
});
