/**
 * POST /api/auth/signout → revokes the current session and clears the cookie.
 */
import { NextResponse } from "next/server";
import { COOKIE_NAME, clearedCookieAttributes, currentSessionFromCookieHeader } from "../../../../lib/auth";
import { revokeSession } from "../../../../lib/sessions";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (ctx?.jti) {
    await revokeSession(ctx.user.id, ctx.jti);
  }
  const res = NextResponse.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; ${clearedCookieAttributes()}`,
  );
  await tryRecordAudit(req, {
    action: "auth.signout",
    actorId: ctx?.user.id ?? null,
    actorEmail: ctx?.user.email ?? null,
    target: { type: "session", id: ctx?.jti ?? undefined },
  });
  return res;
}
