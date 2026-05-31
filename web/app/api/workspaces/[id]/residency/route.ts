/**
 * Workspace data residency policy.
 *
 *   GET    /api/workspaces/:id/residency
 *     Any active member reads the current policy plus the serving region of
 *     the node that answered, plus a `canEdit` flag.
 *
 *   PUT    /api/workspaces/:id/residency
 *     Owner only. Body: { region: "us"|"eu"|"apac"|"global", enforced: bool }.
 *     When `enforced` is true the v1 API will refuse traffic on nodes whose
 *     CODECLONE_REGION does not match.
 *
 *   DELETE /api/workspaces/:id/residency
 *     Owner only. Clears the policy (workspace becomes effectively "global,
 *     not enforced"). The audit entry preserves the previous value in the
 *     before/after diff.
 *
 * Every mutation lands in the tamper-evident audit chain with a before/after
 * diff of the policy. Denials (member trying to PUT) also write an entry so
 * a workspace owner can see attempted privilege escalation.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setResidency,
  sanitizeResidency,
  currentServingRegion,
  residencyDecision,
  RESIDENCY_REGIONS,
  RESIDENCY_REGION_LABELS,
  type WorkspaceRecord,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicResidency(ws: WorkspaceRecord) {
  return {
    region: ws.residency?.region ?? null,
    enforced: !!ws.residency?.enforced,
    updatedAt: ws.residency?.updatedAt ?? null,
    updatedBy: ws.residency?.updatedBy ?? null,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/residency" });
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const serving = currentServingRegion();
  const decision = residencyDecision(ws, serving);
  return NextResponse.json({
    residency: publicResidency(ws),
    canEdit: canManage(ws, user.id),
    servingRegion: serving,
    match: decision.match,
    regions: RESIDENCY_REGIONS.map((id) => ({ id, label: RESIDENCY_REGION_LABELS[id] })),
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/residency" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.residency_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: unknown = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const sanitized = sanitizeResidency(body as { region?: unknown; enforced?: unknown });
  if (!sanitized) {
    return NextResponse.json(
      { error: "invalid_residency", regions: RESIDENCY_REGIONS },
      { status: 400 },
    );
  }
  const before = ws.residency ?? null;
  const updated = await setResidency(ws, sanitized, user.id);
  const after = updated.residency ?? null;
  await tryRecordAudit(req, {
    action: "workspace.residency_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    status: "ok",
    diff: { before, after },
  });
  return NextResponse.json({
    residency: publicResidency(updated),
    servingRegion: currentServingRegion(),
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/residency" });
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.residency_clear",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = ws.residency ?? null;
  const updated = await setResidency(ws, null, user.id);
  await tryRecordAudit(req, {
    action: "workspace.residency_clear",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    status: "ok",
    diff: { before, after: null },
  });
  return NextResponse.json({
    residency: publicResidency(updated),
    servingRegion: currentServingRegion(),
  });
}
