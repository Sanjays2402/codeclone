/**
 * Public GET /v1/sessions: programmatic active-session inventory for a workspace.
 *
 * SecOps teams running CodeClone need a machine-driven way to answer
 * "who is currently signed into the dashboard?" during incident
 * triage, after a phishing report, on offboarding, and on a recurring
 * SOC2 CC6.1 access-review cadence. Doing that one user at a time
 * through the settings UI does not scale past the first audit.
 *
 * This endpoint lists every non-expired, non-revoked dashboard
 * session for every member of the calling key's workspace. Combined
 * with DELETE /v1/sessions/:jti and POST /v1/sessions/revoke-all
 * (see ../sessions/[jti]/route.ts and ./revoke-all/route.ts) it lets a
 * customer's SOAR bot enumerate sessions and force-logout a
 * compromised member without a human in the loop.
 *
 * Auth: Bearer token or `x-api-key` header, same as the rest of /v1.
 * Scope: `sessions:read`. Legacy keys with no `scopes` field keep
 *        working (full privileges, matching every other /v1 route).
 * Tenant scope: results are strictly limited to userIds that are
 *        members of the calling key's workspace. A key minted in
 *        workspace A can never enumerate sessions for a user who
 *        only belongs to workspace B even if both live on the same
 *        on-disk store. Keys with no workspaceId get 403.
 *
 * Returned summaries never include the session secret. Only the
 * metadata the settings UI already exposes (jti, userId, createdAt,
 * expiresAt, lastSeenAt, ip, userAgent).
 *
 * Query: ?format=json|csv (default json). CSV returns an RFC 4180
 *        download (jti,user_id,created_at,expires_at,last_seen_at,
 *        ip,user_agent,created_ip,created_user_agent) so SIEM and
 *        SOC2 CC6.1 access reviewers can pipe the active-session
 *        inventory straight into Splunk, Excel, or csvkit without a
 *        JSON decode step. Unknown formats return 400.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, residency, workspace API key policy, lockdown,
 * per-key rate limit (enforce, not peek, so this endpoint is
 * accounted for in billing).
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import { enforce as enforceRateLimit } from "../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import { logUsage } from "../../../../lib/usage";
import { getWorkspace } from "../../../../lib/workspaces";
import { listSessions } from "../../../../lib/sessions";

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
        message:
          "This API key is not bound to a workspace. Programmatic session management is only available to workspace-scoped keys.",
      },
    },
    { status: 403 },
  );
}

export async function GET(req: Request) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/sessions" });
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
  if (!hasScope(key, "sessions:read")) return insufficientScope("sessions:read", key.scopes);

  const url = new URL(req.url);
  const formatRaw = url.searchParams.get("format");
  const format =
    formatRaw === null || formatRaw === "" ? "json" : formatRaw.toLowerCase();
  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Invalid 'format' value. Use 'json' (default) or 'csv'.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  const ws = await getWorkspace(key.workspaceId);
  if (!ws) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Workspace not found." } },
      { status: 404, headers: rl.headers },
    );
  }

  // Tenant scope: only members of this workspace. We never accept a
  // userId from the request; the set of in-scope users is derived
  // purely from workspace membership.
  const memberIds = ws.members.map((m) => m.userId);
  const out: Array<{
    jti: string;
    user_id: string;
    created_at: number;
    expires_at: number;
    last_seen_at: number;
    ip: string | null;
    user_agent: string | null;
    created_ip: string | null;
    created_user_agent: string | null;
  }> = [];
  for (const userId of memberIds) {
    const sessions = await listSessions(userId);
    for (const s of sessions) {
      out.push({
        jti: s.jti,
        user_id: s.userId,
        created_at: s.createdAt,
        expires_at: s.expiresAt,
        last_seen_at: s.lastSeenAt,
        ip: s.ip,
        user_agent: s.userAgent,
        created_ip: s.createdIp,
        created_user_agent: s.createdUserAgent,
      });
    }
  }
  out.sort((a, b) => b.last_seen_at - a.last_seen_at);

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "/v1/sessions",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.sessions.read",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "workspace", id: key.workspaceId },
    status: "ok",
    meta: {
      prefix: key.prefix,
      count: out.length,
      format,
    },
  });

  if (format === "csv") {
    const csv = sessionsToCsv(out);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...rl.headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="codeclone-${ws.id}-sessions.csv"`,
      },
    });
  }

  return NextResponse.json(
    { workspace_id: key.workspaceId, sessions: out, total: out.length },
    { headers: rl.headers },
  );
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

type SessionRow = {
  jti: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
  created_ip: string | null;
  created_user_agent: string | null;
};

function sessionsToCsv(rows: ReadonlyArray<SessionRow>): string {
  const header = [
    "jti",
    "user_id",
    "created_at",
    "expires_at",
    "last_seen_at",
    "ip",
    "user_agent",
    "created_ip",
    "created_user_agent",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.jti),
        csvCell(r.user_id),
        csvCell(r.created_at),
        csvCell(r.expires_at),
        csvCell(r.last_seen_at),
        csvCell(r.ip),
        csvCell(r.user_agent),
        csvCell(r.created_ip),
        csvCell(r.created_user_agent),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
