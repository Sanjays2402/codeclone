/**
 * Public DELETE /v1/sessions/[jti]: programmatic single-session revoke.
 *
 * Companion to GET /v1/sessions (../route.ts) and POST
 * /v1/sessions/revoke-all (../revoke-all/route.ts). Together they give
 * SecOps a tenant-scoped, audit-logged incident-response primitive:
 * locate a suspicious session by jti, force-logout that one device
 * without disturbing the user's other sessions.
 *
 * Auth: Bearer or `x-api-key`. Scope: `sessions:write`.
 *
 * Tenant scope: we resolve the session's owning userId on the server
 * via findSessionOwner(jti). If that user is not an active member of
 * the calling key's workspace we return 404 (not 403) so the
 * existence of another tenant's jti cannot be probed by status code.
 * The caller never gets to name a userId in the URL or body.
 *
 * Idempotent: revoking an already-revoked or unknown jti returns 404.
 * Successful revoke writes an audit row under `v1.sessions.revoke`.
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
import { findSessionOwner, revokeSession } from "../../../../../lib/sessions";

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

function notFound() {
  // 404, not 403, so callers cannot probe for the existence of
  // another tenant's session jti by watching status codes.
  return NextResponse.json(
    { error: { type: "not_found", message: "Session not found in this workspace." } },
    { status: 404 },
  );
}

type Ctx = { params: Promise<{ jti: string }> | { jti: string } };

async function resolveParams(ctx: Ctx): Promise<{ jti: string }> {
  const p = (ctx as { params: { jti: string } | Promise<{ jti: string }> }).params;
  return p instanceof Promise ? await p : p;
}

export async function DELETE(req: Request, ctx: Ctx) {
  const token = extractBearer(req);
  if (!token) return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  const key = await findByPlaintext(token);
  if (!key) return unauthorized("Invalid or revoked API key.");

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, { route: "/v1/sessions/[jti]" });
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

  const { jti } = await resolveParams(ctx);
  if (!jti || typeof jti !== "string" || jti.length > 256) return notFound();

  const owner = await findSessionOwner(jti);
  if (!owner) return notFound();

  const ws = await getWorkspace(key.workspaceId);
  if (!ws) return notFound();
  const memberIds = new Set(ws.members.map((m) => m.userId));
  if (!memberIds.has(owner.userId)) {
    // Session exists, but for a user not in this workspace. Surface
    // as 404 so cross-tenant probes cannot distinguish "unknown jti"
    // from "jti belongs to another tenant".
    return notFound();
  }

  const ok = await revokeSession(owner.userId, jti);
  if (!ok) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void logUsage({
    ts: Date.now(),
    keyId: key.id,
    endpoint: "DELETE /v1/sessions/:jti",
    bytes: 0,
    latencyMs: 0,
    workspaceId: key.workspaceId,
  });
  void tryRecordAudit(req, {
    action: "v1.sessions.revoke",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "session", id: jti },
    diff: { before: { revoked: false }, after: { revoked: true } },
  });

  return NextResponse.json(
    { jti, user_id: owner.userId, revoked: true },
    { headers: rl.headers },
  );
}
