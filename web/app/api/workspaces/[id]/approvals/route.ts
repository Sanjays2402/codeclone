/**
 * Dual-control approval requests for high-risk workspace operations.
 *
 *   GET  /api/workspaces/:id/approvals
 *     List requests for this workspace. Owners and admins can see them;
 *     everyone else gets 403. Strictly workspace-scoped.
 *
 *   POST /api/workspaces/:id/approvals
 *     Body: { operation, payload, reason }
 *     Open a new request. Caller must be an owner. The destructive route
 *     will later refuse to run unless a *different* owner approves and
 *     the one-time token comes back in.
 *
 * Approval / cancel live under ./[approvalId]/{approve,cancel}.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import { getWorkspace, getActiveMember } from "../../../../../lib/workspaces";
import {
  createApprovalRequest,
  listApprovals,
  isDualControlOperation,
  isDualControlEnabled,
  type DualControlOperation,
} from "../../../../../lib/dual-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REASON_MAX = 280;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const block = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/approvals" },
  );
  if (block) return block;
  const member = getActiveMember(ws, user.id);
  if (!member || (member.role !== "owner" && member.role !== "editor")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const items = await listApprovals(ws.id);
  // Never leak tokenHash even though it is already a one-way digest.
  const safe = items.map((r) => {
    const { tokenHash: _omit, ...rest } = r;
    return rest;
  });
  return NextResponse.json({ items: safe });
}

interface CreateBody {
  operation?: unknown;
  payload?: unknown;
  reason?: unknown;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const block = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/approvals" },
  );
  if (block) return block;
  const member = getActiveMember(ws, user.id);
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    /* empty */
  }
  if (!isDualControlOperation(body.operation)) {
    return NextResponse.json(
      { error: "invalid_operation", message: "Unknown or unsupported operation." },
      { status: 400 },
    );
  }
  const operation = body.operation as DualControlOperation;
  if (!isDualControlEnabled(ws, operation)) {
    return NextResponse.json(
      {
        error: "policy_disabled",
        message:
          "Dual control is not enabled for this operation. Turn it on in workspace security settings first.",
      },
      { status: 400 },
    );
  }
  const reasonRaw = typeof body.reason === "string" ? body.reason : "";
  const reason = reasonRaw.trim();
  if (reason.length < 6) {
    return NextResponse.json(
      { error: "reason_required", message: "Please provide a short justification." },
      { status: 400 },
    );
  }
  if (reason.length > REASON_MAX) {
    return NextResponse.json(
      { error: "reason_too_long", message: `Reason must be under ${REASON_MAX} characters.` },
      { status: 400 },
    );
  }

  // Normalise the payload to the shape the destructive route will hash.
  const payloadIn = (body.payload ?? {}) as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  if (operation === "workspace.transfer_ownership") {
    if (typeof payloadIn.toUserId !== "string" || payloadIn.toUserId.length === 0) {
      return NextResponse.json(
        { error: "invalid_payload", message: "transfer needs payload.toUserId." },
        { status: 400 },
      );
    }
    payload.toUserId = payloadIn.toUserId;
  } else if (operation === "workspace.wipe") {
    // The wipe route hashes { confirm: workspace.slug }; bake that in here
    // so a request is intrinsically pinned to this workspace.
    payload.confirm = ws.slug;
  }

  const rec = await createApprovalRequest({
    workspaceId: ws.id,
    operation,
    payload,
    reason,
    requestedBy: user.id,
    requestedByEmail: user.email,
  });
  await tryRecordAudit(req, {
    action: "workspace.approval_requested",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "approval", id: rec.id, label: operation },
    meta: { operation, reason, payload, expiresAt: rec.expiresAt },
  });
  const { tokenHash: _omit, ...safe } = rec;
  return NextResponse.json({ approval: safe }, { status: 201 });
}
