/**
 * Public /v1 API surface. Authenticated via Bearer token (or x-api-key
 * header). Mirrors the internal /api/compare payload so customers can
 * curl this directly with a documented contract.
 */
import { NextResponse } from "next/server";
import { extractBearer, findByPlaintext, hasScope, recordUse } from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey } from "../../../../lib/ip-allowlist-enforce";
import { compareCode, alignLines, classifyClone } from "../../../../lib/similarity";
import { dispatchEvent } from "../../../../lib/webhooks";
import { logUsage, quotaCheck } from "../../../../lib/usage";
import { tryRecordAudit } from "../../../../lib/audit";
import { getWorkspace } from "../../../../lib/workspaces";
import { workspaceQuotaCheck, planHeaders } from "../../../../lib/plans";
import { isDryRun, DRY_RUN_HEADER } from "../../../../lib/dry-run";

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
  if (!hasScope(key, "compare:write")) {
    return NextResponse.json(
      {
        error: {
          type: "insufficient_scope",
          message: "This key is missing the 'compare:write' scope. Rotate it with the scope enabled or issue a new key.",
          required_scope: "compare:write",
          granted_scopes: key.scopes ?? null,
        },
      },
      { status: 403 },
    );
  }

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  // Per-workspace plan quota (free / pro / enterprise). Falls back to the
  // global free-tier counter when the key has no workspace binding so
  // legacy installs keep working unchanged.
  const ws = key.workspaceId ? await getWorkspace(key.workspaceId) : null;
  const wsQuota = await workspaceQuotaCheck(key.workspaceId ?? null, ws);
  if (wsQuota && !wsQuota.allowed) {
    return NextResponse.json(
      {
        error: {
          type: "plan_quota_exceeded",
          message: `Workspace plan "${wsQuota.plan.label}" monthly cap of ${wsQuota.limit} /v1 calls reached. Upgrade the workspace plan or wait for the next calendar month.`,
        },
        plan: {
          id: wsQuota.plan.id,
          monthToDate: wsQuota.monthToDate,
          limit: wsQuota.limit,
          remaining: 0,
        },
      },
      {
        status: 429,
        headers: {
          ...rl.headers,
          ...planHeaders(wsQuota),
          "Retry-After": "3600",
        },
      },
    );
  }

  const quota = wsQuota ? null : await quotaCheck();
  if (quota && !quota.allowed) {
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
          ...rl.headers,
          "Retry-After": "3600",
          "x-codeclone-quota-limit": String(quota.limit),
          "x-codeclone-quota-remaining": "0",
        },
      },
    );
  }

  let raw: Body & { dry_run?: unknown };
  try {
    raw = (await req.json()) as Body & { dry_run?: unknown };
  } catch {
    return badRequest("Body must be JSON.");
  }
  const dryRun = isDryRun(req, raw);
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

  if (dryRun) {
    // Sandbox mode: validation passed and we computed the real shape so
    // the caller can inspect it, but we deliberately skip recordUse,
    // logUsage, and webhook dispatch. A single audit entry still goes in
    // so security teams can see the probe.
    void tryRecordAudit(req, {
      action: "v1.compare.dry_run",
      actorId: key.userId ?? null,
      target: { type: "api_key", id: key.id, label: key.label },
      meta: {
        language,
        bytes_a: Buffer.byteLength(a, "utf-8"),
        bytes_b: Buffer.byteLength(b, "utf-8"),
      },
    });
    return NextResponse.json(
      {
        dry_run: true,
        would: {
          charge_quota: true,
          dispatch_webhook_event: "compare.completed",
          record_usage: true,
        },
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
          ...rl.headers,
          ...DRY_RUN_HEADER,
          "x-codeclone-key-id": key.id,
          "x-codeclone-key-prefix": key.prefix,
          ...(wsQuota
            ? {
                ...planHeaders(wsQuota),
                "x-codeclone-plan-remaining":
                  wsQuota.remaining == null
                    ? "unlimited"
                    : String(Math.max(0, wsQuota.remaining)),
              }
            : {
                "x-codeclone-quota-limit": String(quota!.limit),
                "x-codeclone-quota-remaining": String(
                  Math.max(0, quota!.remaining),
                ),
              }),
        },
      },
    );
  }

  // Fire-and-forget usage recording; the response should not block on it.
  void recordUse(key.id);
  void tryRecordAudit(req, {
    action: "v1.compare",
    actorId: key.userId ?? null,
    target: { type: "api_key", id: key.id, label: key.label },
    meta: {
      language,
      bytes_a: Buffer.byteLength(a, "utf-8"),
      bytes_b: Buffer.byteLength(b, "utf-8"),
      jaccard: scores.tokenJaccard,
      clone_type: clone.type,
      latency_ms: Number(latencyMs.toFixed(3)),
    },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/compare",
    bytes: Buffer.byteLength(a, "utf-8") + Buffer.byteLength(b, "utf-8"),
    latencyMs: Number(latencyMs.toFixed(3)),
    workspaceId: key.workspaceId,
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
        ...rl.headers,
        "x-codeclone-key-id": key.id,
        "x-codeclone-key-prefix": key.prefix,
        ...(wsQuota
          ? {
              ...planHeaders(wsQuota),
              "x-codeclone-plan-remaining":
                wsQuota.remaining == null
                  ? "unlimited"
                  : String(Math.max(0, wsQuota.remaining - 1)),
            }
          : {
              "x-codeclone-quota-limit": String(quota!.limit),
              "x-codeclone-quota-remaining": String(Math.max(0, quota!.remaining - 1)),
            }),
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
        body: {
          a: "string",
          b: "string",
          language: "string (optional)",
          dry_run: "boolean (optional) - validate without charging quota or firing webhooks",
        },
        sandbox: "Pass ?dry_run=true or { \"dry_run\": true } to preview without side effects.",
      },
      batch: {
        method: "POST",
        path: "/v1/batch",
        auth: "Bearer <api-key>",
        body: {
          snippets:
            "array of { id?: string, label?: string, code: string }, 2 to 12 items",
          language: "string (optional)",
          dry_run: "boolean (optional) - validate without charging quota or firing webhooks",
        },
      },
    },
  });
}
