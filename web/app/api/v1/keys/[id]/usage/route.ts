/**
 * Public GET /v1/keys/{id}/usage: programmatic per-key usage feed.
 *
 * Pairs with GET /v1/usage (workspace-wide aggregate) and GET
 * /v1/keys/{id} (single-key inspect) to close a gap that hygiene
 * and rotation runbooks keep hitting: "has this specific key been
 * used in the last N days, and on which endpoints?" The workspace
 * aggregate already returns a `by_key` array, but answering the
 * single-key question from it still requires pulling the full
 * workspace usage page and filtering client-side, which scales
 * badly for workspaces with hundreds of active keys and forces the
 * caller to be `usage:read` scoped against every key on the floor
 * just to read one.
 *
 * This route returns the same shape `summarize()` already produces
 * (windowDays, totalCalls, monthToDate, byDay, byEndpoint,
 * lastEventAt) but filtered to the target key id only, plus an
 * optional `recent` event list. SOC2 CC6.1 / ISO 27001 A.9.2 access
 * reviewers use this to identify dead keys to revoke; FinOps teams
 * use it for per-key chargeback when several pipelines share a
 * workspace.
 *
 * Auth: Bearer token or `x-api-key` header.
 * Scope: `usage:read`. Same scope as /v1/usage since this is a
 *        narrowed slice of the same data, not a new privilege.
 * Tenant scope: structural. The target key is loaded via
 *        `loadKeyForWorkspace(id, key.workspaceId)`; a key minted in
 *        workspace A cannot read usage for a key in workspace B.
 *        Cross-tenant ids return 404 (not 403) so status codes
 *        cannot be used to probe for the existence of other
 *        tenants' key ids. Keys with no workspace binding receive
 *        `tenant_required`.
 * Query: ?days=1..90 (default 7), ?recent=0..200 (default 0),
 *        ?format=json|csv (default json). CSV returns the per-day
 *        call counts for this one key (date,count) as an RFC 4180
 *        download, mirroring /v1/usage?format=csv so FinOps
 *        chargeback pipelines can pull a single key's daily
 *        timeline straight into Excel or csvkit without a JSON
 *        decode step. Unknown formats return 400.
 * Side effects: increments the per-key rate-limit window, writes
 *        one audit row (`v1.keys.usage.read`) so per-key usage
 *        reads are themselves auditable, logs one usage event so
 *        the call shows up on the caller's own /v1/usage timeline,
 *        and touches `lastUsedAt`/`recentIps`. Does not charge
 *        plan quota (metadata, not a billable model call).
 *
 * Still enforced: revocation, expiry, workspace IP allowlist,
 * per-key IP allowlist, residency, workspace API key policy,
 * lockdown.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  loadKeyForWorkspace,
  recordUse,
} from "../../../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../../../lib/audit";
import {
  logUsage,
  summarize,
  recentEvents,
  type WorkspaceScope,
} from "../../../../../../lib/usage";

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
        message:
          "This API key is not bound to a workspace. Per-key usage is only available to workspace-scoped keys.",
      },
    },
    { status: 403 },
  );
}

function notFound() {
  // 404 (not 403) so callers cannot probe for the existence of
  // another tenant's key id by watching status codes.
  return NextResponse.json(
    { error: { type: "not_found", message: "Key not found in this workspace." } },
    { status: 404 },
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

type Ctx = { params: Promise<{ id: string }> | { id: string } };

async function resolveParams(ctx: Ctx): Promise<{ id: string }> {
  const p = (ctx as { params: { id: string } | Promise<{ id: string }> }).params;
  return p instanceof Promise ? await p : p;
}

export async function GET(req: Request, ctx: Ctx) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");

  if (!hasScope(key, "usage:read")) {
    return insufficientScope("usage:read", key.scopes);
  }

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/keys/:id/usage",
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

  if (!key.workspaceId) return tenantRequired();

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

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;

  const { id } = await resolveParams(ctx);
  const target = await loadKeyForWorkspace(id, key.workspaceId);
  if (!target) return notFound();

  // Tenant scope: workspace-restricted AND key-restricted. Both
  // filters apply so a forged usage row tagged with the wrong
  // workspaceId cannot leak into another tenant's per-key view.
  const scope: WorkspaceScope = new Set<string>([key.workspaceId]);

  const now = Date.now();
  const [summary, recent] = await Promise.all([
    summarize(daysParsed.value, now, scope, target.id),
    recentParsed.value > 0
      ? recentEvents(recentParsed.value, daysParsed.value, now, scope, target.id)
      : Promise.resolve([]),
  ]);

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/keys/:id/usage",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.keys.usage.read",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "api_key", id: target.id, label: target.label },
    status: "ok",
    meta: {
      prefix: key.prefix,
      target_prefix: target.prefix,
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
        ...rl.headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-key-${target.id}-usage.csv"`,
      },
    });
  }

  const body = {
    key: {
      id: target.id,
      prefix: target.prefix,
      label: target.label,
      revoked: Boolean(target.revoked),
      expires_at: target.expiresAt ?? null,
      last_used_at: target.lastUsedAt ?? null,
    },
    window_days: summary.windowDays,
    total_calls: summary.totalCalls,
    month_to_date: summary.monthToDate,
    last_event_at: summary.lastEventAt,
    by_day: summary.byDay.map((d) => ({ date: d.date, count: d.count })),
    by_endpoint: summary.byEndpoint.map((e) => ({
      endpoint: e.endpoint,
      count: e.count,
      avg_latency_ms: e.avgLatencyMs,
      total_bytes: e.totalBytes,
    })),
    recent: recent.map((r) => ({
      ts: r.ts,
      endpoint: r.endpoint,
      bytes: r.bytes,
      latency_ms: r.latencyMs,
    })),
    server_time: now,
  };

  return NextResponse.json(body, { headers: rl.headers });
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
