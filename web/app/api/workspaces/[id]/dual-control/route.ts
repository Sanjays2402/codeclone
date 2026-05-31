/**
 * GET  /api/workspaces/:id/dual-control   read policy
 * PUT  /api/workspaces/:id/dual-control   { operations: string[] }
 *
 * Owner only. Audited. The list is intersected with the supported set so
 * a malformed client cannot encode an unknown operation.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import { enforceWorkspaceAllowlistForSession } from "../../../../../lib/dashboard-allowlist-enforce";
import { getWorkspace, getActiveMember } from "../../../../../lib/workspaces";
import {
  setDualControlPolicy,
  getDualControlPolicy,
  isDualControlOperation,
  DUAL_CONTROL_OPERATIONS,
  type DualControlOperation,
} from "../../../../../lib/dual-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadOwner(req: Request, id: string) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  const ws = await getWorkspace(id);
  if (!ws) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const block = await enforceWorkspaceAllowlistForSession(
    req,
    ws,
    { id: user.id, email: user.email },
    { surface: "workspaces/dual-control" },
  );
  if (block) return { error: block };
  const member = getActiveMember(ws, user.id);
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user, ws };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await loadOwner(req, id);
  if ("error" in r) return r.error;
  return NextResponse.json({
    policy: getDualControlPolicy(r.ws),
    supportedOperations: DUAL_CONTROL_OPERATIONS,
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await loadOwner(req, id);
  if ("error" in r) return r.error;
  const { user, ws } = r;
  let body: { operations?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  if (!Array.isArray(body.operations)) {
    return NextResponse.json(
      { error: "invalid_body", message: "Expected { operations: string[] }." },
      { status: 400 },
    );
  }
  const ops = body.operations.filter(isDualControlOperation) as DualControlOperation[];
  const before = getDualControlPolicy(ws);
  await setDualControlPolicy(ws, ops, user.id);
  await tryRecordAudit(req, {
    action: "workspace.dual_control_policy_set",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: {
      before: { operations: before?.operations ?? [] },
      after: { operations: ops },
    },
  });
  return NextResponse.json({
    policy: getDualControlPolicy(ws),
    supportedOperations: DUAL_CONTROL_OPERATIONS,
  });
}
