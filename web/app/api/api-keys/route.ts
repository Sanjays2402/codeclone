import { NextResponse } from "next/server";
import { createKey, listKeys } from "../../../lib/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await listKeys();
    return NextResponse.json({ items, count: items.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

interface CreateBody {
  label?: unknown;
}

export async function POST(req: Request) {
  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    // empty body is fine; we'll default the label
  }
  try {
    const { record, plaintext } = await createKey(body.label);
    // plaintext is returned exactly once and never persisted
    return NextResponse.json({ key: record, plaintext }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
