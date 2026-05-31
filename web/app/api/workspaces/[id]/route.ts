import { NextResponse } from "next/server";
import { currentUserFromCookieHeader, currentSessionFromCookieHeader } from "../../../../lib/auth";
import { tryRecordAudit } from "../../../../lib/audit";
import { requireStepUp } from "../../../../lib/mfa";
import { revokeAllSessions } from "../../../../lib/sessions";
import { listKeys, revokeKey } from "../../../../lib/api-keys";
import { enforceWorkspaceAllowlistForSession } from "../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  renameWorkspace,
  setMemberRole,
  removeMember,
  type Role,
  type WorkspaceRecord,
} from "../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicWorkspace(ws: WorkspaceRecord | null, viewerId: string) {
  if (!ws) return null;
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    createdAt: ws.createdAt,
    createdBy: ws.createdBy,
    members: ws.members,
    myRole: ws.members.find((m) => m.userId === viewerId)?.role ?? null,
  };
}

function mfaResponse(): NextResponse {
  return NextResponse.json(
    { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
    { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
  );
}

interface PatchBody {
  name?: unknown;
  member?: { userId?: unknown; role?: unknown };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces" });
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ workspace: publicWorkspace(ws, user.id) });
}

/**
 * PATCH /api/workspaces/<id>
 *
 * Owner-only. Two distinct mutations:
 *   1. `name`: rename the workspace.
 *   2. `member: { userId, role }`: change a member's role.
 *
 * Role changes are a destructive privilege boundary (a freshly demoted
 * editor must not keep using elevated UI/API sessions until their cookie
 * naturally expires) so we:
 *   - require an MFA step-up (matching suspend / remove / legal hold),
 *   - record the before/after role in the audit diff,
 *   - revoke ALL sessions for the affected user when their role changes,
 *     so their next request re-authenticates against the new role.
 * Sole-owner demotion attempts and other validation failures emit a
 * denied audit row instead of a silent 400.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: PatchBody = {};
  try { body = await req.json(); } catch { /* empty */ }

  // Role-change branch is gated separately from rename so a plain
  // rename does not unnecessarily demand MFA.
  const wantsRoleChange =
    body.member != null && typeof body.member.userId === "string";

  if (wantsRoleChange) {
    const targetUserId = body.member!.userId as string;
    const role = body.member!.role;
    if (role !== "owner" && role !== "editor" && role !== "viewer") {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }
    const current = ws.members.find((m) => m.userId === targetUserId);
    if (!current) {
      await tryRecordAudit(req, {
        action: "workspace.member_role_change",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace_member", id: targetUserId },
        status: "denied",
        meta: { reason: "not_member" },
      });
      return NextResponse.json({ error: "not_member" }, { status: 400 });
    }
    const beforeRole = current.role;

    // MFA step-up: changing privilege is destructive. Skip the round-trip
    // when role is unchanged so noisy UIs don't loop on MFA.
    if (beforeRole !== role) {
      const sess = await currentSessionFromCookieHeader(req.headers.get("cookie"));
      const gate = await requireStepUp(user.id, sess?.jti ?? null);
      if (!gate.allowed) {
        await tryRecordAudit(req, {
          action: "workspace.member_role_change",
          actorId: user.id,
          actorEmail: user.email,
          workspaceId: ws.id,
          target: { type: "workspace_member", id: targetUserId },
          status: "denied",
          meta: { reason: "mfa_required", before: beforeRole, after: role },
        });
        return mfaResponse();
      }
    }

    try {
      await setMemberRole(ws, targetUserId, role as Role);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg === "only_owner" || msg === "not_member" ? 400 : 500;
      await tryRecordAudit(req, {
        action: "workspace.member_role_change",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace_member", id: targetUserId },
        status: "denied",
        meta: { reason: msg, before: beforeRole, after: role },
      });
      return NextResponse.json({ error: msg }, { status });
    }

    let sessionsRevoked = 0;
    if (beforeRole !== role) {
      try {
        sessionsRevoked = await revokeAllSessions(targetUserId);
      } catch { /* best-effort, audit still records the change */ }
    }

    if (typeof body.name === "string") {
      try { await renameWorkspace(ws, body.name); } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: msg }, { status: 400 });
      }
    }

    await tryRecordAudit(req, {
      action: "workspace.member_role_change",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: targetUserId, label: current.email ?? undefined },
      diff: { before: { role: beforeRole }, after: { role } },
      meta: { sessionsRevoked },
    });
    return NextResponse.json({
      workspace: publicWorkspace(ws, user.id),
      sessionsRevoked,
    });
  }

  // Plain rename path (no role change).
  try {
    if (typeof body.name === "string") {
      await renameWorkspace(ws, body.name);
    }
    await tryRecordAudit(req, {
      action: "workspace.update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      diff: { after: { name: ws.name } },
    });
    return NextResponse.json({ workspace: publicWorkspace(ws, user.id) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "invalid_name" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

/**
 * DELETE /api/workspaces/<id>?userId=<uid>
 *
 * Two modes:
 *   - Self-leave (no `userId`, or `userId` === actor): the actor leaves the
 *     workspace. No MFA required (you can always leave yourself). Sole-owner
 *     attempts are rejected by removeMember(); we record the denial.
 *   - Forced removal (owner removing someone else): owner-only, MFA step-up
 *     required. After removal we revoke every active session AND every
 *     API key for the removed user. Same revocation semantics as suspend
 *     so a removed employee cannot keep using credentials they already
 *     held.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces" });
  if (__ipBlock) return __ipBlock;
  const url = new URL(req.url);
  const targetUserId = url.searchParams.get("userId");

  // Self-leave: allowed for any member.
  if (!targetUserId || targetUserId === user.id) {
    try {
      await removeMember(ws, user.id);
      await tryRecordAudit(req, {
        action: "workspace.member_leave",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace_member", id: user.id, label: user.email },
      });
      return NextResponse.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await tryRecordAudit(req, {
        action: "workspace.member_leave",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace_member", id: user.id, label: user.email },
        status: "denied",
        meta: { reason: msg },
      });
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  }

  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.member_remove",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: targetUserId },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Forced removal: MFA step-up.
  const ctxMfa = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, ctxMfa?.jti ?? null);
  if (!gate.allowed) {
    await tryRecordAudit(req, {
      action: "workspace.member_remove",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: targetUserId },
      status: "denied",
      meta: { reason: "mfa_required" },
    });
    return mfaResponse();
  }

  const beforeRole = ws.members.find((m) => m.userId === targetUserId)?.role ?? null;
  const beforeEmail = ws.members.find((m) => m.userId === targetUserId)?.email ?? null;

  try {
    await removeMember(ws, targetUserId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await tryRecordAudit(req, {
      action: "workspace.member_remove",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: targetUserId, label: beforeEmail ?? undefined },
      status: "denied",
      meta: { reason: msg },
    });
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Sever every credential path for the removed user. Best-effort; failures
  // here do not roll back the removal because the membership row is the
  // primary gate on every workspace-scoped read/write.
  let sessionsRevoked = 0;
  let keysRevoked = 0;
  try {
    sessionsRevoked = await revokeAllSessions(targetUserId);
  } catch { /* logged below */ }
  try {
    const keys = await listKeys(targetUserId);
    for (const k of keys) {
      if (k.revoked) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await revokeKey(k.id, targetUserId)) keysRevoked += 1;
    }
  } catch { /* logged below */ }

  await tryRecordAudit(req, {
    action: "workspace.member_remove",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace_member", id: targetUserId, label: beforeEmail ?? undefined },
    diff: { before: { role: beforeRole }, after: null },
    meta: { sessionsRevoked, apiKeysRevoked: keysRevoked },
  });

  return NextResponse.json({ ok: true, sessionsRevoked, apiKeysRevoked: keysRevoked });
}
