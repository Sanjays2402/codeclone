/**
 * Public GET /v1/usage: programmatic FinOps access.
 *
 * Enterprise customers wiring CodeClone into chargeback systems need a
 * stable, scoped, machine-readable view of their own /v1 usage. The
 * dashboard /api/usage endpoint is cookie-authenticated and meant for
 * humans, so it cannot be called from a finance pipeline. This route
 * accepts the same Bearer token the rest of /v1 uses and returns the
 * caller's workspace usage summary plus optional recent events.
 *
 * Auth: Bearer token or `x-api-key` header.
 * Scope: `usage:read`. Legacy keys with no `scopes` field keep working
 *        (full privileges, matching every other /v1 route).
 * Tenant scope: results are filtered to the calling key's workspace
 *        via `WorkspaceScope`. A key from workspace A can never see
 *        workspace B's keyIds or call volumes, even if both happen to
 *        live on the same store. Keys with no workspace get an empty
 *        scope and see nothing.
 * Side effects: increments the per-key rate-limit window and writes
 *        one audit row (`v1.usage.read`). Does not count toward the
 *        monthly /v1 plan quota (this endpoint is metadata, not a
 *        billable model call), but the quota counters are returned
 *        so finance can read them.
 * Query: ?days=1..90 (default 7), ?recent=0..200 (default 0, omit
 *        the recent-events array). Out-of-range values return 400.
 *        ?format=csv returns the per-day call counts as an RFC 4180
 *        CSV download (date,count) for Excel and csvkit chargeback
 *        pipelines that do not want to write a JSON-to-CSV middle
 *        step. The CSV honors the same `days` window. Default is
 *        `json`. Unknown values return 400.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, residency, workspace API key policy, lockdown.
 */
import { NextResponse } from "next/server";
import { extractBearer, findByPlaintext, hasScope, recordUse } from "../../../../lib/api-keys";
import { effectiveRpm, enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import { enforceWorkspaceAllowlistForKey, enforceKeyAllowlist } from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import { getWorkspace } from "../../../../lib/workspaces";
import { workspaceQuotaCheck, planHeaders } from "../../../../lib/plans";
import { summarize, recentEvents, type WorkspaceScope } from "../../../../lib/usage";

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

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }

  if (!hasScope(key, "usage:read")) {
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "This key is missing the 'usage:read' scope.",
          required_scope: "usage:read",
        },
      },
      { status: 403 },
    );
  }

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/usage" });
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
  const daysParsed = parseIntInRange(url.searchParams.get("days"), 7, 1, 90);
  if (!daysParsed.ok) return badRequest("days must be an integer in [1, 90].");
  const recentParsed = parseIntInRange(url.searchParams.get("recent"), 0, 0, 200);
  if (!recentParsed.ok) return badRequest("recent must be an integer in [0, 200].");
  const formatRaw = url.searchParams.get("format");
  const format = formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return badRequest("Invalid 'format' value. Use 'json' (default) or 'csv'.");
  }

  // Spend a rate-limit slot. /v1/usage is cheap but it is still a real
  // request against the customer's key; we do not want it to be a free
  // pulse generator for our infra.
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;
  const rlHeaders = rl.headers;
  // Touch effectiveRpm so a future audit query can correlate burst spikes
  // back to the key's configured ceiling.
  void effectiveRpm(key);

  // Tenant scope: empty Set => match no events. Keys with no workspace
  // legitimately have no scoped data to read.
  const scope: WorkspaceScope = new Set<string>(
    key.workspaceId ? [key.workspaceId] : [],
  );

  const ws = key.workspaceId ? await getWorkspace(key.workspaceId) : null;
  const wsQuota = await workspaceQuotaCheck(key.workspaceId ?? null, ws);
  const planHdrs = wsQuota ? planHeaders(wsQuota) : {};

  const [summary, recent] = await Promise.all([
    summarize(daysParsed.value, Date.now(), scope),
    recentParsed.value > 0
      ? recentEvents(recentParsed.value, daysParsed.value, Date.now(), scope)
      : Promise.resolve([]),
  ]);

  void recordUse(key.id, clientIpFromRequest(req));

  void tryRecordAudit(req, {
    action: "v1.usage.read",
    actorId: key.id,
    workspaceId: key.workspaceId ?? null,
    target: { type: "usage_summary", id: key.workspaceId ?? key.id },
    status: "ok",
    meta: {
      prefix: key.prefix,
      days: daysParsed.value,
      recent: recentParsed.value,
      total_calls: summary.totalCalls,
      format,
    },
  });

  if (format === "csv") {
    const csv = byDayToCsv(summary.byDay);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...rlHeaders,
        ...planHdrs,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-usage.csv"`,
      },
    });
  }

  const body = {
    workspace: ws
      ? { id: ws.id, name: ws.name ?? null, plan: ws.plan ?? "free" }
      : key.workspaceId
        ? { id: key.workspaceId, name: null, plan: "free" }
        : null,
    window_days: summary.windowDays,
    total_calls: summary.totalCalls,
    month_to_date: summary.monthToDate,
    last_event_at: summary.lastEventAt,
    plan: wsQuota
      ? {
          id: wsQuota.plan.id,
          monthly_limit: wsQuota.limit,
          month_to_date: wsQuota.monthToDate,
          remaining: wsQuota.remaining,
        }
      : {
          id: "free",
          monthly_limit: summary.freeTierMonthly,
          month_to_date: summary.monthToDate,
          remaining: summary.quotaRemaining,
        },
    by_day: summary.byDay.map((d) => ({ date: d.date, count: d.count })),
    by_key: summary.byKey.map((k) => ({ key_id: k.keyId, count: k.count })),
    by_endpoint: summary.byEndpoint.map((e) => ({
      endpoint: e.endpoint,
      count: e.count,
      avg_latency_ms: e.avgLatencyMs,
      total_bytes: e.totalBytes,
    })),
    recent: recent.map((r) => ({
      ts: r.ts,
      key_id: r.keyId,
      endpoint: r.endpoint,
      bytes: r.bytes,
      latency_ms: r.latencyMs,
    })),
    server_time: Date.now(),
  };

  return NextResponse.json(body, {
    headers: { ...rlHeaders, ...planHdrs },
  });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function byDayToCsv(rows: ReadonlyArray<{ date: string; count: number }>): string {
  const lines: string[] = ["date,count"];
  for (const r of rows) {
    lines.push([csvCell(r.date), csvCell(r.count)].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
