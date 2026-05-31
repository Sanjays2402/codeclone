import { NextResponse } from "next/server";
import { currentSessionFromCookieHeader } from "../../../../../lib/auth";
import {
  disableMfa,
  getMfa,
  verifyAndConsume,
  clearStepUp,
} from "../../../../../lib/mfa";
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
  const rec = await getMfa(ctx.user.id);
  if (!rec || !rec.enrolledAt) {
    return NextResponse.json({ ok: true, alreadyDisabled: true });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json(
      { error: "Provide your current MFA code to disable." },
      { status: 400 },
    );
  }
  const v = await verifyAndConsume(ctx.user.id, token);
  if (!v.ok) {
    return NextResponse.json({ error: "Code did not match." }, { status: 401 });
  }
  await disableMfa(ctx.user.id);
  if (ctx.jti) await clearStepUp(ctx.jti);
  await tryRecordAudit(req, {
    action: "mfa.disable",
    actorId: ctx.user.id,
    actorEmail: ctx.user.email,
    target: { type: "user", id: ctx.user.id },
  });
  return NextResponse.json({ ok: true });
}
