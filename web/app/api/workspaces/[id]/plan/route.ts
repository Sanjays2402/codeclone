/**
 * Workspace billing plan management.
 *
 * GET  /api/workspaces/:id/plan
 *   Returns { plan, catalog, usage } for any workspace member so the
 *   admin console can show the current tier and month-to-date burn.
 *
 * PUT  /api/workspaces/:id/plan
 *   Body: { plan: "free" | "pro" | "enterprise" }
 *   Owner only. Updates the plan and writes an audit entry with the
 *   before/after diff. Returns the new plan + refreshed usage so the UI
 *   can render the new cap without a second round trip.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../../lib/auth";
import { tryRecordAudit } from "../../../../../lib/audit";
import {
  getWorkspace,
  getActiveMember,
  canManage,
  setWorkspacePlan,
} from "../../../../../lib/workspaces";
import {
  PLANS,
  PLAN_IDS,
  getPlan,
  isPlanId,
  workspaceQuotaCheck,
} from "../../../../../lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function planCatalog() {
  return PLAN_IDS.map((id) => ({
    id,
    label: PLANS[id].label,
    monthlyCalls: PLANS[id].monthlyCalls,
    description: PLANS[id].description,
  }));
}

async function snapshot(ws: Awaited<ReturnType<typeof getWorkspace>>) {
  if (!ws) return null;
  const quota = await workspaceQuotaCheck(ws.id, ws);
  return {
    plan: {
      id: getPlan(ws).id,
      label: getPlan(ws).label,
      monthlyCalls: getPlan(ws).monthlyCalls,
    },
    usage: {
      monthToDate: quota?.monthToDate ?? 0,
      limit: quota?.limit ?? null,
      remaining: quota?.remaining ?? null,
    },
    catalog: planCatalog(),
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
  const snap = await snapshot(ws);
  return NextResponse.json({ ...snap, canEdit: canManage(ws, user.id) });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canManage(ws, user.id)) {
    await tryRecordAudit(req, {
      action: "workspace.plan_update",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: ws.id,
      target: { type: "workspace", id: ws.id, label: ws.name },
      status: "denied",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { plan?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body => 400 below */ }
  if (!isPlanId(body.plan)) {
    return NextResponse.json(
      {
        error: "invalid_plan",
        message: "plan must be one of: free, pro, enterprise.",
        allowed: PLAN_IDS,
      },
      { status: 400 },
    );
  }
  const before = getPlan(ws).id;
  if (before === body.plan) {
    const snap = await snapshot(ws);
    return NextResponse.json({ ...snap, canEdit: true, changed: false });
  }
  await setWorkspacePlan(ws, body.plan);
  await tryRecordAudit(req, {
    action: "workspace.plan_update",
    actorId: user.id,
    actorEmail: user.email,
    workspaceId: ws.id,
    target: { type: "workspace", id: ws.id, label: ws.name },
    diff: { before: { plan: before }, after: { plan: body.plan } },
  });
  const snap = await snapshot(ws);
  return NextResponse.json({ ...snap, canEdit: true, changed: true });
}
