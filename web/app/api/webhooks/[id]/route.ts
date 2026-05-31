import { NextResponse } from "next/server";
import {
  deleteWebhook,
  setDisabled,
  loadWebhook,
  summarize,
} from "../../../../lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const rec = await loadWebhook(id);
  if (!rec) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(summarize(rec));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: { disabled?: unknown };
  try {
    body = (await req.json()) as { disabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body.disabled !== "boolean") {
    return NextResponse.json({ error: "Field 'disabled' must be boolean." }, { status: 400 });
  }
  const ok = await setDisabled(id, body.disabled);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const rec = await loadWebhook(id);
  return NextResponse.json(rec ? summarize(rec) : { ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ok = await deleteWebhook(id);
  if (!ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
