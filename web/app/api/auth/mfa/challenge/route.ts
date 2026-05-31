import { NextResponse } from "next/server";
import { currentSessionFromCookieHeader } from "../../../../../lib/auth";
import {
  verifyAndConsume,
  grantStepUp,
  getMfa,
  STEPUP_TTL_SEC,
} from "../../../../../lib/mfa";
import { tryRecordAudit } from "../../../../../lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (!ctx) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (!ctx.jti) {
    return NextResponse.json(
      { error: "Session is missing an id. Sign out and back in to re-enable MFA." },
      { status: 400 },
    );
  }
  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "Provide a code." }, { status: 400 });
  const rec = await getMfa(ctx.user.id);
  if (!rec || !rec.enrolledAt) {
    return NextResponse.json({ error: "MFA is not enabled for this account." }, { status: 400 });
  }
  const result = await verifyAndConsume(ctx.user.id, token);
  if (!result.ok) {
    await tryRecordAudit(req, {
      action: "mfa.challenge.fail",
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      target: { type: "user", id: ctx.user.id },
      meta: { reason: result.reason ?? "invalid" },
    });
    return NextResponse.json({ error: "Code did not match." }, { status: 401 });
  }
  const grant = await grantStepUp(ctx.jti, ctx.user.id);
  await tryRecordAudit(req, {
    action: "mfa.challenge.ok",
    actorId: ctx.user.id,
    actorEmail: ctx.user.email,
    target: { type: "user", id: ctx.user.id },
    meta: { via: result.via, remainingBackupCodes: result.remainingBackupCodes ?? null },
  });
  return NextResponse.json({
    ok: true,
    via: result.via,
    remainingBackupCodes: result.remainingBackupCodes ?? null,
    expiresAt: grant.expiresAt,
    ttlSec: STEPUP_TTL_SEC,
  });
}
