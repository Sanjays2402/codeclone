import { NextResponse } from "next/server";
import { currentSessionFromCookieHeader } from "../../../../../lib/auth";
import { confirmEnrollment, grantStepUp } from "../../../../../lib/mfa";
import { tryRecordAudit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^\d{6}$/.test(token)) {
    return NextResponse.json({ error: "Provide a 6-digit code." }, { status: 400 });
  }
  try {
    const out = await confirmEnrollment(ctx.user.id, token);
    if (ctx.jti) await grantStepUp(ctx.jti, ctx.user.id);
    await tryRecordAudit(req, {
      action: "mfa.enroll.confirm",
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      target: { type: "user", id: ctx.user.id },
    });
    return NextResponse.json({ ok: true, backupCodes: out.backupCodes });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Confirmation failed." },
      { status: 400 },
    );
  }
}
