import { NextResponse } from "next/server";
import { summarize } from "../../../lib/usage";
import { currentUserFromCookieHeader } from "../../../lib/auth";
import { listWorkspacesForUser, getActiveMember, getWorkspace } from "../../../lib/workspaces";
import { tryRecordAudit } from "../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage
 *
 * Returns the dashboard usage summary scoped to workspaces the caller
 * is an active member of. Unauthenticated callers are refused. Pass
 * ?workspaceId=ws_... to scope to a single workspace the caller belongs
 * to. Without it, totals span every workspace the caller can see.
 *
 * This route used to be unauthenticated and global, which leaked
 * key-id usage rows across tenants. The tenant filter lives in
 * lib/usage.ts (summarize/recentEvents accept a WorkspaceScope).
 */
export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "sign in required" } },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get("days");
  let windowDays = 30;
  if (raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "days must be 1..90." } },
        { status: 400 },
      );
    }
    windowDays = Math.floor(n);
  }

  const memberWorkspaces = await listWorkspacesForUser(user.id);
  let allowedIds = new Set(memberWorkspaces.map((w) => w.id));

  const requested = url.searchParams.get("workspaceId");
  if (requested) {
    const ws = await getWorkspace(requested);
    const isMember = ws ? !!getActiveMember(ws, user.id) : false;
    if (!isMember) {
      void tryRecordAudit(req, {
        action: "usage.read.denied",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: requested,
        target: { type: "usage_summary", id: requested },
        status: "denied",
        meta: { reason: "not_a_member" },
      });
      return NextResponse.json(
        { error: { type: "forbidden", message: "not a member of that workspace" } },
        { status: 403 },
      );
    }
    allowedIds = new Set([requested]);
  }

  try {
    const data = await summarize(windowDays, Date.now(), allowedIds);
    void tryRecordAudit(req, {
      action: "usage.read",
      actorId: user.id,
      actorEmail: user.email,
      workspaceId: requested ?? undefined,
      target: { type: "usage_summary", id: requested ?? "all" },
      status: "ok",
      meta: { windowDays, workspaces: Array.from(allowedIds) },
    });
    return NextResponse.json(
      { ...data, scope: { workspaceIds: Array.from(allowedIds) } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          type: "internal_error",
          message: err instanceof Error ? err.message : "Failed to load usage.",
        },
      },
      { status: 500 },
    );
  }
}
