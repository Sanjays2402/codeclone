import { NextResponse } from "next/server";
import { currentSessionFromCookieHeader } from "../../../../lib/auth";
import { getMfa, publicStatus } from "../../../../lib/mfa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const rec = await getMfa(ctx.user.id);
  return NextResponse.json(publicStatus(rec));
}
