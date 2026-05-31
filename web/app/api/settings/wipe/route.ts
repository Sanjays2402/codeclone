import { NextRequest, NextResponse } from "next/server";
import { wipeAll } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

const CONFIRM_PHRASE = "delete everything";

export async function POST(req: NextRequest) {
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
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
