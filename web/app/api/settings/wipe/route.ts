import { NextRequest, NextResponse } from "next/server";
import { wipeAll } from "../../../../lib/settings";
import { tryRecordAudit } from "../../../../lib/audit";
import { currentSessionFromCookieHeader } from "../../../../lib/auth";
import { requireStepUp } from "../../../../lib/mfa";

export const dynamic = "force-dynamic";

const CONFIRM_PHRASE = "delete everything";

export async function POST(req: NextRequest) {
  const ctx = await currentSessionFromCookieHeader(req.headers.get("cookie"));
  if (ctx) {
    const gate = await requireStepUp(ctx.user.id, ctx.jti);
    if (!gate.allowed) {
      await tryRecordAudit(req, {
        action: "settings.wipe",
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        target: { type: "settings" },
        status: "denied",
        meta: { reason: "mfa_required" },
      });
      return NextResponse.json(
        { error: "mfa_required", message: "Verify your MFA code at /api/auth/mfa/challenge first." },
        { status: 401, headers: { "WWW-Authenticate": 'MFA realm="codeclone"' } },
      );
    }
  }
  let body: { confirm?: unknown };
  try {
    body = (await req.json()) as { confirm?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.confirm !== "string" || body.confirm.trim().toLowerCase() !== CONFIRM_PHRASE) {
    return NextResponse.json(
      { error: `To proceed, send { "confirm": "${CONFIRM_PHRASE}" }.` },
      { status: 400 },
    );
  }
  try {
    const result = await wipeAll();
    await tryRecordAudit(req, {
      action: "settings.wipe",
      actorId: ctx?.user.id ?? null,
      actorEmail: ctx?.user.email ?? null,
      target: { type: "settings" },
      meta: result as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
