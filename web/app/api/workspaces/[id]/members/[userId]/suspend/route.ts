import { NextResponse } from "next/server";
import {
  currentUserFromCookieHeader,
  currentSessionFromCookieHeader,
} from "../../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../../lib/audit";
import { requireStepUp } from "../../../../../../../lib/mfa";
import {
  getWorkspace,
  canManage,
  suspendMember,
  reinstateMember,
} from "../../../../../../../lib/workspaces";
import { revokeAllSessions } from "../../../../../../../lib/sessions";
import { listKeys, revokeKey } from "../../../../../../../lib/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SuspendBody {
  reason?: unknown;
}

/**
 * POST /api/workspaces/<id>/members/<userId>/suspend
 *
 * Suspend a workspace member. Owner-only, MFA step-up required. On success:
 *   1. Member.status flips to "suspended" (audit trail preserved).
 *   2. All of the user's active sessions are revoked.
 *   3. All API keys owned by that user are revoked (best effort).
 *   4. An audit entry is written.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  const { id, userId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.member_suspend",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: userId },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (userId === user.id) {
    return NextResponse.json(
      { error: "cannot_suspend_self", message: "Owners cannot suspend themselves. Transfer ownership first." },
      { status: 400 },
    );
  }

  const session = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, session?.jti ?? null);
  if (!gate.allowed) {
    await tryRecordAudit(req, {
      action: "workspace.member_suspend",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: userId },
      status: "denied",
      meta: { reason: "mfa_required" },
    });
    return NextResponse.json(
      { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
      { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
    );
  }

  let body: SuspendBody = {};
  try { body = await req.json(); } catch { /* empty */ }
  const reason = typeof body.reason === "string" ? body.reason : null;

  try {
    await suspendMember(ws, userId, { actorUserId: user.id, reason });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "only_owner" || msg === "not_member" || msg === "already_suspended" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  // Sever every active credential path for the suspended user. Best-effort:
  // errors here do not roll back the suspension because the suspension flag
  // itself blocks all workspace-scoped reads/writes on subsequent requests.
  let sessionsRevoked = 0;
  let keysRevoked = 0;
  try {
    sessionsRevoked = await revokeAllSessions(userId);
  } catch { /* logged below in audit */ }
  try {
    const keys = await listKeys(userId);
    for (const k of keys) {
      if (k.revoked) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await revokeKey(k.id, userId)) keysRevoked += 1;
    }
  } catch { /* logged below */ }

  await tryRecordAudit(req, {
    action: "workspace.member_suspend",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace_member", id: userId },
    meta: {
      sessionsRevoked,
      apiKeysRevoked: keysRevoked,
      reason: reason ? reason.slice(0, 280) : null,
    },
  });

  return NextResponse.json({
    ok: true,
    suspended: true,
    sessionsRevoked,
    apiKeysRevoked: keysRevoked,
  });
}

/**
 * DELETE /api/workspaces/<id>/members/<userId>/suspend
 *
 * Reinstate a previously suspended member. Owner-only, MFA step-up required.
 * Sessions and API keys revoked during suspension are NOT auto-restored;
 * the user must sign back in and owners may rotate keys as needed.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; userId: string }> },
) {
  const { id, userId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.member_reinstate",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace_member", id: userId },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const session = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, session?.jti ?? null);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
      { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
    );
  }

  try {
    await reinstateMember(ws, userId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "not_member" || msg === "not_suspended" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  await tryRecordAudit(req, {
    action: "workspace.member_reinstate",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace_member", id: userId },
  });

  return NextResponse.json({ ok: true, suspended: false });
}
