/**
 * POST /api/workspaces/:id/transfer-ownership
 *
 * Hand the single owner role to another existing member. Required by buyers
 * whose admins rotate out of the company: without this endpoint a workspace
 * becomes unmanageable when its owner leaves.
 *
 * Caller must:
 *   - be authenticated
 *   - be the current owner of the workspace
 *   - have completed an MFA step-up in the current session (destructive admin)
 *
 * Body: { toUserId: string }
 *
 * Audited as `workspace.transfer_ownership` with the before/after owner ids.
 */
import { NextResponse } from "next/server";
import {
  currentUserFromCookieHeader,
  currentSessionFromCookieHeader,
} from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { requireStepUp } from "../../../../../lib/mfa";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  transferOwnership,
} from "../../../../../lib/workspaces";
import {
  isDualControlEnabled,
  consumeApprovalToken,
  ApprovalError,
} from "../../../../../lib/dual-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  toUserId?: unknown;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/transfer-ownership" });
  if (__ipBlock) return __ipBlock;

  const me = getActiveMember(ws, user.id);
  if (!me || me.role !== "owner") {
    await tryRecordAudit(req, {
      action: "workspace.transfer_ownership",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "not_owner" },
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Step-up MFA: this is the most destructive workspace operation we expose.
  const session = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, session?.jti ?? null);
  if (!gate.allowed) {
    await tryRecordAudit(req, {
      action: "workspace.transfer_ownership",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "mfa_required" },
    });
    return NextResponse.json(
      { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
      { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
    );
  }

  let body: Body = {};
  try { body = await req.json(); } catch { /* empty */ }
  const toUserId = typeof body.toUserId === "string" ? body.toUserId : "";
  if (!toUserId) {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }

  try {
    if (isDualControlEnabled(ws, "workspace.transfer_ownership")) {
      const token = typeof (body as { approval_token?: unknown }).approval_token === "string"
        ? ((body as { approval_token: string }).approval_token)
        : "";
      try {
        const approval = await consumeApprovalToken({
          workspaceId: ws.id,
          operation: "workspace.transfer_ownership",
          token,
          payloadForHash: { toUserId },
        });
        await tryRecordAudit(req, {
          action: "workspace.approval_consumed",
          actorId: user.id,
          actorEmail: user.email,
          workspaceId: ws.id,
          target: { type: "approval", id: approval.id, label: approval.operation },
          meta: {
            operation: approval.operation,
            requestedBy: approval.requestedBy,
            approvedBy: approval.approvedBy,
          },
        });
      } catch (e) {
        const code = e instanceof ApprovalError ? e.code : "approval_error";
        await tryRecordAudit(req, {
          action: "workspace.transfer_ownership",
          actorId: user.id,
          actorEmail: user.email,
          workspaceId: ws.id,
          target: { type: "workspace", id: ws.id, label: ws.name },
          status: "denied",
          meta: { reason: "dual_control_required", code, toUserId },
        });
        return NextResponse.json(
          {
            error: "approval_required",
            code,
            message:
              "This workspace requires a second owner to approve an ownership transfer.",
          },
          { status: 403 },
        );
      }
    }
    const beforeOwner = user.id;
    await transferOwnership(ws, user.id, toUserId);
    await tryRecordAudit(req, {
      action: "workspace.transfer_ownership",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      diff: { before: { owner: beforeOwner }, after: { owner: toUserId } },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status =
      msg === "not_owner" || msg === "not_member" || msg === "same_user" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
