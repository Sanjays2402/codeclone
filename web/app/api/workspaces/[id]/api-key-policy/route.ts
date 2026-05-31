/**
 * Workspace API key max-age policy management.
 *
 * GET  /api/workspaces/:id/api-key-policy
 *   Any active member may read. Returns the current policy, owner-edit
 *   permission, and the bounds the UI should display.
 *
 * PUT  /api/workspaces/:id/api-key-policy
 *   Owner only. Body: { maxAgeDays: number }. 0 (or missing) clears the
 *   policy. Out-of-bounds values are clamped to API_KEY_POLICY_BOUNDS.
 *
 * DELETE /api/workspaces/:id/api-key-policy
 *   Owner only. Removes the policy entirely (same effect as PUT { 0 }).
 *
 * Every mutation lands in the audit log with a before/after diff. Runtime
 * enforcement happens in lib/api-key-policy-enforce.ts on every /v1
 * request, and at key creation time in lib/api-keys.ts#createKey.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setApiKeyPolicy,
  sanitizeApiKeyPolicy,
  API_KEY_POLICY_BOUNDS,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicPolicy(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.apiKeyPolicy) {
    return { maxAgeDays: 0, updatedAt: null, updatedBy: null };
  }
  const p = ws.apiKeyPolicy;
  return {
    maxAgeDays: p.maxAgeDays,
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
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/api-key-policy" });
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    policy: publicPolicy(ws),
    canEdit: canManage(ws, user.id),
    bounds: API_KEY_POLICY_BOUNDS,
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/api-key-policy" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.api_key_policy_update",
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
  const sanitized = sanitizeApiKeyPolicy(body as Record<string, unknown>);
  if (!sanitized) {
    return NextResponse.json(
      { error: { type: "invalid_policy", message: "Body must be { maxAgeDays: number }. 0 clears." } },
      { status: 400 },
    );
  }
  const before = ws.apiKeyPolicy ? { maxAgeDays: ws.apiKeyPolicy.maxAgeDays } : { maxAgeDays: 0 };
  const updated = await setApiKeyPolicy(ws, sanitized, user.id);
  await tryRecordAudit(req, {
    action: "workspace.api_key_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { apiKeyPolicy: before },
      after: { apiKeyPolicy: sanitized },
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
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/api-key-policy" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.api_key_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = ws.apiKeyPolicy ? { maxAgeDays: ws.apiKeyPolicy.maxAgeDays } : { maxAgeDays: 0 };
  const updated = await setApiKeyPolicy(ws, null, user.id);
  await tryRecordAudit(req, {
    action: "workspace.api_key_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { apiKeyPolicy: before },
      after: { apiKeyPolicy: { maxAgeDays: 0 } },
    },
  });
  return NextResponse.json({ policy: publicPolicy(updated) });
}
