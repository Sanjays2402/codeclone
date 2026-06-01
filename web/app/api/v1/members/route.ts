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
  canManage,
  getWorkspace,
  isEmailAllowedForWorkspace,
  isMemberActive,
  isMemberSuspended,
  issueInvite,
  isSupportMember,
  type Role,
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

/**
 * POST /v1/members: invite a new member to the calling key's workspace.
 *
 * This is the write half of the IGA contract. Identity teams that mirror
 * joiner events from Workday into CodeClone need a programmatic invite path
 * so a new hire's first-day automation can land an invite in their inbox
 * without anyone clicking through the dashboard.
 *
 * Body (JSON):
 *   email: string (required) - invitee email. Must satisfy the workspace
 *          invite-domain allowlist if one is configured.
 *   role:  "editor" | "viewer" (required). Owner role cannot be granted via
 *          invite; transfer ownership through the dashboard.
 *
 * Auth: Bearer token or `x-api-key` header.
 * Scope: `members:write`.
 * RBAC: the API key's owning user must be an active owner of the workspace.
 *       Editor and viewer keys cannot manage membership.
 * Tenant scope: invite is bound to key.workspaceId; no body field can
 *       override the workspace target.
 * Side effects: rate-limit slot consumed, audit row `v1.members.invite`
 *       written (action stable for IGA grep).
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key IP
 * allowlist, residency, workspace API key policy, lockdown.
 */
export async function POST(req: Request) {
  const token = extractBearer(req);
  if (!token) {
    return unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.");
  }
  const key = await findByPlaintext(token);
  if (!key) {
    return unauthorized("Invalid or revoked API key.");
  }

  if (!hasScope(key, "members:write")) {
    return NextResponse.json(
      {
        error: {
          type: "insufficient_scope",
          message: "This key is missing the 'members:write' scope.",
          required_scope: "members:write",
          granted_scopes: key.scopes ?? null,
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

  const rl = await enforceRateLimit(key);
  if (rl.response) return rl.response;
  const rlHeaders = rl.headers;

  const ws = await getWorkspace(key.workspaceId);
  if (!ws) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Workspace not found." } },
      { status: 404, headers: rlHeaders },
    );
  }

  // RBAC: the calling key must belong to an active owner of this workspace.
  // Keys minted without a userId (legacy/service) cannot manage membership
  // because there is no human accountable for the change.
  if (!key.userId || !canManage(ws, key.userId)) {
    void tryRecordAudit(req, {
      action: "v1.members.invite",
      actorId: key.id,
      workspaceId: key.workspaceId,
      target: { type: "workspace_members", id: key.workspaceId },
      status: "denied",
      meta: {
        prefix: key.prefix,
        reason: "rbac_owner_required",
      },
    });
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message:
            "Inviting members requires an owner-bound API key. The calling key is not bound to an active owner of this workspace.",
        },
      },
      { status: 403, headers: rlHeaders },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Request body must be valid JSON.",
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  const body = (raw ?? {}) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Field 'email' is required and must be a valid email address.",
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  if (role !== "editor" && role !== "viewer") {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message:
            "Field 'role' must be 'editor' or 'viewer'. Owner role cannot be granted via invite.",
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  if (!isEmailAllowedForWorkspace(ws, email)) {
    void tryRecordAudit(req, {
      action: "v1.members.invite",
      actorId: key.id,
      workspaceId: key.workspaceId,
      target: { type: "workspace_members", id: key.workspaceId },
      status: "denied",
      meta: { prefix: key.prefix, email, reason: "invite_domain_not_allowed" },
    });
    return NextResponse.json(
      {
        error: {
          type: "invite_domain_not_allowed",
          message:
            "This email is not allowed by the workspace invite-domain allowlist.",
        },
      },
      { status: 403, headers: rlHeaders },
    );
  }

  if (ws.members.some((m) => m.email === email)) {
    return NextResponse.json(
      {
        error: {
          type: "already_member",
          message: "A member with this email is already on the workspace roster.",
        },
      },
      { status: 409, headers: rlHeaders },
    );
  }

  const origin = (() => {
    try {
      return new URL(req.url).origin;
    } catch {
      return "http://localhost:3000";
    }
  })();

  let invite;
  try {
    invite = await issueInvite({
      workspace: ws,
      email,
      role: role as Exclude<Role, "owner">,
      invitedBy: key.userId!,
      origin,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "invite_failed";
    return NextResponse.json(
      {
        error: {
          type: code,
          message: "Failed to issue invite.",
        },
      },
      { status: 400, headers: rlHeaders },
    );
  }

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.members.invite",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "workspace_invite", id: invite.record.id },
    status: "ok",
    meta: {
      prefix: key.prefix,
      email,
      role,
      expires_at: invite.record.expiresAt,
    },
  });

  return NextResponse.json(
    {
      invite: {
        id: invite.record.id,
        workspace_id: invite.record.workspaceId,
        email: invite.record.email,
        role: invite.record.role,
        invited_by: invite.record.invitedBy,
        created_at: invite.record.createdAt,
        expires_at: invite.record.expiresAt,
        accept_url: invite.url,
      },
      token: invite.token,
      token_notice:
        "Store this token now. It will never be shown again. Deliver via your provisioning channel.",
    },
    { status: 201, headers: rlHeaders },
  );
}
