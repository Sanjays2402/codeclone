/**
 * Workspace IP allowlist management.
 *
 * GET  /api/workspaces/:id/allowlist
 *   Returns { entries: string[], canEdit: boolean }.
 *   Any workspace member can read. Surfaces the current rules to the UI.
 *
 * PUT  /api/workspaces/:id/allowlist
 *   Body: { entries: string[] }
 *   Owner only. Replaces the entire allowlist atomically. Returns the
 *   sanitised list plus any rejected raw inputs so the UI can show them.
 *   Empty array disables enforcement (open).
 *
 * Every change is recorded to the audit log with before/after diffs.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import {
  getWorkspace,
  getMember,
  canManage,
  setIpAllowlist,
} from "../../../../../lib/workspaces";
import { sanitizeCidrList } from "../../../../../lib/ip-allowlist";

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
    entries: Array.isArray(ws.ipAllowlist) ? ws.ipAllowlist : [],
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
      action: "workspace.allowlist_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { entries?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body => clear */ }
  const { ok, rejected } = sanitizeCidrList(body.entries ?? []);
  const before = Array.isArray(ws.ipAllowlist) ? ws.ipAllowlist.slice() : [];
  await setIpAllowlist(ws, ok);
  await tryRecordAudit(req, {
    action: "workspace.allowlist_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { ipAllowlist: before }, after: { ipAllowlist: ok } },
    meta: rejected.length ? { rejected } : null,
  });
  return NextResponse.json({ entries: ok, rejected });
}
