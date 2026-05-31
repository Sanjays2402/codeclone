/**
 * DELETE /api/sessions/[jti] → revoke a single session belonging to the
 *                              signed-in user.
 */
import { NextResponse } from "next/server";
import { currentSessionFromCookieHeader } from "../../../../lib/auth";
import { revokeSession, getSession } from "../../../../lib/sessions";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ jti: string }> },
) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { jti } = await params;
  if (!jti || jti.length > 64) {
    return NextResponse.json({ error: "invalid_jti" }, { status: 400 });
  }
  const rec = await getSession(ctx.user.id, jti);
  if (!rec) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await revokeSession(ctx.user.id, jti);
  await tryRecordAudit(req, {
    action: "auth.session_revoke",
    actorId: ctx.user.id,
    actorEmail: ctx.user.email,
    target: { type: "session", id: jti },
    meta: { wasCurrent: ctx.jti === jti },
  });
  return NextResponse.json({ ok: true, revoked: jti });
}
