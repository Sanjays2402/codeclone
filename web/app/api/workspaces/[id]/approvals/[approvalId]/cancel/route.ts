/**
 * POST /api/workspaces/:id/approvals/:approvalId/cancel
 *
 * The original requester or any owner can cancel a pending or approved
 * request, invalidating its token before it is consumed.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../../lib/dashboard-allowlist-enforce";
import { getWorkspace, getActiveMember } from "../../../../../../../lib/workspaces";
import { cancelRequest, getApproval, ApprovalError } from "../../../../../../../lib/dual-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; approvalId: string }> },
) {
  const { id, approvalId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const block = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/approvals/cancel" },
  );
  if (block) return block;
  const member = getActiveMember(ws, user.id);
  if (!member) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const existing = await getApproval(ws.id, approvalId);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Cross-tenant guard. The lib also enforces this; defence in depth.
  if (existing.workspaceId !== ws.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const isRequester = existing.requestedBy === user.id;
  const isOwner = member.role === "owner";
  if (!isRequester && !isOwner) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const rec = await cancelRequest({ workspaceId: ws.id, approvalId, byUserId: user.id });
    await tryRecordAudit(req, {
      action: "workspace.approval_cancelled",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "approval", id: rec.id, label: rec.operation },
      meta: { operation: rec.operation, byRequester: isRequester },
    });
    const { tokenHash: _omit, ...safe } = rec;
    return NextResponse.json({ approval: safe });
  } catch (e) {
    const code = e instanceof ApprovalError ? e.code : "approval_error";
    const status = code === "not_found" ? 404 : 409;
    return NextResponse.json({ error: code }, { status });
  }
}
