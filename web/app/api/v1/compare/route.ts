/**
 * Public /v1 API surface. Authenticated via Bearer token (or x-api-key
 * header). Mirrors the internal /api/compare payload so customers can
 * curl this directly with a documented contract.
 */
import { NextResponse } from "next/server";
import { extractBearer, findByPlaintext, recordUse } from "../../../../lib/api-keys";
import { compareCode, alignLines, classifyClone } from "../../../../lib/similarity";
import { dispatchEvent } from "../../../../lib/webhooks";
import { logUsage, quotaCheck } from "../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 64 * 1024;

interface Body {
  a?: unknown;
  b?: unknown;
  language?: unknown;
}

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: { type: "invalid_request", message } },
    { status: 400 },
  );
}

export async function POST(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }

  const quota = await quotaCheck();
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: {
          type: "quota_exceeded",
          message: `Free tier monthly quota of ${quota.limit} requests reached. Upgrade to keep calling /v1/compare.`,
        },
        quota: {
          monthToDate: quota.monthToDate,
          limit: quota.limit,
          remaining: 0,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": "3600",
          "x-codeclone-quota-limit": String(quota.limit),
          "x-codeclone-quota-remaining": "0",
        },
      },
    );
  }

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return badRequest("Body must be JSON.");
  }
  const a = typeof raw.a === "string" ? raw.a : "";
  const b = typeof raw.b === "string" ? raw.b : "";
  const language =
    typeof raw.language === "string" && raw.language.trim()
      ? raw.language.trim()
      : "auto";
  if (!a.trim() || !b.trim()) {
    return badRequest("Both 'a' and 'b' must be non-empty strings.");
  }
  if (
    Buffer.byteLength(a, "utf-8") > MAX_BYTES ||
    Buffer.byteLength(b, "utf-8") > MAX_BYTES
  ) {
    return NextResponse.json(
      {
        error: {
          type: "payload_too_large",
          message: `Each snippet must be at most ${MAX_BYTES} bytes.`,
        },
      },
      { status: 413 },
    );
  }

  const started = performance.now();
  const scores = compareCode(a, b);
  const alignment = alignLines(a, b);
  const clone = classifyClone(a, b, scores);
  const latencyMs = performance.now() - started;

  // Fire-and-forget usage recording; the response should not block on it.
  void recordUse(key.id);
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/compare",
    bytes: Buffer.byteLength(a, "utf-8") + Buffer.byteLength(b, "utf-8"),
    latencyMs: Number(latencyMs.toFixed(3)),
  });

  // Fan-out to registered webhooks. Best-effort: failures are logged
  // per-delivery and never block the API response.
  void dispatchEvent({
    event: "compare.completed",
    payload: {
      key_id: key.id,
      language,
      bytes: {
        a: Buffer.byteLength(a, "utf-8"),
        b: Buffer.byteLength(b, "utf-8"),
      },
      scores,
      clone,
      latency_ms: Number(latencyMs.toFixed(3)),
    },
  }).catch(() => {});

  return NextResponse.json(
    {
      language,
      bytes: {
        a: Buffer.byteLength(a, "utf-8"),
        b: Buffer.byteLength(b, "utf-8"),
      },
      scores,
      alignment,
      clone,
      latency_ms: Number(latencyMs.toFixed(3)),
      method:
        "exact-jaccard+5gram-shingles+line-align+structural-4gram-clone-type",
    },
    {
      headers: {
        "x-codeclone-key-id": key.id,
        "x-codeclone-key-prefix": key.prefix,
        "x-codeclone-quota-limit": String(quota.limit),
        "x-codeclone-quota-remaining": String(Math.max(0, quota.remaining - 1)),
      },
    },
  );
}

export async function GET() {
  return NextResponse.json({
    name: "codeclone",
    version: "v1",
    endpoints: {
      compare: {
        method: "POST",
        path: "/v1/compare",
        auth: "Bearer <api-key>",
        body: { a: "string", b: "string", language: "string (optional)" },
      },
    },
  });
}
