/**
 * Public POST /v1/sessions/revoke-all: force-logout every active session
 * for a single member of the calling key's workspace.
 *
 * Companion to GET /v1/sessions and DELETE /v1/sessions/[jti]. This is
 * the incident-response "kill switch" SecOps reaches for when a
 * member's laptop is reported stolen or a phishing victim has had
 * cookies exfiltrated: revoke every active session in one round-trip
 * instead of N individual DELETEs.
 *
 * Auth: Bearer or `x-api-key`. Scope: `sessions:write`.
 *
 * Request body: { "user_id": "<userId>" }. The userId MUST belong to
 * the calling key's workspace. If it does not, we return 404 (not
 * 403) so the existence of users in other tenants cannot be probed.
 *
 * Tenant scope: every session lookup is bound to userIds we have
 * proven are members of key.workspaceId. There is no path that lets a
 * caller revoke sessions for a user outside its workspace.
 *
 * Idempotent. Writes one audit row under `v1.sessions.revoke_all`
 * with the count of sessions actually revoked.
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
import { tryRecordAudit } from "../../../../../lib/audit";
import { logUsage } from "../../../../../lib/usage";
import { getWorkspace } from "../../../../../lib/workspaces";
import { revokeAllSessions } from "../../../../../lib/sessions";

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

function badRequest(message: string) {
  return NextResponse.json(
    { error: { type: "invalid_request", message } },
    { status: 400 },
  );
}

function notFound() {
  return NextResponse.json(
    { error: { type: "not_found", message: "User is not a member of this workspace." } },
    { status: 404 },
  );
}

export async function POST(req: Request) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/sessions/revoke-all" });
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
  if (!hasScope(key, "sessions:write")) return insufficientScope("sessions:write", key.scopes);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON: { user_id: string }");
  }
  const userId =
    body && typeof body === "object" && "user_id" in body && typeof (body as { user_id: unknown }).user_id === "string"
      ? ((body as { user_id: string }).user_id).trim()
      : "";
  if (!userId || userId.length > 256) {
    return badRequest("Body must include a non-empty 'user_id' string.");
  }

  const ws = await getWorkspace(key.workspaceId);
  if (!ws) return notFound();
  const memberIds = new Set(ws.members.map((m) => m.userId));
  if (!memberIds.has(userId)) return notFound();

  const revoked = await revokeAllSessions(userId);

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "POST /v1/sessions/revoke-all",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.sessions.revoke_all",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "user", id: userId },
    diff: { before: {}, after: { revoked_count: revoked } },
  });

  return NextResponse.json(
    { user_id: userId, revoked_count: revoked },
    { headers: rl.headers },
  );
}
