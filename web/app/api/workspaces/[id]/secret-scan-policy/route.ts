/**
 * Workspace secret-scan DLP policy management.
 *
 * GET  /api/workspaces/:id/secret-scan-policy
 *   Any active member may read. Returns the current policy, the available
 *   modes, and the list of detection rule ids so the admin UI can render
 *   the coverage list without needing a second roundtrip.
 *
 * PUT  /api/workspaces/:id/secret-scan-policy
 *   Owner only. Body: { mode: "off" | "warn" | "redact" | "block" }.
 *   Unknown modes are rejected with 400; "off" clears the policy.
 *
 * DELETE /api/workspaces/:id/secret-scan-policy
 *   Owner only. Same effect as PUT { mode: "off" }.
 *
 * Every mutation lands in the audit log with a before/after diff. Runtime
 * enforcement happens in lib/secret-scan-enforce.ts on every compare and
 * batch request (internal and /v1).
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setSecretScanPolicy,
  sanitizeSecretScanPolicy,
} from "../../../../../lib/workspaces";
import { SECRET_SCAN_MODES, listRules } from "../../../../../lib/secret-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicPolicy(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.secretScanPolicy) {
    return { mode: "off" as const, updatedAt: null, updatedBy: null };
  }
  const p = ws.secretScanPolicy;
  return { mode: p.mode, updatedAt: p.updatedAt, updatedBy: p.updatedBy };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/secret-scan-policy" },
  );
  if (__ipBlock) return __ipBlock;
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    policy: publicPolicy(ws),
    canEdit: canManage(ws, user.id),
    modes: SECRET_SCAN_MODES,
    rules: listRules(),
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const __ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/secret-scan-policy" },
  );
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.secret_scan_policy_update",
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
  const sanitized = sanitizeSecretScanPolicy(body as Record<string, unknown>);
  if (!sanitized) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_policy",
          message: `Body must be { mode: ${SECRET_SCAN_MODES.map((m) => JSON.stringify(m)).join(" | ")} }.`,
        },
      },
      { status: 400 },
    );
  }
  const before = ws.secretScanPolicy
    ? { mode: ws.secretScanPolicy.mode }
    : { mode: "off" as const };
  const updated = await setSecretScanPolicy(ws, sanitized, user.id);
  await tryRecordAudit(req, {
    action: "workspace.secret_scan_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { secretScanPolicy: before },
      after: { secretScanPolicy: sanitized },
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
  const __ipBlock = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/secret-scan-policy" },
  );
  if (__ipBlock) return __ipBlock;
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.secret_scan_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = ws.secretScanPolicy
    ? { mode: ws.secretScanPolicy.mode }
    : { mode: "off" as const };
  const updated = await setSecretScanPolicy(ws, null, user.id);
  await tryRecordAudit(req, {
    action: "workspace.secret_scan_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { secretScanPolicy: before },
      after: { secretScanPolicy: { mode: "off" } },
    },
  });
  return NextResponse.json({ policy: publicPolicy(updated) });
}
