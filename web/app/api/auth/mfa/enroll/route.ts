import { NextResponse } from "next/server";
import { currentSessionFromCookieHeader } from "../../../../../lib/auth";
import { startEnrollment } from "../../../../../lib/mfa";
import { tryRecordAudit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const out = await startEnrollment(ctx.user.id, ctx.user.email);
    await tryRecordAudit(req, {
      action: "mfa.enroll.start",
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      target: { type: "user", id: ctx.user.id },
    });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Enrollment failed." },
      { status: 400 },
    );
  }
}
