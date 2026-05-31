import { NextResponse } from "next/server";
import { createWebhook, listWebhooks } from "../../../lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: await listWebhooks() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const b = (body ?? {}) as { label?: unknown; url?: unknown; events?: unknown };
  try {
    const created = await createWebhook(b);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not create webhook." },
      { status: 400 },
    );
  }
}
