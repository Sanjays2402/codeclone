import { NextResponse } from "next/server";
import { currentUserFromCookieHeader, currentSessionFromCookieHeader } from "../../../../lib/auth";
import { tryRecordAudit } from "../../../../lib/audit";
import { requireStepUp } from "../../../../lib/mfa";
import {
  getWorkspace,
  getMember,
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

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!getMember(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ workspace: publicWorkspace(ws, user.id) });
}

interface PatchBody {
  name?: unknown;
  member?: { userId?: unknown; role?: unknown };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
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
  try {
    if (typeof body.name === "string") {
      await renameWorkspace(ws, body.name);
    }
    if (body.member && typeof body.member.userId === "string") {
      const role = body.member.role;
      if (role !== "owner" && role !== "editor" && role !== "viewer") {
        return NextResponse.json({ error: "invalid_role" }, { status: 400 });
      }
      await setMemberRole(ws, body.member.userId, role as Role);
    }
    await tryRecordAudit(req, {
      action: "workspace.update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      diff: { after: { name: ws.name, member: body.member ?? undefined } },
    });
    return NextResponse.json({ workspace: publicWorkspace(ws, user.id) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "invalid_name" || msg === "only_owner" || msg === "not_member" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const url = new URL(req.url);
  const targetUserId = url.searchParams.get("userId");
  // Self-leave is allowed. Removing others requires owner.
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
  // Removing another member is a destructive admin action: require MFA step-up.
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
    return NextResponse.json(
      { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
      { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
    );
  }
  try {
    await removeMember(ws, targetUserId);
    await tryRecordAudit(req, {
      action: "workspace.member_remove",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: targetUserId },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
