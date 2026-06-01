import { NextResponse } from "next/server";
import { recentEvents } from "../../../../lib/usage";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { listWorkspacesForUser, getActiveMember, getWorkspace } from "../../../../lib/workspaces";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage/recent
 *
 * Returns the most recent API calls scoped to workspaces the caller
 * is an active member of. Refuses anonymous callers. Pass
 * ?workspaceId=ws_... to scope to one workspace the caller belongs to.
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
  const rawLimit = url.searchParams.get("limit");
  const rawDays = url.searchParams.get("days");

  let limit = 50;
  if (rawLimit) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "limit must be 1..500." } },
        { status: 400 },
      );
    }
    limit = Math.floor(n);
  }

  let days = 7;
  if (rawDays) {
    const n = Number(rawDays);
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      return NextResponse.json(
        { error: { type: "invalid_request", message: "days must be 1..90." } },
        { status: 400 },
      );
    }
    days = Math.floor(n);
  }

  const memberWorkspaces = await listWorkspacesForUser(user.id);
  let allowedIds = new Set(memberWorkspaces.map((w) => w.id));

  const requested = url.searchParams.get("workspaceId");
  if (requested) {
    const ws = await getWorkspace(requested);
    const isMember = ws ? !!getActiveMember(ws, user.id) : false;
    if (!isMember) {
      void tryRecordAudit(req, {
        action: "usage.recent.denied",
        actorId: user.id,
        actorEmail: user.email,
        workspaceId: requested,
        target: { type: "usage_recent", id: requested },
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
    const events = await recentEvents(limit, days, Date.now(), allowedIds);
    return NextResponse.json(
      {
        events,
        limit,
        windowDays: days,
        scope: { workspaceIds: Array.from(allowedIds) },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          type: "internal_error",
          message:
            err instanceof Error ? err.message : "Failed to load recent calls.",
        },
      },
      { status: 500 },
    );
  }
}
