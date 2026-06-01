/**
 * Public /v1/webhooks/failures endpoint.
 *
 * Programmatic, SIEM-friendly feed of recent failed webhook delivery
 * attempts across every webhook in the calling key's workspace. The
 * dashboard /api/webhooks/recent-failures route is cookie-authenticated
 * and meant for the in-app toaster; it cannot be called from a
 * PagerDuty / Datadog / Opsgenie pipeline. Enterprise customers wiring
 * CodeClone webhook health into their on-call rotation need a Bearer
 * token endpoint they can poll on a cron.
 *
 * Auth: Bearer token or `x-api-key` header, same as the rest of /v1.
 * Scope: `webhooks:read`. Matches the equivalent /v1/webhooks/[id]/deliveries
 *        scope, since this is just a workspace-wide aggregation of the
 *        same per-hook delivery log.
 * Tenant scope: results are filtered to the calling key's workspace
 *        via listWebhooksForWorkspace(). A key from workspace A can
 *        never see workspace B's webhook failures even if both
 *        workspaces share the same underlying JSONL store. Keys
 *        without a workspace are refused with 403 tenant_required.
 * Output: NDJSON (one failure per line) when `format=ndjson` (default),
 *        or a JSON object with an `items` array when `format=json`.
 *        NDJSON is the default because every major SIEM ingests it.
 * Query params:
 *   limit   1..200 (default 50)
 *   since   optional ms epoch; only failures attempted after this ts
 * Side effects: increments the per-key rate-limit window, logs one
 *        usage row, audits one `v1.webhooks.failures.read` event so
 *        every poll is itself auditable, updates the key's
 *        `lastUsedAt`/`recentIps` ring. Does not charge plan quota.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, workspace residency, workspace API key policy, and
 * workspace lockdown. Same chain every /v1 route runs.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../lib/lockdown-enforce";
import { collectRecentFailures } from "../../../../../lib/recent-failures";
import { tryRecordAudit } from "../../../../../lib/audit";
import { logUsage } from "../../../../../lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function insufficientScope(required: string, granted: string[] | null | undefined) {
  return NextResponse.json(
    {
      error: {
        type: "insufficient_scope",
        message: `This key is missing the '${required}' scope.`,
        required_scope: required,
        granted_scopes: granted ?? null,
      },
    },
    { status: 403 },
  );
}

function tenantRequired() {
  return NextResponse.json(
    {
      error: {
        type: "tenant_required",
        message: "This API key is not bound to a workspace.",
      },
    },
    { status: 403 },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: { type: "invalid_request", message } },
    { status: 400 },
  );
}

function parseIntInRange(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false };
  const i = Math.floor(n);
  if (i < min || i > max) return { ok: false };
  return { ok: true, value: i };
}

function parsePositiveMs(raw: string | null): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return { ok: true, value: Math.floor(n) };
  const d = new Date(raw).getTime();
  if (Number.isFinite(d) && d >= 0) return { ok: true, value: d };
  return { ok: false };
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");
  if (!hasScope(key, "webhooks:read")) return insufficientScope("webhooks:read", key.scopes);

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/webhooks/failures",
  });
  if (lockdownBlocked) return lockdownBlocked;
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return wsBlocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  if (!key.workspaceId) return tenantRequired();

  const url = new URL(req.url);
  const sp = url.searchParams;

  const limitParsed = parseIntInRange(sp.get("limit"), 50, 1, 200);
  if (!limitParsed.ok) return badRequest("limit must be an integer in [1, 200].");
  const sinceParsed = parsePositiveMs(sp.get("since"));
  if (!sinceParsed.ok) return badRequest("since must be a non-negative ms epoch or ISO 8601 timestamp.");

  const format = (sp.get("format") ?? "ndjson").toLowerCase();
  if (format !== "ndjson" && format !== "json") {
    return badRequest("format must be 'ndjson' or 'json'.");
  }

  // Tenant scope: collectRecentFailures defers to listWebhooksForWorkspace
  // when workspaceId is provided. This is the primary cross-tenant
  // isolation guard. No key may aggregate failures across tenants.
  const items = await collectRecentFailures({
    limit: limitParsed.value,
    since: sinceParsed.value,
    workspaceId: key.workspaceId,
  });

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/webhooks/failures",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });

  void tryRecordAudit(req, {
    action: "v1.webhooks.failures.read",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "webhook_failures", id: key.workspaceId },
    status: "ok",
    meta: {
      prefix: key.prefix,
      returned: items.length,
      limit: limitParsed.value,
      since: sinceParsed.value ?? null,
      format,
    },
  });

  const baseHeaders: Record<string, string> = {
    ...rl.headers,
    "X-Total-Returned": String(items.length),
  };

  if (format === "ndjson") {
    const body = items.map((e) => JSON.stringify(e)).join("\n") + (items.length ? "\n" : "");
    return new NextResponse(body, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
  }

  return NextResponse.json(
    {
      workspace_id: key.workspaceId,
      count: items.length,
      limit: limitParsed.value,
      items,
    },
    { headers: baseHeaders },
  );
}
