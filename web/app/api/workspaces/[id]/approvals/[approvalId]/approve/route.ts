/**
 * POST /api/workspaces/:id/approvals/:approvalId/approve
 *
 * A *second* owner approves a pending request. Self-approval is rejected
 * by the lib. Returns a plaintext one-time token exactly once; it is
 * required on the destructive call and never persisted in plaintext.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../../lib/dashboard-allowlist-enforce";
import { getWorkspace, getActiveMember } from "../../../../../../../lib/workspaces";
import { approveRequest, ApprovalError } from "../../../../../../../lib/dual-control";

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
    { surface: "workspaces/approvals/approve" },
  );
  if (block) return block;
  const member = getActiveMember(ws, user.id);
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const { approval, token } = await approveRequest({
      workspaceId: ws.id,
      approvalId,
      approverUserId: user.id,
      approverEmail: user.email,
    });
    await tryRecordAudit(req, {
      action: "workspace.approval_approved",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "approval", id: approval.id, label: approval.operation },
      meta: {
        operation: approval.operation,
        requestedBy: approval.requestedBy,
        requestedByEmail: approval.requestedByEmail,
      },
    });
    const { tokenHash: _omit, ...safe } = approval;
    return NextResponse.json({ approval: safe, token });
  } catch (e) {
    const code = e instanceof ApprovalError ? e.code : "approval_error";
    const status = code === "not_found" ? 404 : code === "self_approval_forbidden" ? 403 : 409;
    await tryRecordAudit(req, {
      action: "workspace.approval_approved",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "approval", id: approvalId, label: "approve" },
      status: "denied",
      meta: { code },
    });
    return NextResponse.json({ error: code }, { status });
  }
}
