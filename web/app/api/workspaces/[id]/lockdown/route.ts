/**
 * Workspace break-glass lockdown.
 *
 *   GET    /api/workspaces/:id/lockdown   any member
 *   POST   /api/workspaces/:id/lockdown   owner + MFA step-up
 *                                         body: { reason, caseRef? }
 *   DELETE /api/workspaces/:id/lockdown   owner + MFA step-up
 *                                         body: { confirm: "<slug>" }
 *
 * While the lockdown is active, every /v1 endpoint that resolves to a
 * key bound to this workspace is refused with HTTP 423 and the
 * structured `workspace_locked` error. Dashboard sessions keep working
 * so an owner can rotate keys, lift the lockdown, and inspect the
 * audit trail. Placement, release, and every blocked /v1 attempt are
 * recorded in the tamper-evident audit chain.
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
  isWorkspaceLocked,
  placeLockdown,
  releaseLockdown,
  sanitizeLockdown,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicLockdown(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.lockdown) return null;
  return {
    active: true as const,
    reason: ws.lockdown.reason,
    caseRef: ws.lockdown.caseRef ?? null,
    placedAt: ws.lockdown.placedAt,
    placedBy: ws.lockdown.placedBy,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/lockdown" },
  );
  if (ipBlock) return ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    lockdown: publicLockdown(ws),
    canEdit: canManage(ws, user.id),
  });
}

async function gateOwnerWithMfa(req: NextRequest) {
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
        {
          error: "mfa_required",
          message: "Verify your MFA code at /api/auth/mfa/challenge first.",
        },
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
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/lockdown" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.lockdown_place",
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
  if (isWorkspaceLocked(ws)) {
    return NextResponse.json(
      { error: "already_locked", lockdown: publicLockdown(ws) },
      { status: 409 },
    );
  }
  const gated = await gateOwnerWithMfa(req);
  if (gated.error) return gated.error;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = sanitizeLockdown(body);
  if (!input) {
    return NextResponse.json(
      {
        error: "invalid_input",
        message: "reason must be 3-500 chars; optional caseRef <=120 chars [A-Za-z0-9 _-./#:]",
      },
      { status: 400 },
    );
  }

  const updated = await placeLockdown(ws, input, user.id);
  await tryRecordAudit(req, {
    action: "workspace.lockdown_place",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { after: { lockdown: { reason: input.reason, caseRef: input.caseRef ?? null } } },
  });
  return NextResponse.json({ lockdown: publicLockdown(updated) });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/lockdown" },
  );
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.lockdown_release",
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
  if (!isWorkspaceLocked(ws)) {
    return NextResponse.json({ error: "not_locked" }, { status: 409 });
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
        message: `Send {"confirm": "${ws.slug}"} to lift the lockdown.`,
      },
      { status: 400 },
    );
  }
  const gated = await gateOwnerWithMfa(req);
  if (gated.error) return gated.error;

  const before = {
    reason: ws.lockdown?.reason,
    caseRef: ws.lockdown?.caseRef ?? null,
    placedAt: ws.lockdown?.placedAt,
    placedBy: ws.lockdown?.placedBy,
  };
  const updated = await releaseLockdown(ws);
  await tryRecordAudit(req, {
    action: "workspace.lockdown_release",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { lockdown: before }, after: { lockdown: null } },
  });
  return NextResponse.json({ lockdown: publicLockdown(updated) });
}
