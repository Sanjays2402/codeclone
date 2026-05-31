/**
 * POST /api/auth/signout → clears the session cookie.
 */
import { NextResponse } from "next/server";
import { COOKIE_NAME, clearedCookieAttributes } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; ${clearedCookieAttributes()}`,
  );
  return res;
}
