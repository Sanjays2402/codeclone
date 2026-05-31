/**
 * POST /api/auth/signout → clears the session cookie.
 */
import { NextResponse } from "next/server";
import { COOKIE_NAME, clearedCookieAttributes, currentUserFromCookieHeader } from "../../../../lib/auth";
import { tryRecordAudit } from "../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  const res = NextResponse.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; ${clearedCookieAttributes()}`,
  );
  await tryRecordAudit(req, {
    action: "auth.signout",
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    target: { type: "session" },
  });
  return res;
}
