import { NextResponse } from "next/server";
import { compareCode, alignLines, classifyClone } from "../../../lib/similarity";
import { tryRecordAudit } from "../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { instrument } from "../../../lib/instrument";
import {
  enforceSession,
  tooManyRequestsResponse,
} from "../../../lib/session-rate-limit";
import { listWorkspacesForUser } from "../../../lib/workspaces";
import { scanInputs, findingsForAudit } from "../../../lib/secret-scan-enforce";
import type { SecretScanMode } from "../../../lib/secret-scan";

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
  // DLP guardrail. We pick the strictest secret-scan policy across the
  // user's workspaces so a member of a "block" workspace can't bypass
  // it by running compare without selecting that workspace explicitly.
  // Order: block > redact > warn > off.
  const rank: Record<SecretScanMode, number> = { off: 0, warn: 1, redact: 2, block: 3 };
  let strictest: import("../../../lib/workspaces").WorkspaceRecord | null = null;
  let strictestRank = -1;
  if (user) {
    const ws = await listWorkspacesForUser(user.id);
    for (const w of ws) {
      const m = w.secretScanPolicy?.mode;
      if (!m) continue;
      const r = rank[m];
      if (r > strictestRank) {
        strictest = w;
        strictestRank = r;
      }
    }
  }
  const scan = scanInputs({ a: parsed.a, b: parsed.b }, strictest);
  if (!scan.ok) {
    await tryRecordAudit(req, {
      action: "compare.secrets_blocked",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      workspaceId: strictest?.id ?? null,
      target: { type: "compare" },
      meta: { language: parsed.language },
    });
    return scan.response;
  }
  const effA = scan.effective.a ?? parsed.a;
  const effB = scan.effective.b ?? parsed.b;
  const scores = compareCode(effA, effB);
  const alignment = alignLines(effA, effB);
  const clone = classifyClone(effA, effB, scores);
  const latencyMs = performance.now() - started;
  if (scan.findings.length > 0) {
    await tryRecordAudit(req, {
      action: "compare.secrets_detected",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      workspaceId: strictest?.id ?? null,
      target: { type: "compare" },
      meta: {
        language: parsed.language,
        mode: scan.mode,
        findings: findingsForAudit(scan.findings),
      },
    });
  }
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
      secret_scan: { mode: scan.mode, findings: findingsForAudit(scan.findings) },
    },
    {
      headers: {
        ...limit.headers,
        "x-codeclone-secret-scan-mode": scan.mode,
        "x-codeclone-secret-scan-findings": String(scan.findings.length),
      },
    },
  );
});
