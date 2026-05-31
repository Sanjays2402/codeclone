/**
 * Workspace audit log retention policy.
 *
 * GET  /api/workspaces/:id/retention
 *   Any workspace member can read. Returns the current policy plus
 *   `canEdit`, the bounds the UI should display, and a snapshot of the
 *   current cutoff timestamp implied by the policy.
 *
 * PUT  /api/workspaces/:id/retention
 *   Owner only. Body: { auditDays: number }. 0 (or any value <= 0)
 *   clears the policy. Out-of-bounds values are clamped.
 *
 * DELETE /api/workspaces/:id/retention
 *   Owner only. Removes the policy entirely.
 *
 * Enforcement is read-time: lib/audit#listAudit drops entries older than
 * the cutoff for each workspace, so the tamper-evident hash chain on disk
 * stays intact and verifiable while access-layer GDPR data minimisation
 * still kicks in. Every mutation is recorded in the audit log with a
 * before/after diff.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import {
  getWorkspace,
  getMember,
  canManage,
  setRetention,
  sanitizeRetention,
  retentionCutoffMs,
  RETENTION_BOUNDS,
  LegalHoldError,
  isOnLegalHold,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicRetention(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.retention) {
    return { auditDays: 0, updatedAt: null, updatedBy: null };
  }
  return {
    auditDays: ws.retention.auditDays,
    updatedAt: ws.retention.updatedAt,
    updatedBy: ws.retention.updatedBy,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!getMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    policy: publicRetention(ws),
    cutoffMs: retentionCutoffMs(ws),
    canEdit: canManage(ws, user.id),
    bounds: RETENTION_BOUNDS,
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
      action: "workspace.retention_update",
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
  const sanitized = sanitizeRetention(body);
  if (!sanitized) {
    return NextResponse.json({ error: "invalid_policy" }, { status: 400 });
  }
  const before = { auditDays: ws.retention?.auditDays ?? 0 };
  let updated;
  try {
    updated = await setRetention(ws, sanitized, user.id);
  } catch (err) {
    if (err instanceof LegalHoldError) {
      await tryRecordAudit(req, {
        action: "workspace.retention_update",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: ws.id,
        target: { type: "workspace", id: ws.id, label: ws.name },
        status: "denied",
        meta: { reason: "legal_hold" },
      });
      return NextResponse.json(
        { error: "legal_hold", message: "Workspace is on legal hold; retention cannot be shortened or cleared." },
        { status: 409 },
      );
    }
    throw err;
  }
  await tryRecordAudit(req, {
    action: "workspace.retention_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { retention: before }, after: { retention: { auditDays: sanitized.auditDays } } },
  });
  return NextResponse.json({ policy: publicRetention(updated), cutoffMs: retentionCutoffMs(updated) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.retention_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (isOnLegalHold(ws)) {
    await tryRecordAudit(req, {
      action: "workspace.retention_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
      meta: { reason: "legal_hold" },
    });
    return NextResponse.json(
      { error: "legal_hold", message: "Workspace is on legal hold; retention policy cannot be cleared." },
      { status: 409 },
    );
  }
  const before = { auditDays: ws.retention?.auditDays ?? 0 };
  const updated = await setRetention(ws, null, user.id);
  await tryRecordAudit(req, {
    action: "workspace.retention_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { retention: before }, after: { retention: { auditDays: 0 } } },
  });
  return NextResponse.json({ policy: publicRetention(updated), cutoffMs: null });
}
