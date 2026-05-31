/**
 * Public /v1/batch API. Authenticated via Bearer token (or x-api-key)
 * and enforces the same free-tier quota as /v1/compare. Lets customers
 * run a pairwise similarity matrix over up to 12 snippets in one call.
 *
 * Counts as a single billable request even though it runs n*(n-1)/2
 * pair comparisons internally, which matches how the UI page treats it.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../lib/ip-allowlist-enforce";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceDpaForKey } from "../../../../lib/dpa-enforce";
import {
  enforcePayloadPolicyHeaderForKey,
  enforcePayloadPolicyBodyForKey,
} from "../../../../lib/payload-policy-enforce";
import { dispatchEvent } from "../../../../lib/webhooks";
import { logUsage, quotaCheck } from "../../../../lib/usage";
import { parseBatch, runBatch, type BatchInput } from "../../../../lib/batch";
import { tryRecordAudit } from "../../../../lib/audit";
import { getWorkspace } from "../../../../lib/workspaces";
import { workspaceQuotaCheck, planHeaders } from "../../../../lib/plans";
import { isDryRun, DRY_RUN_HEADER } from "../../../../lib/dry-run";
import { scanInputs, findingsForAudit } from "../../../../lib/secret-scan-enforce";
import { begin as idempotencyBegin, buildReplay, readIdempotencyKey, KEY_HEADER, REPLAY_HEADER } from "../../../../lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (!hasScope(key, "batch:write")) {
    return NextResponse.json(
      {
        error: {
          type: "insufficient_scope",
          message: "This key is missing the 'batch:write' scope. Rotate it with the scope enabled or issue a new key.",
          required_scope: "batch:write",
          granted_scopes: key.scopes ?? null,
        },
      },
      { status: 403 },
    );
  }

  const blocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (blocked) return blocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;
  const dpaBlocked = await enforceWorkspaceDpaForKey(req, key, { route: "/v1/batch" });
  if (dpaBlocked) return dpaBlocked;

  const payloadHeader = await enforcePayloadPolicyHeaderForKey(req, key, { route: "/v1/batch" });
  if (payloadHeader.response) return payloadHeader.response;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

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
          message: `Free tier monthly quota of ${quota.limit} requests reached. Upgrade to keep calling /v1/batch.`,
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

  let raw: BatchInput & { dry_run?: unknown };
  try {
    raw = (await req.json()) as BatchInput & { dry_run?: unknown };
  } catch {
    return badRequest("Body must be JSON.");
  }
  const payloadBody = await enforcePayloadPolicyBodyForKey(req, key, raw, payloadHeader.limit, { route: "/v1/batch" });
  if (payloadBody) return payloadBody;
  const dryRun = isDryRun(req, raw);

  const parsed = parseBatch(raw);
  if (!parsed.ok) return badRequest(parsed.error);

  // DLP guardrail. We scan every snippet under the workspace policy
  // before runBatch() touches similarity; on block we reject with 422
  // and never log usage or fire webhooks. On redact we mutate the
  // snippets in place so the similarity matrix and the webhook payload
  // both reflect the post-redaction text.
  const scanInputsMap: Record<string, string> = {};
  for (let i = 0; i < parsed.snippets.length; i++) {
    scanInputsMap[`snippet_${i}`] = parsed.snippets[i].code;
  }
  const scan = scanInputs(scanInputsMap, ws);
  if (!scan.ok) {
    void tryRecordAudit(req, {
      action: "v1.batch.secrets_blocked",
      actorId: key.userId ?? null,
      target: { type: "api_key", id: key.id, label: key.label },
      meta: { snippets: parsed.snippets.length, language: parsed.language },
    });
    return scan.response;
  }
  for (let i = 0; i < parsed.snippets.length; i++) {
    const eff = scan.effective[`snippet_${i}`];
    if (eff !== undefined) parsed.snippets[i].code = eff;
  }
  if (scan.findings.length > 0) {
    void tryRecordAudit(req, {
      action: "v1.batch.secrets_detected",
      actorId: key.userId ?? null,
      target: { type: "api_key", id: key.id, label: key.label },
      meta: {
        snippets: parsed.snippets.length,
        language: parsed.language,
        mode: scan.mode,
        findings: findingsForAudit(scan.findings),
      },
    });
  }

  const totalBytes = parsed.snippets.reduce(
    (sum, s) => sum + Buffer.byteLength(s.code, "utf-8"),
    0,
  );

  const result = runBatch(parsed.snippets, parsed.language);

  if (dryRun) {
    void tryRecordAudit(req, {
      action: "v1.batch.dry_run",
      actorId: key.userId ?? null,
      target: { type: "api_key", id: key.id, label: key.label },
      meta: { snippets: parsed.snippets.length, language: parsed.language },
    });
    return NextResponse.json(
      {
        dry_run: true,
        would: {
          charge_quota: true,
          dispatch_webhook_event: "batch.completed",
          record_usage: true,
          snippet_count: parsed.snippets.length,
          pair_count:
            (parsed.snippets.length * (parsed.snippets.length - 1)) / 2,
          total_bytes: totalBytes,
        },
        ...result,
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

  // Idempotency: see lib/idempotency.ts for the full contract. Same
  // semantics as /v1/compare: per-key scope, 24h window, body-hash
  // mismatch returns 409, inflight duplicates return 409, successful
  // replays return the original status + body with Idempotent-Replayed.
  const idemKey = readIdempotencyKey(req);
  let idemFinalize: ((resp: { status: number; contentType: string; body: string }) => Promise<void>) | null = null;
  if (idemKey) {
    const r = await idempotencyBegin(key.id, idemKey, raw);
    if (r.kind === "conflict_body") {
      void tryRecordAudit(req, {
        action: "v1.batch.idempotency_conflict",
        actorId: key.userId ?? null,
        target: { type: "api_key", id: key.id, label: key.label },
        meta: { reason: "body_mismatch", idempotency_key: idemKey },
      });
      return NextResponse.json(
        {
          error: {
            type: "idempotency_conflict",
            message: "Idempotency-Key was reused with a different request body. Choose a fresh key or send the original payload.",
          },
        },
        { status: 409, headers: { ...rl.headers, [KEY_HEADER]: idemKey } },
      );
    }
    if (r.kind === "conflict_inflight") {
      return NextResponse.json(
        {
          error: {
            type: "idempotency_in_progress",
            message: "A prior request with this Idempotency-Key is still being processed. Retry in a moment.",
          },
        },
        { status: 409, headers: { ...rl.headers, [KEY_HEADER]: idemKey, "Retry-After": "2" } },
      );
    }
    if (r.kind === "replay") {
      return buildReplay(r.response, {
        ...rl.headers,
        [KEY_HEADER]: idemKey,
        "x-codeclone-key-id": key.id,
        "x-codeclone-key-prefix": key.prefix,
        ...(wsQuota ? planHeaders(wsQuota) : {}),
      });
    }
    idemFinalize = r.finalize;
  }

  void recordUse(key.id);
  void tryRecordAudit(req, {
    action: "v1.batch",
    actorId: key.userId ?? null,
    target: { type: "api_key", id: key.id, label: key.label },
    meta: { snippets: parsed.snippets.length, language: parsed.language },
  });
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/batch",
    bytes: totalBytes,
    latencyMs: result.latency_ms,
    workspaceId: key.workspaceId,
  });

  void dispatchEvent({
    event: "batch.completed",
    workspaceId: key.workspaceId ?? null,
    payload: {
      key_id: key.id,
      language: result.language,
      n: result.n,
      total_bytes: totalBytes,
      latency_ms: result.latency_ms,
    },
  }).catch(() => {});

  const responseBody = { ...result, secret_scan: { mode: scan.mode, findings: findingsForAudit(scan.findings) } };
  if (idemFinalize) {
    void idemFinalize({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseBody),
    });
  }
  return NextResponse.json(
    responseBody,
    {
    headers: {
      ...rl.headers,
      ...(idemKey ? { [KEY_HEADER]: idemKey, [REPLAY_HEADER]: "false" } : {}),
      "x-codeclone-key-id": key.id,
      "x-codeclone-key-prefix": key.prefix,
      "x-codeclone-secret-scan-mode": scan.mode,
      "x-codeclone-secret-scan-findings": String(scan.findings.length),
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
    endpoint: {
      method: "POST",
      path: "/v1/batch",
      auth: "Bearer <api-key>",
      body: {
        snippets:
          "array of { id?: string, label?: string, code: string }, 2 to 12 items",
        language: "string (optional, default 'auto')",
        dry_run: "boolean (optional) - validate without charging quota or firing webhooks",
      },
      sandbox: "Pass ?dry_run=true or { \"dry_run\": true } to preview pair_count and totals without side effects.",
      limits: {
        max_snippets: 12,
        max_bytes_each: 32 * 1024,
        max_bytes_total: 192 * 1024,
      },
    },
  });
}
