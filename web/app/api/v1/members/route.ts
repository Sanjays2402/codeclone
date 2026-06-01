/**
 * Public GET /v1/members: programmatic workspace roster.
 *
 * Enterprise identity teams wiring CodeClone into IGA tooling (Okta
 * Lifecycle, SailPoint, Workday joiner/mover/leaver pipelines) need a
 * scoped, machine-readable view of who currently has access to a
 * workspace and at what role. SCIM at /scim/v2 is the push channel
 * from the IdP. This is the pull channel: identity teams reconcile
 * "who CodeClone thinks is in workspace X" against their source of
 * truth on a schedule, without needing the SCIM bearer token.
 *
 * Auth: Bearer token or `x-api-key` header, same as the rest of /v1.
 * Scope: `members:read`. Legacy keys with no `scopes` field keep
 *        working (full privileges, matching every other /v1 route).
 * Tenant scope: results are strictly limited to the calling key's
 *        workspace. A key minted in workspace A can never enumerate
 *        workspace B's members, even if both live on the same store.
 *        Keys with no workspace get 400 (the endpoint is meaningless
 *        without a workspace context).
 * Side effects: increments the per-key rate-limit window and writes
 *        one audit row (`v1.members.read`). Does not count toward
 *        the monthly /v1 plan quota (this endpoint is metadata, not
 *        a billable model call).
 * Query: ?include_suspended=true returns members in "suspended"
 *        status (retained for forensic continuity but with no
 *        effective access). Default false. ?include_support=true
 *        returns just-in-time support grants. Default false.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key
 * IP allowlist, residency, workspace API key policy, lockdown.
 */
import { NextResponse } from "next/server";
import {
  extractBearer,
  findByPlaintext,
  hasScope,
  recordUse,
} from "../../../../lib/api-keys";
import {
  effectiveRpm,
  enforce as enforceRateLimit,
} from "../../../../lib/rate-limit";
import {
  enforceWorkspaceAllowlistForKey,
  enforceKeyAllowlist,
} from "../../../../lib/ip-allowlist-enforce";
import { clientIpFromRequest } from "../../../../lib/ip-allowlist";
import { enforceWorkspaceResidencyForKey } from "../../../../lib/residency-enforce";
import { enforceWorkspaceApiKeyPolicyForKey } from "../../../../lib/api-key-policy-enforce";
import { enforceWorkspaceLockdownForKey } from "../../../../lib/lockdown-enforce";
import { tryRecordAudit } from "../../../../lib/audit";
import {
  getWorkspace,
  isMemberActive,
  isMemberSuspended,
  isSupportMember,
} from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { error: { type: "unauthorized", message } },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

function parseBoolFlag(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
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

  if (!hasScope(key, "members:read")) {
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "This key is missing the 'members:read' scope.",
          required_scope: "members:read",
        },
      },
      { status: 403 },
    );
  }

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/members",
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

  // Tenant scope: the endpoint is meaningless for a key with no
  // workspace context, so reject rather than silently returning [].
  if (!key.workspaceId) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message:
            "This API key is not bound to a workspace. /v1/members requires a workspace-scoped key.",
        },
      },
      { status: 400 },
    );
  }

  // Spend a rate-limit slot. Identity reconciliation is cheap but
  // it is still a real call against the customer's key budget.
  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;
  const rlHeaders = rl.headers;
  void effectiveRpm(key);

  const url = new URL(req.url);
  const includeSuspended = parseBoolFlag(
    url.searchParams.get("include_suspended"),
  );
  const includeSupport = parseBoolFlag(url.searchParams.get("include_support"));

  const ws = await getWorkspace(key.workspaceId);
  if (!ws) {
    // The key references a workspace that no longer exists. Treat as
    // 404 so the caller's IGA pipeline can drop the row.
    return NextResponse.json(
      {
        error: {
          type: "not_found",
          message: "Workspace not found.",
        },
      },
      { status: 404, headers: rlHeaders },
    );
  }

  const now = Date.now();
  const items = ws.members
    .filter((m) => {
      if (isMemberSuspended(m)) return includeSuspended;
      if (isSupportMember(m)) return includeSupport;
      // Default: only return active, non-support members. Expired
      // support grants are also filtered (isMemberActive handles it).
      return isMemberActive(m, now);
    })
    .map((m) => ({
      user_id: m.userId,
      email: m.email,
      role: m.role,
      status: m.status ?? "active",
      joined_at: m.joinedAt,
      suspended_at: m.suspendedAt ?? null,
      suspended_reason: m.suspendedReason ?? null,
      expires_at: m.expiresAt ?? null,
      granted_by: m.grantedBy ?? null,
      grant_reason: m.grantReason ?? null,
    }));

  void recordUse(key.id, clientIpFromRequest(req));

  void tryRecordAudit(req, {
    action: "v1.members.read",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "workspace_members", id: key.workspaceId },
    status: "ok",
    meta: {
      prefix: key.prefix,
      count: items.length,
      include_suspended: includeSuspended,
      include_support: includeSupport,
    },
  });

  const body = {
    workspace: {
      id: ws.id,
      name: ws.name ?? null,
      slug: ws.slug ?? null,
      plan: ws.plan ?? "free",
    },
    count: items.length,
    include_suspended: includeSuspended,
    include_support: includeSupport,
    items,
    server_time: now,
  };

  return NextResponse.json(body, { headers: rlHeaders });
}
