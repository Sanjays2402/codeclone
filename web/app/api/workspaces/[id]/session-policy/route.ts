/**
 * Workspace session policy management.
 *
 * GET  /api/workspaces/:id/session-policy
 *   Any workspace member can read. Returns the current policy plus
 *   `canEdit`, the bounds the UI should display, and a snapshot of the
 *   effective policy for the caller.
 *
 * PUT  /api/workspaces/:id/session-policy
 *   Owner only. Body: { maxLifetimeSec: number, idleTimeoutSec: number }.
 *   Values of 0 disable that limit. Out-of-bounds values are clamped.
 *
 * DELETE /api/workspaces/:id/session-policy
 *   Owner only. Removes the policy entirely.
 *
 * Every mutation lands in the audit log with a full before/after diff.
 * Enforcement happens in lib/auth.ts#currentSessionFromCookieHeader which
 * runs on every authenticated request, so changes take effect immediately.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setSessionPolicy,
  sanitizeSessionPolicy,
  effectiveSessionPolicyForUser,
  SESSION_POLICY_BOUNDS,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicPolicy(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.sessionPolicy) {
    return {
      maxLifetimeSec: 0,
      idleTimeoutSec: 0,
      maxConcurrentSessions: 0,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const p = ws.sessionPolicy;
  return {
    maxLifetimeSec: p.maxLifetimeSec,
    idleTimeoutSec: p.idleTimeoutSec,
    maxConcurrentSessions: p.maxConcurrentSessions ?? 0,
    updatedAt: p.updatedAt,
    updatedBy: p.updatedBy,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/session-policy" });
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const effective = await effectiveSessionPolicyForUser(user.id);
  return NextResponse.json({
    policy: publicPolicy(ws),
    effective,
    canEdit: canManage(ws, user.id),
    bounds: SESSION_POLICY_BOUNDS,
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/session-policy" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.session_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: unknown = {};
  try { body = await req.json(); } catch { /* empty body treated as clear */ }
  const sanitized = sanitizeSessionPolicy(body as Record<string, unknown>);
  if (!sanitized) {
    return NextResponse.json({ error: "invalid_policy" }, { status: 400 });
  }
  const before = ws.sessionPolicy
    ? {
        maxLifetimeSec: ws.sessionPolicy.maxLifetimeSec,
        idleTimeoutSec: ws.sessionPolicy.idleTimeoutSec,
        maxConcurrentSessions: ws.sessionPolicy.maxConcurrentSessions ?? 0,
      }
    : { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 0 };
  const updated = await setSessionPolicy(ws, sanitized, user.id);
  await tryRecordAudit(req, {
    action: "workspace.session_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { sessionPolicy: before },
      after: { sessionPolicy: sanitized },
    },
  });
  return NextResponse.json({ policy: publicPolicy(updated) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/session-policy" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.session_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = ws.sessionPolicy
    ? {
        maxLifetimeSec: ws.sessionPolicy.maxLifetimeSec,
        idleTimeoutSec: ws.sessionPolicy.idleTimeoutSec,
        maxConcurrentSessions: ws.sessionPolicy.maxConcurrentSessions ?? 0,
      }
    : { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 0 };
  const updated = await setSessionPolicy(ws, null, user.id);
  await tryRecordAudit(req, {
    action: "workspace.session_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { sessionPolicy: before },
      after: { sessionPolicy: { maxLifetimeSec: 0, idleTimeoutSec: 0, maxConcurrentSessions: 0 } },
    },
  });
  return NextResponse.json({ policy: publicPolicy(updated) });
}
