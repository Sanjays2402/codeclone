/**
 * POST /api/workspaces/:id/approvals/:reqId/cancel
 *
 * Either the requester or any other owner may cancel a pending or
 * approved-but-not-yet-consumed request. Cancelled tokens cannot be
 * consumed.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../../../lib/dashboard-allowlist-enforce";
import { getWorkspace, getActiveMember } from "../../../../../../../lib/workspaces";
import { cancelRequest, ApprovalError } from "../../../../../../../lib/dual-control";

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
    { surface: "workspaces/approvals.cancel" },
  );
  if (block) return block;
  const member = getActiveMember(ws, user.id);
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "forbidden", message: "Owner role required." }, { status: 403 });
  }
  try {
    const rec = await cancelRequest({
      workspaceId: ws.id,
      approvalId: reqId,
      byUserId: user.id,
    });
    await tryRecordAudit(req, {
      action: "workspace.approval_cancelled",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "approval", id: rec.id, label: rec.operation },
      meta: { operation: rec.operation },
    });
    const { tokenHash: _t, ...safe } = rec;
    return NextResponse.json(safe);
  } catch (e) {
    const code = e instanceof ApprovalError ? e.code : "approval_error";
    const status = code === "not_found" ? 404 : code === "already_consumed" ? 409 : 400;
    return NextResponse.json({ error: code }, { status });
  }
}
