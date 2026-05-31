/**
 * Workspace MFA enrollment policy management.
 *
 * GET  /api/workspaces/:id/mfa-policy
 *   Any active member may read. Returns the current policy, owner-edit
 *   permission, and the bounds the UI should display.
 *
 * PUT  /api/workspaces/:id/mfa-policy
 *   Owner only. Body: { requireEnrollment: boolean, gracePeriodDays?: number }.
 *   requireEnrollment=false clears the policy.
 *
 * DELETE /api/workspaces/:id/mfa-policy
 *   Owner only. Removes the policy entirely.
 *
 * Every mutation lands in the audit log with a before/after diff. Runtime
 * enforcement happens in lib/mfa-enforce.ts on sensitive mutating routes.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setMfaPolicy,
  sanitizeMfaPolicy,
  MFA_POLICY_BOUNDS,
} from "../../../../../lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicPolicy(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws || !ws.mfaPolicy) {
    return {
      requireEnrollment: false,
      gracePeriodDays: 0,
      updatedAt: null,
      updatedBy: null,
    };
  }
  const p = ws.mfaPolicy;
  return {
    requireEnrollment: p.requireEnrollment,
    gracePeriodDays: p.gracePeriodDays,
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
  if (!getActiveMember(ws, user.id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    policy: publicPolicy(ws),
    canEdit: canManage(ws, user.id),
    bounds: MFA_POLICY_BOUNDS,
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
      action: "workspace.mfa_policy_update",
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
  const sanitized = sanitizeMfaPolicy(body as Record<string, unknown>);
  if (!sanitized) {
    return NextResponse.json(
      {
        error: {
          type: "invalid_policy",
          message:
            "Body must be { requireEnrollment: boolean, gracePeriodDays?: number }.",
        },
      },
      { status: 400 },
    );
  }
  const before = ws.mfaPolicy
    ? {
        requireEnrollment: ws.mfaPolicy.requireEnrollment,
        gracePeriodDays: ws.mfaPolicy.gracePeriodDays,
      }
    : { requireEnrollment: false, gracePeriodDays: 0 };
  const updated = await setMfaPolicy(ws, sanitized, user.id);
  await tryRecordAudit(req, {
    action: "workspace.mfa_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { mfaPolicy: before },
      after: { mfaPolicy: sanitized },
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
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.mfa_policy_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const before = ws.mfaPolicy
    ? {
        requireEnrollment: ws.mfaPolicy.requireEnrollment,
        gracePeriodDays: ws.mfaPolicy.gracePeriodDays,
      }
    : { requireEnrollment: false, gracePeriodDays: 0 };
  const updated = await setMfaPolicy(ws, null, user.id);
  await tryRecordAudit(req, {
    action: "workspace.mfa_policy_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { mfaPolicy: before },
      after: { mfaPolicy: { requireEnrollment: false, gracePeriodDays: 0 } },
    },
  });
  return NextResponse.json({ policy: publicPolicy(updated) });
}
