import { NextRequest, NextResponse } from "next/server";
import { loadPreferences, updatePreferences } from "../../../lib/settings";
import { tryRecordAudit } from "../../../lib/audit";
import { currentUserFromCookieHeader } from "../../../lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const prefs = await loadPreferences();
  return NextResponse.json(prefs);
}

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
  }
  try {
    const before = await loadPreferences();
    const next = await updatePreferences(body as Record<string, unknown>);
    const user = await currentUserFromCookieHeader(req.headers.get("cookie"));
    await tryRecordAudit(req, {
      action: "settings.update",
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      target: { type: "settings" },
      diff: { before, after: next },
    });
    return NextResponse.json(next);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
