/**
 * GET /api/auth/verify?token=<id>.<secret>&redirect=/path
 *
 * Consumes the magic token, sets the session cookie, and redirects to
 * the post-login destination (defaults to "/").
 */
import { NextResponse } from "next/server";
import {
  consumeMagicLink,
  signSession,
  COOKIE_NAME,
  sessionCookieAttributes,
} from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const redirectParam = url.searchParams.get("redirect");
  const redirect =
    redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//")
      ? redirectParam
      : "/";

  const user = await consumeMagicLink(token);
  if (!user) {
    const back = new URL("/signin", url.origin);
    back.searchParams.set("error", "invalid_or_expired");
    return NextResponse.redirect(back, { status: 303 });
  }

  const cookie = signSession(user.id);
  const res = NextResponse.redirect(new URL(redirect, url.origin), { status: 303 });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(cookie)}; ${sessionCookieAttributes()}`,
  );
  return res;
}
