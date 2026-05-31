/**
 * POST /api/workspaces/:id/approvals/:reqId/approve
 *
 * A second owner approves a pending dual-control request. Returns the
 * one-time `approval_token` exactly once; the caller must pass it as
 * `approval_token` in the body of the destructive call.
 *
 * Self-approval is refused: the approver MUST differ from the requester.
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
  ctx: { params: Promise<{ id: string; reqId: string }> },
) {
  const { id, reqId } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const block = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/approvals.approve" },
  );
  if (block) return block;
  const member = getActiveMember(ws, user.id);
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "forbidden", message: "Owner role required." }, { status: 403 });
  }
  try {
    const { approval, token } = await approveRequest({
      workspaceId: ws.id,
      approvalId: reqId,
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
        payloadHash: approval.payloadHash,
      },
    });
    const { tokenHash: _t, ...safe } = approval;
    return NextResponse.json({ approval: safe, approval_token: token });
  } catch (e) {
    const code = e instanceof ApprovalError ? e.code : "approval_error";
    const status =
      code === "not_found"
        ? 404
        : code === "self_approval_forbidden"
          ? 403
          : code === "expired" || code === "cancelled" || code === "already_consumed"
            ? 409
            : 400;
    await tryRecordAudit(req, {
      action: "workspace.approval_approved",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "approval", id: reqId },
      status: "denied",
      meta: { code },
    });
    return NextResponse.json({ error: code }, { status });
  }
}
