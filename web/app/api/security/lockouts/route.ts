/**
 * GET /api/security/lockouts
 *
 * Read-only view of magic-link / sign-in lockouts that are currently
 * in effect. Restricted to users who own at least one workspace so
 * that security teams investigating an attack have a place to look,
 * but unprivileged accounts cannot enumerate global abuse state.
 *
 * Identifiers (email / IP) are returned as the same opaque hash used
 * on disk; we never echo the raw email or address back to the
 * browser, so a compromised admin token still cannot harvest the
 * underlying values.
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../lib/auth";
import { listWorkspacesForUser, getActiveMember } from "../../../../lib/workspaces";
import { listActiveLockouts, config as throttleConfig } from "../../../../lib/auth-throttle";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json(
      { error: { type: "unauthorized", message: "Sign in required." } },
      { status: 401 },
    );
  }
  const memberships = await listWorkspacesForUser(user.id);
  const ownsAny = memberships.some((ws) => getActiveMember(ws, user.id)?.role === "owner");
  if (!ownsAny) {
    await tryRecordAudit(req, {
      action: "security.lockouts.read.denied",
      actorId: user.id,
      actorEmail: user.email,
      target: { type: "security", id: "lockouts" },
      status: "denied",
      meta: { reason: "not_owner" },
    });
    return NextResponse.json(
      {
        error: {
          type: "forbidden",
          message: "Only workspace owners can view security lockouts.",
        },
      },
      { status: 403 },
    );
  }

  const lockouts = await listActiveLockouts();
  await tryRecordAudit(req, {
    action: "security.lockouts.read",
    actorId: user.id,
    actorEmail: user.email,
    target: { type: "security", id: "lockouts" },
    meta: { count: lockouts.length },
  });
  return NextResponse.json({
    config: throttleConfig(),
    lockouts,
  });
}
