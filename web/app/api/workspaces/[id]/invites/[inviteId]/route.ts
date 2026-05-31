import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../lib/audit";
import { getWorkspace, canInvite, revokeInvite } from "../../../../../../lib/workspaces";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../lib/dashboard-allowlist-enforce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; inviteId: string }> },
) {
  const { id, inviteId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/invites/[inviteId]" });
  if (__ipBlock) return __ipBlock;
  if (!canInvite(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const ok = await revokeInvite(inviteId);
  if (!ok) return NextResponse.json({ error: "not_found_or_consumed" }, { status: 404 });
  await tryRecordAudit(req, {
    action: "workspace.invite_revoke",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace_invite", id: inviteId },
  });
  return NextResponse.json({ ok: true });
}
