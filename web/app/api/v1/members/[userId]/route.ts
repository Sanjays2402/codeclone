/**
 * Public /v1/members/[userId]: programmatic single-member read,
 * role change, suspend, reinstate, remove.
 *
 *   GET    /v1/members/:user_id   -> fetch one member's role, status,
 *                                    and (for support grants) expiry +
 *                                    grant metadata, without paginating
 *                                    the full roster. Identity teams use
 *                                    this in joiner/mover/leaver runbooks
 *                                    and Okta Lifecycle reconciles to
 *                                    confirm a single user before pushing
 *                                    a SCIM PATCH.
 *   PATCH  /v1/members/:user_id   -> change role ("editor" | "viewer") and/or
 *                                    status ("active" | "suspended"). Owner role
 *                                    transfer is not exposed here on purpose:
 *                                    use the dashboard so a human confirms it.
 *   DELETE /v1/members/:user_id   -> remove the member from the roster.
 *
 * Auth: Bearer token or `x-api-key` header.
 * Scope: `members:write`.
 * RBAC: caller's key must be bound to an active owner of the workspace.
 * Tenant scope: target lookup is filtered by key.workspaceId. A key in
 *       workspace A cannot mutate a member of workspace B, even with a
 *       known userId; cross-tenant lookups return 404 (not 403) so the
 *       existence of foreign user ids cannot be probed.
 * Self-protection: an owner cannot demote, suspend, or remove themselves
 *       through this endpoint. Locking yourself out via a script is the
 *       most common procurement-blocking footgun.
 * Side effects: rate-limit slot consumed, audit row written for every
 *       attempt (status="ok" or "denied") under a stable action id.
 *
 * Still enforced: revocation, expiry, workspace IP allowlist, per-key IP
 * allowlist, residency, workspace API key policy, lockdown.
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
import {
  canManage,
  getWorkspace,
  reinstateMember,
  removeMember,
  setMemberRole,
  suspendMember,
  type Role,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ userId: string }> | { userId: string } };

async function resolveParams(ctx: Ctx): Promise<{ userId: string }> {
  const p = (ctx as { params: { userId: string } | Promise<{ userId: string }> }).params;
  return p instanceof Promise ? await p : p;
}

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

function notFound() {
  // 404, not 403, so a workspace A key cannot probe for workspace B's
  // user ids by watching status codes.
  return NextResponse.json(
    { error: { type: "not_found", message: "Member not found in this workspace." } },
    { status: 404 },
  );
}

async function commonGate(req: Request) {
  const token = extractBearer(req);
  if (!token) return { error: unauthorized("Missing API key. Pass 'Authorization: Bearer <key>'.") };
  const key = await findByPlaintext(token);
  if (!key) return { error: unauthorized("Invalid or revoked API key.") };

  const lockdownBlocked = await enforceWorkspaceLockdownForKey(req, key, {
    route: "/v1/members/[userId]",
  });
  if (lockdownBlocked) return { error: lockdownBlocked };
  const wsBlocked = await enforceWorkspaceAllowlistForKey(req, key);
  if (wsBlocked) return { error: wsBlocked };
  const keyBlocked = await enforceKeyAllowlist(req, key);
  if (keyBlocked) return { error: keyBlocked };
  const residencyBlocked = await enforceWorkspaceResidencyForKey(req, key);
  if (residencyBlocked) return { error: residencyBlocked };
  const policyBlocked = await enforceWorkspaceApiKeyPolicyForKey(req, key);
  if (policyBlocked) return { error: policyBlocked };

  if (!key.workspaceId) {
    return {
      error: NextResponse.json(
        {
          error: {
            type: "invalid_request",
            message:
              "This API key is not bound to a workspace. /v1/members requires a workspace-scoped key.",
          },
        },
        { status: 400 },
      ),
    };
  }

  const rl = await enforceRateLimit(key);
  if (rl.response) return { error: rl.response };
  return { key, rl };
}

async function rbacGate(req: Request, key: any, action: string) {
  const ws = await getWorkspace(key.workspaceId);
  if (!ws) {
    return {
      error: NextResponse.json(
        { error: { type: "not_found", message: "Workspace not found." } },
        { status: 404 },
      ),
    };
  }
  if (!key.userId || !canManage(ws, key.userId)) {
    void tryRecordAudit(req, {
      action,
      actorId: key.id,
      workspaceId: key.workspaceId,
      target: { type: "workspace_members", id: key.workspaceId },
      status: "denied",
      meta: { prefix: key.prefix, reason: "rbac_owner_required" },
    });
    return {
      error: NextResponse.json(
        {
          error: {
            type: "forbidden",
            message:
              "Managing members requires an owner-bound API key. The calling key is not bound to an active owner of this workspace.",
          },
        },
        { status: 403 },
      ),
    };
  }
  return { ws };
}

function presentMember(m: {
  userId: string;
  email: string;
  role: string;
  status?: string | null;
  joinedAt: number;
  suspendedAt?: number | null;
  suspendedReason?: string | null;
  expiresAt?: number | null;
  grantedBy?: string | null;
  grantReason?: string | null;
}) {
  return {
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
  };
}

export async function GET(req: Request, ctx: Ctx) {
  const gate = await commonGate(req);
  if ("error" in gate) return gate.error;
  const { key, rl } = gate;
  if (!hasScope(key, "members:read"))
    return insufficientScope("members:read", key.scopes);

  const ws = await getWorkspace(key.workspaceId!);
  if (!ws) {
    return NextResponse.json(
      { error: { type: "not_found", message: "Workspace not found." } },
      { status: 404, headers: rl.headers },
    );
  }

  const { userId } = await resolveParams(ctx);
  if (typeof userId !== "string" || !userId.trim()) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Missing user id in path." } },
      { status: 400, headers: rl.headers },
    );
  }

  const target = ws.members.find((m) => m.userId === userId);
  if (!target) return notFound();

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.members.get",
    actorId: key.id,
    workspaceId: key.workspaceId!,
    target: { type: "workspace_member", id: userId },
    status: "ok",
    meta: { prefix: key.prefix },
  });

  return NextResponse.json(
    { member: presentMember(target) },
    { headers: rl.headers },
  );
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await commonGate(req);
  if ("error" in gate) return gate.error;
  const { key, rl } = gate;
  if (!hasScope(key, "members:write")) return insufficientScope("members:write", key.scopes);

  const rbac = await rbacGate(req, key, "v1.members.update");
  if ("error" in rbac) return rbac.error;
  let { ws } = rbac;

  const { userId } = await resolveParams(ctx);
  if (typeof userId !== "string" || !userId.trim()) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Missing user id in path." } },
      { status: 400, headers: rl.headers },
    );
  }
  if (userId === key.userId) {
    return NextResponse.json(
      {
        error: {
          type: "self_target_forbidden",
          message:
            "An owner cannot modify their own membership through this endpoint. Use the dashboard for self-changes so it stays auditable.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Request body must be valid JSON." } },
      { status: 400, headers: rl.headers },
    );
  }
  const body = (raw ?? {}) as Record<string, unknown>;

  const target = ws.members.find((m) => m.userId === userId);
  if (!target) return notFound();
  if (target.status === "support") {
    return NextResponse.json(
      {
        error: {
          type: "support_grant_immutable",
          message:
            "Support access grants cannot be edited. Revoke and recreate the grant via the support access API.",
        },
      },
      { status: 409, headers: rl.headers },
    );
  }

  const before = { role: target.role, status: target.status ?? "active" };
  const after: { role?: string; status?: string } = {};

  const desiredRole = body.role;
  const desiredStatus = body.status;

  if (desiredRole !== undefined) {
    if (typeof desiredRole !== "string" || (desiredRole !== "editor" && desiredRole !== "viewer")) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_request",
            message:
              "Field 'role' must be 'editor' or 'viewer'. Owner transfers are not allowed here.",
          },
        },
        { status: 400, headers: rl.headers },
      );
    }
    if (target.role === "owner") {
      return NextResponse.json(
        {
          error: {
            type: "owner_demotion_forbidden",
            message:
              "Owners cannot be demoted via this endpoint. Transfer ownership first in the dashboard.",
          },
        },
        { status: 409, headers: rl.headers },
      );
    }
    try {
      ws = await setMemberRole(ws, userId, desiredRole as Role);
      after.role = desiredRole;
    } catch (err) {
      const code = err instanceof Error ? err.message : "role_update_failed";
      return NextResponse.json(
        { error: { type: code, message: "Failed to update role." } },
        { status: 409, headers: rl.headers },
      );
    }
  }

  if (desiredStatus !== undefined) {
    if (typeof desiredStatus !== "string" || (desiredStatus !== "active" && desiredStatus !== "suspended")) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_request",
            message: "Field 'status' must be 'active' or 'suspended'.",
          },
        },
        { status: 400, headers: rl.headers },
      );
    }
    try {
      if (desiredStatus === "suspended") {
        const reason = typeof body.reason === "string" ? body.reason : null;
        ws = await suspendMember(ws, userId, { actorUserId: key.userId!, reason });
      } else {
        ws = await reinstateMember(ws, userId);
      }
      after.status = desiredStatus;
    } catch (err) {
      const code = err instanceof Error ? err.message : "status_update_failed";
      // already_suspended / not_suspended are benign idempotency signals.
      if (code === "already_suspended" || code === "not_suspended") {
        after.status = desiredStatus;
      } else {
        return NextResponse.json(
          { error: { type: code, message: "Failed to update status." } },
          { status: 409, headers: rl.headers },
        );
      }
    }
  }

  if (Object.keys(after).length === 0) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_request",
          message: "Provide at least one of 'role' or 'status' to update.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  const fresh = ws.members.find((m) => m.userId === userId)!;
  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.members.update",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "workspace_member", id: userId },
    status: "ok",
    diff: { before, after },
    meta: { prefix: key.prefix },
  });

  return NextResponse.json(
    {
      member: {
        user_id: fresh.userId,
        email: fresh.email,
        role: fresh.role,
        status: fresh.status ?? "active",
        joined_at: fresh.joinedAt,
        suspended_at: fresh.suspendedAt ?? null,
        suspended_reason: fresh.suspendedReason ?? null,
      },
    },
    { headers: rl.headers },
  );
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await commonGate(req);
  if ("error" in gate) return gate.error;
  const { key, rl } = gate;
  if (!hasScope(key, "members:write")) return insufficientScope("members:write", key.scopes);

  const rbac = await rbacGate(req, key, "v1.members.remove");
  if ("error" in rbac) return rbac.error;
  const { ws } = rbac;

  const { userId } = await resolveParams(ctx);
  if (typeof userId !== "string" || !userId.trim()) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Missing user id in path." } },
      { status: 400, headers: rl.headers },
    );
  }
  if (userId === key.userId) {
    return NextResponse.json(
      {
        error: {
          type: "self_target_forbidden",
          message:
            "An owner cannot remove themselves through this endpoint. Transfer ownership first.",
        },
      },
      { status: 400, headers: rl.headers },
    );
  }

  const target = ws.members.find((m) => m.userId === userId);
  if (!target) return notFound();
  if (target.status === "support") {
    return NextResponse.json(
      {
        error: {
          type: "support_grant_immutable",
          message:
            "Support access grants cannot be removed via this endpoint. Use the support access revocation API.",
        },
      },
      { status: 409, headers: rl.headers },
    );
  }

  try {
    await removeMember(ws, userId);
  } catch (err) {
    const code = err instanceof Error ? err.message : "remove_failed";
    return NextResponse.json(
      { error: { type: code, message: "Failed to remove member." } },
      { status: 409, headers: rl.headers },
    );
  }

  void recordUse(key.id, clientIpFromRequest(req));
  void tryRecordAudit(req, {
    action: "v1.members.remove",
    actorId: key.id,
    workspaceId: key.workspaceId,
    target: { type: "workspace_member", id: userId },
    status: "ok",
    diff: {
      before: { role: target.role, status: target.status ?? "active" },
      after: { removed: true },
    },
    meta: { prefix: key.prefix, email: target.email },
  });

  return NextResponse.json(
    { id: userId, removed: true },
    { headers: rl.headers },
  );
}
