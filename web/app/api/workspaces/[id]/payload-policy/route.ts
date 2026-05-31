/**
 * Workspace request payload size policy management.
 *
 * GET  /api/workspaces/:id/payload-policy
 *   Any active member may read. Returns the current policy, owner-edit
 *   permission, and the bounds the UI should display.
 *
 * PUT  /api/workspaces/:id/payload-policy
 *   Owner only. Body: { maxBodyBytes: number }. 0 (or missing) clears
 *   the policy. Out-of-bounds values are clamped to PAYLOAD_POLICY_BOUNDS.
 *
 * DELETE /api/workspaces/:id/payload-policy
 *   Owner only. Removes the policy entirely (same effect as PUT { 0 }).
 *
 * Every mutation lands in the audit log with a before/after diff. Runtime
 * enforcement happens in lib/payload-policy-enforce.ts on every /v1
 * request.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setPayloadPolicy,
  sanitizePayloadPolicy,
  PAYLOAD_POLICY_BOUNDS,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicPolicy(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.payloadPolicy) {
    return { maxBodyBytes: 0, updatedAt: null, updatedBy: null };
  }
  const p = ws.payloadPolicy;
  return {
    maxBodyBytes: p.maxBodyBytes,
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
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/payload-policy" });
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    policy: publicPolicy(ws),
    canEdit: canManage(ws, user.id),
    bounds: PAYLOAD_POLICY_BOUNDS,
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/payload-policy" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.payload_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: unknown = {};
  try { body = await req.json(); } catch { /* empty body clears */ }
  const sanitized = sanitizePayloadPolicy(body as Record<string, unknown>);
  if (!sanitized) {
    return NextResponse.json(
      { error: { type: "invalid_policy", message: "Body must be { maxBodyBytes: number }. 0 clears." } },
      { status: 400 },
    );
  }
  const before = ws.payloadPolicy ? { maxBodyBytes: ws.payloadPolicy.maxBodyBytes } : { maxBodyBytes: 0 };
  const updated = await setPayloadPolicy(ws, sanitized, user.id);
  await tryRecordAudit(req, {
    action: "workspace.payload_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { payloadPolicy: before },
      after: { payloadPolicy: sanitized },
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
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/payload-policy" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.payload_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = ws.payloadPolicy ? { maxBodyBytes: ws.payloadPolicy.maxBodyBytes } : { maxBodyBytes: 0 };
  const updated = await setPayloadPolicy(ws, null, user.id);
  await tryRecordAudit(req, {
    action: "workspace.payload_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { payloadPolicy: before },
      after: { payloadPolicy: { maxBodyBytes: 0 } },
    },
  });
  return NextResponse.json({ policy: publicPolicy(updated) });
}
