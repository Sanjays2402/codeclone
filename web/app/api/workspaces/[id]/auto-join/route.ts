/**
 * Workspace domain auto-join policy.
 *
 * GET  /api/workspaces/:id/auto-join
 *   Members can read the current policy. Returns { domains, role, canEdit }.
 *
 * PUT  /api/workspaces/:id/auto-join
 *   Owner only. Body: { domains: string[], role?: "editor" | "viewer" }.
 *   Replaces the policy atomically. Audited with before/after diff.
 *   Empty domains array disables auto-join.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import {
  getWorkspace,
  getMember,
  canManage,
  sanitizeAutoJoinDomains,
  setAutoJoin,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!getMember(ws, user.id)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({
    domains: Array.isArray(ws.autoJoinDomains) ? ws.autoJoinDomains : [],
    role: ws.autoJoinRole === "editor" ? "editor" : "viewer",
    canEdit: canManage(ws, user.id),
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.auto_join_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { domains?: unknown; role?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body clears */ }
  const { ok, rejected } = sanitizeAutoJoinDomains(body.domains ?? []);
  const role = body.role === "editor" ? "editor" : "viewer";
  const before = {
    autoJoinDomains: Array.isArray(ws.autoJoinDomains) ? ws.autoJoinDomains.slice() : [],
    autoJoinRole: ws.autoJoinRole ?? "viewer",
  };
  await setAutoJoin(ws, ok, role);
  await tryRecordAudit(req, {
    action: "workspace.auto_join_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before, after: { autoJoinDomains: ok, autoJoinRole: role } },
    meta: rejected.length ? { rejected } : null,
  });
  return NextResponse.json({ domains: ok, role, rejected });
}
