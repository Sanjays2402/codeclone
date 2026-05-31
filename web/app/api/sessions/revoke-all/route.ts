/**
 * POST /api/sessions/revoke-all
 * Body: { includeCurrent?: boolean }
 *
 * Revokes every active session for the user. By default the caller's current
 * session is preserved so they remain logged in. Pass includeCurrent=true to
 * sign out everywhere; the response clears the cookie.
 */
import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  clearedCookieAttributes,
  currentSessionFromCookieHeader,
} from "../../../../lib/auth";
import { revokeAllSessions, revokeSession } from "../../../../lib/sessions";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: { includeCurrent?: boolean } = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as { includeCurrent?: boolean };
  } catch {
    /* tolerate empty body */
  }
  const includeCurrent = Boolean(body.includeCurrent);

  const exceptJti = includeCurrent ? undefined : ctx.jti ?? undefined;
  let revoked = await revokeAllSessions(ctx.user.id, { exceptJti });
  if (includeCurrent && ctx.jti) {
    if (await revokeSession(ctx.user.id, ctx.jti)) revoked += 1;
  }

  const res = NextResponse.json({ ok: true, revoked, includeCurrent });
  if (includeCurrent) {
    res.headers.append(
      "Set-Cookie",
      `${COOKIE_NAME}=; ${clearedCookieAttributes()}`,
    );
  }
  await tryRecordAudit(req, {
    action: includeCurrent ? "auth.session_revoke_all" : "auth.session_revoke_others",
    actorId: ctx.user.id,
    actorEmail: ctx.user.email,
    target: { type: "user", id: ctx.user.id },
    meta: { revoked, includeCurrent },
  });
  return res;
}
