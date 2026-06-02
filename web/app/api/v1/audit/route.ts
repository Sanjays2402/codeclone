/**
 * GET /v1/audit: programmatic SIEM-friendly audit log stream.
 *
 * Enterprise customers wiring CodeClone into Splunk, Datadog, Elastic, or
 * a generic NDJSON HTTP collector need a machine-readable, scoped, paginated
 * audit feed they can poll on a cron. The dashboard /api/audit endpoint is
 * cookie-authenticated and is meant for humans; it cannot be called from a
 * SIEM forwarder. This route accepts the same Bearer token the rest of /v1
 * uses and returns the calling key's workspace audit entries.
 *
 * Auth: Bearer token or `x-api-key` header.
 * Scope: `audit:read`. Legacy keys with no `scopes` field keep working
 *        (full privileges, matching every other /v1 route).
 * Tenant scope: results are filtered to the calling key's workspace. A key
 *        from workspace A can never see workspace B's audit entries, even
 *        if both workspaces share the same underlying JSONL store. Keys
 *        without a workspace get an empty result set rather than the
 *        platform-wide log.
 * Output: NDJSON (one entry per line) when `format=ndjson` (default), a
 *        JSON object with an `items` array when `format=json`, or a CSV
 *        file when `format=csv`. NDJSON is the default because every major
 *        SIEM ingests it natively; CSV exists for SOC2 reviewers and
 *        spreadsheet-driven workflows (Excel, csvkit, Google Sheets) that
 *        do not want to write a JSON-to-CSV middlestep.
 * Side effects: increments the per-key rate-limit window, audits one
 *        `v1.audit.read` event (so audit reads are themselves auditable),
 *        and updates the key's `lastUsedAt`/`recentIps` ring. Does not
 *        charge plan quota.
 * Cursor: results are newest-first by `ts`. Pass `?until=<ts_ms>` (the
 *        ts of the oldest entry from the previous page minus 1) to walk
 *        backwards. Combine with `?limit=` (1..500, default 100).
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key IP
 * allowlist, residency, workspace API key policy, lockdown.
 */
import { NextResponse } from "next/server";
import { extractBearer, findByPlaintext, hasScope, recordUse } from "../../../../lib/api-keys";
import { effectiveRpm, enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { listAudit, toCsv, tryRecordAudit, MAX_LIST } from "../../../../lib/audit";
import { getWorkspace, retentionCutoffMs } from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function badRequest(message: string, meta?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { type: "invalid_request", message, ...(meta ?? {}) } },
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

function parseTime(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const d = new Date(raw).getTime();
  return Number.isFinite(d) ? d : undefined;
}

const VALID_STATUS = new Set(["ok", "denied", "error"]);

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }

  if (!hasScope(key, "audit:read")) {
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "This key is missing the 'audit:read' scope.",
          required_scope: "audit:read",
        },
      },
      { status: 403 },
    );
  }

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/audit" });
  if (lockdownBlocked) return lockdownBlocked;
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return wsBlocked;
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return keyBlocked;
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return residencyBlocked;
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return policyBlocked;

  const url = new URL(req.url);
  const sp = url.searchParams;

  const limitParsed = parseIntInRange(sp.get("limit"), 100, 1, MAX_LIST);
  if (!limitParsed.ok) {
    return badRequest(`limit must be an integer in [1, ${MAX_LIST}].`);
  }

  const since = parseTime(sp.get("since"));
  if (sp.get("since") && since === undefined) {
    return badRequest("since must be an ISO 8601 timestamp or positive ms epoch.");
  }
  const until = parseTime(sp.get("until"));
  if (sp.get("until") && until === undefined) {
    return badRequest("until must be an ISO 8601 timestamp or positive ms epoch.");
  }

  const statusRaw = sp.get("status");
  if (statusRaw && !VALID_STATUS.has(statusRaw)) {
    return badRequest("status must be one of: ok, denied, error.");
  }
  const status = statusRaw as "ok" | "denied" | "error" | null;

  const format = (sp.get("format") ?? "ndjson").toLowerCase();
  if (format !== "ndjson" && format !== "json" && format !== "csv") {
    return badRequest("format must be 'ndjson', 'json', or 'csv'.");
  }

  // Spend a rate-limit slot. Pulling the audit log is cheap but still a real
  // call against the customer's key; we do not want it to be a free pulse
  // generator for our infra.
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;
  const rlHeaders = rl.headers;
  void effectiveRpm(key);

  // Tenant scope: keys with no workspace get an empty allowlist and see
  // nothing. This is the primary cross-tenant isolation guard.
  const allowedWorkspaceIds = new Set<string>(
    key.workspaceId ? [key.workspaceId] : [],
  );

  // Honour owner-configured retention so an API consumer can never read
  // entries the dashboard would already hide as expired.
  const retentionCutoffByWorkspace = new Map<string, number>();
  if (key.workspaceId) {
    const ws = await getWorkspace(key.workspaceId);
    if (ws) {
      const cutoff = retentionCutoffMs(ws);
      if (cutoff != null) retentionCutoffByWorkspace.set(key.workspaceId, cutoff);
    }
  }

  const entries = await listAudit({
    actorId: sp.get("actorId") ?? undefined,
    workspaceId: key.workspaceId ?? undefined,
    allowedWorkspaceIds,
    // Bearer-auth callers are not users; never admit null-workspace events.
    selfActorId: undefined,
    retentionCutoffByWorkspace,
    action: sp.get("action") ?? undefined,
    targetType: sp.get("targetType") ?? undefined,
    targetId: sp.get("targetId") ?? undefined,
    status: status ?? undefined,
    since,
    until,
    limit: limitParsed.value,
  });

  void recordUse(key.id, clientIpFromRequest(req));

  void tryRecordAudit(req, {
    action: "v1.audit.read",
    actorId: key.id,
    workspaceId: key.workspaceId ?? null,
    target: { type: "audit_log", id: key.workspaceId ?? key.id },
    status: "ok",
    meta: {
      prefix: key.prefix,
      returned: entries.length,
      limit: limitParsed.value,
      format,
      filter: {
        action: sp.get("action") ?? null,
        status: status ?? null,
        since: since ?? null,
        until: until ?? null,
      },
    },
  });

  const nextCursor =
    entries.length === limitParsed.value && entries.length > 0
      ? entries[entries.length - 1]!.ts - 1
      : null;

  const baseHeaders: Record<string, string> = {
    ...rlHeaders,
    "X-Total-Returned": String(entries.length),
  };
  if (nextCursor !== null) {
    baseHeaders["X-Next-Until"] = String(nextCursor);
  }

  if (format === "ndjson") {
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
    return new NextResponse(body, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
  }

  if (format === "csv") {
    // RFC 4180-ish: header row, CRLF line endings, double-quote escaping
    // for any cell containing a comma, quote, or newline. toCsv() already
    // handles the per-cell escaping; we only need to normalize line endings
    // and add a trailing CRLF so Excel and csvkit treat the last row as
    // terminated. Filename pins the workspace id so a SIEM operator pulling
    // multiple tenants does not overwrite one tenant's file with another.
    const body = toCsv(entries).replace(/\r?\n/g, "\r\n") + "\r\n";
    const wsTag = key.workspaceId ?? "workspace";
    return new NextResponse(body, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="codeclone-audit-${wsTag}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(
    {
      workspace_id: key.workspaceId ?? null,
      count: entries.length,
      limit: limitParsed.value,
      next_until: nextCursor,
      items: entries,
    },
    { headers: baseHeaders },
  );
}
