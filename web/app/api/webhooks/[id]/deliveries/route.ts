import { NextResponse } from "next/server";
import { listDeliveries, loadWebhook } from "../../../../../lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const rec = await loadWebhook(id);
  if (!rec) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ items: await listDeliveries(id) });
}
