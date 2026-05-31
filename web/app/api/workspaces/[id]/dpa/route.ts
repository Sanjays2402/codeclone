/**
 * Workspace Data Processing Agreement acceptance.
 *
 *   GET    /api/workspaces/:id/dpa   any active member
 *     Returns the current required version, whether the workspace has
 *     accepted it, and (if so) the pinned acceptance record.
 *
 *   POST   /api/workspaces/:id/dpa   owner + MFA step-up if configured
 *     Body: { version: "<DPA_CURRENT_VERSION>" }. The client MUST echo
 *     the version it intends to accept; a stale dashboard tab cannot
 *     silently accept a newer revision.
 *
 *   DELETE /api/workspaces/:id/dpa   owner + MFA step-up if configured
 *     Withdraws acceptance. Re-enables the /v1 gate on the next call.
 *
 * Every accept, re-accept, and withdrawal is written to the
 * tamper-evident audit log so the workspace produces a defensible
 * "who agreed to which terms, when, from where" record for SOC 2 / DPA
 * review.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader, currentSessionFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { requireStepUp } from "../../../../../lib/mfa";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
} from "../../../../../lib/workspaces";
import {
  DPA_CURRENT_VERSION,
  DPA_SUMMARY,
  acceptDpa,
  withdrawDpa,
  evaluateDpa,
  extractClientIp,
  sanitizeAcceptInput,
} from "../../../../../lib/dpa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicStatus(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  const s = evaluateDpa(ws ?? null);
  return {
    currentVersion: s.currentVersion,
    summary: DPA_SUMMARY,
    accepted: s.accepted,
    stale: s.stale,
    required: s.required,
    acceptance: s.acceptance
      ? {
          version: s.acceptance.version,
          acceptedAt: s.acceptance.acceptedAt,
          acceptedByUserId: s.acceptance.acceptedByUserId,
          acceptedByEmail: s.acceptance.acceptedByEmail,
          acceptedFromIp: s.acceptance.acceptedFromIp,
        }
      : null,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/dpa" });
  if (ipBlock) return ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    status: publicStatus(ws),
    canEdit: canManage(ws, user.id),
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/dpa" });
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.dpa_accept",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sess = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, sess?.jti ?? null);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
      { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
    );
  }

  let body: unknown = null;
  try { body = await req.json(); } catch { /* fall through */ }
  const input = sanitizeAcceptInput(body);
  if (!input) {
    return NextResponse.json(
      { error: { type: "invalid_request", message: "Body must be { version: string }." } },
      { status: 400 },
    );
  }
  if (input.version !== DPA_CURRENT_VERSION) {
    return NextResponse.json(
      {
        error: {
          type: "version_mismatch",
          message: `Refusing acceptance of '${input.version}'. Current version is '${DPA_CURRENT_VERSION}'. Reload the page and re-accept.`,
          current_version: DPA_CURRENT_VERSION,
        },
      },
      { status: 409 },
    );
  }
  const before = ws.dpa ? { version: ws.dpa.version, acceptedAt: ws.dpa.acceptedAt } : null;
  const updated = await acceptDpa(ws, {
    version: input.version,
    userId: user.id,
    email: user.email,
    ip: extractClientIp(req),
  });
  await tryRecordAudit(req, {
    action: "workspace.dpa_accept",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { dpa: before },
      after: { dpa: { version: input.version, acceptedAt: updated.dpa?.acceptedAt ?? null } },
    },
  });
  return NextResponse.json({ status: publicStatus(updated) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ipBlock = await enforceWorkspaceAllowlistForSession(req, ws, { id: user.id, email: user.email }, { surface: "workspaces/dpa" });
  if (ipBlock) return ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.dpa_withdraw",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sess = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  const gate = await requireStepUp(user.id, sess?.jti ?? null);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
      { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
    );
  }
  const before = ws.dpa ? { version: ws.dpa.version, acceptedAt: ws.dpa.acceptedAt } : null;
  const updated = await withdrawDpa(ws);
  await tryRecordAudit(req, {
    action: "workspace.dpa_withdraw",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { dpa: before }, after: { dpa: null } },
  });
  return NextResponse.json({ status: publicStatus(updated) });
}
