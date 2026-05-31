/**
 * Workspace legal hold.
 *
 *   GET    /api/workspaces/:id/legal-hold   any member
 *   POST   /api/workspaces/:id/legal-hold   owner + MFA step-up
 *                                          body: { reason, caseRef? }
 *   DELETE /api/workspaces/:id/legal-hold   owner + MFA step-up
 *                                          body: { confirm: "<slug>" }
 *
 * While the hold is active, every destructive workspace path
 * (workspace wipe, retention shortening/clear, audit retention purge
 * targeting this workspace) refuses with `legal_hold` and a 409. The
 * placement, release, and any blocked attempts are recorded in the
 * tamper-evident audit chain so the workspace produces a defensible
 * preservation timeline for litigation, regulator, or DPA review.
 *
 * There is no \"force\" override. Releasing the hold is the only path to
 * destructive action; that release is itself an auditable owner act.
 */
import { NextRequest, NextResponse } from "next/server";
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
  canManage,
  isOnLegalHold,
  placeLegalHold,
  releaseLegalHold,
  sanitizeLegalHold,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicHold(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.legalHold) return null;
  return {
    active: true as const,
    reason: ws.legalHold.reason,
    caseRef: ws.legalHold.caseRef ?? null,
    placedAt: ws.legalHold.placedAt,
    placedBy: ws.legalHold.placedBy,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/legal-hold" });
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    hold: publicHold(ws),
    canEdit: canManage(ws, user.id),
  });
}

async function gateOwnerWithMfa(
  req: NextRequest,
  action: "workspace.legal_hold_place" | "workspace.legal_hold_release",
) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  const sess = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, sess?.jti ?? null);
  if (!gate.allowed) {
    return {
      user,
      error: NextResponse.json(
        { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
        { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
      ),
    };
  }
  return { user };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/legal-hold" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.legal_hold_place",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json(
      { error: "forbidden", message: "Owner role required." },
      { status: 403 },
    );
  }
  if (isOnLegalHold(ws)) {
    return NextResponse.json(
      { error: "already_held", hold: publicHold(ws) },
      { status: 409 },
    );
  }
  const gated = await gateOwnerWithMfa(req, "workspace.legal_hold_place");
  if (gated.error) return gated.error;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = sanitizeLegalHold(body);
  if (!input) {
    return NextResponse.json(
      {
        error: "invalid_input",
        message: "reason must be 3-500 chars; optional caseRef <=120 chars [A-Za-z0-9 _-./#:]",
      },
      { status: 400 },
    );
  }

  const updated = await placeLegalHold(ws, input, user.id);
  await tryRecordAudit(req, {
    action: "workspace.legal_hold_place",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { after: { legalHold: { reason: input.reason, caseRef: input.caseRef ?? null } } },
  });
  return NextResponse.json({ hold: publicHold(updated) });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/legal-hold" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.legal_hold_release",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "owner_required" },
    });
    return NextResponse.json(
      { error: "forbidden", message: "Owner role required." },
      { status: 403 },
    );
  }
  if (!isOnLegalHold(ws)) {
    return NextResponse.json({ error: "not_held" }, { status: 409 });
  }
  let body: { confirm?: unknown } = {};
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    /* empty */
  }
  if (typeof body.confirm !== "string" || body.confirm !== ws.slug) {
    return NextResponse.json(
      {
        error: "confirm_required",
        message: `Send {"confirm": "${ws.slug}"} to release the hold.`,
      },
      { status: 400 },
    );
  }
  const gated = await gateOwnerWithMfa(req, "workspace.legal_hold_release");
  if (gated.error) return gated.error;

  const before = {
    reason: ws.legalHold?.reason,
    caseRef: ws.legalHold?.caseRef ?? null,
    placedAt: ws.legalHold?.placedAt,
    placedBy: ws.legalHold?.placedBy,
  };
  const updated = await releaseLegalHold(ws);
  await tryRecordAudit(req, {
    action: "workspace.legal_hold_release",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { legalHold: before }, after: { legalHold: null } },
  });
  return NextResponse.json({ hold: publicHold(updated) });
}
