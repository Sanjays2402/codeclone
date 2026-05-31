/**
 * GET /api/auth/me → { user } | { user: null }
 */
import { NextResponse } from "next/server";
import { currentUserFromCookieHeader } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
  if (!user) {
    return NextResponse.json({ user: null });
  }
  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
  });
}
